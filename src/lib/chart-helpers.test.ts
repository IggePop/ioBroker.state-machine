import { expect } from "chai";
import { isTimeBetween, parseTime } from "./chart-helpers";

/**
 * @param time "HH:mm"
 * @returns today at this time
 */
const at = (time: string): Date => {
    const [h, m] = time.split(":").map(Number);
    const date = new Date();
    date.setHours(h, m, 0, 0);
    return date;
};

describe("chart-helpers => isTimeBetween", () => {
    it("checks ranges within a day, the end is exclusive", () => {
        expect(isTimeBetween("08:00", "17:30", at("08:00"))).to.equal(true);
        expect(isTimeBetween("08:00", "17:30", at("12:00"))).to.equal(true);
        expect(isTimeBetween("08:00", "17:30", at("17:30"))).to.equal(false);
        expect(isTimeBetween("08:00", "17:30", at("07:59"))).to.equal(false);
    });

    it("checks ranges over midnight", () => {
        expect(isTimeBetween("22:00", "06:00", at("23:30"))).to.equal(true);
        expect(isTimeBetween("22:00", "06:00", at("00:00"))).to.equal(true);
        expect(isTimeBetween("22:00", "06:00", at("05:59"))).to.equal(true);
        expect(isTimeBetween("22:00", "06:00", at("06:00"))).to.equal(false);
        expect(isTimeBetween("22:00", "06:00", at("12:00"))).to.equal(false);
    });

    it("rejects invalid times", () => {
        expect(() => parseTime("25:00")).to.throw(/Invalid time "25:00"/);
        expect(() => parseTime("8 Uhr")).to.throw(/Invalid time/);
        expect(parseTime("7:05:30")).to.equal(7 * 3600 + 5 * 60 + 30);
    });
});
