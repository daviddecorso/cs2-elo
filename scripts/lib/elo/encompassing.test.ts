import { describe, expect, it } from "vitest";
import { clusterCi, fitLambda, lambdaCi, lcg } from "./encompassing.ts";

const synthetic = (trueLambda: number, n: number, seed: number) => {
    const rand = lcg(seed);
    const offsets: number[] = [];
    const deltas: number[] = [];
    const ys: number[] = [];
    const clusters: string[] = [];
    for (let i = 0; i < n; i++) {
        const o = 2 * (rand() - 0.5);
        const d = 2 * (rand() - 0.5);
        offsets.push(o);
        deltas.push(d);
        ys.push(rand() < 1 / (1 + Math.exp(-(o + trueLambda * d))) ? 1 : 0);
        clusters.push(`e${i % 200}`);
    }
    return { offsets, deltas, ys, clusters };
};

describe("fitLambda", () => {
    it("recovers a known λ", () => {
        for (const trueLambda of [0, 0.5, 1, 2]) {
            const { offsets, deltas, ys } = synthetic(trueLambda, 40000, 3);
            expect(fitLambda(offsets, deltas, ys)).toBeCloseTo(trueLambda, 1);
        }
    });

    it("treats weights as row multiplicities", () => {
        const { offsets, deltas, ys } = synthetic(1, 500, 5);
        const doubled = (xs: number[]) => [...xs, ...xs];
        const weighted = fitLambda(offsets, deltas, ys, new Array(500).fill(2));
        expect(weighted).toBeCloseTo(fitLambda(doubled(offsets), doubled(deltas), doubled(ys)), 8);
    });

    it("returns 0 when the adjustment never moves a forecast", () => {
        expect(fitLambda([0.3, -0.2], [0, 0], [1, 0])).toBe(0);
    });
});

describe("lambdaCi", () => {
    it("covers the true λ and excludes 0 when the signal is strong", () => {
        const { offsets, deltas, ys, clusters } = synthetic(1, 5000, 7);
        const { lo, hi } = lambdaCi(offsets, deltas, ys, clusters, 500);
        expect(lo).toBeGreaterThan(0);
        expect(lo).toBeLessThan(1);
        expect(hi).toBeGreaterThan(1);
    });
});

describe("clusterCi", () => {
    it("brackets the mean", () => {
        const values = Array.from({ length: 400 }, (_, i) => (i % 7) - 3);
        const clusters = values.map((_, i) => `e${i % 40}`);
        const [lo, hi] = clusterCi(values, clusters);
        const mean = values.reduce((s, v) => s + v, 0) / values.length;
        expect(lo).toBeLessThanOrEqual(mean);
        expect(hi).toBeGreaterThanOrEqual(mean);
    });
});
