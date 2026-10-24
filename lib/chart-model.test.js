"use strict";

const { expect } = require("chai");
const { createExport, nameToId, parseExport, parseTransitionLabel } = require("./chart-model");

/** @returns {import("./chart-model").Chart} */
function createTestChart() {
    return {
        version: 1,
        name: "Light",
        enabled: true,
        initial: "off",
        symbols: [
            { name: "motion", scope: "input", stateId: "hm-rpc.0.ABC.MOTION" },
            { name: "count", scope: "local", initial: 0 },
        ],
        states: [
            { id: "off", name: "Off", x: 0, y: 0 },
            { id: "on", name: "On", entry: "count++;", x: 200, y: 0 },
            { id: "dim", name: "Dim", parent: "on", x: 10, y: 40 },
        ],
        transitions: [{ id: "t1", source: "off", target: "on", label: "motion[motion]", priority: 1 }],
        functions: [{ id: "f1", code: "function f() {}", x: 0, y: 200 }],
    };
}

describe("chart-model => export and import", () => {
    it("imports what was exported", () => {
        const chart = createTestChart();
        const [imported] = parseExport(JSON.stringify(createExport([chart])));
        expect(imported).to.deep.equal({ ...chart, states: chart.states.map(s => ({ parent: null, ...s })) });
    });

    it("accepts a single chart without the export wrapper", () => {
        const charts = parseExport(JSON.stringify(createTestChart()));
        expect(charts.map(c => c.name)).to.deep.equal(["Light"]);
    });

    it("fills in defaults of old or hand written charts", () => {
        const [chart] = parseExport(
            JSON.stringify({ states: [{ id: "a" }], transitions: [], symbols: [], initial: "unknown" }),
        );
        expect(chart).to.deep.include({ name: "Chart", initial: undefined, functions: [], version: 1 });
        expect(chart.states).to.deep.equal([{ id: "a", name: "a", parent: null, x: 0, y: 0 }]);
    });

    /**
     * @param {(chart: any) => void} modify
     * @returns {string} the error message
     */
    const importError = modify => {
        const chart = createTestChart();
        modify(chart);
        try {
            parseExport(JSON.stringify(createExport([chart])));
        } catch (err) {
            return err.message;
        }
        return "no error";
    };

    it("rejects invalid files", () => {
        expect(() => parseExport("{ no json")).to.throw(/No valid JSON/);
        expect(() => parseExport('{"format": "something else"}')).to.throw(/contains no charts/);
        expect(() => parseExport(JSON.stringify({ ...createExport([]), version: 99 }))).to.throw(/newer version/);
        expect(() => parseExport(JSON.stringify(createExport([])))).to.throw(/contains no charts/);
    });

    it("rejects invalid charts and tells where the problem is", () => {
        expect(importError(c => (c.version = 2))).to.match(/^Chart 1: created with a newer version/);
        expect(importError(c => delete c.states)).to.equal('Chart 1: "states" is missing or no list');
        expect(importError(c => c.states.push({ id: "on" }))).to.equal(
            "Chart 1: state on: the ID is used more than once",
        );
        expect(importError(c => (c.functions[0].id = "off"))).to.match(
            /function block off: the ID is used more than once/,
        );
        expect(importError(c => (c.transitions[0].target = "gone"))).to.equal(
            'Chart 1: transition t1: unknown target state "gone"',
        );
        expect(importError(c => (c.states[2].parent = "gone"))).to.equal(
            'Chart 1: state dim: unknown parent state "gone"',
        );
        expect(importError(c => (c.states[1].parent = "dim"))).to.match(/the parent states form a cycle/);
        expect(importError(c => (c.symbols[1].name = "motion"))).to.match(
            /variable motion: the name is used more than once/,
        );
        expect(importError(c => (c.symbols[0].name = "1x"))).to.match(/variable 1: invalid name/);
        expect(importError(c => (c.symbols[0].scope = "magic"))).to.match(/invalid kind "magic"/);
        expect(importError(c => (c.states[1].entry = 5))).to.match(/state on: "entry" is no text/);
    });
});

describe("chart-model => parseTransitionLabel", () => {
    it("returns an empty result for an empty label", () => {
        expect(parseTransitionLabel("")).to.deep.equal({});
        expect(parseTransitionLabel(undefined)).to.deep.equal({});
    });

    it("parses event, condition and action", () => {
        expect(parseTransitionLabel("motion[motion == true]{light = true;}")).to.deep.equal({
            event: "motion",
            condition: "motion == true",
            action: "light = true;",
        });
    });

    it("parses a condition only", () => {
        expect(parseTransitionLabel("[temp > 20 && window]")).to.deep.equal({ condition: "temp > 20 && window" });
    });

    it("allows nested brackets", () => {
        expect(parseTransitionLabel("[[1, 2].includes(mode)]{ if (x) { y = 1; } }")).to.deep.equal({
            condition: "[1, 2].includes(mode)",
            action: "if (x) { y = 1; }",
        });
    });

    it("parses labels spanning multiple lines", () => {
        expect(
            parseTransitionLabel("motion\n[motion &&\n  !blocked]\n{\n  light = true;\n  count++;\n}"),
        ).to.deep.equal({
            event: "motion",
            condition: "motion &&\n  !blocked",
            action: "light = true;\n  count++;",
        });
    });

    it("parses temporal transitions", () => {
        expect(parseTransitionLabel("after(5, sec)")).to.deep.equal({ afterMs: 5000 });
        expect(parseTransitionLabel("after(1.5,min)[!motion]")).to.deep.equal({
            afterMs: 90_000,
            condition: "!motion",
        });
        expect(parseTransitionLabel("after(200, msec)")).to.deep.equal({ afterMs: 200 });
    });

    it("rejects invalid labels", () => {
        expect(() => parseTransitionLabel("after(5, hours)")).to.throw(/Invalid temporal expression/);
        expect(() => parseTransitionLabel("[a > 1")).to.throw(/Missing/);
        expect(() => parseTransitionLabel("a b")).to.throw(/Unexpected/);
    });
});

describe("chart-model => nameToId", () => {
    it("creates valid object IDs", () => {
        expect(nameToId("Licht Flur")).to.equal("licht_flur");
        expect(nameToId("Größe/Höhe")).to.equal("groesse_hoehe");
        expect(nameToId("...")).to.equal("chart");
    });
});
