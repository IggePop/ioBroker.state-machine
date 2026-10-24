"use strict";

const vm = require("node:vm");
const { createActor, createMachine } = require("xstate");
const { parseTransitionLabel } = require("./chart-model");
const { ChartStructure } = require("./chart-structure");
const { getDeclarations, validateChart } = require("./chart-validation");

/** Maximum run time of a single condition or action */
const SCRIPT_TIMEOUT_MS = 1000;

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
 * @property {Pick<ioBroker.Logger, "debug" | "info" | "warn" | "error">} log
 */

/**
 * A transition which is checked on wakeups (temporal transitions are handled by XState timers)
 *
 * @typedef {object} CheckedTransition
 * @property {string} id
 * @property {string} where Used in error messages
 * @property {string} [event] Name of the input which must have caused the wakeup
 * @property {import("node:vm").Script | null} condition
 */

/**
 * Executes a single chart with XState.
 *
 * Wakeup semantics like Stateflow: every change of an input wakes up the chart once. Transitions
 * without event are checked on every wakeup, transitions with event only when that input changed.
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
        /** @type {string[]} all active states, parents before children */
        this.activeIds = [];
        /** @type {import("xstate").AnyActor | null} */
        this.actor = null;
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

    async start() {
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
        this.actor = createActor(machine);
        this.actor.subscribe({
            next: snapshot => this.publishActiveStates(snapshot.value),
            error: err => this.host.log.error(`[${this.chart.name}] ${err}`),
        });
        this.actor.start();
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
     * @param {string} input Name of the input which caused the wakeup
     */
    wakeup(input) {
        for (const id of this.getActiveChildren(null)) {
            if (this.processState(id, input)) {
                break;
            }
        }
        // functions called in conditions may have changed outputs as well
        this.writeChangedOutputs();
    }

    /**
     * Processes an active state and its active children, see the class description
     *
     * @param {string} id
     * @param {string} input Name of the input which caused the wakeup
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
     * @param {string} input Name of the input which caused the wakeup
     * @returns {boolean} true if a transition was taken
     */
    takeFirstValid(transitions, input) {
        for (const transition of transitions || []) {
            if (transition.event && transition.event !== input) {
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
                entry: state.entry ? [() => this.runAction(state.entry, `${state.name}/entry`)] : [],
                exit: state.exit ? [() => this.runAction(state.exit, `${state.name}/exit`)] : [],
                on: {},
                after: {},
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
                if (built.afterMs !== undefined) {
                    // temporal transitions are started by XState timers, with the condition as guard
                    node.after[built.afterMs] = [...(node.after[built.afterMs] || []), built.config];
                } else {
                    // all other transitions are selected by processState(), XState only executes them
                    const { guard: _guard, ...config } = built.config;
                    node.on[`T.${transition.id}`] = config;
                    (built.inner ? inner : outer).push(built.checked);
                }
            }
            this.outerTransitions.set(state.id, outer);
            this.innerTransitions.set(state.id, inner);

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
     * @returns {{ afterMs?: number; inner: boolean; config: any; checked: CheckedTransition } | null}
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
            guard: () => !condition || !!this.run(condition, `${where}/condition`),
            actions: label.action ? [() => this.runAction(label.action, `${where}/action`)] : [],
        };
        return {
            afterMs: label.afterMs,
            inner,
            config,
            checked: { id: transition.id, where, event: label.event, condition },
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

module.exports = { ChartRuntime };
