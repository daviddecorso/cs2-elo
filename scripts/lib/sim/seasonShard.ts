import { indicesOf } from "../../../src/sim/schedule.ts";
import type { ValveEvent, ValveMatch } from "../vrs/buildMatchdata.ts";
import { freeze, type FrozenWorld } from "../vrs/oneTeam.ts";
import { computeStandings } from "../vrs/valveModel.ts";
import { loadWorld, rerun, type RerunResult } from "../vrs/valveWorld.ts";
import { eventImpact, impactCheckpoint, tallyImpact, type ImpactSample } from "./impact.ts";
import { emptyOptimizerTally, optimizeRun, rescoreOne, scheduleDelta, type OptimizerTally, type RescoreJob, type RescoreResult, type RescoreRun } from "./optimizer.ts";
import { makeRng, runSeed, subSeed } from "./rng.ts";
import { emptySeasonTally, runSeason, tallyRun, type RunResult, type SeasonInput, type SeasonTally } from "./season.ts";
import type { SeasonSetup } from "./seasonSetup.ts";
import { applyDelta } from "./vrsProjection.ts";

export interface Shard {
    /** Plays `runs`, handing each run's one-run season tally to `onRun`, and returns the optimizer's scores for them. */
    play(runs: number[], onRun: (run: number, season: SeasonTally) => void): OptimizerTally;
    /** Exact re-scores; every job's run must have been played by this shard. */
    rescore(jobs: RescoreJob[]): RescoreResult[];
}

/** One sampled team's one-team impact, kept to compare with two exact reruns once the run is done. */
interface ImpactCheck {
    checkpoint: number;
    eventIds: Set<string>;
    teamId: string;
    playerIds: string[];
    withPoints: number;
    delta: number;
}

const SHARED_PLAYERS = 3;

/** Runs seasons and the optimizer for a set of runs, keeping what the re-score of runs below `rescoreN` needs. */
export const createShard = (setup: SeasonSetup, rescoreN: number, impactCheckN = 0): Shard => {
    const { input, optimizer: ctx } = setup;
    const last = input.checkpoints.length - 1;
    const target = input.checkpoints[last];
    const dates = input.checkpoints.map((c) => c.date);
    const impactAt = input.events.map((e) => impactCheckpoint(dates, e.config.endDate));

    let current: { run: number; result: RerunResult | null; frozenTarget: FrozenWorld | null; season: SeasonTally; checks: ImpactCheck[] };
    const resetRun = (run: number) => {
        current = { run, result: null, frozenTarget: null, season: emptySeasonTally(input.checkpoints.length), checks: [] };
    };
    resetRun(-1);

    const recordImpact = (checkpoint: number, result: RerunResult | null, soFar: RunResult) => {
        const due = input.events.filter((e, i) => impactAt[i] === checkpoint && setup.impactEvents.has(e.config.slug) && soFar.events.get(e.config.slug)?.field);
        if (due.length === 0) return;
        let state = result?.state;
        if (!state) {
            current.season.impactFullLoads++;
            const full = fullInput(soFar.delta);
            state = rerun(loadWorld(full.matches, full.events, dates[checkpoint], { windowEndsAtPull: true })).state;
        }
        const frozen = freeze(state);
        if (checkpoint === last && result) current.frozenTarget = frozen;
        const indexOf = new Map(state.teams.map((t, i) => [t, i]));
        for (const e of due) {
            const slug = e.config.slug;
            const played = soFar.events.get(slug)!;
            if (!played.field) continue;
            const eventIds = new Set(soFar.eventIds.get(slug) ?? []);
            const rosterOfId = new Map<string, number>();
            for (const m of state.matchesAsc) {
                if (!eventIds.has(String(m.eventId))) continue;
                rosterOfId.set(String(m.team1Id), indexOf.get(m.team1)!);
                rosterOfId.set(String(m.team2Id), indexOf.get(m.team2)!);
            }
            const teams = played.field.flatMap(({ team }) => {
                const roster = rosterOfId.get(input.teamIdOf(team));
                const placement = played.outcome.placements.get(team);
                return roster === undefined || !placement ? [] : [{ team, roster, placement }];
            });
            const samples: ImpactSample[] = eventImpact(frozen, eventIds, teams);
            tallyImpact(current.season.impact, slug, samples);

            if (current.run >= impactCheckN || samples.length === 0) continue;
            const rng = makeRng(subSeed(runSeed(input.seed, current.run), `impact:${slug}`));
            const k = Math.floor(rng() * samples.length);
            const own = frozen.rosters[teams[k].roster];
            current.checks.push({
                checkpoint,
                eventIds,
                teamId: input.teamIdOf(samples[k].team),
                playerIds: own.playerIds,
                withPoints: own.points,
                delta: samples[k].delta,
            });
        }
    };

    const shardInput: SeasonInput = {
        ...input,
        onCheckpoint: (_run, checkpoint, result, _standings, soFar) => {
            if (checkpoint === last) current.result = result;
            recordImpact(checkpoint, result, soFar);
        },
    };
    const kept = new Map<number, RescoreRun>();
    const fullInput = (delta: { matches: ValveMatch[]; events: ValveEvent[] }) => applyDelta(input.base, delta);

    /** The run's delta as it stood at `checkpoint`: events are played on their start date, before a same-day checkpoint. */
    const deltaAt = (result: RunResult, checkpoint: number) => {
        const ids = new Set(
            input.events.filter((e) => e.config.startDate <= dates[checkpoint]).flatMap((e) => result.eventIds.get(e.config.slug) ?? [])
        );
        return {
            matches: result.delta.matches.filter((m) => ids.has(String(m.eventId))),
            events: result.delta.events.filter((e) => ids.has(String(e.eventId))),
        };
    };

    /** |exact − one-team| for each check, or nothing when the exact rerun relinks or loses the roster. Clobbers checkpoint states. */
    const runChecks = (result: RunResult) =>
        current.checks.flatMap((c) => {
            const without = rerun(input.checkpoints[c.checkpoint].world, {
                ...deltaAt(result, c.checkpoint),
                excludeMatch: (m) => c.eventIds.has(String(m.eventId)) && (String(m.team1Id) === c.teamId || String(m.team2Id) === c.teamId),
            });
            if (!without.exact) return [];
            const ids = new Set(c.playerIds);
            const roster = without.state.teams.find((t) => t.players.filter((p) => ids.has(String(p.playerId))).length >= SHARED_PLAYERS);
            return roster ? [Math.abs(c.withPoints - roster.rankValue - c.delta)] : [];
        });

    return {
        play(runs, onRun) {
            const optimizer = emptyOptimizerTally(ctx.opt, input.n);
            for (const run of runs) {
                resetRun(run);
                const result = runSeason(shardInput, run);
                const season = current.season;
                tallyRun(season, result, input.rosterId);
                let state = current.result?.state;
                let frozen = current.frozenTarget ?? undefined;
                if (!state) {
                    optimizer.inexactTargets++;
                    const full = fullInput(result.delta);
                    state = rerun(loadWorld(full.matches, full.events, target.date, { windowEndsAtPull: true })).state;
                    frozen = undefined;
                }
                const data = optimizeRun(ctx, optimizer, run, result, state, run < rescoreN, frozen);
                if (data) kept.set(run, data);
                season.impactErrors.push(...runChecks(result));
                onRun(run, season);
            }
            return optimizer;
        },
        rescore(jobs) {
            return jobs.map((job) => {
                const data = kept.get(job.run);
                if (!data) throw new Error(`Run ${job.run} wasn't played by this shard`);
                const team = ctx.opt.teams[job.team];
                const chosen = new Set(indicesOf(team.masks[job.mask]).map((u) => input.events[team.universe[u]].config.slug));
                const delta = scheduleDelta(data, input, team, chosen);
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
