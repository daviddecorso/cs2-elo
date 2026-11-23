import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maskOf } from "../../../src/sim/schedule.ts";
import type { Roster } from "../../../src/vrs/types.ts";
import type { Matchdata } from "../vrs/buildMatchdata.ts";
import { computeStandings } from "../vrs/valveModel.ts";
import { findRoster, freeze, scoreTeam, withoutEvents } from "../vrs/oneTeam.ts";
import { loadWorld, rerun, type RerunResult } from "../vrs/valveWorld.ts";
import type { EventConfig } from "./config.ts";
import {
    emptyOptimizerTally,
    optimizeRun,
    pickSchedules,
    qualifyPaths,
    rescoreOne,
    scheduleDelta,
    teamUniverse,
    type OptimizeRunContext,
    type OptimizerSetup,
    type OptimizerTally,
} from "./optimizer.ts";
import type { SeriesModel } from "./predict.ts";
import { runSeason, type SeasonEvent, type SeasonInput } from "./season.ts";
import { applyDelta, latestLineups, simulationDelta } from "./vrsProjection.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "fixtures/matchdata.synthetic.json"), "utf8")) as Matchdata;
const lastMatch = Math.max(...fixture.matches.map((m) => m.matchStartTime));
const day = (offset: number) => new Date((lastMatch + offset * 86400) * 1000).toISOString().slice(0, 10);
const lineups = latestLineups(fixture);
const pages = [...lineups.keys()];
const [t0, t1, t2, t3, t4, t5, t6, t7] = pages;
const checkpoint = day(20);
const caps = { low: 1, average: 2, high: 3 };

const singleElim = (slug: string, start: number): EventConfig => ({
    slug,
    name: slug,
    liquipedia: `Fixture/${slug}`,
    startDate: day(start),
    endDate: day(start + 2),
    lan: true,
    stages: [
        {
            id: "main",
            name: "Main",
            page: `Fixture/${slug}`,
            format: "single_elim",
            bestOf: { default: 3 },
            invited: [],
            advance: 0,
            exits: { r1: "3-4", r2: "2", champion: "1" },
        },
    ],
});
const seasonEvent = (config: EventConfig, field: SeasonEvent["field"], listMonth: string | null): SeasonEvent => ({
    config,
    projection: { config, eventId: config.slug, prizePool: "$100,000", prizes: new Map([["1", 50000], ["2", 25000], ["3-4", 12500]]) },
    known: new Map(),
    horizon: 3,
    stint: { startDate: config.startDate, endDate: config.endDate, region: "Europe" },
    field,
    listMonth,
    fixed: false,
    entryStages: [{ id: "main", capacity: 4 }],
    category: "lan1",
});

// t0 is announced for the cup, so it declines the overlapping open's invite, which passes down to t7.
const cup = seasonEvent(singleElim("cup", 3), { slug: "cup", region: "Europe", tier: 1, teams: 4, announced: [t0, t1, t2, t3], announcedVia: {} }, null);
const open = seasonEvent(
    singleElim("open", 4),
    {
        slug: "open",
        region: "Europe",
        tier: 1,
        teams: 4,
        announced: [t4, t5],
        announcedVia: {},
        invites: { slots: [{ list: "Global", month: "2026-11", count: 2 }], qualifiers: [], verified: false },
    },
    "2026-11"
);
const entry = (team: string, rank: number) => ({ team, globalRank: rank, regionalRank: rank, region: "Europe" as const, subregion: null });
const coinFlip: SeriesModel = { resample: () => {}, setHorizon: () => {}, seriesProbability: () => 0.5 };
const input: SeasonInput = {
    events: [cup, open],
    checkpoints: [{ date: checkpoint, world: loadWorld(fixture.matches, fixture.events, checkpoint, { windowEndsAtPull: true }) }],
    base: fixture,
    predictor: coinFlip,
    teams: pages,
    toDelta: (ev, outcome) => simulationDelta([ev], [outcome], lineups, (t) => t),
    teamIdOf: (t) => t,
    listEntries: () => [],
    rosterId: (r: Roster) => r.rosterKey,
    published: new Map([["2026-11", [entry(t0, 1), entry(t6, 2), entry(t7, 3)]]]),
    volumeCap: 10,
    n: 2,
    seed: 1,
};

const team = (page: string) => {
    const lineup = lineups.get(page)!;
    return {
        team: page,
        teamId: page,
        rosterKey: page,
        teamName: lineup.name,
        region: "Europe" as const,
        playerIds: lineup.players.map((p) => String(p.playerId)),
        nicks: lineup.players.map((p) => p.nick),
        ...teamUniverse(input.events, page, day(0), caps),
        paths: [] as number[],
    };
};
const slots = { 3: { Europe: 1, Americas: 0, Asia: 0 }, 2: { Europe: 1, Americas: 0, Asia: 0 } };
const opt: OptimizerSetup = {
    teams: [team(t0)],
    caps,
    previousMajor: { event: "none", slots: { stage3: slots[3], stage2: slots[2] } },
    stage1: { Europe: 2, Americas: 0, Asia: 0 },
    eligible: () => true,
};
const ctx: OptimizeRunContext = { input, opt, asOf: day(0), previousSlug: null, regionOf: () => () => "Europe" };

const play = () => {
    const captured: { result: RerunResult | null } = { result: null };
    const result = runSeason({ ...input, onCheckpoint: (_r, _cp, res) => (captured.result = res) }, 0);
    const state = (captured.result as RerunResult | null)!.state;
    const frozen = freeze(state);
    const tally = emptyOptimizerTally(opt, input.n);
    const data = optimizeRun(ctx, tally, 0, result, state, true)!;
    return { result, frozen, tally, data };
};

describe("teamUniverse", () => {
    it("takes announced events and events with open slots, and drops conflicting subsets", () => {
        const t = team(t0);
        expect(t.universe).toEqual([0, 1]);
        expect([...t.announced]).toEqual(["cup"]);
        expect(t.masks).toEqual([0, 1, 2]);
        expect(teamUniverse(input.events, t0, day(3), caps)).toMatchObject({ universe: [1], committed: ["cup"] });
    });

    it("offers a drawn field with no invite rule, but not an unannounced stand-in", () => {
        const drawn = { ...open, config: { ...open.config, slug: "drawn" }, field: { ...open.field, slug: "drawn", invites: undefined } };
        const standIn = { ...drawn, config: { ...drawn.config, slug: "stand-in" }, unannounced: true };
        expect(teamUniverse([cup, drawn, standIn], t0, day(0), caps).universe).toEqual([0, 1]);
    });

    describe("with a Major invite", () => {
        const major = { ...cup, projection: { ...cup.projection, major: true } };
        const later = seasonEvent(singleElim("later", 20), { ...open.field, slug: "later" }, "2026-11");

        it("puts the Major in every schedule and offers nothing open that clashes with it", () => {
            const u = teamUniverse([major, open, later], t0, day(0), caps);
            expect(u).toMatchObject({ universe: [0, 2], required: 1, masks: [1, 3] });
        });

        it("blocks a Major's dates once it's under way", () => {
            const u = teamUniverse([major, open, later], t0, day(3), caps);
            expect(u).toMatchObject({ universe: [2], committed: ["cup"], required: 0, masks: [0, 1] });
        });

        it("keeps an announced clash as a candidate that no schedule takes", () => {
            const clash = { ...open, field: { ...open.field, announced: [t0, t4] } };
            for (const [asOf, masks] of [[day(0), [1]], [day(3), [0]]] as const) {
                const u = teamUniverse([major, clash], t0, asOf, caps);
                expect(u.universe).toContain(1);
                expect(u.masks).toEqual(masks);
            }
        });

        it("keeps the Major when the caps are already full", () => {
            const u = teamUniverse([major, later], t0, day(0), { low: 0, average: 0, high: 0 });
            expect(u.masks).toEqual([1]);
        });

        it("keeps the Major ahead of richer events past the universe limit", () => {
            const prizes = new Map([["1", 1e7]]);
            const richer = Array.from({ length: 12 }, (_, i) => {
                const e = seasonEvent(singleElim(`rich-${i}`, 20 + 10 * i), { ...open.field, slug: `rich-${i}`, announced: [t0] }, null);
                return { ...e, projection: { ...e.projection, prizes } };
            });
            const u = teamUniverse([...richer, major], t0, day(0), caps);
            expect(u.universe[0]).toBe(12);
            expect(u.masks.every((m) => m & 1)).toBe(true);
        });

        it("recommends it at every volume and goal, even when skipping scores better", () => {
            const events = [major, later];
            const setup: OptimizerSetup = {
                ...opt,
                caps: { low: 0, average: 1, high: 2 },
                teams: [{ ...opt.teams[0], ...teamUniverse(events, t0, day(0), caps) }],
            };
            const tally = emptyOptimizerTally(setup, 1);
            const scores = tally.teams[0];
            scores.seen.fill(1);
            tally.slotsKnown.fill(1);
            scores.reach.fill(1);
            scores.points.set([100, 50]);
            const pick = pickSchedules(tally, setup, { ...input, events }, 0);
            expect(pick.recommended).toEqual([{ m: 0, volumes: ["low", "average", "high"], goals: ["points", "invite"] }]);
        });
    });
});

describe("optimizeRun", () => {
    const { result, frozen, tally, data } = play();
    const t = tally.teams[0];
    const self = findRoster(frozen, opt.teams[0].playerIds);
    const standings = result.standings[0];
    const listed = standings.rosters.find((r) => r.rosterKey === frozen.rosters[self].rosterKey)!;
    const at = (mask: number) => t.points[opt.teams[0].masks.indexOf(mask) * tally.n];

    it("scores the schedule the run played exactly, and the empty one as the ledger without it", () => {
        expect(t.rulesPoints[0]).toBeCloseTo(listed.points, 3);
        expect(at(maskOf([0]))).toBeCloseTo(listed.points, 3);
        const without = scoreTeam(frozen, withoutEvents(frozen.ledgers[self], new Set(["cup"]))).points;
        expect(at(0)).toBeCloseTo(without, 3);
    });

    it("replays the event it declined with it in the field", () => {
        expect(tally.replays).toBe(1);
        expect([...t.reach]).toEqual([1, 1]);
        expect([...t.attended]).toEqual([1, 0]);
        const replayed = data.replays.get(`open|${t0}`)!;
        const played = new Set(replayed.matches.flatMap((m) => [String(m.team1Id), String(m.team2Id)]));
        expect(played).toEqual(new Set([t0, t4, t5, t6]));
        expect(at(maskOf([1]))).not.toBeCloseTo(at(0), 3);
    });

    it("builds re-score deltas that swap the team's events, and re-scores the played schedule exactly", () => {
        const kept = scheduleDelta(data, input, opt.teams[0], new Set(["cup"]));
        expect(kept).toEqual(result.delta);
        expect(rescoreOne(standings, data.slots, opt, opt.teams[0]).points).toBeCloseTo(listed.points, 3);

        const swapped = scheduleDelta(data, input, opt.teams[0], new Set(["open"]));
        const has = (eventId: string, page: string) => swapped.matches.some((m) => m.eventId === eventId && (m.team1Id === page || m.team2Id === page));
        expect(has("cup", t0)).toBe(false);
        expect(has("cup", t1)).toBe(true);
        expect(has("open", t0)).toBe(true);
        expect(has("open", t7)).toBe(false);
        expect(swapped.events.find((e) => e.eventId === "cup")!.prizeDistribution.some((p) => p.teamId === t0)).toBe(false);

        const exact = rerun(input.checkpoints[0].world, swapped);
        const full = applyDelta(fixture, swapped);
        expect(exact.standings.rosters).toEqual(computeStandings(full.matches, full.events, checkpoint, { windowEndsAtPull: true }).rosters);
    });
});

describe("qualifying paths", () => {
    // t0 plays the cup, which shares days with the online qualifier, so in the run it skips the qualifier for `main`.
    const qConfig = { ...singleElim("q", 3), lan: false };
    const q: SeasonEvent = {
        ...seasonEvent(
            qConfig,
            {
                slug: "q",
                region: "Europe",
                tier: 1,
                teams: 4,
                announced: [t4, t5],
                announcedVia: {},
                invites: { slots: [{ list: "Global", month: "2026-11", count: 2 }], qualifiers: [], verified: false },
            },
            "2026-11"
        ),
        stint: { startDate: qConfig.startDate, endDate: qConfig.endDate, region: "Europe", kind: "online" },
        feeds: { slug: "main", slotKey: "qualifier:Closed Qualifier", count: 1 },
        category: "qualifier",
    };
    const main = seasonEvent(
        singleElim("main", 9),
        {
            slug: "main",
            region: "Europe",
            tier: 1,
            teams: 4,
            announced: [t1, t2, t3],
            announcedVia: {},
            invites: { slots: [], qualifiers: [{ label: "Closed Qualifier", count: 1 }], verified: false },
        },
        "2026-11"
    );
    const events = [cup, q, main];
    const qInput = { ...input, events };
    const wins = (team: string): SeriesModel => ({ ...coinFlip, seriesProbability: (a, b) => (a === team ? 1 : b === team ? 0 : 0.5) });
    const runFor = (predictor: SeriesModel) => {
        const captured: { result: RerunResult | null } = { result: null };
        const withPredictor = { ...qInput, predictor };
        const result = runSeason({ ...withPredictor, onCheckpoint: (_r, _cp, res) => (captured.result = res) }, 0);
        const setup: OptimizerSetup = { ...opt, teams: [{ ...opt.teams[0], ...teamUniverse(events, t0, day(0), caps), paths: qualifyPaths(events, t0, "Europe", day(0)) }] };
        const tally = emptyOptimizerTally(setup, input.n);
        optimizeRun({ ...ctx, input: withPredictor, opt: setup }, tally, 0, result, captured.result!.state, false);
        return { result, tally, setup };
    };

    it("lists the event a regional feeder qualifies for, and not for a team from another region", () => {
        expect(qualifyPaths(events, t0, "Europe", day(0))).toEqual([2]);
        expect(qualifyPaths(events, t0, "Asia", day(0))).toEqual([]);
        expect(qualifyPaths(events, t1, "Europe", day(0))).toEqual([]);
    });

    it("replays the feeder with the team in it and counts a qualification only within the feeder's slots", () => {
        const won = runFor(wins(t0));
        expect(won.result.events.get("q")!.field!.some((f) => f.team === t0)).toBe(false);
        expect([...won.tally.teams[0].pathEntered]).toEqual([1]);
        expect([...won.tally.teams[0].pathQualified]).toEqual([1]);
        expect(won.tally.pathReplays).toBe(1);
        const lost = runFor({ ...coinFlip, seriesProbability: (a, b) => (a === t0 ? 0 : b === t0 ? 1 : 0.5) });
        expect([...lost.tally.teams[0].pathEntered]).toEqual([1]);
        expect([...lost.tally.teams[0].pathQualified]).toEqual([0]);
    });

    it("climbs through an open qualifier when the closed one has no place it could take", () => {
        const oConfig = { ...singleElim("o", 3), lan: false };
        const o: SeasonEvent = {
            ...q,
            config: oConfig,
            projection: { ...q.projection, config: oConfig, eventId: "o" },
            stint: { startDate: oConfig.startDate, endDate: oConfig.endDate, region: "Europe", kind: "online" },
            field: { ...q.field, slug: "o", announced: [t5, t6] },
            feeds: { slug: "q", slotKey: "qualifier:Fixture/o", count: 1 },
        };
        const closedConfig = { ...singleElim("q", 6), lan: false };
        const closedQ: SeasonEvent = {
            ...q,
            config: closedConfig,
            projection: { ...q.projection, config: closedConfig },
            stint: { startDate: closedConfig.startDate, endDate: closedConfig.endDate, region: "Europe", kind: "online" },
            field: { ...q.field, announced: [t1, t2, t3], invites: undefined },
            listMonth: null,
        };
        const chainMain = { ...main, field: { ...main.field, announced: [t5, t6, t7] } };
        const chain = [cup, o, closedQ, chainMain];
        const chainInput = { ...input, events: chain, predictor: wins(t0), published: new Map([["2026-11", [entry(t0, 1), entry(t7, 2), entry(t4, 3)]]]) };
        const captured: { result: RerunResult | null } = { result: null };
        const result = runSeason({ ...chainInput, onCheckpoint: (_r, _cp, res) => (captured.result = res) }, 0);
        expect(result.qualifiedFrom.get("q")?.map((x) => x.from)).toEqual(["o"]);
        const setup: OptimizerSetup = { ...opt, teams: [{ ...opt.teams[0], ...teamUniverse(chain, t0, day(0), caps), paths: qualifyPaths(chain, t0, "Europe", day(0)) }] };
        expect(setup.teams[0].paths).toEqual([3]);
        const tally = emptyOptimizerTally(setup, input.n);
        optimizeRun({ ...ctx, input: chainInput, opt: setup }, tally, 0, result, captured.result!.state, false);
        expect([...tally.teams[0].pathEntered]).toEqual([1]);
        expect([...tally.teams[0].pathQualified]).toEqual([1]);
        expect(tally.pathReplays).toBe(2);
    });
});

describe("pickSchedules", () => {
    const events = ["a", "b", "c", "d"].map((slug) => ({ config: { slug } })) as unknown as SeasonEvent[];
    const setup: OptimizerSetup = {
        ...opt,
        caps,
        teams: [{ ...opt.teams[0], universe: [0, 1, 2, 3], announced: new Set(["a"]), committed: [], required: 0, masks: [...Array(16).keys()] }],
    };
    const n = 10;
    const tally: OptimizerTally = emptyOptimizerTally(setup, n);
    const t = tally.teams[0];
    t.seen.fill(1);
    tally.slotsKnown.fill(1);
    t.reach.set([n, n, 0, n]);
    t.qualifierOnly.set([0, 0, 0, n]);
    const points: Record<number, number> = { 0: 50, 1: 100, 2: 120, 3: 150 };
    const invited: Record<number, number> = { 1: 1 };
    for (let m = 0; m < 16; m++) {
        for (let r = 0; r < n; r++) {
            t.points[m * n + r] = points[m] ?? 0;
            t.invited[m * n + r] = invited[m] ?? 0;
        }
    }
    const pick = pickSchedules(tally, setup, { ...input, events }, 0);

    it("keeps announced and reachable events, and sets aside rarely reached and qualifier-only ones", () => {
        expect(pick.candidates).toEqual([0, 1]);
        expect(pick.requiresQualifying).toEqual([3]);
        expect(pick.subsets.map((s) => s.m)).toEqual([0, 1, 2, 3]);
    });

    it("picks the best schedule per volume cap and goal", () => {
        expect(pick.recommended).toEqual([
            { m: 2, volumes: ["low"], goals: ["points"] },
            { m: 1, volumes: ["low", "average", "high"], goals: ["invite"] },
            { m: 3, volumes: ["average", "high"], goals: ["points"] },
        ]);
    });
});
