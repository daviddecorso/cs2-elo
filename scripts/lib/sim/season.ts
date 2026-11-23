import type { Roster, Standings } from "../../../src/vrs/types.ts";
import type { Matchdata, ValveEvent, ValveMatch } from "../vrs/buildMatchdata.ts";
import { computeStandings } from "../vrs/valveModel.ts";
import { rerun, type RerunResult, type ValveWorld } from "../vrs/valveWorld.ts";
import type { FieldSource } from "../../../src/sim/types.ts";
import { Pacer, type ActivityModel } from "./activity.ts";
import {
    isLowerTier,
    LOWER_TIER_TOP_RANK,
    resolveField,
    type FieldEntry,
    type FieldEvent,
    type FieldSampler,
    type LinkedSlots,
    type ListEntry,
} from "./attendance.ts";
import type { EventConfig, StageConfig } from "./config.ts";
import type { EventFieldModel } from "./fieldModel.ts";
import type { ActivityCategory } from "./history.ts";
import type { KnownMatch } from "./locks.ts";
import type { SeriesModel } from "./predict.ts";
import { makeRng, runSeed, subSeed } from "./rng.ts";
import { fits, type Caps, type Stint } from "./schedule.ts";
import { runEvent, type EventOutcome } from "./simulate.ts";
import type { TeamId } from "./types.ts";
import { mergeImpact, type ImpactTally } from "./impact.ts";
import { applyDelta, type ProjectionEvent } from "./vrsProjection.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const monthOf = (date: string) => date.slice(0, 7);

const firstMonday = (year: number, month: number): string => {
    for (let d = 1; d <= 7; d++) {
        if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === 1) return `${year}-${pad(month)}-${pad(d)}`;
    }
    throw new Error("unreachable");
};

/** VRS publication dates after `from` through `to`: the first Monday of each month, or the published list's date for that month. */
export const publicationDates = (from: string, to: string, published: string[]): string[] => {
    const byMonth = new Map(published.map((d) => [monthOf(d), d]));
    const out: string[] = [];
    let [y, m] = from.split("-").map(Number);
    while (`${y}-${pad(m)}` <= monthOf(to)) {
        const date = byMonth.get(`${y}-${pad(m)}`) ?? firstMonday(y, m);
        if (date > from && date <= to) out.push(date);
        [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
    }
    if (out.at(-1) !== to && to > from) out.push(to);
    return out;
};

export interface EntryStage {
    id: string;
    capacity: number;
}

export interface SeasonEvent {
    config: EventConfig;
    projection: ProjectionEvent;
    known: Map<string, KnownMatch[]>;
    /** Days from the ratings' as-of date to the start. */
    horizon: number;
    stint: Stint;
    field: FieldEvent;
    /** Latest VRS list month the field invites from; null when it needs none. */
    listMonth: string | null;
    /** Every entry stage already lists its teams. */
    fixed: boolean;
    entryStages: EntryStage[];
    /** Habit category a place in it counts toward. */
    category: ActivityCategory;
    /** Share of runs that play it, for a projected edition or stand-in; every run when unset. */
    chance?: number;
    /** A stand-in for an event Liquipedia will list later: rivals play it, no team can choose it. */
    unannounced?: boolean;
    /** The later event whose qualifier slot this one fills (`qualifierLinks`), by its top `count` finishers. */
    feeds?: { slug: string; slotKey: string; count: number };
}

/** Learned fields and habits; without them fields fill deterministically and every team shares `volumeCap`. */
export interface SeasonFields {
    /** Event slug → how its open slots fill. */
    models: Map<string, EventFieldModel>;
    /** Recently active teams off the list, drawable into open slots. */
    unranked: ListEntry[];
    /** The only teams offered or drawn: others' lineups would relink Valve rosters and force full reruns. */
    drawable: Set<TeamId>;
    activity: ActivityModel;
    /** Per team (simulator id), most LAN and online events over the horizon. */
    caps: (team: TeamId) => Caps;
    /** Last day of the horizon budgets are drawn over, and its length. */
    horizonEnd: string;
    horizonDays: number;
    /** Event slug → each team's draw weight within its rank band and region. */
    affinity?: Map<string, (team: TeamId) => number>;
    /** Per event slug, the log-odds a team's value adds to its band's VRS acceptance (`FieldSampler.acceptShift`). */
    acceptance?: Map<string, (team: TeamId, band: number) => number>;
}

const seedCount = (stage: StageConfig) =>
    Math.max(0, ...(stage.matches ?? []).flatMap((m) => m.teams).map((ref) => Number(/^s(\d+)$/.exec(ref)?.[1] ?? 0)));

/** Stages teams enter directly, with their size; a string says why the field can't be split. */
export const entryStages = (config: EventConfig, teams: number): EntryStage[] | string => {
    const entries = config.stages.filter((s) => s.invited !== undefined);
    if (entries.length === 0) return "no stage takes invited teams";
    const capacities = entries.map((s) => (s.format === "bracket" ? seedCount(s) : 0));
    const unsized = capacities.filter((c) => c === 0).length;
    const rest = teams - capacities.reduce((a, b) => a + b, 0);
    if (unsized > 0 && (rest <= 0 || rest % unsized !== 0)) return `can't split ${teams} teams across ${entries.length} entry stages`;
    const stages = entries.map((s, i) => ({ id: s.id, capacity: capacities[i] || rest / unsized }));
    if (stages.reduce((n, s) => n + s.capacity, 0) !== teams) return `entry stages hold ${stages.reduce((n, s) => n + s.capacity, 0)} of ${teams} teams`;
    return stages;
};

/** Seed order snaked across entry stages: 1→A, 2→B, 3→B, 4→A, ...; a full stage passes its turn on. */
export const splitField = (field: TeamId[], stages: EntryStage[]): Map<string, TeamId[]> => {
    const out = new Map(stages.map((s) => [s.id, [] as TeamId[]]));
    const k = stages.length;
    let turn = 0;
    for (const team of field) {
        for (let tries = 0; tries < 2 * k; tries++, turn++) {
            const round = Math.floor(turn / k);
            const pos = turn % k;
            const stage = stages[round % 2 === 0 ? pos : k - 1 - pos];
            const list = out.get(stage.id)!;
            if (list.length < stage.capacity) {
                list.push(team);
                turn++;
                break;
            }
        }
    }
    return out;
};

export const withField = (config: EventConfig, field: TeamId[], stages: EntryStage[]): EventConfig => {
    const split = splitField(field, stages);
    return { ...config, stages: config.stages.map((s) => (split.has(s.id) ? { ...s, invited: split.get(s.id)! } : s)) };
};

export interface Checkpoint {
    date: string;
    world: ValveWorld;
}

export interface SeasonInput {
    /** Simulated events, in start order. */
    events: SeasonEvent[];
    checkpoints: Checkpoint[];
    base: Matchdata;
    predictor: SeriesModel;
    /** Every team a run may field, so each gets a rating path. */
    teams: TeamId[];
    toDelta: (event: ProjectionEvent, outcome: EventOutcome) => { matches: ValveMatch[]; events: ValveEvent[] };
    /** The model-input team id `toDelta` gives a simulator team. */
    teamIdOf: (team: TeamId) => string;
    /** Ranked rosters as the simulator's teams. */
    listEntries: (rosters: Roster[]) => ListEntry[];
    /** Stable key for a roster across checkpoints, since a new lineup linking into a roster changes its `rosterKey`. */
    rosterId: (r: Roster) => string;
    /** Published VRS lists by month (`YYYY-MM`), as list entries. */
    published: Map<string, ListEntry[]>;
    /** Most LAN events a team takes in the horizon before it declines more. */
    volumeCap: number;
    /** Most online events a team takes in the horizon; unlimited when unset. */
    onlineCap?: number;
    fields?: SeasonFields;
    /** Hindcast oracle: real matches after as-of, added before each checkpoint they precede, with winners redrawn from the run's ratings when `redraw` (as a Bo3). */
    replay?: { matches: ValveMatch[]; events: ValveEvent[]; teamOf: (teamId: string) => TeamId; horizonOf: (matchStartTime: number) => number; redraw: boolean };
    n: number;
    seed: number;
    onCheckpoint?: (run: number, checkpoint: number, result: RerunResult | null, standings: Standings, runSoFar: RunResult) => void;
}

export interface RunResult {
    standings: Standings[];
    events: Map<string, { field: FieldEntry[]; outcome: EventOutcome } | { field: null; short: number }>;
    /** Per resolved event, the field it would have had if `team` took a slot, as lists and commitments stood then; null when it can't get one. */
    reach: Map<string, (team: TeamId) => FieldEntry[] | null>;
    /** Valve event ids of each played event: one, or a split Major's stage pages. */
    eventIds: Map<string, string[]>;
    delta: { matches: ValveMatch[]; events: ValveEvent[] };
    /** Why each inexact checkpoint rerun fell back to a full run. */
    inexact: string[];
    /** Per linked event, the teams its feeders sent, in the order they qualified. */
    qualifiedFrom: Map<string, Array<{ from: string; team: TeamId }>>;
}

/** First position of a placement label ("3-4" → 3); Infinity without one. */
export const positionOf = (label: string | undefined) => Number(/^(\d+)/.exec(label ?? "")?.[1] ?? Infinity);

const latestBefore = <T>(byMonth: Map<string, T>, month: string): T | undefined => {
    const months = [...byMonth.keys()].filter((m) => m <= month).sort();
    return months.length ? byMonth.get(months.at(-1)!) : undefined;
};

/** `reach` with `team` in the seed of the one team it displaced from `actual`, so a replay keeps every other pairing; `reach` as is when more changed. */
export const inPlaceOf = (actual: FieldEntry[], reach: FieldEntry[], team: TeamId): FieldEntry[] => {
    const inReach = new Set(reach.map((f) => f.team));
    const inActual = new Set(actual.map((f) => f.team));
    const displaced = actual.filter((f) => !inReach.has(f.team));
    const added = reach.filter((f) => !inActual.has(f.team));
    if (displaced.length !== 1 || added.length !== 1 || added[0].team !== team) return reach;
    return actual.map((f) => (f === displaced[0] ? added[0] : f));
};

/** One season: events and checkpoints in date order, with fields resolved from the run's own lists. */
export const runSeason = (input: SeasonInput, run: number): RunResult => {
    const { checkpoints, predictor } = input;
    const seed = runSeed(input.seed, run);
    const bySlug = new Map(input.events.map((e) => [e.config.slug, e]));
    // A projected feeder plays exactly when the projected edition it feeds does.
    const drawOf = (e: SeasonEvent): SeasonEvent => {
        const target = e.feeds ? bySlug.get(e.feeds.slug) : undefined;
        return target?.chance !== undefined ? drawOf(target) : e;
    };
    const events = input.events.filter((e) => {
        if (e.chance === undefined) return true;
        const d = drawOf(e);
        return makeRng(subSeed(seed, `happens|${d.config.slug}`))() < d.chance!;
    });
    const inRun = new Set(events.map((e) => e.config.slug));
    const feedersOf = new Map<string, SeasonEvent[]>();
    for (const e of events) if (e.feeds && inRun.has(e.feeds.slug)) feedersOf.set(e.feeds.slug, [...(feedersOf.get(e.feeds.slug) ?? []), e]);
    const rng = makeRng(seed);
    predictor.resample(input.teams, rng);
    const learned = input.fields;
    const pacer = learned ? new Pacer(learned.activity, learned.horizonEnd, learned.horizonDays, seed) : null;
    const capsOf = (team: TeamId): Caps => learned?.caps(team) ?? { lan: input.volumeCap, online: input.onlineCap ?? Infinity };

    const lists = new Map(input.published);
    const latestPublished = [...input.published.keys()].sort().at(-1) ?? "";
    const listFor = (month: string) => latestBefore(lists, month) ?? lists.get(latestPublished) ?? [];
    const latestList = () => listFor("9999-12");

    const commitments = new Map<TeamId, Stint[]>();
    const commit = (team: TeamId, e: SeasonEvent) => {
        commitments.set(team, [...(commitments.get(team) ?? []), e.stint]);
        pacer?.record(input.teamIdOf(team), e.category);
    };
    for (const e of events) for (const team of e.fixed ? e.config.stages.flatMap((s) => s.invited ?? []) : e.field.announced) commit(team, e);

    const fields = new Map<string, { field: FieldEntry[] } | { field: null; short: number }>();
    const reach = new Map<string, (team: TeamId) => FieldEntry[] | null>();
    for (const e of events) {
        if (e.fixed) fields.set(e.config.slug, { field: [...new Set(e.config.stages.flatMap((s) => s.invited ?? []))].map((team) => ({ team, source: "announced" as const })) });
    }
    const played = new Set<string>();
    /** Per linked event, teams its feeders sent → the slot each fills. */
    const qualified = new Map<string, Map<TeamId, string>>();
    /** Per linked event, places held at its resolve for feeders still to play, by slot. */
    const pending = new Map<string, Map<string, number>>();
    /** Per event, teams added after it resolved: feeders' qualifiers and leftover draws. */
    const late = new Map<string, FieldEntry[]>();
    const qualifiedFrom = new Map<string, Array<{ from: string; team: TeamId }>>();
    const topOf = (list: ListEntry[]) => new Set(list.filter((x) => x.globalRank !== null && x.globalRank <= LOWER_TIER_TOP_RANK).map((x) => x.team));

    const linkedFor = (e: SeasonEvent): LinkedSlots => {
        const reserved = new Map<string, number>();
        for (const f of feedersOf.get(e.config.slug) ?? []) {
            if (!played.has(f.config.slug)) reserved.set(f.feeds!.slotKey, (reserved.get(f.feeds!.slotKey) ?? 0) + f.feeds!.count);
        }
        return { filled: new Map(qualified.get(e.config.slug) ?? []), reserved };
    };

    /** A feeder's entrants must be free for, and allowed into, the event it feeds. */
    const feederDeclines = (e: SeasonEvent, held: Map<TeamId, Stint[]>, top: Set<TeamId>) => {
        const target = e.feeds && inRun.has(e.feeds.slug) ? bySlug.get(e.feeds.slug)! : null;
        if (!target) return () => false;
        const inTarget = new Set(fieldOf(target.config.slug)?.map((f) => f.team) ?? []);
        const already = qualified.get(target.config.slug);
        const lowerTier = isLowerTier(target.field);
        return (team: TeamId) =>
            inTarget.has(team) || !!already?.has(team) || !fits(held.get(team) ?? [], target.stint, capsOf(team)) || (lowerTier && top.has(team));
    };
    const fieldOf = (slug: string): FieldEntry[] | null => {
        const f = fields.get(slug);
        return f && f.field !== null ? f.field : null;
    };

    /** Sends a feeder's best finishers to the event it feeds, passing down past teams already in it or unable to go. */
    const advance = (e: SeasonEvent, field: FieldEntry[], outcome: EventOutcome) => {
        if (!e.feeds || !inRun.has(e.feeds.slug)) return;
        const target = bySlug.get(e.feeds.slug)!;
        const slug = target.config.slug;
        if (fields.has(slug) && fields.get(slug)!.field === null) return;
        const targetField = fieldOf(slug);
        const inTarget = new Set(targetField?.map((f) => f.team) ?? []);
        const sent = qualified.get(slug) ?? new Map<TeamId, string>();
        qualified.set(slug, sent);
        const top = topOf(latestList());
        const lowerTier = isLowerTier(target.field);
        const order = field
            .map((f, i) => ({ team: f.team, i, pos: positionOf(outcome.placements.get(f.team)) }))
            .sort((a, b) => a.pos - b.pos || a.i - b.i);
        const key = e.feeds.slotKey;
        const held = pending.get(slug);
        let left = targetField ? Math.min(e.feeds.count, held?.get(key) ?? 0) : e.feeds.count;
        for (const { team } of order) {
            if (left <= 0) break;
            if (inTarget.has(team) || sent.has(team) || !fits(commitments.get(team) ?? [], target.stint, capsOf(team)) || (lowerTier && top.has(team))) continue;
            sent.set(team, key);
            commit(team, target);
            qualifiedFrom.set(slug, [...(qualifiedFrom.get(slug) ?? []), { from: e.config.slug, team }]);
            if (targetField && held) {
                targetField.push({ team, source: "qualifier" });
                late.set(slug, [...(late.get(slug) ?? []), { team, source: "qualifier" }]);
                held.set(key, held.get(key)! - 1);
            }
            left--;
        }
    };

    const resolve = (e: SeasonEvent) => {
        const seedList = latestList();
        const top = topOf(seedList);
        const declinesGiven = (held: Map<TeamId, Stint[]>) => {
            const feeder = feederDeclines(e, held, top);
            return (team: TeamId) => !fits(held.get(team) ?? [], e.stint, capsOf(team)) || feeder(team);
        };
        const model = learned?.models.get(e.config.slug);
        const fieldSeed = subSeed(seed, `field|${e.config.slug}`);
        const paces = new Map<TeamId, number>();
        const samplerFor = (forced?: TeamId): FieldSampler | undefined =>
            model && learned && pacer
                ? {
                      seed: fieldSeed,
                      model,
                      unranked: learned.unranked,
                      drawable: learned.drawable,
                      affinity: learned.affinity?.get(e.config.slug),
                      acceptShift: learned.acceptance?.get(e.config.slug),
                      forced,
                      // Reach reruns this draw after the run, so it reuses the paces the real draw saw.
                      pace: (team) => {
                          let p = paces.get(team);
                          if (p === undefined) {
                              p = forced === undefined ? pacer.pace(input.teamIdOf(team), e.category, e.config.startDate) : 1;
                              if (forced === undefined) paces.set(team, p);
                          }
                          return p;
                      },
                  }
                : undefined;
        const slug = e.config.slug;
        const linked = linkedFor(e);
        const { field, short } = resolveField(e.field, listFor, seedList, declinesGiven(commitments), samplerFor(), linked);

        // Commit replaces a team's array rather than mutating it, so shallow copies hold this moment.
        const listsNow = new Map(lists);
        const declinesNow = declinesGiven(new Map(commitments));
        const listForNow = (month: string) => latestBefore(listsNow, month) ?? listsNow.get(latestPublished) ?? [];
        reach.set(slug, (team) => {
            const r = resolveField(e.field, listForNow, seedList, (t) => t !== team && declinesNow(t), samplerFor(team), linked);
            if (r.short !== 0 || !r.field.some((f) => f.team === team)) return null;
            const inReach = new Set(r.field.map((f) => f.team));
            const added = (late.get(slug) ?? []).filter((f) => f.team !== team && !inReach.has(f.team));
            return inPlaceOf(fieldOf(slug) ?? field, [...r.field, ...added], team);
        });

        if (short > 0) {
            fields.set(slug, { field: null, short });
            return;
        }
        for (const entry of field) if (entry.source !== "announced" && !linked.filled.has(entry.team)) commit(entry.team, e);
        fields.set(slug, { field });
        if (linked.reserved.size === 0) return;
        pending.set(slug, new Map(linked.reserved));
        // Slots whose feeder sent too few teams are drawn at the start, on the streams the first draw would have used.
        topUps.set(slug, (missing) => {
            const current = fieldOf(slug)!;
            const qualifiers = missing.map(([key, count]) => ({ label: key.slice("qualifier:".length), count }));
            const r = resolveField(
                { ...e.field, announced: current.map((f) => f.team), announcedVia: {}, invites: { slots: [], qualifiers, verified: false } },
                listFor,
                latestList(),
                declinesGiven(commitments),
                samplerFor()
            );
            const have = new Set(current.map((f) => f.team));
            return r.short > 0 ? null : r.field.filter((f) => !have.has(f.team)).map((f) => ({ team: f.team, source: "qualifier" as const }));
        });
    };
    const topUps = new Map<string, (missing: Array<[string, number]>) => FieldEntry[] | null>();
    const resolveDue = (month: string) => {
        for (const e of events) if (!fields.has(e.config.slug) && e.listMonth !== null && e.listMonth <= month) resolve(e);
    };
    resolveDue(latestPublished);

    const delta = { matches: [] as ValveMatch[], events: [] as ValveEvent[] };
    const result: RunResult = { standings: [], events: new Map(), reach, eventIds: new Map(), delta, inexact: [], qualifiedFrom };

    type Step = { kind: "checkpoint"; index: number; date: string } | { kind: "event"; event: SeasonEvent; date: string };
    const steps: Step[] = [
        ...checkpoints.map((c, index) => ({ kind: "checkpoint" as const, index, date: c.date })),
        ...events.map((event) => ({ kind: "event" as const, event, date: event.config.startDate })),
    ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "event" ? -1 : 1));

    const replay = input.replay;
    const replayRng = makeRng(subSeed(seed, "replay"));
    let replayed = 0;
    if (replay) delta.events.push(...replay.events);

    for (const step of steps) {
        if (step.kind === "checkpoint") {
            const { world, date } = checkpoints[step.index];
            const before = Date.parse(`${date}T00:00:00Z`) / 1000;
            while (replay && replayed < replay.matches.length && replay.matches[replayed].matchStartTime < before) {
                const m = replay.matches[replayed++];
                if (!replay.redraw || m.forfeited) {
                    delta.matches.push(m);
                    continue;
                }
                predictor.setHorizon(replay.horizonOf(m.matchStartTime));
                predictor.setTier?.(null);
                const p = predictor.seriesProbability(replay.teamOf(String(m.team1Id)), replay.teamOf(String(m.team2Id)), 3);
                delta.matches.push({ ...m, winningTeam: replayRng() < p ? 1 : 2 });
            }
            const fast = rerun(world, delta);
            let standings = fast.standings;
            if (!fast.exact) {
                result.inexact.push(`${date}: ${fast.inexact}`);
                const full = applyDelta(input.base, delta);
                standings = computeStandings(full.matches, full.events, date, { windowEndsAtPull: true });
            }
            result.standings.push(standings);
            input.onCheckpoint?.(run, step.index, fast.exact ? fast : null, standings, result);
            lists.set(monthOf(date), input.listEntries(standings.rosters));
            resolveDue(monthOf(date));
            continue;
        }
        const e = step.event;
        const slug = e.config.slug;
        if (!fields.has(slug)) resolve(e);
        let resolved = fields.get(slug)!;
        const missing = [...(pending.get(slug) ?? [])].filter(([, k]) => k > 0);
        if (resolved.field !== null && missing.length > 0) {
            const extra = topUps.get(slug)!(missing);
            if (extra === null) {
                resolved = { field: null, short: missing.reduce((s, [, k]) => s + k, 0) };
                fields.set(slug, resolved);
            } else {
                for (const entry of extra) {
                    resolved.field.push(entry);
                    commit(entry.team, e);
                }
                late.set(slug, [...(late.get(slug) ?? []), ...extra]);
            }
        }
        pending.delete(slug);
        if (resolved.field === null) {
            result.events.set(slug, resolved);
            continue;
        }
        const config = e.fixed ? e.config : withField(e.config, resolved.field.map((f) => f.team), e.entryStages);
        predictor.setHorizon(e.horizon);
        const playSeed = subSeed(seed, `play|${e.config.slug}`);
        const outcome = runEvent({ config, known: e.known, horizon: e.horizon, seriesSeed: playSeed }, predictor, makeRng(playSeed));
        const part = input.toDelta({ ...e.projection, config }, outcome);
        delta.matches.push(...part.matches);
        delta.events.push(...part.events);
        result.events.set(slug, { field: resolved.field, outcome });
        result.eventIds.set(slug, part.events.map((ev) => String(ev.eventId)));
        played.add(slug);
        advance(e, resolved.field, outcome);
    }
    return result;
};

export interface Range {
    p10: number | null;
    p50: number | null;
    p90: number | null;
}

/** Percentiles over `n` runs; runs missing from `values` count as `missing`, and an infinite percentile is null. */
export const range = (values: number[], n: number, missing: number, round = (x: number) => x): Range => {
    const sorted = [...values, ...Array<number>(Math.max(0, n - values.length)).fill(missing)].sort((a, b) => a - b);
    const at = (q: number) => {
        const v = sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        return v === undefined || !Number.isFinite(v) ? null : round(v);
    };
    return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
};

export interface RosterTally {
    teamName: string;
    region: Roster["region"];
    players: string[];
    points: number[];
    globalRanks: number[];
    regionalRanks: number[];
}

export interface EventTally {
    runs: number;
    shortRuns: number;
    /** Places filled by a linked feeder's finishers, summed over played runs. */
    linked: number;
    teams: Map<TeamId, { attend: number; sources: Map<FieldSource, number>; placements: Map<string, number> }>;
}

export interface SeasonTally {
    /** Checkpoint → rosterKey → values over the runs it appeared in. */
    standings: Array<Map<string, RosterTally>>;
    events: Map<string, EventTally>;
    inexact: number;
    inexactReasons: Map<string, number>;
    n: number;
    impact: ImpactTally;
    /** |exact − one-team| points change for sampled (run, event, team) triples. */
    impactErrors: number[];
    /** Impact checkpoints whose rerun relinked rosters, so impact froze a freshly loaded world instead. */
    impactFullLoads: number;
}

const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

export const tallyRun = (tally: SeasonTally, result: RunResult, rosterId: (r: Roster) => string) => {
    tally.n++;
    tally.inexact += result.inexact.length;
    for (const reason of result.inexact) bump(tally.inexactReasons, reason.replace(/^\S+: /, ""));
    result.standings.forEach((s, i) => {
        tally.standings[i] ??= new Map();
        const seen = new Set<string>();
        for (const r of [...s.rosters].sort((a, b) => b.points - a.points)) {
            const id = rosterId(r);
            if (seen.has(id)) continue;
            seen.add(id);
            let t = tally.standings[i].get(id);
            if (!t) {
                t = { teamName: r.teamName, region: r.region, players: r.players, points: [], globalRanks: [], regionalRanks: [] };
                tally.standings[i].set(id, t);
            }
            t.points.push(r.points);
            if (r.globalRank !== null) t.globalRanks.push(r.globalRank);
            if (r.regionalRank !== null) t.regionalRanks.push(r.regionalRank);
        }
    });
    for (const [slug, ev] of result.events) {
        let t = tally.events.get(slug);
        if (!t) {
            t = { runs: 0, shortRuns: 0, linked: 0, teams: new Map() };
            tally.events.set(slug, t);
        }
        t.runs++;
        if (ev.field === null) {
            t.shortRuns++;
            continue;
        }
        const inField = new Set(ev.field.map((f) => f.team));
        t.linked += (result.qualifiedFrom.get(slug) ?? []).filter((q) => inField.has(q.team)).length;
        for (const { team, source } of ev.field) {
            let tt = t.teams.get(team);
            if (!tt) {
                tt = { attend: 0, sources: new Map(), placements: new Map() };
                t.teams.set(team, tt);
            }
            tt.attend++;
            bump(tt.sources, source);
            const label = ev.outcome.placements.get(team);
            if (label) bump(tt.placements, label);
        }
    }
};

export const emptySeasonTally = (checkpoints: number): SeasonTally => ({
    standings: Array.from({ length: checkpoints }, () => new Map()),
    events: new Map(),
    inexact: 0,
    inexactReasons: new Map(),
    n: 0,
    impact: new Map(),
    impactErrors: [],
    impactFullLoads: 0,
});

const addCounts = <K>(into: Map<K, number>, from: Map<K, number>) => {
    for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v);
};

/** Appends `from` to `into`; merging one-run tallies in run order gives the same tally, key order included, as `tallyRun` in sequence. */
export const mergeSeasonTally = (into: SeasonTally, from: SeasonTally) => {
    into.n += from.n;
    into.inexact += from.inexact;
    addCounts(into.inexactReasons, from.inexactReasons);
    mergeImpact(into.impact, from.impact);
    into.impactErrors.push(...from.impactErrors);
    into.impactFullLoads += from.impactFullLoads;
    from.standings.forEach((cp, i) => {
        into.standings[i] ??= new Map();
        for (const [id, t] of cp) {
            const x = into.standings[i].get(id);
            if (!x) {
                into.standings[i].set(id, { ...t, points: [...t.points], globalRanks: [...t.globalRanks], regionalRanks: [...t.regionalRanks] });
                continue;
            }
            x.points.push(...t.points);
            x.globalRanks.push(...t.globalRanks);
            x.regionalRanks.push(...t.regionalRanks);
        }
    });
    for (const [slug, ev] of from.events) {
        let x = into.events.get(slug);
        if (!x) {
            x = { runs: 0, shortRuns: 0, linked: 0, teams: new Map() };
            into.events.set(slug, x);
        }
        x.runs += ev.runs;
        x.shortRuns += ev.shortRuns;
        x.linked += ev.linked;
        for (const [team, tt] of ev.teams) {
            let y = x.teams.get(team);
            if (!y) {
                y = { attend: 0, sources: new Map(), placements: new Map() };
                x.teams.set(team, y);
            }
            y.attend += tt.attend;
            addCounts(y.sources, tt.sources);
            addCounts(y.placements, tt.placements);
        }
    }
};

export const simulateSeason = (input: SeasonInput, onProgress?: (done: number) => void): SeasonTally => {
    const tally = emptySeasonTally(input.checkpoints.length);
    for (let run = 0; run < input.n; run++) {
        tallyRun(tally, runSeason(input, run), input.rosterId);
        onProgress?.(run + 1);
    }
    return tally;
};
