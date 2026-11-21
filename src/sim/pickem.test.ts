import { describe, expect, it } from "vitest";
import { decodeSample, encodeSample, favouritePicks, modelPickem, pickKey, runPickem, scorePicks } from "./pickem.ts";
import type { PickemData } from "./types.ts";

const team = (prefix: string, i: number) => `${prefix}${String(i + 1).padStart(2, "0")}`;
const s1 = Array.from({ length: 16 }, (_, i) => team("A", i));
const s2 = Array.from({ length: 8 }, (_, i) => team("B", i));
const all = [...s1, ...s2].sort();

/** The team that sorts first always wins. */
const matrix = all.map((a) => all.map((b) => (a < b ? 0.9 : a > b ? 0.1 : 0.5)));

const data = (played: PickemData["stages"][number]["played"] = []): PickemData => ({
    stages: [
        { id: "stage1", name: "Stage 1", format: "swiss", seeds: s1, bestOf: { default: 1, decider: 3 }, played },
        { id: "stage2", name: "Stage 2", format: "swiss", seeds: s2, from: "stage1", bestOf: { default: 1, decider: 3 }, played: [] },
        {
            id: "playoffs",
            name: "Playoffs",
            format: "bracket",
            seeds: [],
            from: "stage2",
            bestOf: { default: 3, final: 5 },
            played: [],
            matches: [
                { id: "qf1", teams: ["s1", "s8"] },
                { id: "qf2", teams: ["s4", "s5"] },
                { id: "qf3", teams: ["s2", "s7"] },
                { id: "qf4", teams: ["s3", "s6"] },
                { id: "sf1", teams: ["w:qf1", "w:qf2"] },
                { id: "sf2", teams: ["w:qf3", "w:qf4"] },
                { id: "gf", teams: ["w:sf1", "w:sf2"] },
            ],
        },
    ],
    odds: { teams: all, bo1: matrix, bo3: matrix, bo5: matrix },
});

describe("runPickem", () => {
    it("pairs round 1 by seed and waits for picks", () => {
        const [stage1, stage2, playoffs] = runPickem(data(), {});
        expect(stage1.rounds).toHaveLength(1);
        expect(stage1.rounds[0].map((m) => m.teams)).toEqual(s1.slice(0, 8).map((t, i) => [t, s1[i + 8]]));
        expect(stage1.complete).toBe(false);
        expect(stage2.seeds).toEqual([]);
        expect(playoffs.champion).toBeNull();
    });

    it("plays every stage through with favourite picks", () => {
        const d = data();
        const runs = runPickem(d, favouritePicks(d));
        const [stage1, stage2, playoffs] = runs;
        expect(stage1.complete).toBe(true);
        expect(stage1.advancing).toHaveLength(8);
        expect(stage1.outcomes.filter((o) => o.losses === 3)).toHaveLength(8);
        expect(stage1.outcomes.filter((o) => o.wins === 3 && o.losses === 0).map((o) => o.team)).toEqual(["A01", "A02"]);
        expect(stage2.seeds).toEqual([...s2, ...stage1.advancing]);
        expect(stage2.complete).toBe(true);
        expect(playoffs.champion).toBe("A01");
        expect(playoffs.rounds.map((r) => r.length)).toEqual([4, 2, 1]);
    });

    it("re-pairs later rounds when an earlier pick changes, dropping stale picks", () => {
        const d = data();
        const picks = favouritePicks(d);
        const upset = { ...picks, [pickKey("stage1", 1, "A01", "A09")]: "A09" };
        const before = runPickem(d, picks)[0].rounds[1].map((m) => m.key);
        const after = runPickem(d, upset)[0];
        expect(after.rounds[1].map((m) => m.key)).not.toEqual(before);
        expect(after.rounds[0][0].winner).toBe("A09");
    });

    it("locks played results over picks", () => {
        const d = data([{ round: 1, teams: ["A01", "A09"], winner: 1 }]);
        const run = runPickem(d, { [pickKey("stage1", 1, "A01", "A09")]: "A01" })[0];
        expect(run.rounds[0][0]).toMatchObject({ winner: "A09", locked: true });
    });
});

describe("sample scoring", () => {
    const seeds = s1;
    // Two sims: in the first every team lands in bucket i % 4, in the second all are "other".
    const buckets = new Uint8Array([...seeds.map((_, i) => i % 4), ...seeds.map(() => 3)]);

    it("round-trips the packed sample", () => {
        const model = { seeds, n: 2, sample: encodeSample(buckets) };
        expect([...decodeSample(model)]).toEqual([...buckets]);
    });

    it("counts coin and expected correct", () => {
        const picks = {
            threeZero: ["A01", "A05"],
            advance: ["A02", "A06", "A10", "A14", "A04", "A08"],
            zeroThree: ["A03", "A07"],
        };
        const score = scorePicks(seeds, buckets, picks);
        // Sim 1 hits 8 (A04 and A08 are "other"), sim 2 hits none.
        expect(score.expected).toBe(4);
        expect(score.coin).toBe(0.5);
        expect(score.perTeam.get("A01")).toBe(0.5);
        expect(score.perTeam.get("A04")).toBe(0);
    });
});

describe("modelPickem", () => {
    it("picks ten distinct teams", () => {
        const teams = s1.map((t, i) => ({ team: t, p30: i < 3 ? 0.4 : 0.05, p3x: 0.5 - i * 0.02, p03: i > 13 ? 0.3 : 0.02 }));
        const pick = modelPickem(teams)!;
        const picked = [...pick.threeZero, ...pick.advance, ...pick.zeroThree].map((t) => t.team);
        expect(new Set(picked).size).toBe(10);
        expect(pick.zeroThree.map((t) => t.team).sort()).toEqual(["A15", "A16"]);
    });
});
