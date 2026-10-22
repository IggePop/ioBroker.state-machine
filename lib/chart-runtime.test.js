"use strict";

const { expect } = require("chai");
const { ChartRuntime } = require("./chart-runtime");

/**
 * Creates a host which keeps the states in memory
 *
 * @param {Record<string, any>} [states]
 */
function createHost(states = {}) {
    const host = {
        states: { ...states },
        /** @type {string[]} */
        active: [],
        /** @type {string[]} */
        warnings: [],
        readState: async (/** @type {string} */ id) => host.states[id],
        writeState: async (/** @type {string} */ id, /** @type {any} */ val) => {
            host.states[id] = val;
        },
        onActiveChange: (/** @type {{ names: string }} */ active) => host.active.push(active.names),
        log: {
            debug: () => {},
            info: () => {},
            warn: (/** @type {string} */ msg) => host.warnings.push(msg),
            error: (/** @type {string} */ msg) => host.warnings.push(msg),
        },
    };
    return host;
}

/**
 * A simple light switch: off -> on on motion, back to off after 50 ms without motion
 *
 * @returns {import("./chart-model").Chart}
 */
function createLightChart() {
    return {
        version: 1,
        name: "Light",
        enabled: true,
        initial: "off",
        symbols: [
            { name: "motion", scope: "input", stateId: "test.0.motion" },
            { name: "light", scope: "output", stateId: "test.0.light" },
            { name: "count", scope: "local", initial: 0 },
        ],
        states: [
            { id: "off", name: "Off", entry: "light = false;", x: 0, y: 0 },
            { id: "on", name: "On", entry: "light = true; count++;", x: 0, y: 0 },
        ],
        transitions: [
            { id: "t1", source: "off", target: "on", label: "motion[motion == true]" },
            { id: "t2", source: "on", target: "off", label: "after(50, msec)[!motion]" },
        ],
    };
}

const wait = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

describe("chart-runtime => ChartRuntime", () => {
    /** @type {ChartRuntime | undefined} */
    let runtime;
    afterEach(() => runtime?.stop());

    it("enters the initial state and executes its entry action", async () => {
        const host = createHost({ "test.0.light": true });
        runtime = new ChartRuntime("light", createLightChart(), host);
        await runtime.start();
        expect(host.active).to.deep.equal(["Off"]);
        expect(host.states["test.0.light"]).to.equal(false);
    });

    it("takes transitions on input changes and writes outputs", async () => {
        const host = createHost({ "test.0.motion": false, "test.0.light": false });
        runtime = new ChartRuntime("light", createLightChart(), host);
        await runtime.start();
        runtime.handleInput("test.0.motion", true);
        expect(host.active).to.deep.equal(["Off", "On"]);
        expect(host.states["test.0.light"]).to.equal(true);
        expect(runtime.sandbox.count).to.equal(1);
    });

    it("executes temporal transitions", async () => {
        const host = createHost({ "test.0.motion": false });
        runtime = new ChartRuntime("light", createLightChart(), host);
        await runtime.start();
        runtime.handleInput("test.0.motion", true);
        runtime.handleInput("test.0.motion", false);
        await wait(100);
        expect(host.active).to.deep.equal(["Off", "On", "Off"]);
        expect(host.states["test.0.light"]).to.equal(false);
    });

    it("executes during actions if no transition is taken", async () => {
        const chart = createLightChart();
        chart.states[0].during = "count += 10;";
        const host = createHost({ "test.0.motion": false });
        runtime = new ChartRuntime("light", chart, host);
        await runtime.start();
        runtime.handleInput("test.0.motion", false);
        expect(runtime.sandbox.count).to.equal(10);
        runtime.handleInput("test.0.motion", true);
        expect(runtime.sandbox.count).to.equal(1 + 10);
    });

    it("re-enters the state on self transitions", async () => {
        const chart = createLightChart();
        chart.transitions.push({ id: "t3", source: "on", target: "on", label: "motion[motion]" });
        const host = createHost({ "test.0.motion": false });
        runtime = new ChartRuntime("light", chart, host);
        await runtime.start();
        runtime.handleInput("test.0.motion", true);
        runtime.handleInput("test.0.motion", true);
        expect(runtime.sandbox.count).to.equal(2);
    });

    it("supports nested states", async () => {
        const chart = createLightChart();
        chart.states[1].initial = "dim";
        chart.states.push(
            { id: "dim", name: "Dim", parent: "on", x: 0, y: 0 },
            { id: "bright", name: "Bright", parent: "on", x: 0, y: 0 },
        );
        chart.transitions.push({ id: "t3", source: "dim", target: "bright", label: "after(10, msec)" });
        const host = createHost({ "test.0.motion": false });
        runtime = new ChartRuntime("light", chart, host);
        await runtime.start();
        runtime.handleInput("test.0.motion", true);
        expect(host.active.at(-1)).to.equal("On.Dim");
        await wait(30);
        expect(host.active.at(-1)).to.equal("On.Bright");
    });

    it("logs errors in conditions instead of crashing", async () => {
        const chart = createLightChart();
        chart.transitions[0].label = "[unknownVariable > 1]";
        const host = createHost();
        runtime = new ChartRuntime("light", chart, host);
        await runtime.start();
        runtime.handleInput("test.0.motion", true);
        expect(host.active).to.deep.equal(["Off"]);
        expect(host.warnings.join()).to.match(/unknownVariable is not defined/);
    });

    it("keeps let declarations local to each action", async () => {
        const chart = createLightChart();
        chart.states[0].entry = "let x = 1; light = x == 1;";
        chart.states[1].entry = "let x = 2; light = x == 2;";
        const host = createHost();
        runtime = new ChartRuntime("light", chart, host);
        await runtime.start();
        runtime.handleInput("test.0.motion", true);
        expect(host.warnings).to.deep.equal([]);
        expect(host.states["test.0.light"]).to.equal(true);
    });

    it("provides the functions of function blocks to conditions and actions", async () => {
        const chart = createLightChart();
        chart.functions = [
            {
                id: "f1",
                code: "const LIMIT = 2;\nfunction allowed() { return count < LIMIT; }\nfunction switchOn() { light = true; count++; }",
                x: 0,
                y: 0,
            },
        ];
        chart.states[1].entry = "switchOn();";
        chart.transitions[0].label = "motion[motion && allowed()]";
        chart.transitions[1].label = "motion[!motion]";
        const host = createHost({ "test.0.motion": false });
        runtime = new ChartRuntime("light", chart, host);
        await runtime.start();
        for (let i = 0; i < 3; i++) {
            runtime.handleInput("test.0.motion", true);
            runtime.handleInput("test.0.motion", false);
        }
        expect(host.warnings).to.deep.equal([]);
        // the third switch on is not allowed anymore
        expect(runtime.sandbox.count).to.equal(2);
        expect(host.active).to.deep.equal(["Off", "On", "Off", "On", "Off"]);
    });
});

/**
 * A heating control with a super state: Auto (with the children Idle and Heat) and Manual.
 * All actions write to "trace", so the tests can check the order of execution.
 *
 * @returns {import("./chart-model").Chart}
 */
function createHeatingChart() {
    /**
     * @param {string} id
     * @param {string} name
     * @param {string | null} parent
     */
    const state = (id, name, parent) => ({
        id,
        name,
        parent,
        entry: `trace.push("${name}/entry");`,
        during: `trace.push("${name}/during");`,
        exit: `trace.push("${name}/exit");`,
        x: 0,
        y: 0,
    });
    return {
        version: 1,
        name: "Heating",
        enabled: true,
        initial: "auto",
        symbols: [
            { name: "temp", scope: "input", stateId: "test.0.temp" },
            { name: "manual", scope: "input", stateId: "test.0.manual" },
            { name: "reset", scope: "input", stateId: "test.0.reset" },
            { name: "trace", scope: "local", initial: [] },
        ],
        states: [
            { ...state("auto", "Auto", null), initial: "idle" },
            state("idle", "Idle", "auto"),
            state("heat", "Heat", "auto"),
            state("manualState", "Manual", null),
        ],
        transitions: [
            { id: "toManual", source: "auto", target: "manualState", label: "[manual]" },
            { id: "toAuto", source: "manualState", target: "auto", label: "[!manual]" },
            { id: "startHeating", source: "idle", target: "heat", label: "[temp < 20]" },
            { id: "stopHeating", source: "heat", target: "idle", label: "[temp > 22]" },
        ],
    };
}

describe("chart-runtime => nested states (Stateflow semantics)", () => {
    /** @type {ChartRuntime | undefined} */
    let runtime;
    afterEach(() => runtime?.stop());

    /**
     * @param {import("./chart-model").Chart} chart
     * @param {Record<string, any>} states
     */
    async function start(chart, states) {
        const host = createHost(states);
        runtime = new ChartRuntime("heating", chart, host);
        await runtime.start();
        return host;
    }

    it("enters parents before children and leaves children before parents", async () => {
        const host = await start(createHeatingChart(), { "test.0.temp": 18, "test.0.manual": false });
        expect(runtime?.sandbox.trace).to.deep.equal(["Auto/entry", "Idle/entry"]);
        runtime?.sandbox.trace.splice(0);
        runtime?.handleInput("test.0.manual", true);
        expect(runtime?.sandbox.trace).to.deep.equal(["Idle/exit", "Auto/exit", "Manual/entry"]);
        expect(host.active.at(-1)).to.equal("Manual");
    });

    it("checks the transitions of the parent before those of the child", async () => {
        const host = await start(createHeatingChart(), { "test.0.temp": 18, "test.0.manual": true });
        // both transitions are valid now: Auto -> Manual and Idle -> Heat
        runtime?.handleInput("test.0.temp", 18);
        expect(host.active).to.deep.equal(["Auto.Idle", "Manual"]);
    });

    it("executes the during action of the parent before the child is processed", async () => {
        const host = await start(createHeatingChart(), { "test.0.temp": 21, "test.0.manual": false });
        runtime?.sandbox.trace.splice(0);
        // no transition: during of parent and child
        runtime?.handleInput("test.0.temp", 21);
        expect(runtime?.sandbox.trace).to.deep.equal(["Auto/during", "Idle/during"]);
        runtime?.sandbox.trace.splice(0);
        // transition of the child: the parent's during is executed, the child's not
        runtime?.handleInput("test.0.temp", 18);
        expect(runtime?.sandbox.trace).to.deep.equal(["Auto/during", "Idle/exit", "Heat/entry"]);
        expect(host.active.at(-1)).to.equal("Auto.Heat");
    });

    it("keeps the parent active on inner transitions", async () => {
        const chart = createHeatingChart();
        chart.transitions.push({ id: "restart", source: "auto", target: "idle", label: "reset[reset]" });
        const host = await start(chart, { "test.0.temp": 18, "test.0.manual": false, "test.0.reset": false });
        runtime?.handleInput("test.0.temp", 18);
        expect(host.active.at(-1)).to.equal("Auto.Heat");
        runtime?.sandbox.trace.splice(0);
        runtime?.handleInput("test.0.reset", true);
        // inner transitions are checked after the during action of the parent
        expect(runtime?.sandbox.trace).to.deep.equal(["Auto/during", "Heat/exit", "Idle/entry"]);
        expect(host.active.at(-1)).to.equal("Auto.Idle");
    });

    it("leaves and enters the parent again if requested", async () => {
        const chart = createHeatingChart();
        chart.transitions.push({
            id: "restart",
            source: "auto",
            target: "idle",
            label: "reset[reset]",
            reenterParent: true,
        });
        await start(chart, { "test.0.temp": 18, "test.0.manual": false, "test.0.reset": false });
        runtime?.handleInput("test.0.temp", 18);
        runtime?.sandbox.trace.splice(0);
        runtime?.handleInput("test.0.reset", true);
        // an outer transition: checked before the during action, the parent is left
        expect(runtime?.sandbox.trace).to.deep.equal(["Heat/exit", "Auto/exit", "Auto/entry", "Idle/entry"]);
    });

    it("leaves and enters the parent on transitions from a child to the parent", async () => {
        const chart = createHeatingChart();
        chart.transitions.push({ id: "up", source: "heat", target: "auto", label: "reset[reset]" });
        const host = await start(chart, { "test.0.temp": 18, "test.0.manual": false, "test.0.reset": false });
        runtime?.handleInput("test.0.temp", 18);
        runtime?.sandbox.trace.splice(0);
        runtime?.handleInput("test.0.reset", true);
        expect(runtime?.sandbox.trace).to.deep.equal([
            "Auto/during",
            "Heat/exit",
            "Auto/exit",
            "Auto/entry",
            "Idle/entry",
        ]);
        expect(host.active.at(-1)).to.equal("Auto.Idle");
    });

    it("uses the first child if the initial state is no child (anymore)", async () => {
        const chart = createHeatingChart();
        // e.g. "idle" was the initial state and was moved out of "auto" in the editor
        chart.states[0].initial = "manualState";
        chart.initial = "heat";
        const host = await start(chart, { "test.0.temp": 21, "test.0.manual": false });
        expect(host.active).to.deep.equal(["Auto.Idle"]);
    });

    it("does not change the initial values of locals in the chart model", async () => {
        const chart = createHeatingChart();
        await start(chart, { "test.0.temp": 18, "test.0.manual": false });
        expect(chart.symbols.find(s => s.name === "trace")?.initial).to.deep.equal([]);
    });
});
