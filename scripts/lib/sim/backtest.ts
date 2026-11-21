import { modelPickem, PickemBucket, swissBucket } from "../../../src/sim/pickem.ts";
import type { PickemSet } from "../../../src/sim/types.ts";
import type { EventConfig, StageConfig } from "./config.ts";
import type { KnownMatch } from "./locks.ts";
import { coinPickem, simulateSwissStage } from "./pickemModel.ts";
import type { SeriesModel } from "./predict.ts";
import { makeRng, subSeed } from "./rng.ts";
import { eventTeams, runEvent, type EventOutcome } from "./simulate.ts";
import type { TeamId } from "./types.ts";

export interface Forecast {
    p: number;
    y: 0 | 1;
}

const BUCKET_LABEL: Record<PickemBucket, string> = {
    [PickemBucket.ThreeZero]: "3-0",
    [PickemBucket.Advance]: "3-X",
    [PickemBucket.ZeroThree]: "0-3",
    [PickemBucket.Other]: "out",
};

/** A team's result in one stage: its Pick'em bucket in a Swiss stage, else `advance` or its placement label. */
export const stageOutcomes = (outcome: EventOutcome, config: EventConfig, stage: StageConfig): Map<TeamId, string> => {
    const out = new Map<TeamId, string>();
    const teams = outcome.entrants.get(stage.id) ?? [];
    if (stage.format === "swiss") {
        const record = new Map(teams.map((t) => [t, { wins: 0, losses: 0 }]));
        for (const m of outcome.matches) {
            if (m.stage !== stage.id) continue;
            m.teams.forEach((t, i) => (i === m.winner ? record.get(t)!.wins++ : record.get(t)!.losses++));
        }
        for (const [t, r] of record) out.set(t, BUCKET_LABEL[swissBucket(r.wins, r.losses)]);
        return out;
    }
    const later = config.stages.slice(config.stages.indexOf(stage) + 1).map((s) => s.id);
    for (const t of teams) {
        const advanced = outcome.reached.get(t)?.some((s) => later.includes(s));
        out.set(t, advanced ? "advance" : (outcome.placements.get(t) ?? "?"));
    }
    return out;
};

type Counts = Map<TeamId, Map<string, number>>;

export interface Tally {
    n: number;
    placements: Counts;
    reached: Counts;
    /** Stage id → team → stage outcome (see `stageOutcomes`) → count. */
    stages: Map<string, Counts>;
}

const bump = (counts: Counts, team: TeamId, key: string) => {
    if (!counts.has(team)) counts.set(team, new Map());
    const inner = counts.get(team)!;
    inner.set(key, (inner.get(key) ?? 0) + 1);
};

/** `n` runs of the event with `known` locked; the model resamples each run. */
export const tallyEvent = (
    config: EventConfig,
    known: Map<string, KnownMatch[]>,
    model: SeriesModel,
    { n, seed, horizon = 0 }: { n: number; seed: number; horizon?: number }
): Tally => {
    const rng = makeRng(seed);
    const teams = eventTeams(config);
    const tally: Tally = { n, placements: new Map(), reached: new Map(), stages: new Map(config.stages.map((s) => [s.id, new Map()])) };
    for (let s = 0; s < n; s++) {
        model.resample(teams, rng);
        model.setHorizon(horizon);
        const o = runEvent({ config, known, horizon }, model, rng);
        for (const [team, label] of o.placements) bump(tally.placements, team, label);
        for (const [team, stages] of o.reached) for (const st of stages) bump(tally.reached, team, st);
        for (const stage of config.stages) for (const [team, label] of stageOutcomes(o, config, stage)) bump(tally.stages.get(stage.id)!, team, label);
    }
    return tally;
};

export interface StageScore {
    stage: string;
    /** Mean log loss of each entrant's stage outcome. */
    logLoss: number;
    teams: number;
    /** P(advance from the stage), or P(title) for the last stage, per entrant. */
    advance: Forecast[];
    /** The entrant behind each `advance` forecast. */
    entrants: TeamId[];
    /** Title odds of the actual champion. */
    pChampion: number;
    /** The actual champion's rank in the title odds, 1 = favourite. */
    championRank: number;
}

export interface EventScore {
    /** Mean log loss of each team's final placement label. */
    placementLogLoss: number;
    /** Mean over teams of (P(title) − won)². */
    championBrier: number;
    /** P(reach each later stage) and P(title), per team. */
    reach: Forecast[];
}

const share = (counts: Counts, team: TeamId, key: string, n: number) => (counts.get(team)?.get(key) ?? 0) / n;
const logLossOf = (p: number, n: number) => -Math.log(Math.max(p, 0.5 / n));

export const championOf = (actual: EventOutcome): TeamId => [...actual.placements].find(([, label]) => label === "1")![0];

/** Scores a tally made at the start of `stage` against the actual run. */
export const scoreStage = (config: EventConfig, actual: EventOutcome, tally: Tally, stage: StageConfig): StageScore => {
    const { n } = tally;
    const truth = stageOutcomes(actual, config, stage);
    const counts = tally.stages.get(stage.id)!;
    const last = stage === config.stages.at(-1);
    const next = config.stages[config.stages.indexOf(stage) + 1]?.id;
    let logLoss = 0;
    const advance: Forecast[] = [];
    for (const [team, label] of truth) {
        logLoss += logLossOf(share(counts, team, label, n), n);
        const p = last ? share(tally.placements, team, "1", n) : share(tally.reached, team, next, n);
        const y = last ? actual.placements.get(team) === "1" : actual.reached.get(team)!.includes(next);
        advance.push({ p, y: y ? 1 : 0 });
    }
    const champion = championOf(actual);
    const pChampion = share(tally.placements, champion, "1", n);
    const championRank = 1 + eventTeams(config).filter((t) => share(tally.placements, t, "1", n) > pChampion).length;
    return { stage: stage.id, logLoss: logLoss / truth.size, teams: truth.size, advance, entrants: [...truth.keys()], pChampion, championRank };
};

/** Whole-event scores for a tally made before the first stage. */
export const scoreEvent = (config: EventConfig, actual: EventOutcome, tally: Tally): EventScore => {
    const { n } = tally;
    const teams = eventTeams(config);
    let placementLogLoss = 0;
    let championBrier = 0;
    const reach: Forecast[] = [];
    for (const team of teams) {
        placementLogLoss += logLossOf(share(tally.placements, team, actual.placements.get(team)!, n), n);
        const won = actual.placements.get(team) === "1" ? 1 : 0;
        const pWin = share(tally.placements, team, "1", n);
        championBrier += (pWin - won) ** 2;
        for (const stage of config.stages.slice(1)) {
            if (stage.invited?.includes(team)) continue;
            reach.push({ p: share(tally.reached, team, stage.id, n), y: actual.reached.get(team)!.includes(stage.id) ? 1 : 0 });
        }
        reach.push({ p: pWin, y: won });
    }
    return { placementLogLoss: placementLogLoss / teams.length, championBrier: championBrier / teams.length, reach };
};

export interface PickemResult {
    /** The set maximizing P(5+ correct), as `/major` shows it. */
    coin: PickemSet;
    /** The set maximizing expected correct picks. */
    favourites: PickemSet;
}

/** Both model Pick'em sets for one Swiss stage from its real seeds; `n` pre-stage simulations. */
export const pickemSets = (
    stage: StageConfig,
    seeds: TeamId[],
    odds: (a: TeamId, b: TeamId, bestOf: number) => number,
    { n, seed }: { n: number; seed: number }
): PickemResult | null => {
    const buckets = simulateSwissStage(seeds, stage.bestOf, odds, n, makeRng(subSeed(seed, `${stage.id}:sim`)));
    const coin = coinPickem(seeds, buckets, makeRng(subSeed(seed, `${stage.id}:search`)));
    const k = seeds.length;
    const marginals = seeds.map((team, i) => {
        const c = [0, 0, 0, 0];
        for (let s = 0; s < n; s++) c[buckets[s * k + i]]++;
        return { team, p30: c[PickemBucket.ThreeZero] / n, p3x: c[PickemBucket.Advance] / n, p03: c[PickemBucket.ZeroThree] / n };
    });
    const ev = modelPickem(marginals);
    if (!coin || !ev) return null;
    const teamsOf = (xs: Array<{ team: string }>) => xs.map((x) => x.team);
    return { coin, favourites: { threeZero: teamsOf(ev.threeZero), advance: teamsOf(ev.advance), zeroThree: teamsOf(ev.zeroThree) } };
};

/** Correct picks out of 10 against a stage's actual outcomes. */
export const pickemCorrect = (set: PickemSet, truth: Map<TeamId, string>): number =>
    set.threeZero.filter((t) => truth.get(t) === "3-0").length +
    set.advance.filter((t) => truth.get(t) === "3-X").length +
    set.zeroThree.filter((t) => truth.get(t) === "0-3").length;

export const logLoss = (fs: Forecast[]) => fs.reduce((s, f) => s + logLossOf(f.y ? f.p : 1 - f.p, 1e6), 0) / fs.length;
export const brier = (fs: Forecast[]) => fs.reduce((s, f) => s + (f.p - f.y) ** 2, 0) / fs.length;

/** Forecasts bucketed by tenths of probability: mean forecast, observed rate and count per bucket. */
export const calibration = (fs: Forecast[]) => {
    const buckets = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
    for (const f of fs) {
        const b = buckets[Math.min(9, Math.floor(f.p * 10))];
        b.p += f.p;
        b.y += f.y;
        b.n++;
    }
    return buckets.map((b, i) => ({ from: i / 10, to: (i + 1) / 10, n: b.n, forecast: b.n ? b.p / b.n : NaN, observed: b.n ? b.y / b.n : NaN }));
};
