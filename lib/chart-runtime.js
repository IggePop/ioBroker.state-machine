"use strict";

const vm = require("node:vm");
const { createActor, createMachine } = require("xstate");
const { parseTransitionLabel } = require("./chart-model");
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
 * Executes a single chart with XState.
 *
 * Wakeup semantics: every change of an input sends one WAKEUP event. Transitions without event
 * are checked on every wakeup, transitions with event only when that input changed.
 * If no transition is taken, the "during" actions of all active states are executed.
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
        /** @type {Map<string, ChartState>} */
        this.statesById = new Map(chart.states.map(s => [s.id, s]));
        /** values of all symbols, this is also the global scope of conditions and actions */
        this.sandbox = vm.createContext({
            log: (/** @type {any} */ msg) => host.log.info(`[${chart.name}] ${msg}`),
        });
        /** last value written to (or read from) each output */
        this.outputValues = new Map();
        /** set by every transition, used to decide if "during" actions must run */
        this.transitionTaken = false;
        /** @type {string[]} */
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
                this.sandbox[symbol.name] = symbol.initial;
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
        this.transitionTaken = false;
        this.actor?.send(/** @type {import("xstate").AnyEventObject} */ ({ type: "WAKEUP", input }));
        if (!this.transitionTaken) {
            // outer states first, like Stateflow
            for (const id of this.activeIds) {
                const state = this.statesById.get(id);
                if (state?.during) {
                    this.runAction(state.during, `${state.name}/during`);
                }
            }
        }
        // functions called in conditions may have changed outputs as well
        this.writeChangedOutputs();
    }

    buildMachineConfig() {
        /** @type {Map<string, ChartState[]>} */
        const children = new Map();
        for (const state of this.chart.states) {
            const parent = state.parent || "";
            children.set(parent, [...(children.get(parent) || []), state]);
        }
        /** @type {Map<string, ChartTransition[]>} */
        const transitions = new Map();
        for (const transition of this.chart.transitions) {
            transitions.set(transition.source, [...(transitions.get(transition.source) || []), transition]);
        }

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
                on: { WAKEUP: [] },
                after: {},
            };

            const sorted = [...(transitions.get(state.id) || [])].sort(
                (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
            );
            for (const transition of sorted) {
                const built = this.buildTransition(transition, state);
                if (!built) {
                    continue;
                }
                if (built.afterMs !== undefined) {
                    node.after[built.afterMs] = [...(node.after[built.afterMs] || []), built.config];
                } else {
                    node.on.WAKEUP.push(built.config);
                }
            }

            const subStates = children.get(state.id);
            if (subStates?.length) {
                node.initial = state.initial && this.statesById.has(state.initial) ? state.initial : subStates[0].id;
                node.states = Object.fromEntries(subStates.map(s => [s.id, buildState(s)]));
            }
            return node;
        };

        const topLevel = children.get("") || [];
        if (!topLevel.length) {
            throw new Error("The chart has no states");
        }
        return {
            id: `chart_${this.chartId}`,
            initial:
                this.chart.initial && this.statesById.has(this.chart.initial) ? this.chart.initial : topLevel[0].id,
            states: Object.fromEntries(topLevel.map(s => [s.id, buildState(s)])),
        };
    }

    /**
     * @param {ChartTransition} transition
     * @param {ChartState} source
     * @returns {{ afterMs?: number; config: any } | null}
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
        const config = {
            target: `#${target.id}`,
            // a self transition leaves and enters the state again, like Stateflow
            reenter: source.id === target.id,
            guard: (/** @type {{ event: any }} */ { event }) => {
                if (label.event && event.input !== label.event) {
                    return false;
                }
                return !condition || !!this.run(condition, `${where}/condition`);
            },
            actions: [
                () => {
                    this.transitionTaken = true;
                    if (label.action) {
                        this.runAction(label.action, `${where}/action`);
                    }
                },
            ],
        };
        return { afterMs: label.afterMs, config };
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
