"use strict";

const { expect } = require("chai");
const acorn = require("acorn");
const { generateChartCode } = require("./chart-codegen");

/** @returns {import("./chart-model").Chart} */
function createChart() {
    return {
        version: 1,
        name: "Heating",
        enabled: true,
        initial: "auto",
        symbols: [
            { name: "temp", scope: "input", stateId: "test.0.temp" },
            { name: "manual", scope: "input", stateId: "test.0.manual" },
            { name: "heating", scope: "output", stateId: "test.0.heating" },
            { name: "count", scope: "local", initial: 0 },
        ],
        states: [
            { id: "auto", name: "Auto", initial: "heat", during: "count++;", x: 0, y: 0 },
            { id: "idle", name: "Idle", parent: "auto", entry: "heating = false;", x: 0, y: 0 },
            { id: "heat", name: "Heat", parent: "auto", entry: "heating = true;\nlog('heating');", x: 0, y: 0 },
            { id: "manualState", name: "Manual", x: 0, y: 0 },
        ],
        transitions: [
            { id: "toManual", source: "auto", target: "manualState", label: "manual[manual]", priority: 1 },
            { id: "toAuto", source: "manualState", target: "auto", label: "after(5, min)[!manual]" },
            { id: "start", source: "idle", target: "heat", label: "[temp < 20]{count = 0;}" },
            { id: "restart", source: "auto", target: "idle", label: "[temp > 30]" },
            { id: "broken", source: "heat", target: "idle", label: "[temp > 22" },
        ],
        functions: [{ id: "f1", code: "function tooWarm(t) {\n    return t > 22;\n}", x: 0, y: 0 }],
    };
}

describe("chart-codegen => generateChartCode", () => {
    it("generates valid JavaScript", () => {
        const code = generateChartCode(createChart(), "heating");
        expect(() => acorn.parse(code, { ecmaVersion: "latest", sourceType: "script" })).not.to.throw();
    });

    it("contains variables, function blocks and the machine", () => {
        const code = generateChartCode(createChart(), "heating");
        expect(code).to.include('let temp = getState("test.0.temp"); // input');
        expect(code).to.include("let count = 0; // local");
        expect(code).to.include("const written = { heating };");
        expect(code).to.include("function tooWarm(t) {\n    return t > 22;\n}");
        expect(code).to.include('id: "chart_heating"');
        expect(code).to.include('initial: "heat"');
        // temporal transitions are XState timers with the condition as guard
        expect(code).to.include("300000: [");
        expect(code).to.include('{ target: "#auto", guard: () => (!manual) }');
    });

    it("selects the transitions in Stateflow order", () => {
        const code = generateChartCode(createChart(), "heating");
        const auto = code.substring(code.indexOf("function process_auto("), code.indexOf("function process_idle("));
        const order = [
            'input === "manual" && (manual)',
            "count++;",
            "(temp > 30)",
            'isActive("idle")',
            'isActive("heat")',
        ].map(part => auto.indexOf(part));
        expect(order.every(i => i >= 0)).to.equal(true, auto);
        expect([...order].sort((a, b) => a - b)).to.deep.equal(order);
    });

    it("marks inner transitions as not re-entering and ignores invalid transitions like the runtime", () => {
        const code = generateChartCode(createChart(), "heating");
        expect(code).to.include('"T.restart": { target: "#idle" }');
        expect(code).to.include('// Heat -> Idle: [temp > 22: ignored, Missing "]"');
        expect(code).not.to.include('"T.broken"');
    });

    it("processes only the state which was active when the chart woke up", () => {
        const code = generateChartCode(createChart(), "heating");
        expect(code).to.include(
            '    if (isActive("auto")) {\n        process_auto(input);\n    } else if (isActive("manualState")) {\n',
        );
    });

    it("indents multi line actions", () => {
        const code = generateChartCode(createChart(), "heating");
        expect(code).to.include(
            "entry: () => {\n                        heating = true;\n                        log('heating');\n",
        );
    });

    it("handles empty charts", () => {
        const code = generateChartCode(
            { version: 1, name: "Empty", enabled: true, symbols: [], states: [], transitions: [] },
            "empty",
        );
        expect(() => acorn.parse(code, { ecmaVersion: "latest" })).not.to.throw();
        expect(code).to.include("// no variables");
    });
});
