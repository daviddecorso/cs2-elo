import type { PlanDiff, PlanEventRef, PlanOdds } from "../../../../src/sim/types.ts";
import type { SeasonEvent } from "../season.ts";
import { SMOOTH_POINTS, type PlanRunInfo } from "./planShard.ts";

export const eventRef = (e: SeasonEvent, generic: boolean): PlanEventRef => ({
    slug: e.config.slug,
    name: e.config.name,
    liquipedia: e.config.liquipedia,
    startDate: e.config.startDate,
    endDate: e.config.endDate,
    kind: e.stint.kind ?? "lan",
    tier: e.config.tier ?? null,
    projected: e.projection && e.chance !== undefined ? e.chance : null,
    generic,
});

/** Runs that count toward invite odds: the roster was found and the invite slots are known. */
export const counts = (info: PlanRunInfo) => info.seen && info.slotsKnown;

/** The habitual schedule's smoothed invite on a run, as `scoreSchedule` computes it. */
export const rulesSmooth = (info: PlanRunInfo) =>
    counts(info) && info.eligible && info.rules.points > 0 ? 1 / (1 + Math.exp(-(info.rules.points - info.cutoff) / SMOOTH_POINTS)) : 0;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

/** Odds over runs: smoothed and hard invites over counted runs, points over seen ones. */
export const oddsOf = (runs: Array<{ info: PlanRunInfo; points: number; smooth: number; invited: boolean }>): PlanOdds => {
    const counted = runs.filter((r) => counts(r.info));
    const points = runs.filter((r) => r.info.seen).map((r) => r.points).sort((a, b) => a - b);
    return {
        smooth: mean(counted.map((r) => r.smooth)),
        invite: mean(counted.map((r) => Number(r.invited))),
        points: { mean: mean(points), p10: quantile(points, 0.1), p50: quantile(points, 0.5), p90: quantile(points, 0.9) },
    };
};

/** Mean of paired differences with a normal 95% interval. */
export const pairedDiff = (diffs: number[]): PlanDiff => {
    const m = mean(diffs);
    const sd = diffs.length > 1 ? Math.sqrt(diffs.reduce((a, d) => a + (d - m) ** 2, 0) / (diffs.length - 1)) : 0;
    const half = diffs.length ? (1.96 * sd) / Math.sqrt(diffs.length) : 0;
    return { mean: m, low: m - half, high: m + half };
};
