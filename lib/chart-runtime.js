"use strict";

const crypto = require("node:crypto");
const vm = require("node:vm");
const { createActor, createMachine } = require("xstate");
const { parseTransitionLabel } = require("./chart-model");
const { ChartStructure } = require("./chart-structure");
const { getDeclarations, validateChart } = require("./chart-validation");

/** Maximum run time of a single condition or action */
const SCRIPT_TIMEOUT_MS = 1000;

/** Longer delays are not supported by setTimeout() */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Version of the persisted data, increase on incompatible changes */
const PERSISTED_VERSION = 1;

/**
 * The persisted state of a running chart, restored when the adapter starts again
 *
 * @typedef {object} PersistedChart
 * @property {number} version See PERSISTED_VERSION
 * @property {string} hash Of the chart logic, the data is only restored for an unchanged chart
 * @property {any} machine Persisted XState snapshot (active states)
 * @property {Record<string, number>} entered Time each active state was entered (ms since 1970)
 * @property {Record<string, any>} locals Values of the local variables
 */

/**
 * A hash over everything which influences the execution, but not e.g. the positions in the editor
 *
 * @param {Chart} chart
 * @returns {string}
 */
function getChartHash(chart) {
    const logic = {
        initial: chart.initial,
        symbols: chart.symbols,
        // comments and notes are only documentation
        states: chart.states.map(({ x: _x, y: _y, width: _w, height: _h, comment: _c, ...state }) => state),
        transitions: chart.transitions.map(
            ({ sourceHandle: _s, targetHandle: _t, comment: _c, ...transition }) => transition,
        ),
        functions: (chart.functions || []).map(fn => fn.code),
    };
    return crypto.createHash("sha1").update(JSON.stringify(logic)).digest("hex");
}

/**
 * @typedef {import("./chart-model").Chart} Chart
 * @typedef {import("./chart-model").ChartState} ChartState
 * @typedef {import("./chart-model").ChartTransition} ChartTransition
 */

/**
 * The connection of a chart to the outside world, provided by the adapter
 *
 * @typedef {object} RuntimeHost
 * @property {(stateId: string) => Promise<any>} readState Reads the current value of a state
 * @property {(stateId: string, val: any) => Promise<void>} writeState Writes the value of an output
 * @property {(active: { names: string; ids: string[] }) => void} onActiveChange Called when the active states change
 * @property {(data: PersistedChart) => void} [persist] Stores the state of the chart, called when it changes
 * @property {() => Promise<PersistedChart | null>} [loadPersisted] Loads the stored state of the chart
 * @property {Pick<ioBroker.Logger, "debug" | "info" | "warn" | "error">} log
 */

/**
 * A transition which is checked on wakeups
 *
 * @typedef {object} CheckedTransition
 * @property {string} id
 * @property {string} source ID of the source state
 * @property {string} where Used in error messages
 * @property {string} [event] Name of the input which must have caused the wakeup
 * @property {number} [afterMs] Temporal transition: only valid this long after entering the source state
 * @property {import("node:vm").Script | null} condition
 */

/**
 * Executes a single chart with XState.
 *
 * Wakeup semantics like Stateflow: every change of an input wakes up the chart once, as well as every
 * expiring after(...) of an active state. Transitions with event are only checked when that input changed,
 * all others on every wakeup. A temporal transition after(n, unit) is valid from n units after entering its
 * source state on, so its condition is checked again on every following wakeup.
 *
 * Starting with the active top level state, each active state is processed like this:
 * 1. its outer transitions, 2. its "during" action, 3. its inner transitions (to its own children),
 * 4. its active child. Processing stops as soon as a transition is taken.
 *
 * The runtime selects the transition itself and sends an event for exactly this transition to XState,
 * which executes the exit, transition and entry actions in the right order.
 */
class ChartRuntime {
    /**
     * @param {string} chartId
     * @param {Chart} chart
     * @param {RuntimeHost} host
     */
    constructor(chartId, chart, host) {
        this.chartId = chartId;
        this.chart = chart;
        this.host = host;
        this.structure = new ChartStructure(chart);
        /** @type {Map<string, ChartState>} */
        this.statesById = this.structure.statesById;
        /** values of all symbols, this is also the global scope of conditions and actions */
        this.sandbox = vm.createContext({
            log: (/** @type {any} */ msg) => host.log.info(`[${chart.name}] ${msg}`),
        });
        /** last value written to (or read from) each output */
        this.outputValues = new Map();
        /** @type {Map<string, CheckedTransition[]>} transitions which leave the source state, by source, sorted */
        this.outerTransitions = new Map();
        /** @type {Map<string, CheckedTransition[]>} transitions to children of the source state, by source, sorted */
        this.innerTransitions = new Map();
        /** @type {Map<string, CheckedTransition[]>} temporal transitions by source */
        this.temporalTransitions = new Map();
        /** @type {string[]} all active states, parents before children */
        this.activeIds = [];
        /** @type {Map<string, number>} time each active state was entered */
        this.enteredAt = new Map();
        /** @type {Map<string, { handle?: NodeJS.Timeout }[]>} timers of the temporal transitions by state */
        this.timers = new Map();
        /** @type {Set<string>} temporal transitions whose time has come */
        this.expired = new Set();
        /** JSON of the last persisted data, to persist only changes */
        this.lastPersisted = "";
        this.hash = getChartHash(chart);
        /** @type {import("xstate").AnyActor | null} */
        this.actor = null;
        /** the current time, can be replaced in tests */
        this.now = () => Date.now();
    }

    /**
     * IDs of all states this chart reads
     *
     * @returns {string[]}
     */
    get inputStateIds() {
        return this.chart.symbols
            .filter(s => s.scope === "input" && s.stateId)
            .map(s => /** @type {string} */ (s.stateId));
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.restore] Continue with the persisted state, if the chart was not changed since
     */
    async start(options = {}) {
        this.logProblems();
        for (const symbol of this.chart.symbols) {
            if (symbol.scope === "local") {
                // a copy, so actions changing an object or array do not change the chart model
                this.sandbox[symbol.name] = structuredClone(symbol.initial);
            } else if (symbol.stateId) {
                const val = await this.host.readState(symbol.stateId);
                this.sandbox[symbol.name] = val;
                if (symbol.scope === "output") {
                    this.outputValues.set(symbol.name, val);
                }
            }
        }

        // defines the functions, without block around the code so they become globals of the sandbox
        for (const fn of this.chart.functions || []) {
            const where = `function block ${getDeclarations(fn.code)
                .map(d => d.name)
                .join(", ")}`;
            this.run(this.compile(fn.code, where), where);
        }
        this.writeChangedOutputs();

        const machine = createMachine(this.buildMachineConfig());
        const persisted = options.restore && this.chart.restoreState !== false ? await this.loadPersisted() : null;
        if (persisted) {
            try {
                this.restore(machine, persisted);
                this.host.log.info(`[${this.chart.name}] Restored the state from before the restart`);
            } catch (err) {
                this.host.log.warn(`[${this.chart.name}] Cannot restore the state, starting anew: ${err.message}`);
                this.stop();
                this.startActor(machine);
            }
        } else {
            this.startActor(machine);
        }
        this.persist();
    }

    /**
     * Starts the chart in its initial state, the entry actions are executed
     *
     * @param {import("xstate").AnyStateMachine} machine
     */
    startActor(machine) {
        this.activeIds = [];
        this.enteredAt.clear();
        this.actor = createActor(machine);
        this.subscribe();
        this.actor.start();
    }

    /**
     * Continues with a persisted state: the entry actions are not executed again,
     * the timers of the temporal transitions continue with their remaining time
     *
     * @param {import("xstate").AnyStateMachine} machine
     * @param {PersistedChart} persisted
     */
    restore(machine, persisted) {
        for (const symbol of this.chart.symbols) {
            if (symbol.scope === "local" && symbol.name in persisted.locals) {
                this.sandbox[symbol.name] = persisted.locals[symbol.name];
            }
        }
        this.actor = createActor(machine, { snapshot: persisted.machine });
        this.subscribe();
        this.actor.start();
        this.publishActiveStates(this.actor.getSnapshot().value);
        for (const id of this.activeIds) {
            this.enteredAt.set(id, persisted.entered[id] ?? this.now());
            this.startTimers(id);
        }
    }

    subscribe() {
        this.actor?.subscribe({
            next: snapshot => this.publishActiveStates(snapshot.value),
            error: err => this.host.log.error(`[${this.chart.name}] ${err}`),
        });
    }

    /**
     * @returns {Promise<PersistedChart | null>} the persisted data, if it fits to this chart
     */
    async loadPersisted() {
        let persisted;
        try {
            persisted = await this.host.loadPersisted?.();
        } catch (err) {
            this.host.log.warn(`[${this.chart.name}] Cannot load the stored state: ${err.message}`);
            return null;
        }
        if (!persisted?.machine || persisted.version !== PERSISTED_VERSION) {
            return null;
        }
        if (persisted.hash !== this.hash) {
            this.host.log.info(`[${this.chart.name}] The chart was changed, starting in the initial state`);
            return null;
        }
        return { ...persisted, entered: persisted.entered || {}, locals: persisted.locals || {} };
    }

    /**
     * Stores the current state of the chart, if it changed since the last time
     */
    persist() {
        if (!this.actor || !this.host.persist) {
            return;
        }
        /** @type {PersistedChart} */
        const data = {
            version: PERSISTED_VERSION,
            hash: this.hash,
            machine: this.actor.getPersistedSnapshot(),
            entered: Object.fromEntries(this.enteredAt),
            locals: Object.fromEntries(
                this.chart.symbols.filter(s => s.scope === "local").map(s => [s.name, this.sandbox[s.name]]),
            ),
        };
        let json;
        try {
            json = JSON.stringify(data);
        } catch (err) {
            this.host.log.warn(`[${this.chart.name}] Cannot store the state: ${err.message}`);
            return;
        }
        if (json !== this.lastPersisted) {
            this.lastPersisted = json;
            this.host.persist(data);
        }
    }

    /**
     * Called by XState before the entry action of a state
     *
     * @param {string} id
     */
    onEnter(id) {
        this.enteredAt.set(id, this.now());
        this.startTimers(id);
    }

    /**
     * Called by XState after the exit action of a state
     *
     * @param {string} id
     */
    onExit(id) {
        this.enteredAt.delete(id);
        for (const timer of this.timers.get(id) || []) {
            clearTimeout(timer.handle);
        }
        this.timers.delete(id);
        for (const transition of this.temporalTransitions.get(id) || []) {
            this.expired.delete(transition.id);
        }
    }

    /**
     * Starts a timer for every temporal transition of a state, which wakes up the chart when its time has come
     *
     * @param {string} id
     */
    startTimers(id) {
        const entered = this.enteredAt.get(id) ?? this.now();
        const timers = [];
        for (const transition of this.temporalTransitions.get(id) || []) {
            const timer = {};
            const due = entered + /** @type {number} */ (transition.afterMs);
            const wait = () => {
                const remaining = due - this.now();
                timer.handle = setTimeout(
                    () => {
                        if (due - this.now() > 0 && remaining > MAX_TIMEOUT_MS) {
                            wait();
                            return;
                        }
                        this.expired.add(transition.id);
                        this.wakeup(null);
                    },
                    Math.min(Math.max(remaining, 0), MAX_TIMEOUT_MS),
                );
            };
            wait();
            timers.push(timer);
        }
        this.timers.set(id, timers);
    }

    /**
     * Logs the problems found by the validation, the chart is started anyway
     */
    logProblems() {
        for (const { kind, id, field, diagnostic } of validateChart(this.chart)) {
            let where;
            if (kind === "state") {
                where = `${this.statesById.get(id)?.name ?? id}/${field}`;
            } else if (kind === "function") {
                const fn = this.chart.functions?.find(f => f.id === id);
                where = `Function block ${getDeclarations(fn?.code)
                    .map(d => d.name)
                    .join(", ")}`;
            } else {
                const transition = this.chart.transitions.find(t => t.id === id);
                const source = this.statesById.get(transition?.source ?? "")?.name;
                const target = this.statesById.get(transition?.target ?? "")?.name;
                where = `Transition ${source} -> ${target}`;
            }
            const log = diagnostic.severity === "error" ? this.host.log.error : this.host.log.warn;
            log(`[${this.chart.name}] ${where}: ${diagnostic.message}`);
        }
    }

    stop() {
        this.actor?.stop();
        this.actor = null;
        for (const timers of this.timers.values()) {
            for (const timer of timers) {
                clearTimeout(timer.handle);
            }
        }
        this.timers.clear();
        this.expired.clear();
    }

    /**
     * Must be called when an input state changes
     *
     * @param {string} stateId
     * @param {any} val
     */
    handleInput(stateId, val) {
        if (!this.actor) {
            return;
        }
        for (const symbol of this.chart.symbols) {
            if (symbol.scope === "input" && symbol.stateId === stateId) {
                this.sandbox[symbol.name] = val;
                this.wakeup(symbol.name);
            }
        }
    }

    /**
     * @param {string | null} input Name of the input which caused the wakeup, null for timers
     */
    wakeup(input) {
        if (!this.actor) {
            return;
        }
        for (const id of this.getActiveChildren(null)) {
            if (this.processState(id, input)) {
                break;
            }
        }
        // functions called in conditions may have changed outputs as well
        this.writeChangedOutputs();
        this.persist();
    }

    /**
     * Processes an active state and its active children, see the class description
     *
     * @param {string} id
     * @param {string | null} input Name of the input which caused the wakeup, null for timers
     * @returns {boolean} true if a transition was taken
     */
    processState(id, input) {
        if (this.takeFirstValid(this.outerTransitions.get(id), input)) {
            return true;
        }
        const state = this.statesById.get(id);
        if (state?.during) {
            this.runAction(state.during, `${state.name}/during`);
        }
        if (this.takeFirstValid(this.innerTransitions.get(id), input)) {
            return true;
        }
        for (const child of this.getActiveChildren(id)) {
            if (this.processState(child, input)) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param {string | null} parent null for the top level
     * @returns {string[]}
     */
    getActiveChildren(parent) {
        const children = new Set(this.structure.getChildren(parent).map(s => s.id));
        return this.activeIds.filter(id => children.has(id));
    }

    /**
     * Takes the first transition whose event and condition match
     *
     * @param {CheckedTransition[] | undefined} transitions
     * @param {string | null} input Name of the input which caused the wakeup, null for timers
     * @returns {boolean} true if a transition was taken
     */
    takeFirstValid(transitions, input) {
        for (const transition of transitions || []) {
            if (transition.event && transition.event !== input) {
                continue;
            }
            if (transition.afterMs !== undefined && !this.isExpired(transition)) {
                continue;
            }
            if (transition.condition && !this.run(transition.condition, `${transition.where}/condition`)) {
                continue;
            }
            this.actor?.send({ type: `T.${transition.id}` });
            return true;
        }
        return false;
    }

    /**
     * @param {CheckedTransition} transition A temporal transition
     * @returns {boolean} true if its source state is active for at least its delay
     */
    isExpired(transition) {
        if (this.expired.has(transition.id)) {
            return true;
        }
        const entered = this.enteredAt.get(transition.source);
        return entered !== undefined && this.now() - entered >= /** @type {number} */ (transition.afterMs);
    }

    buildMachineConfig() {
        const structure = this.structure;

        /**
         * @param {ChartState} state
         * @returns {any}
         */
        const buildState = state => {
            /** @type {any} */
            const node = {
                id: state.id,
                entry: [
                    () => this.onEnter(state.id),
                    ...(state.entry ? [() => this.runAction(state.entry, `${state.name}/entry`)] : []),
                ],
                exit: [
                    ...(state.exit ? [() => this.runAction(state.exit, `${state.name}/exit`)] : []),
                    () => this.onExit(state.id),
                ],
                on: {},
            };

            /** @type {CheckedTransition[]} */
            const outer = [];
            /** @type {CheckedTransition[]} */
            const inner = [];
            for (const transition of structure.getTransitions(state.id)) {
                const built = this.buildTransition(transition, state);
                if (!built) {
                    continue;
                }
                // all transitions are selected by processState(), XState only executes them
                node.on[`T.${transition.id}`] = built.config;
                (built.inner ? inner : outer).push(built.checked);
            }
            this.outerTransitions.set(state.id, outer);
            this.innerTransitions.set(state.id, inner);
            this.temporalTransitions.set(
                state.id,
                [...outer, ...inner].filter(t => t.afterMs !== undefined),
            );

            const subStates = structure.getChildren(state.id);
            if (subStates.length) {
                node.initial = structure.getInitialChild(state.id);
                node.states = Object.fromEntries(subStates.map(s => [s.id, buildState(s)]));
            }
            return node;
        };

        const topLevel = structure.getChildren(null);
        if (!topLevel.length) {
            throw new Error("The chart has no states");
        }
        return {
            id: `chart_${this.chartId}`,
            initial: structure.getInitialChild(null),
            states: Object.fromEntries(topLevel.map(s => [s.id, buildState(s)])),
        };
    }

    /**
     * @param {ChartTransition} transition
     * @param {ChartState} source
     * @returns {{ inner: boolean; config: any; checked: CheckedTransition } | null}
     */
    buildTransition(transition, source) {
        const target = this.statesById.get(transition.target);
        const where = `${source.name} -> ${target?.name ?? transition.target}`;
        if (!target) {
            this.host.log.warn(`[${this.chart.name}] Transition ${where}: unknown target, ignored`);
            return null;
        }

        let label;
        try {
            label = parseTransitionLabel(transition.label);
        } catch (err) {
            this.host.log.error(`[${this.chart.name}] Transition ${where}: ${err.message}, ignored`);
            return null;
        }

        const condition = label.condition ? this.compile(`(${label.condition})`, `${where}/condition`) : null;
        const { inner, reenter } = this.structure.getTransitionKind(transition);
        const config = {
            target: `#${target.id}`,
            reenter,
            actions: label.action ? [() => this.runAction(label.action, `${where}/action`)] : [],
        };
        return {
            inner,
            config,
            checked: {
                id: transition.id,
                source: source.id,
                where,
                event: label.event,
                afterMs: label.afterMs,
                condition,
            },
        };
    }

    /**
     * @param {string} code
     * @param {string} where Used in error messages
     * @returns {vm.Script | null}
     */
    compile(code, where) {
        try {
            return new vm.Script(code, { filename: `${this.chart.name}/${where}` });
        } catch (err) {
            this.host.log.error(`[${this.chart.name}] ${where}: ${err.message}`);
            return null;
        }
    }

    /**
     * @param {vm.Script | null} script
     * @param {string} where Used in error messages
     * @returns {any}
     */
    run(script, where) {
        if (!script) {
            return undefined;
        }
        try {
            return script.runInContext(this.sandbox, { timeout: SCRIPT_TIMEOUT_MS });
        } catch (err) {
            this.host.log.warn(`[${this.chart.name}] ${where}: ${err.message}`);
            return undefined;
        }
    }

    /**
     * Executes an action and writes all changed outputs
     *
     * @param {string | undefined} code
     * @param {string} where Used in error messages
     */
    runAction(code, where) {
        // the block keeps "let" and "const" declarations local to this action
        this.run(this.compile(`{\n${code}\n}`, where), where);
        this.writeChangedOutputs();
    }

    writeChangedOutputs() {
        for (const symbol of this.chart.symbols) {
            if (symbol.scope !== "output" || !symbol.stateId) {
                continue;
            }
            const val = this.sandbox[symbol.name];
            if (val !== this.outputValues.get(symbol.name)) {
                this.outputValues.set(symbol.name, val);
                this.host
                    .writeState(symbol.stateId, val)
                    .catch(err => this.host.log.warn(`[${this.chart.name}] Cannot write ${symbol.stateId}: ${err}`));
            }
        }
    }

    /**
     * @param {any} value XState state value
     */
    publishActiveStates(value) {
        /** @type {string[]} all active states, parents before children */
        const ids = [];
        /** @type {string[]} name paths of the active leaf states */
        const names = [];

        /**
         * @param {any} val
         * @param {string[]} path
         */
        const walk = (val, path) => {
            const keys = typeof val === "string" ? [val] : Object.keys(val || {});
            for (const key of keys) {
                const name = [...path, this.statesById.get(key)?.name ?? key];
                ids.push(key);
                if (typeof val === "string" || !val[key] || !Object.keys(val[key]).length) {
                    names.push(name.join("."));
                } else {
                    walk(val[key], name);
                }
            }
        };
        walk(value, []);

        if (ids.join() !== this.activeIds.join()) {
            this.activeIds = ids;
            this.host.onActiveChange({ names: names.join(", "), ids });
        }
    }
}

module.exports = { ChartRuntime, getChartHash };
