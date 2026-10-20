import type { EventConfig, StageFormat } from "./config.ts";
import { bracket } from "./formats/bracket.ts";
import { doubleElim, singleElim } from "./formats/elimination.ts";
import { gsl, roundRobin } from "./formats/groups.ts";
import { swiss } from "./formats/swiss.ts";
import { StageLocks, type KnownMatch } from "./locks.ts";
import type { SeriesModel } from "./predict.ts";
import { makeRng, type Rng } from "./rng.ts";
import { loserOf, winnerOf, type SimMatch, type SlotPlace, type StageResult, type StageRunner, type TeamId } from "./types.ts";

const FORMATS: Record<StageFormat, StageRunner> = {
    swiss,
    single_elim: singleElim,
    double_elim: doubleElim,
    gsl,
    round_robin: roundRobin,
    bracket,
};

export interface EventInput {
    config: EventConfig;
    /** Stage id → that stage page's known matches. */
    known: Map<string, KnownMatch[]>;
    /** Days from the ratings' as-of date to the event's start. */
    horizon: number;
}

export interface EventOutcome {
    /** Team → placement label in the parent prize table. */
    placements: Map<TeamId, string>;
    /** Team → stages it played in. */
    reached: Map<TeamId, string[]>;
    matches: SimMatch[];
    /** Played matches this run's pairings never reached. */
    diverged: KnownMatch[];
}

export const eventTeams = (config: EventConfig): TeamId[] => [...new Set(config.stages.flatMap((s) => s.invited ?? []))];

export const runEvent = (input: EventInput, predictor: SeriesModel, rng: Rng): EventOutcome => {
    const { config } = input;
    const results = new Map<string, StageResult>();
    const placements = new Map<TeamId, string>();
    const reached = new Map<TeamId, string[]>();
    const matches: SimMatch[] = [];
    const diverged: KnownMatch[] = [];

    for (const stage of config.stages) {
        const advancers = [stage.from ?? []].flat().flatMap((id) => {
            const from = results.get(id);
            if (!from) throw new Error(`${config.slug}: stage ${stage.id} comes from ${id}, which isn't earlier`);
            return from.advancing;
        });
        const teams = [...(stage.invited ?? []), ...advancers];
        for (const t of teams) reached.set(t, [...(reached.get(t) ?? []), stage.id]);

        const locks = new StageLocks(input.known.get(stage.id) ?? []);
        const result = FORMATS[stage.format](teams, {
            config: stage,
            rng,
            knownPairings: (round) => locks.pairings(round),
            play: (a, b, bestOf, round, place) => {
                const lock = locks.take(a, b);
                if (lock) {
                    const winner = (lock.teams[lock.winner!] === a ? 0 : 1) as 0 | 1;
                    return { stage: stage.id, round, ...place, teams: [a, b], bestOf, winner, locked: true, t: lock.t };
                }
                const winner = rng() < predictor.seriesProbability(a, b, bestOf) ? 0 : 1;
                return { stage: stage.id, round, ...place, teams: [a, b], bestOf, winner, locked: false, t: null };
            },
        });
        for (const [team, key] of result.exits) {
            const label = stage.exits[key];
            if (!label) throw new Error(`${config.slug}: stage ${stage.id} has no placement for exit "${key}"`);
            placements.set(team, label);
        }
        results.set(stage.id, result);
        matches.push(...result.matches);
        diverged.push(...locks.unused());
    }
    return { placements, reached, matches, diverged };
};

export interface EventSummary {
    slug: string;
    teams: TeamId[];
    n: number;
    /** Team → placement label → count. */
    placements: Map<TeamId, Map<string, number>>;
    /** Team → stage id → count of simulations it played that stage. */
    reached: Map<TeamId, Map<string, number>>;
    /** Simulations whose pairings missed at least one played match. */
    divergedRuns: number;
    /** `stage/slot` → tally, in first-played order. */
    slots: Map<string, SlotTally>;
}

export interface SlotTally extends SlotPlace {
    stage: string;
    round: number;
    bestOf: number;
    /** Simulations that played this slot at least once. */
    runs: number;
    /** Team → simulations it played here (once per run, even in a Swiss pool). */
    here: Map<TeamId, number>;
    /** Team → matches it won here. */
    won: Map<TeamId, number>;
    /** `a|b`, sorted → matches between them here. */
    pairs: Map<string, number>;
    /** The played matches every simulation had here; null once any differs or is simulated. */
    locked: SimMatch[] | null;
}

const bump = (counts: Map<TeamId, Map<string, number>>, team: TeamId, key: string) => {
    if (!counts.has(team)) counts.set(team, new Map());
    const inner = counts.get(team)!;
    inner.set(key, (inner.get(key) ?? 0) + 1);
};

const add = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

const sameResults = (a: SimMatch[], b: SimMatch[]) =>
    a.length === b.length && a.every((x) => b.some((y) => winnerOf(x) === winnerOf(y) && loserOf(x) === loserOf(y)));

const tallySlots = (slots: Map<string, SlotTally>, matches: SimMatch[]) => {
    const bySlot = new Map<string, SimMatch[]>();
    for (const m of matches) {
        const key = `${m.stage}/${m.slot}`;
        bySlot.set(key, [...(bySlot.get(key) ?? []), m]);
    }
    for (const [key, run] of bySlot) {
        const played = run.every((m) => m.locked) ? run : null;
        let tally = slots.get(key);
        if (!tally) {
            const { stage, slot, lane, round, bestOf } = run[0];
            tally = { stage, slot, lane, round, bestOf, runs: 0, here: new Map(), won: new Map(), pairs: new Map(), locked: played };
            slots.set(key, tally);
        } else if (tally.locked && !(played && sameResults(tally.locked, played))) {
            tally.locked = null;
        }
        tally.runs++;
        for (const team of new Set(run.flatMap((m) => m.teams))) add(tally.here, team);
        for (const m of run) {
            add(tally.won, winnerOf(m));
            add(tally.pairs, [...m.teams].sort().join("|"));
        }
    }
};

export interface SimulateOptions {
    n: number;
    seed: number;
    /** Keep the first `keep` runs' outcomes for the VRS layer. */
    keep?: number;
}

/** All events share one rating path per simulation, so a team that's strong in one event stays strong in the next. */
export const simulateEvents = (
    inputs: EventInput[],
    predictor: SeriesModel,
    { n, seed, keep = 0 }: SimulateOptions
): { summaries: EventSummary[]; outcomes: EventOutcome[][] } => {
    const rng = makeRng(seed);
    const allTeams = [...new Set(inputs.flatMap((i) => eventTeams(i.config)))];
    const summaries: EventSummary[] = inputs.map((i) => ({
        slug: i.config.slug,
        teams: eventTeams(i.config),
        n,
        placements: new Map(),
        reached: new Map(),
        divergedRuns: 0,
        slots: new Map(),
    }));
    const outcomes: EventOutcome[][] = [];

    for (let s = 0; s < n; s++) {
        predictor.resample(allTeams, rng);
        const run = inputs.map((input) => {
            predictor.setHorizon(input.horizon);
            return runEvent(input, predictor, rng);
        });
        run.forEach((o, i) => {
            for (const [team, label] of o.placements) bump(summaries[i].placements, team, label);
            for (const [team, stages] of o.reached) for (const st of stages) bump(summaries[i].reached, team, st);
            if (o.diverged.length) summaries[i].divergedRuns++;
            tallySlots(summaries[i].slots, o.matches);
        });
        if (s < keep) outcomes.push(run);
    }
    return { summaries, outcomes };
};
