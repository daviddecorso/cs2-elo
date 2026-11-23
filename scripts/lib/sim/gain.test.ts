import { describe, expect, it } from "vitest";
import type { TeamScore } from "../vrs/oneTeam.ts";
import { GAIN_PARTS, splitGain, summarizeWhy, wilson } from "./gain.ts";

const score = (points: number, seedRating: number, factors: TeamScore["factors"]): TeamScore => ({
    points,
    seedRating,
    seedValue: (factors.bountyCollected + factors.bountyOffered + factors.opponentNetwork + factors.lanFactor) / 4,
    factors,
});

describe("splitGain", () => {
    it("splits the seed rating's change by factor and leaves head to head as the rest", () => {
        const before = score(1000, 900, { bountyCollected: 0.2, bountyOffered: 0.2, opponentNetwork: 0.2, lanFactor: 0.2 });
        const after = score(1100, 980, { bountyCollected: 0.3, bountyOffered: 0.2, opponentNetwork: 0.3, lanFactor: 0.4 });
        const gain = splitGain(before, after);
        expect(gain.points).toBeCloseTo(100);
        expect(gain.parts.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
        expect(gain.parts.slice(0, 4).reduce((a, b) => a + b, 0)).toBeCloseTo(80);
        expect(gain.parts[0]).toBeCloseTo(20);
        expect(gain.parts[1]).toBeCloseTo(0);
        expect(gain.parts[3]).toBeCloseTo(40);
        expect(gain.parts[4]).toBeCloseTo(20);
    });

    it("puts a seed-range shift without factor change into head to head", () => {
        const f = { bountyCollected: 0.2, bountyOffered: 0.2, opponentNetwork: 0.2, lanFactor: 0.2 };
        const gain = splitGain(score(1000, 900, f), score(990, 890, f));
        expect(gain.parts.slice(0, 4)).toEqual([0, 0, 0, 0]);
        expect(gain.parts[4]).toBeCloseTo(-10);
    });
});

describe("wilson", () => {
    it("brackets the share and stays in [0, 1]", () => {
        const [lo, hi] = wilson(18, 30);
        expect(lo).toBeLessThan(0.6);
        expect(hi).toBeGreaterThan(0.6);
        expect(hi - lo).toBeGreaterThan(0.3);
        expect(wilson(0, 10)[0]).toBe(0);
        expect(wilson(10, 10)[1]).toBe(1);
        expect(wilson(0, 0)).toEqual([0, 1]);
    });
});

describe("summarizeWhy", () => {
    it("averages over runs with a finish and labels finishes from the prize table", () => {
        const k = GAIN_PARTS.length;
        const n = 4;
        // One event at offset 0; run 2 didn't reach it.
        const place = [1, 3, 0, 4];
        const gain = new Array<number>(n * k).fill(0);
        const set = (run: number, parts: number[]) => parts.forEach((v, p) => (gain[run * k + p] = v));
        set(0, [10, 10, 10, 10, 20]);
        set(1, [2, 2, 2, 2, 4]);
        set(3, [2, 2, 2, 2, -2]);
        const prizes = new Map([
            ["1", 1000],
            ["2", 500],
            ["3-4", 200],
        ]);
        const why = summarizeWhy(place, gain, 0, [0, 1, 2, 3], prizes)!;
        expect(why.n).toBe(3);
        expect(why.points).toBeCloseTo((60 + 12 + 6) / 3, 1);
        // Parts are rounded to whole points one by one.
        expect(Math.abs(why.parts.reduce((a, b) => a + b, 0) - why.points)).toBeLessThanOrEqual(GAIN_PARTS.length / 2);
        expect(why.place).toEqual([
            ["1", 0.33, 60],
            ["3-4", 0.33, 12],
            ["4", 0.33, 6],
        ]);
        expect(why.prize).toBe(Math.round((1000 + 200) / 3));
        expect(summarizeWhy([0, 0], gain, 0, [0, 1], prizes)).toBeUndefined();
    });
});
