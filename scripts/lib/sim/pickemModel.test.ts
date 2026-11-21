import { describe, expect, it } from "vitest";
import { modelPickem, scorePicks } from "../../../src/sim/pickem.ts";
import type { PickemData, PickemModel } from "../../../src/sim/types.ts";
import { coinPickem, pickemModels, simulateSwissStage } from "./pickemModel.ts";
import { makeRng } from "./rng.ts";

const seeds = Array.from({ length: 16 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);
const bestOf = { default: 1, decider: 3 };
/** Higher seed wins with a probability that grows with the seed gap. */
const odds = (a: string, b: string) => 1 / (1 + Math.exp((seeds.indexOf(a) - seeds.indexOf(b)) / 4));

describe("simulateSwissStage", () => {
    it("ends every run with 2 at 3-0, 6 at 3-X and 2 at 0-3", () => {
        const n = 200;
        const buckets = simulateSwissStage(seeds, bestOf, odds, n, makeRng(1));
        for (let s = 0; s < n; s++) {
            const counts = [0, 0, 0, 0];
            for (let t = 0; t < seeds.length; t++) counts[buckets[s * seeds.length + t]]++;
            expect(counts).toEqual([2, 6, 2, 6]);
        }
    });
});

describe("coinPickem", () => {
    const buckets = simulateSwissStage(seeds, bestOf, odds, 4000, makeRng(2));
    const picks = coinPickem(seeds, buckets, makeRng(3))!;

    it("picks ten distinct teams in the 2/6/2 shape", () => {
        expect(picks.threeZero).toHaveLength(2);
        expect(picks.advance).toHaveLength(6);
        expect(picks.zeroThree).toHaveLength(2);
        expect(new Set([...picks.threeZero, ...picks.advance, ...picks.zeroThree]).size).toBe(10);
    });

    it("reaches the coin at least as often as the favourites", () => {
        const naive = { threeZero: seeds.slice(0, 2), advance: seeds.slice(2, 8), zeroThree: seeds.slice(14) };
        expect(scorePicks(seeds, buckets, picks).coin).toBeGreaterThanOrEqual(scorePicks(seeds, buckets, naive).coin);
    });

    it("reaches the coin at least as often as the expected-correct optimum", () => {
        const k = seeds.length;
        const rate = (t: number, bucket: number) => {
            let hits = 0;
            for (let s = 0; s < buckets.length / k; s++) if (buckets[s * k + t] === bucket) hits++;
            return hits / (buckets.length / k);
        };
        const ev = modelPickem(seeds.map((team, t) => ({ team, p30: rate(t, 0), p3x: rate(t, 1), p03: rate(t, 2) })))!;
        const evSet = { threeZero: ev.threeZero.map((t) => t.team), advance: ev.advance.map((t) => t.team), zeroThree: ev.zeroThree.map((t) => t.team) };
        expect(scorePicks(seeds, buckets, picks).coin).toBeGreaterThanOrEqual(scorePicks(seeds, buckets, evSet).coin);
    });
});

describe("pickemModels", () => {
    const stage = { id: "stage1", name: "Stage 1", format: "swiss" as const, seeds, bestOf, played: [] };
    const data = (played: PickemData["stages"][number]["played"]): PickemData => ({
        stages: [{ ...stage, played }],
        odds: { teams: seeds, bo1: [], bo3: [], bo5: [] },
    });
    const prev: PickemModel = {
        asOf: "2026-01-01",
        seeds,
        picks: { threeZero: [], advance: [], zeroThree: [] },
        n: 0,
        sample: "",
    };
    const fresh = { ...prev, asOf: "2026-02-01" };

    it("recomputes before the stage starts", () => {
        expect(pickemModels(data([]), { stage1: prev }, () => fresh).stage1.asOf).toBe("2026-02-01");
    });

    it("keeps the previous model once a match is played", () => {
        const played = [{ round: 1, teams: ["T01", "T09"] as [string, string], winner: 0 as const }];
        expect(pickemModels(data(played), { stage1: prev }, () => fresh).stage1.asOf).toBe("2026-01-01");
    });

    it("recomputes when the seeds changed", () => {
        const played = [{ round: 1, teams: ["T01", "T09"] as [string, string], winner: 0 as const }];
        const stale = { ...prev, seeds: [...seeds].reverse() };
        expect(pickemModels(data(played), { stage1: stale }, () => fresh).stage1.asOf).toBe("2026-02-01");
    });
});
