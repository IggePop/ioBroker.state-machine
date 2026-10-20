"use strict";

const { expect } = require("chai");
const { nameToId, parseTransitionLabel } = require("./chart-model");

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
