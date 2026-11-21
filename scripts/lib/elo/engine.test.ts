import { describe, expect, it } from "vitest";
import { EloEngine, expectedScore, makeSkillLookup, mapMargin, marginMultiplier } from "./engine.ts";
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

    it("scales MR15 margins to MR12 and starts CS:GO overtime at 15", () => {
        expect(mapMargin([16, 1], 2, true)).toBeCloseTo(12, 10);
        expect(mapMargin([14, 16], 2, true)).toBeCloseTo(1.6, 10);
        expect(mapMargin([19, 15], 2, true)).toBe(2);
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

    it("records each map's pre-map ratings, updated between maps of a series", () => {
        const engine = new EloEngine(params, players);
        const [series] = engine.run([match(0, ["A", "B"], [roster("n"), roster("o")], 0, [[13, 5], [13, 9]])]);
        const [first, second] = series.maps;
        expect(first.ratings).toEqual([1500, 1500]);
        expect(second.ratings[0]).toBeGreaterThan(1500);
        expect(second.ratings[0] + second.ratings[1]).toBeCloseTo(3000, 6);
        expect(second.p).toBeCloseTo(expectedScore(second.ratings[0] - second.ratings[1], params.scale), 10);
    });

    it("regresses every lineage by gameRegress at the first CS2 series after CS:GO", () => {
        const a = roster("g");
        const b = roster("h");
        const series = [
            ...Array.from({ length: 4 }, (_, i) => ({ ...match(i * DAY, ["A", "B"], [a, b], 0, [[16, 8]]), game: "csgo" as const })),
            match(5 * DAY, ["A", "B"], [a, b], 0),
        ];
        const firstCs2 = (gameRegress: number) => new EloEngine({ ...params, gameRegress }, players).run(series).at(-1)!;
        expect(firstCs2(0).p).toBeGreaterThan(0.5);
        expect(firstCs2(1).p).toBeCloseTo(0.5, 10);
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

    it("ignores luck rows at luckWeight 0 and moves updates toward them above it", () => {
        const a = roster("p");
        const b = roster("q");
        const series = [match(0, ["A", "B"], [a, b], 0, [[13, 3]]), match(DAY, ["A", "B"], [a, b], 0, [[13, 3]])];
        const unlucky = () => ({ xMargin: -4, yHat: 0.3 });
        const ratingOf = (luckWeight: number, luck?: () => { xMargin: number; yHat: number }) => {
            const engine = new EloEngine({ ...params, luckWeight }, players, luck);
            const preds = engine.run(series);
            return { rating: engine.teamLineageOf("A")!.rating, preds };
        };
        const plain = ratingOf(0);
        const off = ratingOf(0, unlucky);
        expect(off.rating).toBe(plain.rating);
        expect(off.preds).toEqual(plain.preds);
        const half = ratingOf(0.5, unlucky);
        const full = ratingOf(1, unlucky);
        expect(half.rating).toBeLessThan(plain.rating);
        expect(full.rating).toBeLessThan(1500);
        expect(half.preds[0].maps[0].y).toBe(1);
        expect(full.preds[0].maps[0].margin).toBe(10);
    });

    it("ignores skill at skillWeight 0 and shifts the prediction toward the more skilled side above it", () => {
        const a = roster("t");
        const b = roster("u");
        const series = [match(0, ["A", "B"], [a, b], 0), match(DAY, ["A", "B"], [a, b], 1)];
        const skill = (player: string) => (player.startsWith("t") ? 0.1 : 0);
        const run = (skillWeight: number, lookup?: (player: string, t: number) => number) =>
            new EloEngine({ ...params, skillWeight }, players, undefined, lookup).run(series);
        const plain = run(0);
        const off = run(0, skill);
        expect(off.map((p) => p.p)).toEqual(plain.map((p) => p.p));
        expect(off[0].skillGap).toBeCloseTo(0.1, 10);
        const on = run(500, skill);
        expect(on[0].p).toBeGreaterThan(0.5);
        expect(on[0].maps[0].p).toBeCloseTo(expectedScore(50, params.scale), 10);
    });

    it("takes θ at a series only from series with an earlier t", () => {
        const a = roster("v");
        const b = roster("w");
        const history: Array<[number, number, number]> = [[DAY, 5, 10], [2 * DAY, 10, 10]];
        const flat: Array<[number, number, number]> = [[DAY, 0, 10]];
        const skill = makeSkillLookup({
            k: 10,
            players: { v1: history, v2: history, v3: history, w1: flat, w2: flat, w3: flat },
        });
        expect(skill("v1", DAY)).toBeUndefined();
        expect(skill("v1", 2 * DAY)).toBeCloseTo(5 / 20, 10);
        expect(skill("v1", 3 * DAY)).toBeCloseTo(15 / 30, 10);
        expect(skill("nobody", 3 * DAY)).toBeUndefined();
        const preds = new EloEngine(params, players, undefined, skill).run([
            match(DAY, ["A", "B"], [a, b], 0),
            match(2 * DAY, ["A", "B"], [a, b], 0),
        ]);
        expect(preds[0].skillGap).toBe(0);
        expect(preds[1].skillGap).toBeCloseTo(0.25, 10);
    });

    it("gives players without history their teammates' mean θ and needs 3 with history per side", () => {
        const a = roster("x");
        const b = roster("y");
        const series = [match(0, ["A", "B"], [a, b], 0)];
        const gapWith = (known: Record<string, number>) =>
            new EloEngine(params, players, undefined, (player) => known[player]).run(series)[0].skillGap;
        expect(gapWith({ x1: 0.3, x2: 0.1, x3: 0.2, y1: 0, y2: 0, y3: 0 })).toBeCloseTo(0.2, 10);
        expect(gapWith({ x1: 0.3, x2: 0.1, y1: 0, y2: 0, y3: 0 })).toBe(0);
    });

    it("records lineage ids and pre-series pool offsets", () => {
        const engine = new EloEngine({ ...params, kMap: 8 }, players);
        const a = roster("r");
        const b = roster("s");
        const [, second] = engine.run([match(0, ["A", "B"], [a, b], 0), match(DAY, ["A", "B"], [a, b], 0)]);
        expect(second.lineages).toEqual([engine.teamLineageOf("A")!.id, engine.teamLineageOf("B")!.id]);
        expect(Object.keys(second.poolOffsets[0])).toEqual(["Mirage"]);
    });

    it("skips forfeits", () => {
        const engine = new EloEngine(params, players);
        const m = { ...match(0, ["A", "B"], [roster("l"), roster("m")], 0), forfeit: true };
        expect(engine.run([m])).toHaveLength(0);
    });
});
