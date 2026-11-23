import { maskOf } from "./schedule.ts";
import type { EventWhy, SeasonTeamSchedule } from "./types.ts";

export const PART_LABEL: Record<string, string> = {
    bountyCollected: "Bounty collected (beating rich teams)",
    bountyOffered: "Bounty offered (own prize money)",
    opponentNetwork: "Opponent network (beating well-connected teams)",
    lanFactor: "LAN wins",
    headToHead: "Head to head (rating)",
};

type Gain = { points: number; invite: number | null };

const subset = (schedule: SeasonTeamSchedule, mask: number) => schedule.subsets.find((s) => s[0] === mask);

const diff = (schedule: SeasonTeamSchedule, withMask: number, withoutMask: number): Gain | null => {
    const a = subset(schedule, withMask);
    const b = subset(schedule, withoutMask);
    if (!a || !b) return null;
    return { points: a[1] - b[1], invite: a[4] === null || b[4] === null ? null : a[4] - b[4] };
};

export const requiredMask = (schedule: SeasonTeamSchedule): number => maskOf(schedule.candidates.flatMap((c, i) => (c.required ? [i] : [])));

/** Candidate `i` alone against no optional events, from the one-team subset table; null for a required one. */
export const soloGain = (schedule: SeasonTeamSchedule, i: number): Gain | null => {
    const base = requiredMask(schedule);
    return (base >> i) & 1 ? null : diff(schedule, base | (1 << i), base);
};

/** What candidate `i` adds to (or, when already in it, takes from) the rest of `mask`; null when either schedule isn't feasible. */
export const marginalGain = (schedule: SeasonTeamSchedule, mask: number, i: number): Gain | null => diff(schedule, mask | (1 << i), mask & ~(1 << i));

const startOf = (label: string) => Number(/^(\d+)/.exec(label)?.[1] ?? Infinity);

/** The likeliest finish, and the share of runs finishing in the top 4. */
export const finishSummary = (why: EventWhy): { likely: string; top4: number } => ({
    likely: why.place.reduce((a, b) => (b[1] > a[1] ? b : a))[0],
    top4: why.place.filter(([label]) => startOf(label) <= 4).reduce((s, [, share]) => s + share, 0),
});

export const signed = (x: number, digits = 0) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(digits)}`;
