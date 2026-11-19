import { describe, expect, it } from "vitest";
import { makeRng } from "../rng.ts";
import { feasibleSchedules, keyOf, neighbors, ScoreCache, searchSchedules, type SearchProblem } from "./search.ts";

/** Random gains with pairwise synergies and diminishing returns, a few clashing pairs and a cap. */
const problem = (seed: number, size = 11, cap = 4): SearchProblem & { calls: number } => {
    const rng = makeRng(seed);
    const gain = Array.from({ length: size }, () => rng() * 10 - 2);
    const pair = Array.from({ length: size }, () => Array.from({ length: size }, () => (rng() < 0.2 ? rng() * 8 - 4 : 0)));
    const clash = new Set(Array.from({ length: 6 }, () => `${Math.floor(rng() * size)}|${Math.floor(rng() * size)}`));
    const p = {
        size,
        calls: 0,
        feasible: (chosen: number[]) => chosen.length <= cap && chosen.every((a) => chosen.every((b) => !clash.has(`${a}|${b}`) || a === b)),
        evaluate: async (schedules: number[][]) => {
            p.calls += schedules.length;
            return schedules.map((s) => {
                let v = 0;
                for (const a of s) v += gain[a];
                for (const a of s) for (const b of s) if (a < b) v += pair[a][b] + pair[b][a];
                return v - 0.5 * s.length ** 2;
            });
        },
    };
    return p;
};

describe("searchSchedules", () => {
    it("finds the exhaustive optimum on small problems with interactions", async () => {
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const p = problem(seed);
            const cache = new ScoreCache(p.evaluate);
            const best = await searchSchedules(p, cache, { beam: 16, restarts: 4, seed: 1 });
            const all = await new ScoreCache(p.evaluate).score(feasibleSchedules(p)!);
            const optimum = Math.max(...all.map((s) => s.value));
            expect(best.value).toBeCloseTo(optimum, 9);
        }
    });

    it("is deterministic for a seed", async () => {
        const run = async () => {
            const p = problem(9, 14, 5);
            const cache = new ScoreCache(p.evaluate);
            return keyOf((await searchSchedules(p, cache, { beam: 4, restarts: 2, seed: 3 })).chosen);
        };
        expect(await run()).toBe(await run());
    });

    it("scores each schedule once", async () => {
        const p = problem(10);
        const cache = new ScoreCache(p.evaluate);
        await searchSchedules(p, cache, { beam: 8, restarts: 2, seed: 1 });
        expect(p.calls).toBe(cache.size);
    });
});

describe("neighbors", () => {
    it("swaps only into options that don't fit beside the current schedule", () => {
        const p: SearchProblem = { size: 3, feasible: (c) => c.length <= 1, evaluate: async () => [] };
        expect(neighbors(p, [0]).map(keyOf).sort()).toEqual(["", "1", "2"]);
        const roomy: SearchProblem = { ...p, feasible: (c) => c.length <= 2 };
        expect(neighbors(roomy, [0]).map(keyOf).sort()).toEqual(["", "0,1", "0,2"]);
    });
});
