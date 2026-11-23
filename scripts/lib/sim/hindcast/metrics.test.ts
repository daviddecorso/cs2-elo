import { describe, expect, it } from "vitest";
import { brier, crps, logLoss, median, quantile, spearman } from "./metrics.ts";

describe("hindcast metrics", () => {
    it("scores a point forecast's CRPS as its absolute error", () => {
        expect(crps([5], 8)).toBe(3);
        expect(crps([5, 5, 5], 2)).toBe(3);
    });

    it("matches the pairwise CRPS formula on a small sample", () => {
        const xs = [1, 4, 6];
        const y = 3;
        const miss = xs.reduce((s, x) => s + Math.abs(x - y), 0) / 3;
        let pairs = 0;
        for (const a of xs) for (const b of xs) pairs += Math.abs(a - b);
        expect(crps(xs, y)).toBeCloseTo(miss - pairs / 18, 12);
    });

    it("ranks with average ties", () => {
        expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
        expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 12);
        expect(spearman([1, 1, 2], [1, 1, 2])).toBeCloseTo(1, 12);
    });

    it("takes floor-index quantiles", () => {
        expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
        expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1)).toBe(2);
        expect(median([3, 1, 2])).toBe(2);
    });

    it("scores probabilities", () => {
        expect(brier([1, 0, 0.5], [1, 0, 1])).toBeCloseTo(0.25 / 3, 12);
        expect(logLoss([0.5, 0.5], [1, 0])).toBeCloseTo(Math.log(2), 12);
    });
});
