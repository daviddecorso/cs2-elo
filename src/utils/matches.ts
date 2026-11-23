import type { ScheduledMatch } from "../elo/types.ts";

export type ExcitementTier = "low" | "medium" | "high" | "elite";

export interface ExcitementBreakdown {
    quality: number;
    closeness: number;
}

export interface ExcitementResult {
    score: number;
    breakdown: ExcitementBreakdown;
}

const QUALITY_SCALE = 400;

/** 0..1 team quality anchored to the #1 active rating (1 Elo scale below #1 ≈ 0.37). */
const ratingQuality = (rating: number | null, topRating: number): number => {
    if (rating === null) return 0.2;
    return Math.exp(-Math.max(0, topRating - rating) / QUALITY_SCALE);
};

export const computeExcitement = (
    match: Pick<ScheduledMatch, "sides" | "p">,
    topRating: number
): ExcitementResult => {
    const qa = ratingQuality(match.sides[0].rating, topRating);
    const qb = ratingQuality(match.sides[1].rating, topRating);
    const quality = (qa + qb) / 2;
    const closeness = 1 - Math.abs(2 * match.p - 1);
    const score = Math.min(100, 100 * Math.sqrt(Math.max(0, quality * closeness)));
    return { score, breakdown: { quality, closeness } };
};

export const getExcitementTier = (score: number): ExcitementTier => {
    const rounded = Math.round(score);
    if (rounded >= 85) return "elite";
    if (rounded >= 70) return "high";
    if (rounded >= 50) return "medium";
    return "low";
};

export const isUpset = (match: ScheduledMatch): boolean => {
    if (match.status !== "completed" || match.winner === undefined) return false;
    if (Math.abs(match.p - 0.5) < 0.005) return false;
    const favorite: 0 | 1 = match.p >= 0.5 ? 0 : 1;
    return match.winner !== favorite;
};

export interface DayGroup<T = ScheduledMatch> {
    key: string;
    date?: Date;
    items: T[];
}

export const groupByDay = <T extends { t: number | null }>(
    items: T[],
    order: "asc" | "desc"
): DayGroup<T>[] => {
    const byKey = new Map<string, DayGroup<T>>();
    const tbd: T[] = [];

    for (const item of items) {
        if (item.t === null) {
            tbd.push(item);
            continue;
        }
        const d = new Date(item.t * 1000);
        if (Number.isNaN(d.getTime())) {
            tbd.push(item);
            continue;
        }
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const key = `${year}-${month}-${day}`;
        let group = byKey.get(key);
        if (!group) {
            group = { key, date: new Date(year, d.getMonth(), d.getDate()), items: [] };
            byKey.set(key, group);
        }
        group.items.push(item);
    }

    const sorted = [...byKey.values()].sort((a, b) =>
        order === "asc" ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key)
    );
    if (tbd.length > 0) sorted.push({ key: "TBD", items: tbd });
    return sorted;
};

export type MatchSort = "excitement" | "time";

export const sortMatches = (
    matches: ScheduledMatch[],
    sortBy: MatchSort,
    timeOrder: "asc" | "desc",
    topRating: number
): ScheduledMatch[] => {
    const scores = new Map(matches.map((m) => [m.id, computeExcitement(m, topRating).score]));
    const compareTime = (a: ScheduledMatch, b: ScheduledMatch) => {
        if (a.t === null && b.t !== null) return 1;
        if (a.t !== null && b.t === null) return -1;
        if (a.t !== null && b.t !== null && a.t !== b.t) {
            return timeOrder === "asc" ? a.t - b.t : b.t - a.t;
        }
        return 0;
    };

    return [...matches].sort((a, b) => {
        const ea = scores.get(a.id) ?? 0;
        const eb = scores.get(b.id) ?? 0;
        if (sortBy === "excitement") {
            if (ea !== eb) return eb - ea;
            return compareTime(a, b) || a.id.localeCompare(b.id);
        }
        return compareTime(a, b) || eb - ea || a.id.localeCompare(b.id);
    });
};

export const formatDayHeading = (date?: Date): string => {
    if (!date) return "TBD";
    return date.toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
    });
};

export const formatMatchTime = (t: number | null, dateExact: boolean): { localTime: string; localDate: string; utcTooltip?: string } => {
    if (t === null) return { localTime: "TBD", localDate: "TBD" };
    const d = new Date(t * 1000);
    if (Number.isNaN(d.getTime())) return { localTime: "TBD", localDate: "TBD" };
    const localDate = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (!dateExact) return { localTime: "TBD", localDate };
    const localTime = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const utc = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false });
    return { localTime, localDate, utcTooltip: `${utc} UTC` };
};

export const matchAnchor = (id: string): string =>
    `match-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
