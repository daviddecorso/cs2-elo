import { describe, expect, it } from "vitest";
import { ASIA, EloEngine, expectedScore, FINE_OCEANIA, isOceaniaInternal, makeSkillLookup, mapMargin, marginMultiplier } from "./engine.ts";
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

    it("moves a core change toward incoming players' active ratings by transferWeight", () => {
        const a = roster("ta");
        const s = roster("ts");
        const b = roster("tb");
        const two: Array<[number, number]> = [[13, 2], [13, 2]];
        const setup = [
            ...Array.from({ length: 15 }, (_, i) => match(i * DAY, ["S", "B"], [s, b], 0, two)),
            ...Array.from({ length: 6 }, (_, i) => match((15 + i) * DAY, ["A", "B"], [a, b], 1)),
        ];
        const run = (transferWeight: number, incoming: string[]) => {
            const engine = new EloEngine({ ...params, regress: 0, coreWindow: 3, transferWeight }, players);
            const changed = [...a.slice(0, 3), ...incoming];
            const preds = engine.run([...setup, ...Array.from({ length: 2 }, (_, i) => match((21 + i) * DAY, ["A", "B"], [changed, b], 0))]);
            return { engine, flip: preds.at(-1)!.ratings[0] };
        };
        const off = run(0, [s[0], s[1]]);
        const on = run(1, [s[0], s[1]]);
        const strong = off.engine.lineages.find((l) => l.team === "S")!;
        expect(strong.maps).toBe(30);
        expect(on.flip - off.flip).toBeCloseTo((2 / 5) * (strong.rating - off.flip), 6);
        expect(run(1, ["tnew1", "tnew2"]).flip).toBeCloseTo(run(0, ["tnew1", "tnew2"]).flip, 10);
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

    it("ignores round share at roundWeight 0 and learns less from a close map above it", () => {
        const a = roster("rw");
        const b = roster("rx");
        const ratingAfter = (roundWeight: number, rounds: [number, number], roundSlope = params.roundSlope) => {
            const engine = new EloEngine({ ...params, roundWeight, roundSlope }, players);
            engine.run([match(0, ["A", "B"], [a, b], rounds[0] > rounds[1] ? 0 : 1, [rounds])]);
            return engine.teamLineageOf("A")!.rating;
        };
        expect(ratingAfter(0, [13, 11], 0.9)).toBe(ratingAfter(0, [13, 11]));
        const closeWin = ratingAfter(1, [13, 11]);
        expect(closeWin).toBeGreaterThan(1500);
        expect(closeWin).toBeLessThan(ratingAfter(0, [13, 11]));
        expect(ratingAfter(1, [13, 3]) - 1500).toBeGreaterThan(closeWin - 1500);
        expect(ratingAfter(1, [11, 13]) - 1500).toBeCloseTo(1500 - closeWin, 6);
    });

    it("lowers an insular Asian roster's cross-region odds by insularityPrior, predictions only by default", () => {
        const asia = roster("ia", "cn");
        const asia2 = roster("ib", "cn");
        const europe = roster("ic", "se");
        const series = [
            ...Array.from({ length: 4 }, (_, i) => match(i * DAY, ["A", "C"], [asia, asia2], (i % 2) as 0 | 1, [[13, 9], [9, 13], [13, 9]])),
            match(10 * DAY, ["A", "E"], [asia, europe], 0),
        ];
        const run = (overrides: Partial<EloParams>) => {
            const engine = new EloEngine({ ...params, ...overrides }, players);
            const preds = engine.run(series);
            return { last: preds.at(-1)!, rating: engine.teamLineageOf("A")!.rating };
        };
        const plain = run({});
        const insular = run({ insularityPrior: -100 });
        expect(plain.last.ownRegionShare[0]).toBe(1);
        expect(insular.last.maps[0].p).toBeCloseTo(expectedScore(plain.last.ratings[0] - plain.last.ratings[1] - 100, params.scale), 10);
        expect(insular.rating).toBe(plain.rating);
        expect(run({ insularityPrior: -100, insularityInUpdate: 1 }).rating).toBeGreaterThan(plain.rating);
        expect(run({ insularityPrior: -100 }).last.p).toBeLessThan(plain.last.p);
        const sameRegion = new EloEngine({ ...params, insularityPrior: -100 }, players).run(series.slice(0, 4));
        expect(sameRegion.map((p) => p.p)).toEqual(new EloEngine(params, players).run(series.slice(0, 4)).map((p) => p.p));
    });

    it("splits Oceania out of Asia in fineRegions and flags Oceania-internal series", () => {
        const [au, au2, cn] = [roster("oa", "au"), roster("ob", "nz"), roster("oc", "cn")];
        const [internal, cross] = new EloEngine(params, players).run([
            match(0, ["A", "B"], [au, au2], 0),
            match(DAY, ["A", "C"], [au, cn], 0),
        ]);
        expect(internal.regions).toEqual([ASIA, ASIA]);
        expect(internal.fineRegions).toEqual([FINE_OCEANIA, FINE_OCEANIA]);
        expect(isOceaniaInternal(internal)).toBe(true);
        expect(cross.fineRegions).toEqual([FINE_OCEANIA, ASIA]);
        expect(isOceaniaInternal(cross)).toBe(false);
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

    it("halves an earlier series' weight in θ per skillHalfLife days", () => {
        const history: Array<[number, number, number]> = [[DAY, 5, 10], [2 * DAY, 10, 10]];
        const decayed = makeSkillLookup({ k: 10, players: { p: history } }, 1);
        expect(decayed("p", 2 * DAY)).toBeCloseTo(2.5 / 15, 10);
        expect(decayed("p", 3 * DAY)).toBeCloseTo((1.25 + 5) / (2.5 + 5 + 10), 10);
    });

    it("scales the luck weight by the row's reliability under luckReliability", () => {
        const a = roster("lr");
        const b = roster("ls");
        const series = [match(0, ["A", "B"], [a, b], 0, [[13, 3]])];
        const ratingOf = (luckWeight: number, luckReliability: number) => {
            const engine = new EloEngine({ ...params, luckWeight, luckReliability }, players, () => ({ xMargin: -4, yHat: 0.3, reliability: 0.5 }));
            engine.run(series);
            return engine.teamLineageOf("A")!.rating;
        };
        expect(ratingOf(1, 1)).toBeCloseTo(ratingOf(0.5, 0), 10);
        expect(ratingOf(1, 0)).not.toBeCloseTo(ratingOf(0.5, 0), 4);
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

    it("takes debutOffset off an unrated debut's odds without moving any rating", () => {
        const a = roster("da");
        const b = roster("db");
        const c = roster("dc");
        const feed = [match(0, ["A", "B"], [a, b], 0), match(DAY, ["A", "C"], [a, c], 1), match(2 * DAY, ["A", "C"], [a, c], 1)];
        const plain = new EloEngine(params, players);
        const shifted = new EloEngine({ ...params, debutOffset: 200, debutMaps: 1 }, players);
        const [, p1, p2] = plain.run(feed);
        const [, s1, s2] = shifted.run(feed);
        expect(s1.seedsFromMean).toEqual([5, 5]);
        expect(s1.p).toBeGreaterThan(p1.p);
        expect(s2.p).toBeCloseTo(p2.p, 10);
        expect(shifted.teamLineageOf("C")!.rating).toBeCloseTo(plain.teamLineageOf("C")!.rating, 10);
    });

    it("takes newLanOffset off a new lineage's LAN odds only, without moving any rating", () => {
        const a = roster("na");
        const b = roster("nb");
        const c = roster("nc");
        const lanFeed = [match(0, ["A", "B"], [a, b], 0), match(DAY, ["A", "C"], [a, c], 1)];
        const onlineFeed = lanFeed.map((m) => ({ ...m, lan: false }));
        const shiftedParams = { ...params, newLanOffset: 200, newLanMaps: 2 };
        const [, lanPlain] = new EloEngine(params, players).run(lanFeed);
        const shifted = new EloEngine(shiftedParams, players);
        const [, lanShifted] = shifted.run(lanFeed);
        expect(lanShifted.p).toBeGreaterThan(lanPlain.p);
        const [, onlinePlain] = new EloEngine(params, players).run(onlineFeed);
        const [, onlineShifted] = new EloEngine(shiftedParams, players).run(onlineFeed);
        expect(onlineShifted.p).toBeCloseTo(onlinePlain.p, 10);
        expect(lanShifted.after).toEqual(lanPlain.after);
    });

    it("moves every player by the provisional-scaled player Elo update", () => {
        const a = roster("pa");
        const b = roster("pb");
        const [first, second] = new EloEngine(params, players).run([match(0, ["A", "B"], [a, b], 0), match(DAY, ["A", "B"], [a, b], 0)]);
        expect(first.playerGap).toBe(0);
        const delta = 16 * (1 + 0.5 * Math.log(7)) * 0.5 * (1 + 3);
        expect(second.playerGap).toBeCloseTo(2 * delta, 10);
    });

    it("blends player Elo into odds by playerBlend, never into lineage ratings", () => {
        const a = roster("qa");
        const b = roster("qb");
        const feed = [match(0, ["A", "B"], [a, b], 0), match(DAY, ["A", "B"], [a, b], 1)];
        const plain = new EloEngine(params, players);
        const ignored = new EloEngine({ ...params, playerK: 100 }, players);
        const blended = new EloEngine({ ...params, playerBlend: 1 }, players);
        const [, p] = plain.run(feed);
        const [, i] = ignored.run(feed);
        const [, s] = blended.run(feed);
        expect(i.p).toBe(p.p);
        expect(s.maps[0].p).toBeCloseTo(expectedScore(s.playerGap, params.scale), 10);
        expect(s.after).toEqual(p.after);
        const upcoming = blended.predictMatchup(["A", "B"], { t: 2 * DAY, bestOf: 1, lan: true, tier: 1 });
        expect(upcoming.maps[0].p).toBeCloseTo(expectedScore(blended.playerGap(a, b, 1), params.scale), 10);
    });
});
