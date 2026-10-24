"use strict";

const { expect } = require("chai");
const { ChartRuntime, getChartHash } = require("./chart-runtime");

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
        /** @type {{ id: string; val: any; ack: boolean | undefined }[]} all writes */
        writes: [],
        writeState: async (
            /** @type {string} */ id,
            /** @type {any} */ val,
            /** @type {boolean | undefined} */ ack,
        ) => {
            host.states[id] = val;
            host.writes.push({ id, val, ack });
        },
        /** @type {any[][]} */
        messages: [],
        sendTo: (/** @type {any[]} */ ...args) => host.messages.push(args),
        /** @type {{ latitude: number; longitude: number } | null} */
        location: null,
        getLocation: () => host.location,
        /** @type {string[]} info and debug messages */
        infos: [],
        onActiveChange: (/** @type {{ names: string }} */ active) => host.active.push(active.names),
        /** @type {import("./chart-runtime").PersistedChart | null} the last persisted data */
        persisted: null,
        persistCount: 0,
        persist: (/** @type {import("./chart-runtime").PersistedChart} */ data) => {
            // a copy like a round trip through a state, so later changes do not change the stored data
            host.persisted = JSON.parse(JSON.stringify(data));
            host.persistCount++;
        },
        loadPersisted: async () => host.persisted,
        log: {
            debug: (/** @type {string} */ msg) => host.infos.push(`debug: ${msg}`),
            info: (/** @type {string} */ msg) => host.infos.push(`info: ${msg}`),
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

describe("chart-runtime => temporal transitions and restoring after a restart", () => {
    /** @type {ChartRuntime[]} */
    const runtimes = [];
    afterEach(() => runtimes.splice(0).forEach(r => r.stop()));

    /**
     * @param {import("./chart-model").Chart} chart
     * @param {ReturnType<typeof createHost>} host
     * @param {boolean} [restore]
     */
    async function start(chart, host, restore = false) {
        const runtime = new ChartRuntime("light", chart, host);
        runtimes.push(runtime);
        await runtime.start({ restore });
        return runtime;
    }

    it("keeps an expired temporal transition valid until its condition is true", async () => {
        const host = createHost({ "test.0.motion": false });
        const runtime = await start(createLightChart(), host);
        runtime.handleInput("test.0.motion", true);
        // after 50 ms there is still motion, so the light stays on ...
        await wait(80);
        expect(host.active.at(-1)).to.equal("On");
        // ... and goes off as soon as the motion stops
        runtime.handleInput("test.0.motion", false);
        expect(host.active.at(-1)).to.equal("Off");
    });

    it("restores the active state and the locals without executing the entry actions again", async () => {
        const host = createHost({ "test.0.motion": false });
        const first = await start(createLightChart(), host);
        first.handleInput("test.0.motion", true);
        expect(first.sandbox.count).to.equal(1);
        first.stop();

        // the adapter was restarted, meanwhile someone switched the light off by hand
        host.states["test.0.light"] = false;
        host.active = [];
        const second = await start(createLightChart(), host, true);
        expect(host.active).to.deep.equal(["On"]);
        expect(second.sandbox.count).to.equal(1, "locals restored, entry not executed again");
        expect(host.states["test.0.light"]).to.equal(false, "outputs are not written again");
    });

    it("continues the timers with their remaining time", async () => {
        const host = createHost({ "test.0.motion": false });
        const first = await start(createLightChart(), host);
        first.handleInput("test.0.motion", true);
        first.handleInput("test.0.motion", false);
        first.stop();

        // "On" was entered 40 ms before the restart, so after(50, msec) expires 10 ms after it
        /** @type {any} */ (host.persisted).entered.on = Date.now() - 40;
        await start(createLightChart(), host, true);
        expect(host.active.at(-1)).to.equal("On");
        await wait(30);
        expect(host.active.at(-1)).to.equal("Off");
    });

    it("takes transitions whose time expired while the adapter was stopped", async () => {
        const host = createHost({ "test.0.motion": false });
        const first = await start(createLightChart(), host);
        first.handleInput("test.0.motion", true);
        first.handleInput("test.0.motion", false);
        first.stop();

        /** @type {any} */ (host.persisted).entered.on = Date.now() - 60_000;
        await start(createLightChart(), host, true);
        await wait(5);
        expect(host.active.at(-1)).to.equal("Off");
    });

    it("starts in the initial state if the chart was changed", async () => {
        const host = createHost({ "test.0.motion": false });
        const first = await start(createLightChart(), host);
        first.handleInput("test.0.motion", true);
        first.stop();

        const changed = createLightChart();
        changed.states[1].entry = "light = true; count += 2;";
        host.active = [];
        const second = await start(changed, host, true);
        expect(host.active).to.deep.equal(["Off"]);
        expect(second.sandbox.count).to.equal(0);
    });

    it("ignores changed positions in the editor", async () => {
        const host = createHost({ "test.0.motion": false });
        const first = await start(createLightChart(), host);
        first.handleInput("test.0.motion", true);
        first.stop();

        const moved = createLightChart();
        moved.states[1].x = 500;
        host.active = [];
        await start(moved, host, true);
        expect(host.active).to.deep.equal(["On"]);
    });

    it("ignores comments and notes for the hash, but not the logic", () => {
        const chart = createLightChart();
        const hash = getChartHash(chart);
        const documented = createLightChart();
        documented.comment = "About the chart";
        documented.states[0].comment = "Light is off";
        documented.transitions[0].comment = "Motion switches it on";
        documented.notes = [{ id: "n1", text: "A note", x: 0, y: 0 }];
        expect(getChartHash(documented)).to.equal(hash);
        documented.transitions[0].label = "motion";
        expect(getChartHash(documented)).not.to.equal(hash);
    });

    it("does not restore if it is not requested or switched off for the chart", async () => {
        const host = createHost({ "test.0.motion": false });
        const first = await start(createLightChart(), host);
        first.handleInput("test.0.motion", true);
        first.stop();
        const persisted = host.persisted;

        host.active = [];
        (await start(createLightChart(), host, false)).stop();
        expect(host.active).to.deep.equal(["Off"]);

        host.persisted = persisted;
        host.active = [];
        const chart = createLightChart();
        chart.restoreState = false;
        await start(chart, host, true);
        expect(host.active).to.deep.equal(["Off"]);
    });

    it("persists only changes", async () => {
        const host = createHost({ "test.0.motion": false });
        const runtime = await start(createLightChart(), host);
        const count = host.persistCount;
        // a wakeup without any change
        runtime.handleInput("test.0.motion", false);
        expect(host.persistCount).to.equal(count);
        runtime.handleInput("test.0.motion", true);
        expect(host.persistCount).to.equal(count + 1);
    });
});

describe("chart-runtime => helper functions", () => {
    /** @type {ChartRuntime | undefined} */
    let runtime;
    afterEach(() => runtime?.stop());

    /**
     * Starts a chart whose initial state executes the given entry action
     *
     * @param {string} entry
     * @param {(host: ReturnType<typeof createHost>) => void} [prepare]
     */
    async function run(entry, prepare) {
        const chart = createLightChart();
        chart.symbols.push({ name: "result", scope: "local", initial: null });
        chart.states[0].entry = entry;
        const host = createHost();
        prepare?.(host);
        runtime = new ChartRuntime("light", chart, host);
        await runtime.start();
        return { host, runtime };
    }

    it("logs with a level", async () => {
        const { host } = await run('log("hello"); log("careful", "warn"); log("details", "debug");');
        expect(host.infos).to.include.members(["info: [Light] hello", "debug: [Light] details"]);
        expect(host.warnings).to.deep.equal(["[Light] careful"]);
    });

    it("writes any state, with ack", async () => {
        const { host } = await run('setState("other.0.x", 5); setState("other.0.y", "a", true);');
        expect(host.writes).to.deep.include({ id: "other.0.x", val: 5, ack: false });
        expect(host.writes).to.deep.include({ id: "other.0.y", val: "a", ack: true });
    });

    it("writes delayed and cancels pending writes when the chart stops", async () => {
        const { host, runtime: r } = await run(
            'setStateDelayed("other.0.x", 1, 20); setStateDelayed("other.0.y", 2, 60);',
        );
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(host.states["other.0.x"]).to.equal(1);
        r.stop();
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(host.states).not.to.have.property("other.0.y");
    });

    it("sends messages to adapters", async () => {
        const { host } = await run('sendTo("telegram.0", "send", { text: "Hello" });');
        expect(host.messages).to.deep.equal([["telegram.0", "send", { text: "Hello" }]]);
    });

    it("checks time ranges", async () => {
        const { runtime: r } = await run('result = isTimeBetween("00:00", "23:59:59");');
        expect(r.sandbox.result).to.equal(true);
    });

    it("calculates astro times at the configured location", async () => {
        const { runtime: r } = await run(
            'const sunrise = astroTime("sunrise"); result = [sunrise.getTime(), astroTime("sunrise", 30).getTime(), isDaytime()];',
            host => (host.location = { latitude: 52.52, longitude: 13.4 }),
        );
        const [sunrise, later, daytime] = r.sandbox.result;
        expect(later - sunrise).to.equal(30 * 60_000);
        const sunset = r.getSunTimes(new Date()).sunset.getTime();
        const now = Date.now();
        expect(daytime).to.equal(now >= sunrise && now < sunset);
    });

    it("reports a missing location and unknown astro events as problem of the action", async () => {
        const { host } = await run("result = isDaytime();");
        expect(host.warnings.join()).to.match(/No location \(latitude\/longitude\) configured/);
        const second = await run(
            'result = astroTime("teatime");',
            h => (h.location = { latitude: 52.52, longitude: 13.4 }),
        );
        expect(second.host.warnings.join()).to.match(/Unknown astro event "teatime"/);
    });

    it("knows the helper functions in the validation", () => {
        const { validateCode } = require("./chart-validation");
        expect(
            validateCode('sendTo("a.0", "b", {}); setStateDelayed("x", 1, 100); isDaytime();', "statements", []),
        ).to.deep.equal([]);
    });
});

describe("chart-runtime => triggers of inputs", () => {
    /** @type {ChartRuntime | undefined} */
    let runtime;
    afterEach(() => runtime?.stop());

    /**
     * A chart which counts its wakeups (during action) and stores the last motion value
     *
     * @param {Partial<import("./chart-model").ChartSymbol>} options Of the input "motion"
     */
    async function start(options) {
        const chart = createLightChart();
        Object.assign(chart.symbols[0], options);
        chart.symbols.push({ name: "seen", scope: "local", initial: null });
        chart.states[0].during = "count++; seen = motion;";
        // no transitions, so every wakeup executes the during action
        chart.transitions = [];
        const host = createHost({ "test.0.motion": false });
        runtime = new ChartRuntime("light", chart, host);
        await runtime.start();
        return runtime;
    }

    it("wakes up on every update by default, regardless of ack", async () => {
        const r = await start({});
        r.handleInput("test.0.motion", false, { ack: true });
        r.handleInput("test.0.motion", false, { ack: false });
        r.handleInput("test.0.motion", true);
        expect(r.sandbox.count).to.equal(3);
    });

    it("wakes up only on changes", async () => {
        const r = await start({ trigger: "change" });
        r.handleInput("test.0.motion", false);
        r.handleInput("test.0.motion", true);
        r.handleInput("test.0.motion", true);
        r.handleInput("test.0.motion", false);
        expect(r.sandbox.count).to.equal(2);
    });

    it("uses only confirmed values", async () => {
        const r = await start({ ack: "ack" });
        r.handleInput("test.0.motion", true, { ack: false });
        expect(r.sandbox.count).to.equal(0);
        expect(r.sandbox.motion).to.equal(false, "a filtered update does not change the variable");
        r.handleInput("test.0.motion", true, { ack: true });
        expect(r.sandbox.count).to.equal(1);
        expect(r.sandbox.seen).to.equal(true);
    });

    it("uses only commands", async () => {
        const r = await start({ ack: "command" });
        r.handleInput("test.0.motion", true, { ack: true });
        r.handleInput("test.0.motion", true);
        expect(r.sandbox.count).to.equal(0);
        r.handleInput("test.0.motion", true, { ack: false });
        expect(r.sandbox.count).to.equal(1);
    });

    it("debounces: one wakeup with the last value after the input was quiet", async () => {
        const r = await start({ debounceMs: 30 });
        r.handleInput("test.0.motion", true);
        await wait(10);
        r.handleInput("test.0.motion", false);
        await wait(10);
        r.handleInput("test.0.motion", true);
        expect(r.sandbox.count).to.equal(0);
        expect(r.sandbox.motion).to.equal(false, "the variable changes only with the wakeup");
        await wait(50);
        expect(r.sandbox.count).to.equal(1);
        expect(r.sandbox.seen).to.equal(true);
    });

    it("debounces and checks for changes with the last value", async () => {
        const r = await start({ debounceMs: 20, trigger: "change" });
        // bounces back to the old value: no change, no wakeup
        r.handleInput("test.0.motion", true);
        r.handleInput("test.0.motion", false);
        await wait(40);
        expect(r.sandbox.count).to.equal(0);
    });

    it("cancels pending debounce timers when it stops", async () => {
        const r = await start({ debounceMs: 20 });
        r.handleInput("test.0.motion", true);
        r.stop();
        await wait(40);
        expect(r.sandbox.count).to.equal(0);
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

    it("restores nested states", async () => {
        const host = await start(createHeatingChart(), { "test.0.temp": 18, "test.0.manual": false });
        runtime?.handleInput("test.0.temp", 18);
        expect(host.active.at(-1)).to.equal("Auto.Heat");
        runtime?.stop();

        host.active = [];
        runtime = new ChartRuntime("heating", createHeatingChart(), host);
        await runtime.start({ restore: true });
        expect(host.active).to.deep.equal(["Auto.Heat"]);
        expect([...runtime.enteredAt.keys()]).to.deep.equal(["auto", "heat"]);
        // the trace (a local) is restored as well, without new entries
        expect(runtime.sandbox.trace.at(-1)).to.equal("Heat/entry");
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
