import { describe, expect, it } from "vitest";
import { stageBrackets } from "./bracketView.ts";
import type { EventConfig } from "./config.ts";
import type { SeriesModel } from "./predict.ts";
import { simulateEvents, type EventInput } from "./simulate.ts";

const fixedOdds = (p: number): SeriesModel => ({ resample: () => {}, setHorizon: () => {}, seriesProbability: () => p });

const majorLike = (teams: string[]): EventConfig => ({
    slug: "test",
    name: "Test",
    liquipedia: "Test",
    startDate: "2026-01-01",
    endDate: "2026-01-10",
    lan: true,
    stages: [
        {
            id: "swiss",
            name: "Swiss",
            page: "Test/Swiss",
            format: "swiss",
            bestOf: { default: 1, decider: 3 },
            invited: teams,
            advance: 8,
            exits: { "2-3": "9-11", "1-3": "12-14", "0-3": "15-16" },
        },
        {
            id: "po",
            name: "Playoffs",
            page: "Test/Playoffs",
            format: "single_elim",
            bestOf: { default: 3, final: 5 },
            from: "swiss",
            advance: 0,
            exits: { r1: "5-8", r2: "3-4", r3: "2", champion: "1" },
        },
    ],
});

const teams = Array.from({ length: 16 }, (_, i) => `T${i + 1}`);

describe("simulateEvents", () => {
    it("matches the series probability for a two-team final within Monte Carlo error", () => {
        const config: EventConfig = {
            ...majorLike([]),
            stages: [{ ...majorLike([]).stages[1], from: undefined, invited: ["A", "B"], exits: { r1: "2", champion: "1" } }],
        };
        const { summaries } = simulateEvents([{ config, known: new Map(), horizon: 0 }], fixedOdds(0.7), { n: 20000, seed: 3 });
        const pA = summaries[0].placements.get("A")!.get("1")! / 20000;
        expect(Math.abs(pA - 0.7)).toBeLessThan(0.01);
    });

    it("gives every team exactly one placement per simulation", () => {
        const { summaries } = simulateEvents([{ config: majorLike(teams), known: new Map(), horizon: 0 }], fixedOdds(0.5), {
            n: 500,
            seed: 1,
        });
        for (const t of teams) {
            const total = [...summaries[0].placements.get(t)!.values()].reduce((a, b) => a + b, 0);
            expect(total).toBe(500);
        }
        expect(summaries[0].divergedRuns).toBe(0);
    });

    it("never resimulates a played match", () => {
        const input: EventInput = {
            config: majorLike(teams),
            known: new Map([["swiss", [{ id: "1", teams: ["T1", "T9"], winner: 1, round: 1, t: 100 }]]]),
            horizon: 0,
        };
        const { outcomes, summaries } = simulateEvents([input], fixedOdds(0.99), { n: 200, seed: 2, keep: 200 });
        for (const [o] of outcomes) {
            const m = o.matches.find((x) => x.round === 1 && x.teams.includes("T1"))!;
            expect(m.locked).toBe(true);
            expect(m.teams[m.winner]).toBe("T9");
        }
        expect(summaries[0].divergedRuns).toBe(0);
    });

    it("tallies who reaches and wins each bracket slot", () => {
        const config: EventConfig = {
            ...majorLike([]),
            stages: [{ ...majorLike([]).stages[1], from: undefined, invited: ["A", "B", "C", "D"], exits: { r1: "3-4", r2: "2", champion: "1" } }],
        };
        const n = 20000;
        // The first-listed team always has 0.7, so A and B (each first in their semi) meet in the final 49% of the time.
        const { summaries } = simulateEvents([{ config, known: new Map(), horizon: 0 }], fixedOdds(0.7), { n, seed: 4 });
        const final = summaries[0].slots.get("po/r2-m1")!;
        expect(final.runs).toBe(n);
        expect(Math.abs(final.here.get("A")! / n - 0.7)).toBeLessThan(0.01);
        expect(Math.abs(final.pairs.get("A|B")! / n - 0.49)).toBeLessThan(0.01);
        expect(Math.abs(final.won.get("A")! / n - 0.49)).toBeLessThan(0.01);
        expect(final.locked).toBeNull();
    });

    it("keeps a played slot's result", () => {
        const config: EventConfig = {
            ...majorLike([]),
            stages: [{ ...majorLike([]).stages[1], from: undefined, invited: ["A", "B", "C", "D"], exits: { r1: "3-4", r2: "2", champion: "1" } }],
        };
        const known = new Map([["po", [{ id: "1", teams: ["A", "D"] as [string, string], winner: 1 as const, round: 1, t: 100 }]]]);
        const { summaries } = simulateEvents([{ config, known, horizon: 0 }], fixedOdds(0.7), { n: 100, seed: 4 });
        const view = stageBrackets(config, summaries[0])[0];
        const semi = view.slots.find((s) => s.id === "r1-m1")!;
        expect(semi.results).toEqual([{ teams: ["A", "D"], winner: 1 }]);
        expect(view.slots.find((s) => s.id === "r2-m1")!.results).toBeUndefined();
    });

    it("counts each team once per Swiss pool and round", () => {
        const n = 300;
        const { summaries } = simulateEvents([{ config: majorLike(teams), known: new Map(), horizon: 0 }], fixedOdds(0.5), { n, seed: 1 });
        const swiss = [...summaries[0].slots.values()].filter((s) => s.stage === "swiss");
        const perRound = new Map<number, number>();
        for (const s of swiss) perRound.set(s.round, (perRound.get(s.round) ?? 0) + [...s.here.values()].reduce((a, b) => a + b, 0));
        expect(perRound.get(1)).toBe(16 * n);
        expect(perRound.get(2)).toBe(16 * n);
        expect(perRound.get(3)).toBe(16 * n);
        expect(swiss.find((s) => s.slot === "r3:1-1")!.runs).toBe(n);
    });

    it("fails loudly on an exit with no placement", () => {
        const config = majorLike(teams);
        delete config.stages[0].exits["0-3"];
        expect(() => simulateEvents([{ config, known: new Map(), horizon: 0 }], fixedOdds(0.5), { n: 1, seed: 1 })).toThrow(/0-3/);
    });
});
