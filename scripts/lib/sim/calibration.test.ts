import { describe, expect, it } from "vitest";
import { calibrateInvite, calibrateRange, fitCalibration, type CalibrationRow, type SeasonCalibration } from "./calibration.ts";

const cal: SeasonCalibration = {
    source: "test",
    fittedAt: "2026-11-21",
    bands: [
        { band: "1-14", lo: 1, hi: 14, lambda: [1, 1], widen: [1, 1] },
        { band: "15-80", lo: 15, hi: 80, lambda: [0.5, 0.25], widen: [2, 3] },
    ],
    invite: { a: 0.02, b: 0.9 },
};

describe("calibrateRange", () => {
    it("shrinks the p50 toward today and widens the range around it", () => {
        expect(calibrateRange(cal, 30, 1000, 1, { p10: 900, p50: 1100, p90: 1200 })).toEqual({ p10: 650, p50: 1050, p90: 1250 });
    });

    it("uses the last horizon past the fit and the last band for unranked teams", () => {
        expect(calibrateRange(cal, null, 1000, 6, { p10: 1000, p50: 1400, p90: 1500 }, (x) => Math.max(0, x))).toEqual({ p10: 0, p50: 1100, p90: 1400 });
    });

    it("leaves a range alone without a calibration or a value today", () => {
        const r = { p10: 1, p50: 2, p90: 3 };
        expect(calibrateRange(null, 30, 1000, 1, r)).toBe(r);
        expect(calibrateRange(cal, 30, null, 1, r)).toBe(r);
    });

    it("squeezes invite shares away from 0 and 1", () => {
        expect(calibrateInvite(cal, 0)).toBeCloseTo(0.02, 12);
        expect(calibrateInvite(cal, 1)).toBeCloseTo(0.92, 12);
    });
});

describe("fitCalibration", () => {
    it("keeps a sim that is right as is and widens a range that's too narrow", () => {
        const rows: CalibrationRow[] = Array.from({ length: 200 }, (_, i) => {
            const truth = 1000 + ((i * 37) % 200) - 100;
            return { band: "15-80", horizon: 1, persistence: 900, truth, sim: { p10: truth - 10, p50: truth, p90: truth + 10 }, invite: { sim: i % 2, truth: i % 2 } };
        });
        const fit = fitCalibration(rows, [["15-80", 15, 80]], "test");
        expect(fit.bands[0].lambda).toEqual([1]);
        expect(fit.bands[0].widen[0]).toBe(1);
        expect(fit.invite).toEqual({ a: 0, b: 1 });
    });
});
