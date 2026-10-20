import { describe, expect, it } from "vitest";
import { EloEngine, expectedScore, mapMargin, marginMultiplier } from "./engine.ts";
import { STARTING_PARAMS, type EloParams } from "./params.ts";
import type { EloMatch, EloPlayers } from "./types.ts";

const DAY = 86400;
const players: EloPlayers = {};
const roster = (prefix: string, country = "se") =>
    [1, 2, 3, 4, 5].map((i) => {
        const page = `${prefix}${i}`;
        players[page] = { nick: page, country };
        return page;
    });

let seq = 0;
const match = (t: number, teams: [string, string], lineups: [string[], string[]], winner: 0 | 1, maps: Array<[number, number]> = [[13, 7]]): EloMatch => ({
    id: `m${seq++}`,
    t,
    event: "E",
    tier: 1,
    lan: true,
    prizePool: null,
    bestOf: maps.length === 1 ? 1 : 3,
    teams,
    lineups,
    winner,
    forfeit: false,
    maps: maps.map((rounds) => ({ map: "Mirage", rounds })),
});

const params: EloParams = { ...STARTING_PARAMS, provisionalK: 0, kMap: 0, regress: 0.5, newRosterRegress: 0, tierGap: 0 };

describe("map math", () => {
    it("gives 10:1 odds at one scale of rating gap", () => {
        expect(expectedScore(400, 400)).toBeCloseTo(10 / 11, 10);
        expect(expectedScore(0, 400)).toBe(0.5);
    });

    it("uses round differential in regulation and otMargin in overtime", () => {
        expect(mapMargin([13, 4], 2)).toBe(9);
        expect(mapMargin([11, 13], 2)).toBe(2);
        expect(mapMargin([19, 17], 2)).toBe(2);
        expect(mapMargin([16, 12], 3)).toBe(3);
    });

    it("damps the margin multiplier when the favourite wins", () => {
        expect(marginMultiplier(5, 200, 0.5)).toBeLessThan(marginMultiplier(5, -200, 0.5));
        expect(marginMultiplier(0, 0, 0.5)).toBe(1);
    });
});

describe("EloEngine", () => {
    it("moves ratings zero-sum and predicts before updating", () => {
        const a = roster("a");
        const b = roster("b");
        const engine = new EloEngine(params, players);
        const [first, second] = engine.run([
            match(0, ["A", "B"], [a, b], 0),
            match(DAY, ["A", "B"], [a, b], 0),
        ]);
        expect(first.p).toBeCloseTo(0.5, 10);
        expect(second.p).toBeGreaterThan(0.5);
        const [la, lb] = [engine.teamLineageOf("A")!, engine.teamLineageOf("B")!];
        expect(la.rating + lb.rating).toBeCloseTo(3000, 6);
    });

    it("keeps the lineage through a one-series stand-in and flags it", () => {
        const a = roster("c");
        const b = roster("d");
        const engine = new EloEngine(params, players);
        const preds = engine.run([
            match(0, ["A", "B"], [a, b], 0),
            match(DAY, ["A", "B"], [[...a.slice(0, 4), "sub"], b], 0),
            match(2 * DAY, ["A", "B"], [a, b], 0),
        ]);
        expect(engine.lineages).toHaveLength(2);
        expect(preds.map((p) => p.standIn)).toEqual([false, true, false]);
        expect(engine.teamLineageOf("A")!.core.sort()).toEqual([...a].sort());
    });

    it("regresses toward the tier mean when the core changes by two players", () => {
        const a = roster("e");
        const b = roster("f");
        const newA = [...a.slice(0, 3), "new1", "new2"];
        const series = [
            ...Array.from({ length: 6 }, (_, i) => match(i * DAY, ["A", "B"], [a, b], 0)),
            ...Array.from({ length: 3 }, (_, i) => match((6 + i) * DAY, ["A", "B"], [newA, b], 0)),
        ];
        const rated = (regress: number) => {
            const engine = new EloEngine({ ...params, coreWindow: 3, regress }, players);
            engine.run(series);
            return engine.teamLineageOf("A")!;
        };
        const kept = rated(0);
        const regressed = rated(0.5);
        expect(regressed.id).toBe(0);
        expect(regressed.core.sort()).toEqual([...newA].sort());
        expect(kept.rating).toBeGreaterThan(1500);
        expect(regressed.rating).toBeLessThan(kept.rating);
    });

    it("starts a new lineage when three players change, seeded from their old ratings", () => {
        const a = roster("g");
        const b = roster("h");
        const c = roster("i");
        const engine = new EloEngine(params, players);
        engine.run([
            ...Array.from({ length: 10 }, (_, i) => match(i * DAY, ["A", "B"], [a, b], 0, [[13, 2]])),
            match(11 * DAY, ["A", "C"], [[a[0], a[1], "x1", "x2", "x3"], c], 0),
        ]);
        const strong = engine.lineages[0];
        const fresh = engine.teamLineageOf("A")!;
        expect(fresh).not.toBe(strong);
        expect(fresh.rating).toBeGreaterThan(1500);
        expect(fresh.rating).toBeLessThan(strong.rating);
    });

    it("follows a roster that moves to a new team page", () => {
        const a = roster("j");
        const b = roster("k");
        const engine = new EloEngine(params, players);
        engine.run([match(0, ["Old Org", "B"], [a, b], 0), match(DAY, ["New Org", "B"], [a, b], 0)]);
        expect(engine.teamLineageOf("New Org")).toBe(engine.lineages[0]);
        expect(engine.lineages).toHaveLength(2);
    });

    it("skips forfeits", () => {
        const engine = new EloEngine(params, players);
        const m = { ...match(0, ["A", "B"], [roster("l"), roster("m")], 0), forfeit: true };
        expect(engine.run([m])).toHaveLength(0);
    });
});
