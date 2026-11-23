import type { ValveMatch } from "../../vrs/buildMatchdata.ts";
import { findRoster, freeze, scoreTeam, slimFrozen, withoutEvents, type FrozenWorld, type Ledger } from "../../vrs/oneTeam.ts";
import { computeStandings } from "../../vrs/valveModel.ts";
import { loadWorld, rerun, type RerunResult, type WorldState } from "../../vrs/valveWorld.ts";
import { allocateInvites, previousMajorSlots, totalSlots, type StageSlots } from "../invites.ts";
import {
    compose,
    cutFragment,
    feedersFor,
    ledgerFragment,
    MAX_PATH_DEPTH,
    replayEvent,
    rescoreOne,
    type Delta,
    type Fragment,
    type OptimizeRunContext,
    type OptimizerTeam,
} from "../optimizer.ts";
import { eventGain, GAIN_PARTS, NOT_QUALIFIED } from "../gain.ts";
import { positionOf, runSeason, type RunResult, type SeasonEvent, type SeasonInput } from "../season.ts";
import type { SeasonSetup } from "../seasonSetup.ts";
import type { TeamId } from "../types.ts";
import { applyDelta } from "../vrsProjection.ts";
import type { OptionSet } from "./options.ts";

/** Points over the cutoff that move the smoothed invite from 0.5 to about 0.73. */
export const SMOOTH_POINTS = 10;

/** One event an option puts the team in: as the run played it, or replayed with the team in the field. */
export interface PlanStep {
    slug: string;
    replay?: Delta;
}

/** What one run says about the team and its options, sent back to the main thread. */
export interface PlanRunInfo {
    run: number;
    /** False when the team's roster isn't in the target world; such runs score nothing. */
    seen: boolean;
    slotsKnown: boolean;
    eligible: boolean;
    /** Points at or above which the team is invited, with other rosters frozen; Infinity when its region has no slots. */
    cutoff: number;
    /** Under the season's own attendance rules. */
    rules: { points: number; invited: boolean };
    /** Per option: the team had a place (or played), entered a feeder, qualified through one. */
    reached: Uint8Array;
    entered: Uint8Array;
    qualified: Uint8Array;
    replays: number;
    /** Options whose events the frozen world couldn't place, so they score nothing this run. */
    skipped: number;
    /** Qualifications through a feeder whose slot the target didn't fill from it, so there's no place to take. */
    noSlot: number;
    /** Per option: the team's finish at its event (0 = none, `NOT_QUALIFIED` = entered a feeder and failed). */
    place: Uint16Array;
    /** Per (option × parts): what the option alone adds to the team's points, by `GAIN_PARTS`. */
    gain: Float32Array;
}

/** A run's scoring inputs, kept by the worker that played it. */
export interface PlanRunData {
    info: PlanRunInfo;
    world: FrozenWorld;
    base: Ledger;
    fragments: Array<Fragment | null>;
    exact: ExactData | null;
}

export interface ExactData {
    delta: Delta;
    eventIds: Map<string, string[]>;
    steps: PlanStep[][];
    /** Every event any option holds. */
    held: string[];
    slots: StageSlots | null;
}

export interface ScheduleScore {
    points: number;
    smooth: number;
    invited: boolean;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Plays out one run's options for the team against the run's frozen target world. */
export const planRun = (
    ctx: OptimizeRunContext,
    set: OptionSet,
    team: OptimizerTeam,
    run: number,
    result: RunResult,
    state: WorldState,
    frozen: FrozenWorld,
    keepExact: boolean
): PlanRunData => {
    const { input, opt } = ctx;
    const { events } = input;
    const count = set.options.length;
    const info: PlanRunInfo = {
        run,
        seen: false,
        slotsKnown: false,
        eligible: false,
        cutoff: Infinity,
        rules: { points: 0, invited: false },
        reached: new Uint8Array(count),
        entered: new Uint8Array(count),
        qualified: new Uint8Array(count),
        replays: 0,
        skipped: 0,
        noSlot: 0,
        place: new Uint16Array(count),
        gain: new Float32Array(count * GAIN_PARTS.length),
    };
    const empty: Ledger = { roster: -1, matches: [], events: [] };
    const self = findRoster(frozen, team.playerIds);
    if (self < 0) return { info, world: frozen, base: empty, fragments: [], exact: null };
    info.seen = true;

    const standings = result.standings.at(-1)!;
    const major = ctx.previousSlug ? result.events.get(ctx.previousSlug) : undefined;
    const reachedMajor = major && major.field !== null ? major.outcome.reached : null;
    const slots: StageSlots | null =
        "slots" in opt.previousMajor || reachedMajor !== null ? { ...previousMajorSlots(opt.previousMajor, reachedMajor, ctx.regionOf(standings)), 1: opt.stage1 } : null;
    info.slotsKnown = slots !== null;
    const own = frozen.rosters[self];
    const listed = standings.rosters.find((r) => r.rosterKey === own.rosterKey);
    const region = listed?.region ?? team.region;
    info.eligible = opt.eligible({ players: listed?.players ?? team.nicks, region });
    if (slots) {
        const places = totalSlots(slots, region);
        const rivals = standings.rosters
            .filter((r) => r.region === region && r.regionalRank !== null && r.rosterKey !== listed?.rosterKey && opt.eligible(r))
            .map((r) => r.points)
            .sort((a, b) => b - a);
        info.cutoff = places === 0 ? Infinity : rivals.length < places ? -Infinity : rivals[places - 1];
    }
    const ranked = listed !== undefined && listed.globalRank !== null;
    info.rules = { points: ranked ? listed.points : 0, invited: ranked && slots !== null && allocateInvites(standings.rosters, slots, opt.eligible).has(listed.rosterKey) };

    const ledger = frozen.ledgers[self];
    const inField = (slug: string) => result.events.get(slug)?.field?.some((f) => f.team === team.team) ?? false;
    const replay = (e: SeasonEvent, field: TeamId[]) => {
        info.replays++;
        return replayEvent(ctx, run, e, field);
    };

    type Walk = { position: number; steps: PlanStep[] } | null;
    type Through = { qualified: boolean; steps: PlanStep[]; field?: TeamId[] } | null;
    /** The team's finish at `e`: as played, through its own place, or by qualifying through `e`'s feeders. */
    const place = (e: SeasonEvent, depth: number): Walk => {
        const slug = e.config.slug;
        const played = result.events.get(slug);
        if (!played || played.field === null) return null;
        if (inField(slug)) return { position: positionOf(played.outcome.placements.get(team.team)), steps: [{ slug }] };
        const reached = result.reach.get(slug)?.(team.team);
        if (reached) {
            const r = replay(e, reached.map((f) => f.team));
            return { position: positionOf(r.outcome.placements.get(team.team)), steps: [{ slug, replay: r.part }] };
        }
        if (depth >= MAX_PATH_DEPTH) return null;
        const q = through(e, depth);
        if (!q) return null;
        if (!q.qualified) return { position: Infinity, steps: q.steps };
        const r = replay(e, q.field!);
        return { position: positionOf(r.outcome.placements.get(team.team)), steps: [...q.steps, { slug, replay: r.part }] };
    };
    /** Enters `target`'s feeders in date order until one sends the team; it then takes the place of the team that feeder really sent. */
    const through = (target: SeasonEvent, depth: number): Through => {
        const played = result.events.get(target.config.slug);
        if (!played || played.field === null) return null;
        const steps: PlanStep[] = [];
        let entered = false;
        for (const feeder of feedersFor(events, target.config.slug, team.region)) {
            const w = place(feeder, depth + 1);
            if (!w) continue;
            entered = true;
            steps.push(...w.steps);
            if (w.position > feeder.feeds!.count) continue;
            const sent = result.qualifiedFrom.get(target.config.slug)?.find((q) => q.from === feeder.config.slug)?.team;
            if (sent === undefined || !played.field.some((f) => f.team === sent)) {
                info.noSlot++;
                continue;
            }
            return { qualified: true, steps, field: played.field.map((f) => (f.team === sent ? team.team : f.team)) };
        }
        return entered ? { qualified: false, steps } : null;
    };

    const positions = new Array<number>(count).fill(0);
    const playedAt = (slug: string) => {
        const played = result.events.get(slug);
        return played && played.field !== null ? positionOf(played.outcome.placements.get(team.team)) : 0;
    };
    const replayedAt = (o: number, e: SeasonEvent, field: TeamId[]) => {
        const r = replay(e, field);
        positions[o] = positionOf(r.outcome.placements.get(team.team));
        return r.part;
    };
    const steps: PlanStep[][] = set.options.map((option, o) => {
        const e = events[option.event];
        const slug = e.config.slug;
        if (option.kind !== "qualify") {
            if (inField(slug)) {
                info.reached[o] = 1;
                positions[o] = playedAt(slug);
                return [{ slug }];
            }
            const reached = result.reach.get(slug)?.(team.team);
            if (reached) {
                info.reached[o] = 1;
                return [{ slug, replay: replayedAt(o, e, reached.map((f) => f.team)) }];
            }
            if (option.kind === "event") return [];
        } else if (inField(slug)) {
            // Drawn into a qualifier slot the run didn't simulate.
            info.entered[o] = info.qualified[o] = 1;
            positions[o] = playedAt(slug);
            return [{ slug }];
        }
        const q = through(e, 0);
        if (!q) return [];
        info.entered[o] = 1;
        if (!q.qualified) {
            positions[o] = NOT_QUALIFIED;
            return q.steps;
        }
        info.qualified[o] = 1;
        return [...q.steps, { slug, replay: replayedAt(o, e, q.field!) }];
    });

    const held = [...new Set(set.options.flatMap((o) => o.holds.map((i) => events[i].config.slug)))];
    const playedIds = held.filter(inField).flatMap((slug) => result.eventIds.get(slug) ?? []);
    const base = playedIds.length ? withoutEvents(ledger, new Set(playedIds)) : ledger;
    const fragments = steps.map((list) => {
        const parts: Fragment[] = [];
        for (const step of list) {
            const part = step.replay ? ledgerFragment(frozen, state, team.teamId, self, step.replay) : cutFragment(ledger, result.eventIds.get(step.slug) ?? []);
            if (!part) {
                info.skipped++;
                return null;
            }
            parts.push(part);
        }
        return { matches: parts.flatMap((p) => p.matches), events: parts.flatMap((p) => p.events) };
    });
    const before = scoreTeam(frozen, base, { rank: false });
    fragments.forEach((fragment, o) => {
        if (!fragment || !Number.isFinite(positions[o]) || positions[o] === 0) return;
        info.place[o] = Math.min(positions[o], NOT_QUALIFIED);
        eventGain(frozen, base, fragment, before).parts.forEach((v, p) => (info.gain[o * GAIN_PARTS.length + p] = v));
    });
    return {
        info,
        world: slimFrozen(frozen, self),
        base,
        fragments,
        exact: keepExact ? { delta: result.delta, eventIds: result.eventIds, steps, held, slots } : null,
    };
};

/** One schedule's points, smoothed invite and hard invite on one run, other rosters frozen. */
export const scoreSchedule = (data: PlanRunData, chosen: number[]): ScheduleScore => {
    const { info } = data;
    if (!info.seen) return { points: 0, smooth: 0, invited: false };
    const parts = chosen.flatMap((o) => (data.fragments[o] ? [data.fragments[o]!] : []));
    const score = scoreTeam(data.world, compose(data.base, parts), { rank: false });
    if (score.globalRank === null) return { points: 0, smooth: 0, invited: false };
    const counts = info.eligible && info.slotsKnown;
    return {
        points: score.points,
        smooth: counts ? sigmoid((score.points - info.cutoff) / SMOOTH_POINTS) : 0,
        invited: counts && score.points >= info.cutoff,
    };
};

/** The run's delta with the team playing exactly what the chosen options give it. */
export const planDelta = (exact: ExactData, teamId: string, chosen: number[]): Delta => {
    let { matches, events } = exact.delta;
    const isTeam = (m: ValveMatch) => String(m.team1Id) === teamId || String(m.team2Id) === teamId;
    const kept = new Set<string>();
    const replays: Delta[] = [];
    for (const o of chosen) {
        for (const s of exact.steps[o]) {
            if (s.replay) replays.push(s.replay);
            else kept.add(s.slug);
        }
    }
    for (const slug of exact.held) {
        if (kept.has(slug)) continue;
        const ids = new Set(exact.eventIds.get(slug) ?? []);
        if (!matches.some((m) => ids.has(String(m.eventId)) && isTeam(m))) continue;
        matches = matches.filter((m) => !(ids.has(String(m.eventId)) && isTeam(m)));
        events = events.map((ev) => (ids.has(String(ev.eventId)) ? { ...ev, prizeDistribution: ev.prizeDistribution.filter((p) => String(p.teamId) !== teamId) } : ev));
    }
    for (const r of replays) {
        const replaced = new Set(r.events.map((ev) => String(ev.eventId)));
        matches = [...matches.filter((m) => !replaced.has(String(m.eventId))), ...r.matches];
        events = [...events.filter((ev) => !replaced.has(String(ev.eventId))), ...r.events];
    }
    return { matches, events };
};

export interface ScoreBatch {
    runs: number[];
    /** Schedule s, run j at s × runs.length + j. */
    points: Float32Array;
    smooth: Float32Array;
    invited: Uint8Array;
}

export interface ExactJob {
    run: number;
    chosen: number[];
}

export interface ExactResult extends ExactJob {
    points: number;
    invited: boolean;
    inexact: boolean;
}

export interface PlanShard {
    /** `infos[k]` is focal team k's info for the run. */
    play(runs: number[], onRun?: (infos: PlanRunInfo[]) => void): number;
    /** Scores each of team k's schedules on the requested runs this shard played. */
    score(k: number, schedules: number[][], runs: number[]): ScoreBatch;
    exact(k: number, jobs: ExactJob[]): ExactResult[];
}

/** Runs seasons once for every focal team (`sets[k]` for `opt.teams[k]`) and keeps each run's scoring inputs; `exactRuns` also keep what an exact re-score needs. */
export const createPlanShard = (setup: SeasonSetup, sets: OptionSet[], exactRuns: ReadonlySet<number>): PlanShard => {
    const { input, optimizer: ctx } = setup;
    const teams = ctx.opt.teams;
    const last = input.checkpoints.length - 1;
    const target = input.checkpoints[last];
    const kept = teams.map(() => new Map<number, PlanRunData>());
    let targetResult: RerunResult | null = null;
    const shardInput: SeasonInput = {
        ...input,
        onCheckpoint: (_run, checkpoint, result) => {
            if (checkpoint === last) targetResult = result;
        },
    };
    const fullInput = (delta: Delta) => applyDelta(input.base, delta);
    const runCtx: OptimizeRunContext = { ...ctx, input: shardInput };

    return {
        play(runs, onRun) {
            for (const run of runs) {
                targetResult = null;
                const result = runSeason(shardInput, run);
                let state = (targetResult as RerunResult | null)?.state;
                if (!state) {
                    const full = fullInput(result.delta);
                    state = rerun(loadWorld(full.matches, full.events, target.date, { windowEndsAtPull: true })).state;
                }
                const frozen = freeze(state);
                const infos = teams.map((team, k) => {
                    const data = planRun(runCtx, sets[k], team, run, result, state, frozen, exactRuns.has(run));
                    kept[k].set(run, data);
                    return data.info;
                });
                onRun?.(infos);
            }
            return runs.length;
        },
        score(k, schedules, runs) {
            const own = runs.filter((r) => kept[k].has(r));
            const size = schedules.length * own.length;
            const batch: ScoreBatch = { runs: own, points: new Float32Array(size), smooth: new Float32Array(size), invited: new Uint8Array(size) };
            schedules.forEach((chosen, s) => {
                own.forEach((run, j) => {
                    const v = scoreSchedule(kept[k].get(run)!, chosen);
                    batch.points[s * own.length + j] = v.points;
                    batch.smooth[s * own.length + j] = v.smooth;
                    batch.invited[s * own.length + j] = Number(v.invited);
                });
            });
            return batch;
        },
        exact(k, jobs) {
            const team = teams[k];
            return jobs.map((job) => {
                const data = kept[k].get(job.run)?.exact;
                if (!data) throw new Error(`Run ${job.run} wasn't kept for an exact re-score by this shard`);
                const delta = planDelta(data, team.teamId, job.chosen);
                const fast = rerun(target.world, delta);
                let standings = fast.standings;
                if (!fast.exact) {
                    const full = fullInput(delta);
                    standings = computeStandings(full.matches, full.events, target.date, { windowEndsAtPull: true });
                }
                return { ...job, ...rescoreOne(standings, data.slots, ctx.opt, team), inexact: !fast.exact };
            });
        },
    };
};
