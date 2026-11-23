import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Roster } from "../../../../src/vrs/types.ts";
import type { Matchdata } from "../../vrs/buildMatchdata.ts";
import { findRoster, freeze, scoreTeam } from "../../vrs/oneTeam.ts";
import { computeStandings } from "../../vrs/valveModel.ts";
import { loadWorld, rerun, type RerunResult } from "../../vrs/valveWorld.ts";
import type { EventConfig } from "../config.ts";
import { GAIN_PARTS, NOT_QUALIFIED } from "../gain.ts";
import type { OptimizeRunContext, OptimizerSetup, OptimizerTeam } from "../optimizer.ts";
import type { SeriesModel } from "../predict.ts";
import { runSeason, type SeasonEvent, type SeasonInput } from "../season.ts";
import { applyDelta, latestLineups, simulationDelta } from "../vrsProjection.ts";
import { buildOptions } from "./options.ts";
import { planDelta, planRun, scoreSchedule } from "./planShard.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "fixtures/matchdata.synthetic.json"), "utf8")) as Matchdata;
const lastMatch = Math.max(...fixture.matches.map((m) => m.matchStartTime));
const day = (offset: number) => new Date((lastMatch + offset * 86400) * 1000).toISOString().slice(0, 10);
const lineups = latestLineups(fixture);
const [t0, t1, t2, t3, t4, t5, t6, t7] = [...lineups.keys()];
const checkpoint = day(20);

const singleElim = (slug: string, start: number, lan = true): EventConfig => ({
    slug,
    name: slug,
    liquipedia: `Fixture/${slug}`,
    startDate: day(start),
    endDate: day(start + 2),
    lan,
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
const seasonEvent = (config: EventConfig, field: SeasonEvent["field"], extra: Partial<SeasonEvent> = {}): SeasonEvent => ({
    config,
    projection: { config, eventId: config.slug, prizePool: "$100,000", prizes: new Map([["1", 50000], ["2", 25000], ["3-4", 12500]]) },
    known: new Map(),
    horizon: 3,
    stint: { startDate: config.startDate, endDate: config.endDate, region: "Europe", kind: config.lan ? "lan" : "online" },
    field,
    listMonth: "2026-11",
    fixed: false,
    entryStages: [{ id: "main", capacity: 4 }],
    category: "lan1",
    ...extra,
});

// t0 plays the cup, which shares days with the online qualifier, so in the run it skips the qualifier for `main`.
const cup = seasonEvent(singleElim("cup", 3), { slug: "cup", region: "Europe", tier: 1, teams: 4, announced: [t0, t1, t2, t3], announcedVia: {} });
const q = seasonEvent(
    singleElim("q", 3, false),
    {
        slug: "q",
        region: "Europe",
        tier: 1,
        teams: 4,
        announced: [t4, t5],
        announcedVia: {},
        invites: { slots: [{ list: "Global", month: "2026-11", count: 2 }], qualifiers: [], verified: false },
    },
    { feeds: { slug: "main", slotKey: "qualifier:Closed Qualifier", count: 1 }, category: "qualifier" }
);
const main = seasonEvent(singleElim("main", 9), {
    slug: "main",
    region: "Europe",
    tier: 1,
    teams: 4,
    announced: [t1, t2, t3],
    announcedVia: {},
    invites: { slots: [], qualifiers: [{ label: "Closed Qualifier", count: 1 }], verified: false },
});
const events = [cup, q, main];
const entry = (team: string, rank: number) => ({ team, globalRank: rank, regionalRank: rank, region: "Europe" as const, subregion: null });
const coinFlip: SeriesModel = { resample: () => {}, setHorizon: () => {}, seriesProbability: () => 0.5 };
const input: SeasonInput = {
    events,
    checkpoints: [{ date: checkpoint, world: loadWorld(fixture.matches, fixture.events, checkpoint, { windowEndsAtPull: true }) }],
    base: fixture,
    predictor: coinFlip,
    teams: [...lineups.keys()],
    toDelta: (ev, outcome) => simulationDelta([ev], [outcome], lineups, (t) => t),
    teamIdOf: (t) => t,
    listEntries: () => [],
    rosterId: (r: Roster) => r.rosterKey,
    published: new Map([["2026-11", [entry(t0, 1), entry(t6, 2), entry(t7, 3)]]]),
    volumeCap: 10,
    n: 1,
    seed: 1,
};
const lineup = lineups.get(t0)!;
const team: OptimizerTeam = {
    team: t0,
    teamId: t0,
    rosterKey: t0,
    teamName: lineup.name,
    region: "Europe",
    playerIds: lineup.players.map((p) => String(p.playerId)),
    nicks: lineup.players.map((p) => p.nick),
    universe: [],
    committed: [],
    announced: new Set(),
    required: 0,
    masks: [0],
    paths: [],
};
const slots = { 3: { Europe: 1, Americas: 0, Asia: 0 }, 2: { Europe: 1, Americas: 0, Asia: 0 } };
const opt: OptimizerSetup = {
    teams: [team],
    caps: { low: 1, average: 2, high: 3 },
    previousMajor: { event: "none", slots: { stage3: slots[3], stage2: slots[2] } },
    stage1: { Europe: 2, Americas: 0, Asia: 0 },
    eligible: () => true,
};
const set = buildOptions(events, t0, "Europe", day(0), () => false);

const play = (predictor: SeriesModel) => {
    const runInput = { ...input, predictor };
    const captured: { result: RerunResult | null } = { result: null };
    const result = runSeason({ ...runInput, onCheckpoint: (_r, _cp, res) => (captured.result = res) }, 0);
    const state = captured.result!.state;
    const frozen = freeze(state);
    const ctx: OptimizeRunContext = { input: runInput, opt, asOf: day(0), previousSlug: null, regionOf: () => () => "Europe" };
    return { result, frozen, data: planRun(ctx, set, team, 0, result, state, frozen, true) };
};
const always = (winner: string): SeriesModel => ({ ...coinFlip, seriesProbability: (a, b) => (a === winner ? 1 : b === winner ? 0 : 0.5) });
const never = (loser: string): SeriesModel => ({ ...coinFlip, seriesProbability: (a, b) => (a === loser ? 0 : b === loser ? 1 : 0.5) });
const eventIdsOf = (frag: { events: Array<{ eventId: string }> } | null) => (frag ? [...new Set(frag.events.map((e) => e.eventId))].sort() : null);

describe("planRun", () => {
    it("offers the fed event only through its qualifier, with the cup locked", () => {
        expect(set.locked).toEqual([0]);
        expect(set.options).toEqual([{ kind: "qualify", event: 2, holds: [2, 1], counts: [2, 1] }]);
    });

    it("adds the qualifier and the main event when the team qualifies, in place of the team the qualifier sent", () => {
        const { result, data } = play(always(t0));
        expect(data.info.entered[0]).toBe(1);
        expect(data.info.qualified[0]).toBe(1);
        expect(eventIdsOf(data.fragments[0])).toEqual(["main", "q"]);
        const sent = result.qualifiedFrom.get("main")![0].team;
        const delta = planDelta(data.exact!, t0, [0]);
        const teamsAt = (eventId: string) => new Set(delta.matches.filter((m) => m.eventId === eventId).flatMap((m) => [String(m.team1Id), String(m.team2Id)]));
        expect(teamsAt("main").has(t0)).toBe(true);
        expect(teamsAt("main").has(sent)).toBe(false);
        expect(teamsAt("q").has(t0)).toBe(true);
        const exact = rerun(input.checkpoints[0].world, delta);
        const full = applyDelta(fixture, delta);
        expect(exact.standings.rosters).toEqual(computeStandings(full.matches, full.events, checkpoint, { windowEndsAtPull: true }).rosters);
    });

    it("adds only the qualifier when the team fails there", () => {
        const { data } = play(never(t0));
        expect(data.info.entered[0]).toBe(1);
        expect(data.info.qualified[0]).toBe(0);
        expect(eventIdsOf(data.fragments[0])).toEqual(["q"]);
    });

    it("scores the empty schedule as the run's own ledger, and the invite against the cutoff", () => {
        const { frozen, data } = play(always(t0));
        const self = findRoster(frozen, team.playerIds);
        const none = scoreSchedule(data, []);
        expect(none.points).toBeCloseTo(scoreTeam(frozen, frozen.ledgers[self], { rank: false }).points, 9);
        expect(none.invited).toBe(none.points >= data.info.cutoff);
        expect(planDelta(data.exact!, t0, [])).toEqual(play(always(t0)).result.delta);
        const withRoute = scoreSchedule(data, [0]);
        expect(withRoute.points).not.toBeCloseTo(none.points, 3);
        expect(withRoute.smooth).toBeGreaterThan(0);
        expect(withRoute.smooth).toBeLessThan(1);
    });

    it("records the route's finish and what it alone adds, by source", () => {
        const won = play(always(t0)).data;
        expect(won.info.place[0]).toBe(1);
        const parts = Array.from(won.info.gain.subarray(0, GAIN_PARTS.length));
        expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(scoreSchedule(won, [0]).points - scoreSchedule(won, []).points, 3);
        expect(play(never(t0)).data.info.place[0]).toBe(NOT_QUALIFIED);
    });

    it("plans a second team on the same run without changing the first", () => {
        const predictor = always(t0);
        const runInput = { ...input, predictor };
        const captured: { result: RerunResult | null } = { result: null };
        const result = runSeason({ ...runInput, onCheckpoint: (_r, _cp, res) => (captured.result = res) }, 0);
        const state = captured.result!.state;
        const frozen = freeze(state);
        const lineup5 = lineups.get(t5)!;
        const other: OptimizerTeam = { ...team, team: t5, teamId: t5, rosterKey: t5, teamName: lineup5.name, playerIds: lineup5.players.map((p) => String(p.playerId)), nicks: lineup5.players.map((p) => p.nick) };
        const ctx: OptimizeRunContext = { input: runInput, opt: { ...opt, teams: [team, other] }, asOf: day(0), previousSlug: null, regionOf: () => () => "Europe" };
        const alone = planRun(ctx, set, team, 0, result, state, frozen, false);
        planRun(ctx, buildOptions(events, t5, "Europe", day(0), () => true), other, 0, result, state, frozen, false);
        const again = planRun(ctx, set, team, 0, result, state, frozen, false);
        expect(again.info).toEqual(alone.info);
        expect(again.fragments).toEqual(alone.fragments);
        expect(scoreSchedule(again, [0])).toEqual(scoreSchedule(alone, [0]));
    });
});
