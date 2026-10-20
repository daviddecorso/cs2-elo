import { describe, expect, it } from "vitest";
import { calibrationSlope, expectedCalibrationError, logit, type Forecast } from "./metrics.ts";

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Deterministic outcomes whose win rate at each true probability matches it exactly. */
const outcomes = (stretch: number): Forecast[] => {
    const out: Forecast[] = [];
    for (let i = 1; i < 20; i++) {
        const truth = i / 20;
        const p = sigmoid(logit(truth) * stretch);
        for (let j = 0; j < 100; j++) out.push({ p, y: j < truth * 100 ? 1 : 0 });
    }
    return out;
};

describe("calibration metrics", () => {
    it("fits a slope of 1 on calibrated forecasts", () => {
        const fit = calibrationSlope(outcomes(1));
        expect(fit.slope).toBeCloseTo(1, 2);
        expect(fit.intercept).toBeCloseTo(0, 2);
        expect(expectedCalibrationError(outcomes(1))).toBeLessThan(0.01);
    });

    it("fits the inverse stretch on overconfident forecasts", () => {
        expect(calibrationSlope(outcomes(1.25)).slope).toBeCloseTo(0.8, 2);
        expect(expectedCalibrationError(outcomes(1.25))).toBeGreaterThan(0.02);
    });
});
