import type { Region } from "../vrs/types.ts";

export type EventKind = "lan" | "online";

export interface Stint {
    startDate: string;
    endDate: string;
    region: Region | null;
    /** Missing means LAN. */
    kind?: EventKind;
}

/** Days needed between one LAN's end and the next's start. */
export const SAME_REGION_BUFFER = 2;
export const CROSS_REGION_BUFFER = 4;
/** Most online events a team plays on any one day. */
export const ONLINE_CONCURRENCY = 2;

const DAY_MS = 86400000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const isOnline = (s: Stint) => s.kind === "online";
const overlaps = (a: Stint, b: Stint) => a.startDate <= b.endDate && b.startDate <= a.endDate;

/** True when a team can't attend both: LANs need a travel buffer (an unknown region counts as cross-region), online events only clash with a LAN on shared days. */
export const conflicts = (a: Stint, b: Stint): boolean => {
    if (isOnline(a) && isOnline(b)) return false;
    if (isOnline(a) || isOnline(b)) return overlaps(a, b);
    const [first, second] = a.startDate <= b.startDate ? [a, b] : [b, a];
    const buffer = first.region && first.region === second.region ? SAME_REGION_BUFFER : CROSS_REGION_BUFFER;
    return daysBetween(first.endDate, second.startDate) < buffer;
};

export interface Caps {
    lan: number;
    online: number;
}

/** Whether `next` can join `held` without a clash, a day with more than `ONLINE_CONCURRENCY` online events, or a cap overrun. */
export const fits = (held: Stint[], next: Stint, caps: Caps): boolean => {
    const online = isOnline(next);
    if (held.filter((s) => isOnline(s) === online).length >= (online ? caps.online : caps.lan)) return false;
    if (held.some((s) => conflicts(s, next))) return false;
    if (!online) return true;
    const concurrent = held.filter((s) => isOnline(s) && overlaps(s, next));
    // Overlaps with `next` are intervals; the busiest day is at one of their start dates, or `next`'s own start.
    const days = [next.startDate, ...concurrent.map((s) => s.startDate)].filter((d) => d >= next.startDate && d <= next.endDate);
    return days.every((d) => concurrent.filter((s) => s.startDate <= d && d <= s.endDate).length < ONLINE_CONCURRENCY);
};

/** Every subset of `stints` (as ascending indices) that `fits` allows, in lexicographic order; stops after `limit` sets. */
export const feasibleSets = (stints: Stint[], caps: Caps, limit = Infinity): number[][] => {
    const out: number[][] = [];
    const visit = (from: number, chosen: number[]) => {
        if (out.length >= limit) return;
        out.push(chosen);
        for (let i = from; i < stints.length; i++) {
            if (fits(chosen.map((j) => stints[j]), stints[i], caps)) visit(i + 1, [...chosen, i]);
        }
    };
    visit(0, []);
    return out;
};

export const popcount = (mask: number): number => {
    let n = 0;
    for (let m = mask; m; m &= m - 1) n++;
    return n;
};

export const indicesOf = (mask: number): number[] => {
    const out: number[] = [];
    for (let i = 0; 1 << i <= mask; i++) if (mask & (1 << i)) out.push(i);
    return out;
};

export const maskOf = (indices: number[]): number => indices.reduce((m, i) => m | (1 << i), 0);

/** `feasibleSets` as bitmasks (bit i = stint i), ascending, with one cap over every event; at most 31 stints. */
export const feasibleMasks = (stints: Stint[], cap: number): number[] => {
    if (stints.length > 31) throw new Error(`${stints.length} stints don't fit a 32-bit mask; use feasibleSets`);
    return feasibleSets(stints, { lan: cap, online: cap })
        .filter((set) => set.length <= cap)
        .map(maskOf)
        .sort((a, b) => a - b);
};
