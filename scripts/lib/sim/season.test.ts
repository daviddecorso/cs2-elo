import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Roster } from "../../../src/vrs/types.ts";
import type { Matchdata } from "../vrs/buildMatchdata.ts";
import { computeStandings } from "../vrs/valveModel.ts";
import { loadWorld } from "../vrs/valveWorld.ts";
import type { EventConfig } from "./config.ts";
import type { SeriesModel } from "./predict.ts";
import { fitActivity } from "./activity.ts";
import { BANDS } from "./fieldModel.ts";
import { entryStages, inPlaceOf, publicationDates, runSeason, splitField, type SeasonEvent, type SeasonFields, type SeasonInput } from "./season.ts";
import { applyDelta, latestLineups, simulationDelta } from "./vrsProjection.ts";

describe("publicationDates", () => {
    it("lists first Mondays after `from` through `to`, preferring a published list's date", () => {
        expect(publicationDates("2026-11-12", "2027-04-05", [])).toEqual(["2026-12-07", "2027-01-04", "2027-02-01", "2027-03-01", "2027-04-05"]);
        expect(publicationDates("2026-11-12", "2027-01-04", ["2026-12-08"])).toEqual(["2026-12-08", "2027-01-04"]);
        expect(publicationDates("2026-11-12", "2027-01-20", [])).toEqual(["2026-12-07", "2027-01-04", "2027-01-20"]);
    });
});

const config = (stages: EventConfig["stages"]): EventConfig => ({
    slug: "e",
    name: "E",
    liquipedia: "E",
    startDate: "2027-01-01",
    endDate: "2027-01-05",
    lan: true,
    stages,
});
const bracketStage = (id: string, seeds: number) => ({
    id,
    name: id,
    page: "E",
    format: "bracket" as const,
    bestOf: { default: 3 },
    invited: [],
    advance: 2,
    exits: {},
    matches: Array.from({ length: seeds / 2 }, (_, i) => ({ id: `m${i}`, teams: [`s${2 * i + 1}`, `s${2 * i + 2}`] as [string, string] })),
});

describe("entryStages and splitField", () => {
    it("sizes bracket groups from their seeds and snakes the field across them", () => {
        const stages = entryStages(config([bracketStage("A", 4), bracketStage("B", 4)]), 8);
        expect(stages).toEqual([
            { id: "A", capacity: 4 },
            { id: "B", capacity: 4 },
        ]);
        const split = splitField(["1", "2", "3", "4", "5", "6", "7", "8"], stages as Exclude<typeof stages, string>);
        expect(split.get("A")).toEqual(["1", "4", "5", "8"]);
        expect(split.get("B")).toEqual(["2", "3", "6", "7"]);
    });

    it("gives a lone unsized stage the whole field and rejects sizes that don't add up", () => {
        const swiss = { ...bracketStage("S", 2), format: "swiss" as const, matches: undefined };
        expect(entryStages(config([swiss]), 16)).toEqual([{ id: "S", capacity: 16 }]);
        expect(typeof entryStages(config([bracketStage("A", 4), bracketStage("B", 4)]), 16)).toBe("string");
    });
});

describe("inPlaceOf", () => {
    const f = (...teams: string[]) => teams.map((team) => ({ team, source: "vrs" as const }));

    it("puts the team in the seed of the one team it displaced", () => {
        expect(inPlaceOf(f("A", "B", "C", "D"), f("A", "X", "B", "C"), "X").map((e) => e.team)).toEqual(["A", "B", "C", "X"]);
    });

    it("keeps the reach field's own order when more than one team changed", () => {
        const reach = f("A", "X", "Y", "C");
        expect(inPlaceOf(f("A", "B", "C", "D"), reach, "X")).toBe(reach);
    });
});

describe("runSeason", () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "fixtures/matchdata.synthetic.json"), "utf8")) as Matchdata;
    const lastMatch = Math.max(...fixture.matches.map((m) => m.matchStartTime));
    const day = (offset: number) => new Date((lastMatch + offset * 86400) * 1000).toISOString().slice(0, 10);
    const lineups = latestLineups(fixture);
    const teams = [...lineups.keys()].slice(0, 4);
    const checkpoint = day(20);

    const eventConfig: EventConfig = {
        ...config([
            {
                id: "main",
                name: "Main",
                page: "Fixture/Cup",
                format: "single_elim",
                bestOf: { default: 3 },
                invited: [],
                advance: 0,
                exits: { r1: "3-4", r2: "2", champion: "1" },
            },
        ]),
        slug: "cup",
        liquipedia: "Fixture/Cup",
        startDate: day(3),
        endDate: day(5),
    };
    const coinFlip: SeriesModel = { resample: () => {}, setHorizon: () => {}, seriesProbability: () => 0.5 };
    const event: SeasonEvent = {
        config: eventConfig,
        projection: { config: eventConfig, eventId: "cup", prizePool: "$100,000", prizes: new Map([["1", 50000], ["2", 25000], ["3-4", 12500]]) },
        known: new Map(),
        horizon: 3,
        stint: { startDate: day(3), endDate: day(5), region: "Europe" },
        field: { slug: "cup", region: "Europe", tier: 1, teams: 4, announced: teams, announcedVia: {}, invites: undefined },
        listMonth: null,
        fixed: false,
        entryStages: [{ id: "main", capacity: 4 }],
        category: "lan1",
    };
    const input: SeasonInput = {
        events: [event],
        checkpoints: [{ date: checkpoint, world: loadWorld(fixture.matches, fixture.events, checkpoint, { windowEndsAtPull: true }) }],
        base: fixture,
        predictor: coinFlip,
        teams,
        toDelta: (ev, outcome) => simulationDelta([ev], [outcome], lineups, (t) => t),
        teamIdOf: (t) => t,
        listEntries: () => [],
        rosterId: (r: Roster) => r.rosterKey,
        published: new Map(),
        volumeCap: 10,
        n: 3,
        seed: 1,
    };

    it("plays the event before the checkpoint, and the checkpoint matches the full model on the same input", () => {
        const result = runSeason(input, 0);
        expect(result.events.get("cup")).toMatchObject({ field: teams.map((team) => ({ team, source: "announced" })) });
        expect(result.delta.matches).toHaveLength(3);
        const full = applyDelta(fixture, result.delta);
        expect(result.standings[0].rosters).toEqual(computeStandings(full.matches, full.events, checkpoint, { windowEndsAtPull: true }).rosters);
    });

    describe("reach", () => {
        const others = [...lineups.keys()].slice(4, 9);
        const [t4, t5, t6, t7, t8] = others;
        const invited = (tier: number): SeasonEvent => {
            const c: EventConfig = { ...eventConfig, slug: "open", name: "Open", liquipedia: "Fixture/Open", startDate: day(4), endDate: day(6) };
            return {
                ...event,
                config: c,
                projection: { ...event.projection, config: c, eventId: "open" },
                stint: { startDate: day(4), endDate: day(6), region: "Europe" },
                field: {
                    slug: "open",
                    region: "Europe",
                    tier,
                    teams: 4,
                    announced: [t4, t5],
                    announcedVia: {},
                    invites: { slots: [{ list: "Global", month: "2026-11", count: 2 }], qualifiers: [], verified: false },
                },
                listMonth: "2026-11",
            };
        };
        const entry = (team: string, rank: number) => ({ team, globalRank: rank, regionalRank: rank, region: "Europe" as const, subregion: null });
        // teams[0] is committed to the overlapping cup, so it declines and the slot passes down.
        const published = new Map([["2026-11", [entry(teams[0], 1), entry(t6, 2), entry(t7, 3), entry(t8, 4)]]]);
        const run = (tier: number) => runSeason({ ...input, events: [event, invited(tier)], published }, 0);

        it("gives the field a declining team would have had, displacing the last invitee", () => {
            const result = run(1);
            const played = result.events.get("open")!;
            expect(played.field?.map((f) => f.team).sort()).toEqual([t4, t5, t6, t7].sort());
            expect(result.reach.get("open")!(teams[0])?.map((f) => f.team).sort()).toEqual([teams[0], t4, t5, t6].sort());
            expect(result.reach.get("open")!(t8)).toBeNull();
            expect(result.reach.get("open")!(t6)?.some((f) => f.team === t6)).toBe(true);
        });

        it("keeps the Tournament Operation Requirements: no top-12 team at a lower-tier event", () => {
            expect(run(2).reach.get("open")!(teams[0])).toBeNull();
        });

        it("leaves the run unchanged when asked, and records each event's Valve ids", () => {
            const before = run(1);
            for (const team of [...teams, ...others]) before.reach.get("open")!(team);
            expect(run(1).delta).toEqual(before.delta);
            expect(before.eventIds.get("open")).toEqual(["open"]);
        });
    });

    describe("with learned fields", () => {
        const pool = [...lineups.keys()].slice(0, 9);
        const entry = (team: string, rank: number) => ({ team, globalRank: rank, regionalRank: rank, region: "Europe" as const, subregion: null });
        const published = new Map([["2026-11", pool.map((t, i) => entry(t, 30 + i))]]);
        const c: EventConfig = { ...eventConfig, slug: "drawn", name: "Drawn", liquipedia: "Fixture/Drawn" };
        const drawn: SeasonEvent = {
            ...event,
            config: c,
            projection: { ...event.projection, config: c, eventId: "drawn" },
            field: { slug: "drawn", region: "Europe", tier: 3, teams: 4, announced: [], announcedVia: {} },
            category: "lan34",
        };
        const flat = new Array<number>(BANDS).fill(1 / BANDS);
        const fields: SeasonFields = {
            models: new Map([
                ["drawn", { open: flat, qualifier: flat, region: null, subregion: null, sameRegion: null, acceptance: flat.map(() => 1), learnedRule: null, seriesWeight: 0 }],
            ]),
            unranked: [],
            drawable: new Set(pool.slice(0, 6)),
            activity: fitActivity([], [], { asOf: day(0) }),
            caps: () => ({ lan: 10, online: 10 }),
            horizonEnd: checkpoint,
            horizonDays: 20,
        };
        const learned = (run: number) => runSeason({ ...input, events: [drawn], published, fields }, run);

        it("draws a field with no rule from drawable teams only, the same way for the same run", () => {
            const field = learned(0).events.get("drawn")!.field!;
            expect(field).toHaveLength(4);
            expect(field.every((f) => f.source === "open" && fields.drawable.has(f.team))).toBe(true);
            expect(learned(0).events.get("drawn")!.field).toEqual(field);
        });

        it("gives a team left out the field it would have had", () => {
            const result = learned(0);
            const out = pool.slice(0, 6).find((t) => !result.events.get("drawn")!.field!.some((f) => f.team === t))!;
            expect(result.reach.get("drawn")!(out)?.some((f) => f.team === out)).toBe(true);
            expect(result.reach.get("drawn")!(pool[8])).toBeNull();
        });
    });

    describe("linked qualifiers", () => {
        const [a, b, c, d, e4, e5, e6, x, y, f, g] = [...lineups.keys()].slice(0, 11);
        const entry = (team: string, rank: number) => ({ team, globalRank: rank, regionalRank: rank, region: "Europe" as const, subregion: null });
        const make = (slug: string, start: number, end: number, lan: boolean, field: Partial<SeasonEvent["field"]>, extra: Partial<SeasonEvent> = {}): SeasonEvent => {
            const c: EventConfig = {
                ...eventConfig,
                slug,
                name: slug,
                liquipedia: `Fixture/${slug}`,
                startDate: day(start),
                endDate: day(end),
                lan,
                stages: eventConfig.stages.map((s) => ({ ...s, page: `Fixture/${slug}` })),
            };
            return {
                ...event,
                config: c,
                projection: { ...event.projection, config: c, eventId: slug },
                stint: { startDate: day(start), endDate: day(end), region: "Europe", kind: lan ? "lan" : "online" },
                field: { slug, region: "Europe", tier: 1, teams: 4, announced: [], announcedVia: {}, invites: undefined, ...field },
                listMonth: null,
                ...extra,
            };
        };
        const closed = { slots: [], qualifiers: [{ label: "Closed Qualifier", count: 1 }], verified: false };
        // `main` resolves at the run's start, before its qualifier plays, so its qualifier slot waits for the winner.
        const main = make("main", 10, 12, true, { announced: [e4, e5], invites: { ...closed, slots: [{ list: "Global", month: "2026-11", count: 1 }] } }, { listMonth: "2026-11" });
        const qualifier = make(
            "q",
            1,
            2,
            false,
            { announced: [a, b], invites: { slots: [{ list: "Global", month: "2026-11", count: 2 }], qualifiers: [], verified: false } },
            { feeds: { slug: "main", slotKey: "qualifier:Closed Qualifier", count: 1 }, category: "qualifier" }
        );
        const clashBase = make("clash", 10, 12, true, {}, { fixed: true });
        const clash = { ...clashBase, config: { ...clashBase.config, stages: clashBase.config.stages.map((s) => ({ ...s, invited: [x, y, f, g] })) } };
        // x and y play `clash`, which overlaps `main`; e6 takes main's VRS slot, so the qualifier invites c and d.
        const published = new Map([["2026-11", [entry(x, 1), entry(e6, 2), entry(c, 3), entry(d, 4), entry(y, 5)]]]);
        const run = (events: SeasonEvent[], r = 0) => runSeason({ ...input, events, published }, r);

        it("fills the slot with the qualifier's winner, and keeps out teams that can't attend the main event", () => {
            const result = run([qualifier, clash, main]);
            const q = result.events.get("q")!;
            if (q.field === null) throw new Error("qualifier not played");
            expect(q.field.map((f) => f.team).sort()).toEqual([a, b, c, d].sort());
            const winner = q.field.find((f) => q.outcome.placements.get(f.team) === "1")!.team;
            expect(result.qualifiedFrom.get("main")).toEqual([{ from: "q", team: winner }]);
            const field = result.events.get("main")!.field!;
            expect(field.map((f) => f.team).sort()).toEqual([e4, e5, e6, winner].sort());
            expect(field.find((f) => f.team === winner)?.source).toBe("qualifier");
        });

        it("draws the slot as before when the qualifier isn't in the run", () => {
            const result = run([{ ...qualifier, chance: 0 }, clash, main]);
            expect(result.events.has("q")).toBe(false);
            expect(result.qualifiedFrom.size).toBe(0);
            expect(result.events.get("main")!.field!.find((f) => f.source === "qualifier")?.team).toBe(c);
        });

        it("keeps the qualifier's winner in a reach field", () => {
            const result = run([qualifier, clash, main]);
            const winner = result.qualifiedFrom.get("main")![0].team;
            expect(result.reach.get("main")!(x)?.map((f) => f.team).sort()).toEqual([e4, e5, x, winner].sort());
        });

        it("plays a projected qualifier exactly when the projected event it feeds plays", () => {
            const events = [{ ...qualifier, chance: 0.3 }, clash, { ...main, chance: 0.5 }];
            const plays = [...Array(12).keys()].map((r) => run(events, r)).map((res) => [res.events.has("q"), res.events.has("main")]);
            expect(plays.every(([q, m]) => q === m)).toBe(true);
            expect(new Set(plays.map(([q]) => q)).size).toBe(2);
        });
    });

    it("regenerates a run from its seed and index alone", () => {
        const winners = (run: number) => runSeason(input, run).delta.matches.map((m) => `${m.team1Id}-${m.team2Id}-${m.winningTeam}`);
        expect(winners(2)).toEqual(winners(2));
        expect(new Set([0, 1, 2, 3, 4, 5].map((r) => winners(r).join())).size).toBeGreaterThan(1);
    });
});
