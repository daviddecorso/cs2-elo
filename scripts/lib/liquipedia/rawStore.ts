import { getRowDedupeKey } from "./client.ts";

export type Row = Record<string, unknown>;

/** Inclusive `YYYY-MM-DD` dates. */
export interface DateRange {
    from: string;
    to: string;
}

export interface StoreMeta {
    from: string;
    to: string;
    /** `YYYY-MM-DD` of the last fetch that refetched the whole window. */
    lastFullRefresh: string;
}

/** Liquipedia keeps editing recent results (lineups, forfeits, placements) for about this long. */
export const HOT_DAYS = 14;
export const FULL_REFRESH_DAYS = 7;

export const addDays = (date: string, days: number): string => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

/** Ranges to fetch from the API; the rest of the window is served from stored rows. */
export const planFetchRanges = (
    window: DateRange,
    meta: StoreMeta | null,
    today: string,
    forceFull = false
): { ranges: DateRange[]; full: boolean } => {
    const stale = !meta || addDays(meta.lastFullRefresh, FULL_REFRESH_DAYS) <= today;
    if (forceFull || stale || window.to < meta.from || window.from > meta.to) {
        return { ranges: [window], full: true };
    }

    const ranges: DateRange[] = [];
    if (window.from < meta.from) {
        ranges.push({ from: window.from, to: addDays(meta.from, -1) });
    }
    const hotFrom = [addDays(window.to, -HOT_DAYS), addDays(meta.to, 1)].sort()[0];
    const tailFrom = hotFrom > window.from ? hotFrom : window.from;
    ranges.push({ from: tailFrom, to: window.to });
    return { ranges, full: false };
};

const rowDate = (row: Row): string => String(row.date ?? "").slice(0, 10);

const inRange = (date: string, range: DateRange): boolean => date >= range.from && date <= range.to;

/** Fetched ranges replace stored rows wholesale, so rows deleted on Liquipedia disappear too. */
export const mergeRows = (
    stored: Row[],
    fetched: Array<{ range: DateRange; rows: Row[] }>,
    window: DateRange
): Row[] => {
    const merged = new Map<string, Row>();
    for (const row of stored) {
        const date = rowDate(row);
        if (fetched.some(({ range }) => inRange(date, range))) continue;
        merged.set(getRowDedupeKey(row), row);
    }
    for (const { rows } of fetched) {
        for (const row of rows) merged.set(getRowDedupeKey(row), row);
    }
    return [...merged.values()]
        .filter((row) => inRange(rowDate(row), window))
        .sort((a, b) => rowDate(a).localeCompare(rowDate(b)));
};
