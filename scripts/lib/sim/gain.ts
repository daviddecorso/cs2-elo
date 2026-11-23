import { scoreTeam, type FrozenWorld, type Ledger, type TeamScore } from "../vrs/oneTeam.ts";
import { WHY_PARTS, type EventWhy } from "../../../src/sim/types.ts";
import type { Fragment } from "./optimizer.ts";

/** Order of `EventGain.parts` and of every tally that stores them. */
export const GAIN_PARTS = WHY_PARTS;
/** A finish for a qualifier route that entered a feeder and didn't qualify. */
export const NOT_QUALIFIED = 65535;
export const NOT_QUALIFIED_LABEL = "DNQ";

export interface EventGain {
    points: number;
    /** Points by source, in `GAIN_PARTS` order; they sum to `points`. */
    parts: number[];
}

const FACTORS = ["bountyCollected", "bountyOffered", "opponentNetwork", "lanFactor"] as const;

/** Valve's seed value is the factors' mean, so each factor takes its share of the seed rating's change; head to head is the rest. */
export const splitGain = (before: TeamScore, after: TeamScore): EventGain => {
    const points = after.points - before.points;
    const seedRating = after.seedRating - before.seedRating;
    const seedValue = after.seedValue - before.seedValue;
    const scale = Math.abs(seedValue) > 1e-9 ? seedRating / seedValue : 0;
    const factors = FACTORS.map((f) => (scale * (after.factors[f] - before.factors[f])) / FACTORS.length);
    return { points, parts: [...factors, points - factors.reduce((a, b) => a + b, 0)] };
};

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Wilson score interval for `k` successes in `n` trials, 95% by default. */
export const wilson = (k: number, n: number, z = 1.96): [number, number] => {
    if (n === 0) return [0, 1];
    const p = k / n;
    const denom = 1 + (z * z) / n;
    const center = (p + (z * z) / (2 * n)) / denom;
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
    return [Math.max(0, center - half), Math.min(1, center + half)];
};

/** `place[offset + run]` is a finishing position (0 = not played or reached), with its gain parts at `gain[(offset + run) × parts + p]`. */
export const summarizeWhy = (place: ArrayLike<number>, gain: ArrayLike<number>, offset: number, runs: number[], prizes: Map<string, number>): EventWhy | undefined => {
    const labelAt = new Map<number, string>();
    for (const label of prizes.keys()) labelAt.set(Number(/^(\d+)/.exec(label)?.[1] ?? NaN), label);
    labelAt.set(NOT_QUALIFIED, NOT_QUALIFIED_LABEL);
    const k = GAIN_PARTS.length;
    const parts = new Array<number>(k).fill(0);
    const byPlace = new Map<number, { count: number; points: number }>();
    let count = 0;
    let prize = 0;
    for (const run of runs) {
        const cell = offset + run;
        const position = place[cell];
        if (!position) continue;
        count++;
        let points = 0;
        for (let p = 0; p < k; p++) {
            parts[p] += gain[cell * k + p];
            points += gain[cell * k + p];
        }
        const at = byPlace.get(position) ?? { count: 0, points: 0 };
        at.count++;
        at.points += points;
        byPlace.set(position, at);
        prize += prizes.get(labelAt.get(position) ?? "") ?? 0;
    }
    if (count === 0) return undefined;
    const mean = parts.map((x) => x / count);
    return {
        n: count,
        points: round1(mean.reduce((a, b) => a + b, 0)),
        parts: mean.map(Math.round),
        place: [...byPlace]
            .sort((a, b) => a[0] - b[0])
            .map(([position, x]) => [labelAt.get(position) ?? String(position), Math.round((x.count / count) * 100) / 100, Math.round(x.points / x.count)]),
        prize: Math.round(prize / count),
    };
};

/** What adding `fragment` alone to `base` is worth to the roster, other rosters frozen. */
export const eventGain = (world: FrozenWorld, base: Ledger, fragment: Fragment, before = scoreTeam(world, base, { rank: false })): EventGain =>
    splitGain(
        before,
        scoreTeam(
            world,
            { roster: base.roster, matches: [...base.matches, ...fragment.matches].sort((a, b) => a.t - b.t), events: [...base.events, ...fragment.events] },
            { rank: false }
        )
    );
