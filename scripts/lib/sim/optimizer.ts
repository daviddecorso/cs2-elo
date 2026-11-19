import type { Region, Roster, Standings } from "../../../src/vrs/types.ts";
import type { FieldSource } from "../../../src/sim/types.ts";
import { feasibleMasks, indicesOf, popcount } from "../../../src/sim/schedule.ts";
import type { ValveEvent, ValveMatch } from "../vrs/buildMatchdata.ts";
import { findRoster, freeze, scoreTeam, withEvent, withoutEvents, type FrozenWorld, type Ledger, type LedgerEvent, type LedgerMatch } from "../vrs/oneTeam.ts";
import type { WorldState } from "../vrs/valveWorld.ts";
import { allocateInvites, countAbove, previousMajorSlots, REGIONS, totalSlots, type InviteConfig, type StageSlots } from "./invites.ts";
import { makeRng, runSeed, subSeed } from "./rng.ts";
import { positionOf, withField, type RunResult, type SeasonEvent, type SeasonInput } from "./season.ts";
import { runEvent, type EventOutcome } from "./simulate.ts";
import type { TeamId } from "./types.ts";

/** Most optional events per team; its subsets are enumerated. */
export const MAX_UNIVERSE = 10;
/** Share of runs an event must be reachable in to be a candidate. */
export const MIN_REACH = 0.1;

export interface OptimizerTeam {
    team: TeamId;
    /** Matchdata team id its simulated matches are played under. */
    teamId: string;
    rosterKey: string;
    teamName: string;
    region: Region;
    playerIds: string[];
    nicks: string[];
    /** Indices into the season's events: the optional ones, by start date. */
    universe: number[];
    /** Slugs of events already under way that the team plays; kept in every schedule. */
    committed: string[];
    /** Universe events the team is announced for. */
    announced: Set<string>;
    /** Feasible subsets of `universe` within the high cap. */
    masks: number[];
    /** Indices into the season's events: LANs the team could qualify for through linked feeders (`qualifyPaths`). */
    paths: number[];
}

export interface OptimizerSetup {
    teams: OptimizerTeam[];
    caps: { low: number; average: number; high: number };
    previousMajor: InviteConfig["previousMajor"];
    stage1: Record<Region, number>;
    /** Intact and allowed in its region under the Major rules. */
    eligible: (r: { players: string[]; region: Region }) => boolean;
}

export const isUnderWay = (e: SeasonEvent, asOf: string) => e.config.startDate <= asOf;
/** A place a team can't simply accept; an open slot it reached is one its organizer would invite it to (`welcomes`). */
const notChosen = (source: FieldSource) => source === "qualifier";
export const fieldTeams = (e: SeasonEvent): TeamId[] => (e.fixed ? [...new Set(e.config.stages.flatMap((s) => s.invited ?? []))] : e.field.announced);
export const hasOpenSlots = (e: SeasonEvent) => !e.fixed && e.field.teams > e.field.announced.length;

/** Events a team can choose: announced for it, or with open slots it could plausibly enter (`canEnter`), not yet started; capped at `MAX_UNIVERSE`, announced first, then by prize pool. */
export const teamUniverse = (events: SeasonEvent[], team: TeamId, asOf: string, caps: OptimizerSetup["caps"], canEnter: (e: SeasonEvent) => boolean = () => true) => {
    const announced = new Set<string>();
    const committed: string[] = [];
    const options: number[] = [];
    events.forEach((e, i) => {
        if (e.stint.kind === "online" || e.unannounced) return;
        const inField = fieldTeams(e).includes(team);
        if (isUnderWay(e, asOf)) {
            if (inField) committed.push(e.config.slug);
            return;
        }
        if (inField) announced.add(e.config.slug);
        if (inField || (hasOpenSlots(e) && canEnter(e))) options.push(i);
    });
    const prize = (i: number) => [...events[i].projection.prizes.values()].reduce((a, b) => a + b, 0);
    const universe = options
        .sort((a, b) => Number(announced.has(events[b].config.slug)) - Number(announced.has(events[a].config.slug)) || prize(b) - prize(a))
        .slice(0, MAX_UNIVERSE)
        .sort((a, b) => events[a].config.startDate.localeCompare(events[b].config.startDate));
    const masks = feasibleMasks(
        universe.map((i) => events[i].stint),
        Math.max(0, caps.high - committed.length)
    );
    return { universe, committed, announced, masks };
};

/** A feeder the team could enter for the event it feeds: in its region, or with none. */
export const feedersFor = (events: SeasonEvent[], slug: string, region: Region) =>
    events
        .filter((e) => e.feeds?.slug === slug && (e.field.region === null || e.field.region === region))
        .sort((a, b) => a.config.startDate.localeCompare(b.config.startDate) || a.config.slug.localeCompare(b.config.slug));

/** LANs not yet started, and not announced for the team, that its region's linked feeders qualify teams for. */
export const qualifyPaths = (events: SeasonEvent[], team: TeamId, region: Region, asOf: string): number[] =>
    events.flatMap((e, i) =>
        e.stint.kind !== "online" && !e.unannounced && !isUnderWay(e, asOf) && !fieldTeams(e).includes(team) && feedersFor(events, e.config.slug, region).length > 0
            ? [i]
            : []
    );

export interface TeamTally {
    /** Points per (mask index × n + run). */
    points: Float32Array;
    /** 1 when invited to the Major, same layout. */
    invited: Uint8Array;
    /** 1 for runs the team's roster was found in. */
    seen: Uint8Array;
    /** Points and invite under the season's own attendance rules, per run. */
    rulesPoints: Float32Array;
    rulesInvited: Uint8Array;
    /** Per universe event: runs it was reachable, attended under the rules, and reachable only through a qualifier. */
    reach: Uint32Array;
    attended: Uint32Array;
    qualifierOnly: Uint32Array;
    /** Runs it was reachable through an open slot: an invitation the model assumes, not one a rule gives. */
    viaOpen: Uint32Array;
    /** Per path: runs the team could enter a feeder while not otherwise attending, and runs it then qualified. */
    pathEntered: Uint32Array;
    pathQualified: Uint32Array;
}

export interface OptimizerTally {
    n: number;
    teams: TeamTally[];
    /** 1 for runs whose invite slots are known. */
    slotsKnown: Uint8Array;
    inexactTargets: number;
    replays: number;
    skippedReplays: number;
    /** Feeder events replayed with a team in them, for qualifying odds. */
    pathReplays: number;
    missingRosters: number;
    scores: number;
}

export const emptyOptimizerTally = (opt: OptimizerSetup, n: number): OptimizerTally => ({
    n,
    teams: opt.teams.map((t) => ({
        points: new Float32Array(t.masks.length * n),
        invited: new Uint8Array(t.masks.length * n),
        seen: new Uint8Array(n),
        rulesPoints: new Float32Array(n),
        rulesInvited: new Uint8Array(n),
        reach: new Uint32Array(t.universe.length),
        attended: new Uint32Array(t.universe.length),
        qualifierOnly: new Uint32Array(t.universe.length),
        viaOpen: new Uint32Array(t.universe.length),
        pathEntered: new Uint32Array(t.paths.length),
        pathQualified: new Uint32Array(t.paths.length),
    })),
    slotsKnown: new Uint8Array(n),
    inexactTargets: 0,
    replays: 0,
    skippedReplays: 0,
    pathReplays: 0,
    missingRosters: 0,
    scores: 0,
});

/** Shards write disjoint runs into zeroed arrays, so adding them merges. */
export const mergeOptimizerTallies = (into: OptimizerTally, from: OptimizerTally) => {
    const add = (a: Float32Array | Uint8Array | Uint32Array, b: typeof a) => {
        for (let i = 0; i < a.length; i++) a[i] += b[i];
    };
    into.teams.forEach((t, k) => {
        const f = from.teams[k];
        add(t.points, f.points);
        add(t.invited, f.invited);
        add(t.seen, f.seen);
        add(t.rulesPoints, f.rulesPoints);
        add(t.rulesInvited, f.rulesInvited);
        add(t.reach, f.reach);
        add(t.attended, f.attended);
        add(t.qualifierOnly, f.qualifierOnly);
        add(t.viaOpen, f.viaOpen);
        add(t.pathEntered, f.pathEntered);
        add(t.pathQualified, f.pathQualified);
    });
    add(into.slotsKnown, from.slotsKnown);
    into.inexactTargets += from.inexactTargets;
    into.replays += from.replays;
    into.skippedReplays += from.skippedReplays;
    into.pathReplays += from.pathReplays;
    into.missingRosters += from.missingRosters;
    into.scores += from.scores;
};

export type Delta = { matches: ValveMatch[]; events: ValveEvent[] };

/** What the exact re-score of one run needs, kept by the shard that ran it. */
export interface RescoreRun {
    delta: Delta;
    eventIds: Map<string, string[]>;
    /** `${slug}|${team}` → the full event replayed with the team in it. */
    replays: Map<string, Delta>;
    slots: StageSlots | null;
}

export interface Fragment {
    matches: LedgerMatch[];
    events: LedgerEvent[];
}

export const compose =(base: Ledger, parts: Fragment[]): Ledger => {
    if (parts.length === 0) return base;
    return {
        roster: base.roster,
        matches: [...base.matches, ...parts.flatMap((p) => p.matches)].sort((a, b) => a.t - b.t),
        events: [...base.events, ...parts.flatMap((p) => p.events)],
    };
};

const rosterMatching = (rosters: Roster[], nicks: string[]): Roster | undefined => {
    const wanted = new Set(nicks.map((n) => n.toLowerCase()));
    let best: Roster | undefined;
    let bestShared = 2;
    for (const r of rosters) {
        const shared = r.players.filter((p) => wanted.has(p.toLowerCase())).length;
        if (shared > bestShared || (shared === bestShared && best && r.points > best.points)) {
            best = r;
            bestShared = shared;
        }
    }
    return best;
};

/** Whether `rosterKey` gets any Major invite from these standings. */
export const invitedIn = (rosters: Roster[], slots: StageSlots, eligible: OptimizerSetup["eligible"], rosterKey: string): boolean =>
    allocateInvites(rosters, slots, eligible).has(rosterKey);

export interface OptimizeRunContext {
    input: SeasonInput;
    opt: OptimizerSetup;
    asOf: string;
    previousSlug: string | null;
    /** Region a team's roster is listed in, for the previous Major's slots. */
    regionOf: (standings: Standings) => (team: TeamId) => Region;
}

/** Scores every team's subsets in one run against that run's frozen target world; returns what its re-score needs. */
export const optimizeRun = (
    ctx: OptimizeRunContext,
    tally: OptimizerTally,
    run: number,
    result: RunResult,
    state: WorldState,
    keepForRescore: boolean,
    frozen: FrozenWorld = freeze(state)
): RescoreRun | null => {
    const { input, opt } = ctx;
    const { n } = tally;
    const standings = result.standings.at(-1)!;
    const byKey = new Map(standings.rosters.map((r) => [r.rosterKey, r]));

    const major = ctx.previousSlug ? result.events.get(ctx.previousSlug) : undefined;
    const reached = major && major.field !== null ? major.outcome.reached : null;
    const knowsSlots = "slots" in opt.previousMajor || reached !== null;
    const slots: StageSlots | null = knowsSlots ? { ...previousMajorSlots(opt.previousMajor, reached, ctx.regionOf(standings)), 1: opt.stage1 } : null;
    if (slots) tally.slotsKnown[run] = 1;

    const rivals = new Map<Region, Float64Array>();
    const eligibleKeys = new Set<string>();
    for (const region of REGIONS) {
        const list = standings.rosters.filter((r) => r.region === region && r.regionalRank !== null && opt.eligible(r));
        for (const r of list) eligibleKeys.add(r.rosterKey);
        rivals.set(region, Float64Array.from(list.map((r) => r.points).sort((a, b) => b - a)));
    }

    const rulesInvites = slots ? allocateInvites(standings.rosters, slots, opt.eligible) : null;
    const rescore: RescoreRun | null = keepForRescore ? { delta: result.delta, eventIds: result.eventIds, replays: new Map(), slots } : null;

    opt.teams.forEach((team, k) => {
        const t = tally.teams[k];
        const self = findRoster(frozen, team.playerIds);
        if (self < 0) {
            tally.missingRosters++;
            return;
        }
        t.seen[run] = 1;
        const own = frozen.rosters[self];
        const listed = byKey.get(own.rosterKey);
        const region = listed?.region ?? team.region;
        const eligible = opt.eligible({ players: listed?.players ?? team.nicks, region });
        const regionRivals = rivals.get(region)!;
        const selfRival = listed !== undefined && eligibleKeys.has(listed.rosterKey);
        const invitedAt = (points: number, ranked: boolean) => {
            if (!slots || !ranked || !eligible) return false;
            const above = countAbove(regionRivals, points) - (selfRival && listed!.points > points ? 1 : 0);
            return above < totalSlots(slots, region);
        };

        t.rulesPoints[run] = listed && listed.globalRank !== null ? listed.points : 0;
        t.rulesInvited[run] = Number(listed !== undefined && listed.globalRank !== null && rulesInvites !== null && rulesInvites.has(listed.rosterKey));

        const ledger = frozen.ledgers[self];
        const attendedIds = new Set<string>();
        const fragments: Array<Fragment | null> = team.universe.map((ei, u) => {
            const e = input.events[ei];
            const slug = e.config.slug;
            const played = result.events.get(slug);
            const ids = result.eventIds.get(slug) ?? [];
            if (played && played.field !== null && played.field.some((f) => f.team === team.team)) {
                t.reach[u]++;
                t.attended[u]++;
                const source = played.field.find((f) => f.team === team.team)!.source;
                if (notChosen(source)) t.qualifierOnly[u]++;
                if (source === "open") t.viaOpen[u]++;
                for (const id of ids) attendedIds.add(id);
                return cutFragment(ledger, ids);
            }
            const field = result.reach.get(slug)?.(team.team) ?? null;
            if (!field) return null;
            t.reach[u]++;
            const source = field.find((f) => f.team === team.team)!.source;
            if (notChosen(source)) t.qualifierOnly[u]++;
            if (source === "open") t.viaOpen[u]++;
            return replay(ctx, tally, frozen, state, run, e, team, field.map((f) => f.team), self, rescore);
        });

        const base = attendedIds.size ? withoutEvents(ledger, attendedIds) : ledger;
        team.masks.forEach((mask, m) => {
            const parts = indicesOf(mask).flatMap((u) => (fragments[u] ? [fragments[u]!] : []));
            const score = scoreTeam(frozen, compose(base, parts), { rank: false });
            const ranked = score.globalRank !== null;
            t.points[m * n + run] = ranked ? score.points : 0;
            t.invited[m * n + run] = Number(invitedAt(score.points, ranked));
        });
        tally.scores += team.masks.length;

        team.paths.forEach((ti, p) => {
            const target = input.events[ti];
            const played = result.events.get(target.config.slug);
            if (!played || played.field === null || played.field.some((f) => f.team === team.team)) return;
            const qualifies = tryQualify(ctx, tally, run, result, target, team, 0);
            if (qualifies === null) return;
            t.pathEntered[p]++;
            if (qualifies) t.pathQualified[p]++;
        });
    });
    return rescore;
};

/** Most feeder levels a qualifying path climbs: open qualifier → closed qualifier → event. */
export const MAX_PATH_DEPTH = 2;

/** Whether the team qualifies for `target` through a feeder it can enter, trying them in date order; null when it can enter none. */
const tryQualify = (ctx: OptimizeRunContext, tally: OptimizerTally, run: number, result: RunResult, target: SeasonEvent, team: OptimizerTeam, depth: number): boolean | null => {
    let entered = false;
    for (const feeder of feedersFor(ctx.input.events, target.config.slug, team.region)) {
        const position = placeIn(ctx, tally, run, result, feeder, team, depth);
        if (position === null) continue;
        entered = true;
        if (position <= feeder.feeds!.count) return true;
    }
    return entered ? false : null;
};

/** The team's finishing position at `e` with it in the field: as played, by its own slot, or by qualifying through a feeder of `e`; Infinity when it entered a feeder and failed, null when it can't enter. */
const placeIn = (ctx: OptimizeRunContext, tally: OptimizerTally, run: number, result: RunResult, e: SeasonEvent, team: OptimizerTeam, depth: number): number | null => {
    const slug = e.config.slug;
    const played = result.events.get(slug);
    if (!played || played.field === null) return null;
    if (played.field.some((f) => f.team === team.team)) return positionOf(played.outcome.placements.get(team.team));
    const reached = result.reach.get(slug)?.(team.team);
    if (reached) return positionOf(playField(ctx, tally, run, e, reached.map((f) => f.team)).placements.get(team.team));
    if (depth >= MAX_PATH_DEPTH) return null;
    let entered = false;
    for (const feeder of feedersFor(ctx.input.events, slug, team.region)) {
        const position = placeIn(ctx, tally, run, result, feeder, team, depth + 1);
        if (position === null) continue;
        entered = true;
        if (position > feeder.feeds!.count) continue;
        const sent = result.qualifiedFrom.get(slug)?.find((q) => q.from === feeder.config.slug)?.team;
        if (sent === undefined || !played.field.some((f) => f.team === sent)) continue;
        const field = played.field.map((f) => (f.team === sent ? team.team : f.team));
        return positionOf(playField(ctx, tally, run, e, field).placements.get(team.team));
    }
    return entered ? Infinity : null;
};

/** Plays `e` with this field on the run's own per-series streams, as `replay` does, without scoring it. */
const playField = (ctx: OptimizeRunContext, tally: OptimizerTally, run: number, e: SeasonEvent, field: TeamId[]): EventOutcome => {
    const { input } = ctx;
    const config = withField(e.config, field, e.entryStages);
    const playSeed = subSeed(runSeed(input.seed, run), `play|${e.config.slug}`);
    input.predictor.setHorizon(e.horizon);
    tally.pathReplays++;
    return runEvent({ config, known: e.known, horizon: e.horizon, seriesSeed: playSeed }, input.predictor, makeRng(playSeed));
};

/** Plays `e` with this field under the run's rating path, on the run's own per-series streams, so matchups the team doesn't change replay exactly as the run played them. */
export const replayEvent = (ctx: OptimizeRunContext, run: number, e: SeasonEvent, field: TeamId[]): { outcome: EventOutcome; part: Delta } => {
    const { input } = ctx;
    const config = withField(e.config, field, e.entryStages);
    const playSeed = subSeed(runSeed(input.seed, run), `play|${e.config.slug}`);
    input.predictor.setHorizon(e.horizon);
    const outcome = runEvent({ config, known: e.known, horizon: e.horizon, seriesSeed: playSeed }, input.predictor, makeRng(playSeed));
    return { outcome, part: input.toDelta({ ...e.projection, config }, outcome) };
};

/** The team's ranked matches and prize in a replayed event's delta, against frozen opponents; null when the world can't place an event or an opponent. */
export const ledgerFragment = (frozen: FrozenWorld, state: WorldState, teamId: string, self: number, part: Delta): Fragment | null => {
    const fragment: Fragment = { matches: [], events: [] };
    for (const ev of part.events) {
        const id = String(ev.eventId);
        const info = state.events[id];
        const own = part.matches.filter((m) => String(m.eventId) === id && m.valveRanked !== false && (String(m.team1Id) === teamId || String(m.team2Id) === teamId));
        if (!info) return null;
        // Valve credits an event's prize only through a ranked match in it.
        if (own.length === 0) continue;
        const opponents = own.map((m) => findRoster(frozen, (String(m.team1Id) === teamId ? m.team2Players : m.team1Players).map((p) => String(p.playerId))));
        if (opponents.some((o) => o < 0)) return null;
        const row = ev.prizeDistribution.find((p) => String(p.teamId) === teamId);
        const added = withEvent(frozen, { roster: self, matches: [], events: [] }, {
            eventId: id,
            lan: info.lan,
            prizePool: info.prizePool,
            lastMatchTime: info.lastMatchTime,
            prize: row ? row.prize + row.clubShare : 0,
            matches: own.map((m, k) => ({ t: m.matchStartTime, opponent: opponents[k], won: m.winningTeam === (String(m.team1Id) === teamId ? 1 : 2) })),
        });
        fragment.matches.push(...added.matches);
        fragment.events.push(...added.events);
    }
    return fragment;
};

/** The ledger's matches and events at these Valve event ids. */
export const cutFragment = (ledger: Ledger, ids: Iterable<string>): Fragment => {
    const idSet = new Set(ids);
    return { matches: ledger.matches.filter((m) => idSet.has(m.eventId)), events: ledger.events.filter((ev) => idSet.has(ev.eventId)) };
};

/** The team's ledger fragment for an event it didn't play this run, replayed with it in the field. */
const replay = (
    ctx: OptimizeRunContext,
    tally: OptimizerTally,
    frozen: FrozenWorld,
    state: WorldState,
    run: number,
    e: SeasonEvent,
    team: OptimizerTeam,
    field: TeamId[],
    self: number,
    rescore: RescoreRun | null
): Fragment | null => {
    const { part } = replayEvent(ctx, run, e, field);
    tally.replays++;
    const fragment = ledgerFragment(frozen, state, team.teamId, self, part);
    if (!fragment) {
        tally.skippedReplays++;
        return null;
    }
    rescore?.replays.set(`${e.config.slug}|${team.team}`, part);
    return fragment;
};

/** The run's delta with `team` playing exactly the universe events in `chosen`, where it can reach them. */
export const scheduleDelta = (data: RescoreRun, input: SeasonInput, team: OptimizerTeam, chosen: Set<string>): Delta => {
    let { matches, events } = data.delta;
    const isTeam = (m: ValveMatch) => String(m.team1Id) === team.teamId || String(m.team2Id) === team.teamId;
    for (const ei of team.universe) {
        const slug = input.events[ei].config.slug;
        const ids = new Set(data.eventIds.get(slug) ?? []);
        if (ids.size === 0) continue;
        const attended = matches.some((m) => ids.has(String(m.eventId)) && isTeam(m));
        if (attended && !chosen.has(slug)) {
            matches = matches.filter((m) => !(ids.has(String(m.eventId)) && isTeam(m)));
            events = events.map((ev) =>
                ids.has(String(ev.eventId)) ? { ...ev, prizeDistribution: ev.prizeDistribution.filter((p) => String(p.teamId) !== team.teamId) } : ev
            );
        }
        const replayed = !attended && chosen.has(slug) ? data.replays.get(`${slug}|${team.team}`) : undefined;
        if (replayed) {
            const replaced = new Set(replayed.events.map((ev) => String(ev.eventId)));
            matches = [...matches.filter((m) => !ids.has(String(m.eventId))), ...replayed.matches];
            events = [...events.filter((ev) => !replaced.has(String(ev.eventId))), ...replayed.events];
        }
    }
    return { matches, events };
};

export interface RescoreJob {
    run: number;
    team: number;
    mask: number;
}

export interface RescoreResult extends RescoreJob {
    points: number;
    invited: boolean;
    inexact: boolean;
}

/** One exact re-score: the team's points and invite in Valve's model with the schedule's matches. */
export const rescoreOne = (
    standings: Standings,
    slots: StageSlots | null,
    opt: OptimizerSetup,
    team: Pick<OptimizerTeam, "nicks">
): { points: number; invited: boolean } => {
    const roster = rosterMatching(standings.rosters, team.nicks);
    if (!roster || roster.globalRank === null) return { points: 0, invited: false };
    return { points: roster.points, invited: slots !== null && invitedIn(standings.rosters, slots, opt.eligible, roster.rosterKey) };
};

export interface Summary {
    mean: number;
    p10: number;
    p90: number;
    invite: number | null;
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

/** Points and invite share over `runs` for one mask index. */
export const summarize = (tally: OptimizerTally, k: number, m: number | "rules", runs: number[]): Summary => {
    const t = tally.teams[k];
    const points = runs.map((r) => (m === "rules" ? t.rulesPoints[r] : t.points[m * tally.n + r]));
    const invited = runs.filter((r) => (m === "rules" ? t.rulesInvited[r] : t.invited[m * tally.n + r]));
    const known = runs.filter((r) => tally.slotsKnown[r]).length;
    const sorted = [...points].sort((a, b) => a - b);
    return {
        mean: points.reduce((a, b) => a + b, 0) / Math.max(1, points.length),
        p10: quantile(sorted, 0.1),
        p90: quantile(sorted, 0.9),
        invite: known === 0 ? null : invited.length / known,
    };
};

export type Volume = "low" | "average" | "high";
export type Goal = "points" | "invite";
export const VOLUMES: Volume[] = ["low", "average", "high"];

export interface TeamPick {
    /** Universe indices that are candidates, in universe order. */
    candidates: number[];
    requiresQualifying: number[];
    /** Qualifying paths entered in at least `MIN_REACH` of runs, for events that aren't candidates: shares of seen runs entered, and of entered runs qualified. */
    paths: Array<{ p: number; entered: number; qualified: number }>;
    /** Mask indices (into `team.masks`) using candidates only, with their summaries over every seen run. */
    subsets: Array<{ m: number; summary: Summary }>;
    recommended: Array<{ m: number; volumes: Volume[]; goals: Goal[] }>;
    runs: number[];
}

/** Candidates and the recommended schedule per volume and goal, from the one-team scores. */
export const pickSchedules = (tally: OptimizerTally, opt: OptimizerSetup, input: SeasonInput, k: number): TeamPick => {
    const team = opt.teams[k];
    const t = tally.teams[k];
    const runs = [...Array(tally.n).keys()].filter((r) => t.seen[r]);
    const seen = Math.max(1, runs.length);
    const candidates: number[] = [];
    const requiresQualifying: number[] = [];
    team.universe.forEach((ei, u) => {
        const announced = team.announced.has(input.events[ei].config.slug);
        if (announced) candidates.push(u);
        else if (t.reach[u] / seen < MIN_REACH) return;
        else if (t.qualifierOnly[u] === t.reach[u]) requiresQualifying.push(u);
        else candidates.push(u);
    });
    const candidateEvents = new Set(candidates.map((u) => team.universe[u]));
    const paths = team.paths.flatMap((ei, p) =>
        !candidateEvents.has(ei) && t.pathEntered[p] / seen >= MIN_REACH ? [{ p, entered: t.pathEntered[p] / seen, qualified: t.pathQualified[p] / t.pathEntered[p] }] : []
    );
    const allowed = candidates.reduce((mask, u) => mask | (1 << u), 0);
    const subsets = team.masks.flatMap((mask, m) => ((mask & ~allowed) === 0 ? [{ m, summary: summarize(tally, k, m, runs) }] : []));

    const picks = new Map<number, { volumes: Volume[]; goals: Goal[] }>();
    const note = (m: number, volume: Volume, goal: Goal) => {
        const p = picks.get(m) ?? { volumes: [], goals: [] };
        if (!p.volumes.includes(volume)) p.volumes.push(volume);
        if (!p.goals.includes(goal)) p.goals.push(goal);
        picks.set(m, p);
    };
    for (const volume of VOLUMES) {
        const cap = opt.caps[volume] - team.committed.length;
        const within = subsets.filter((s) => popcount(team.masks[s.m]) <= cap);
        if (within.length === 0) continue;
        const byPoints = within.reduce((a, b) => (b.summary.mean > a.summary.mean ? b : a));
        note(byPoints.m, volume, "points");
        if (within[0].summary.invite !== null) {
            const byInvite = within.reduce((a, b) =>
                b.summary.invite! > a.summary.invite! || (b.summary.invite === a.summary.invite && b.summary.mean > a.summary.mean) ? b : a
            );
            note(byInvite.m, volume, "invite");
        }
    }
    return { candidates, requiresQualifying, paths, subsets, recommended: [...picks].map(([m, p]) => ({ m, ...p })), runs };
};
