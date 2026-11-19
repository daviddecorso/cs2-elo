import type { RawRow } from "../elo/normalize.ts";
import { addDays } from "../liquipedia/rawStore.ts";
import { exclusionReason, kindOf, locationOf, NO_RANKED_RULES, roleOf, tierOf, type CountryRegion, type RankedRules } from "./catalog.ts";
import { categoryOf, type ActivityCategory } from "./history.ts";

/** Categories filled with unannounced events; tier 1 is announced months ahead, so a missing one is news, not a gap. */
export const UNANNOUNCED_CATEGORIES: ActivityCategory[] = ["lan2", "lan34", "online", "qualifier"];
const BUCKET_DAYS = 30;
/** The rate comes from this many days before as-of: event counts grow, and a year-long window lags them (`backtest-fields`). */
export const RATE_DAYS = 180;
/** Larger fields are open leagues filled through unranked rounds; projections skip them too. */
const MAX_TEAMS = 64;
const DROPPED = /cancelled|postponed/i;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

export interface UnannouncedOptions {
    asOf: string;
    /** Events start in (asOf, until). */
    until: string;
    rules?: RankedRules;
    /** Projected editions and the chance each is played, counted as already expected. */
    projected?: Array<{ row: RawRow; chance: number }>;
    /** Teams with a match at a past event, by page: Liquipedia's `participantsnumber` counts about twice that for qualifiers. */
    played?: Map<string, number>;
}

export interface UnannouncedEvent {
    row: RawRow;
    chance: number;
    category: ActivityCategory;
    /** Region of the cell, "global" for events without one. */
    region: string;
}

const LABELS: Record<ActivityCategory, string> = {
    lan1: "tier 1 LAN",
    lan2: "tier 2 LAN",
    lan34: "tier 3–4 LAN",
    online: "online event",
    qualifier: "qualifier",
};

/** Ranked, not cancelled, and top-level or a qualifier: the events the catalog lists. */
const counts = (r: RawRow, rules: RankedRules) =>
    str(r.startdate) !== "" &&
    !DROPPED.test(str(r.status)) &&
    str(r.liquipediatiertype) !== "Showmatch" &&
    !(r.parent && str(r.parent) !== str(r.pagename) && roleOf(r) !== "qualifier") &&
    !exclusionReason(r, rules);

/** The category and region an event counts toward, or null when stand-ins don't cover it. */
export const unannouncedCell = (r: RawRow, rules: RankedRules, countryRegion: CountryRegion): { category: ActivityCategory; region: string } | null => {
    if (!counts(r, rules)) return null;
    const category = categoryOf(kindOf(r), roleOf(r), tierOf(r));
    return UNANNOUNCED_CATEGORIES.includes(category) ? { category, region: locationOf(r, countryRegion)?.region ?? "global" } : null;
};

/** Events Liquipedia doesn't list yet, per category, region and 30-day bucket: the recent rate less what's listed or projected; rows starting after `asOf` count as listed, so pass only what was listed then. */
export const unannouncedEvents = (tournamentRows: RawRow[], countryRegion: CountryRegion, opts: UnannouncedOptions): UnannouncedEvent[] => {
    const rules = opts.rules ?? NO_RANKED_RULES;
    const latest = new Map<string, RawRow>();
    for (const r of tournamentRows) latest.set(str(r.pagename), r);
    type Cell = { category: ActivityCategory; region: string; past: RawRow[]; listed: string[]; projected: Array<{ date: string; chance: number }> };
    const cells = new Map<string, Cell>();
    const cell = (c: { category: ActivityCategory; region: string }) => {
        const key = `${c.category}|${c.region}`;
        let out = cells.get(key);
        if (!out) cells.set(key, (out = { ...c, past: [], listed: [], projected: [] }));
        return out;
    };
    const rateFrom = addDays(opts.asOf, -RATE_DAYS);
    for (const r of latest.values()) {
        const c = unannouncedCell(r, rules, countryRegion);
        if (!c) continue;
        const start = str(r.startdate);
        if (start > opts.asOf) cell(c).listed.push(start);
        else if (start > rateFrom) cell(c).past.push(r);
    }
    for (const p of opts.projected ?? []) {
        const c = unannouncedCell(p.row, rules, countryRegion);
        if (c) cell(c).projected.push({ date: str(p.row.startdate), chance: p.chance });
    }

    const out: UnannouncedEvent[] = [];
    for (const c of [...cells.values()].sort((a, b) => `${a.category}|${a.region}`.localeCompare(`${b.category}|${b.region}`))) {
        const teamsOf = (r: RawRow) => opts.played?.get(str(r.pagename)) ?? Number(r.participantsnumber);
        const templates = c.past.filter((r) => teamsOf(r) >= 2 && teamsOf(r) <= MAX_TEAMS).sort((a, b) => Number(a.prizepool) - Number(b.prizepool));
        if (templates.length === 0) continue;
        const buckets: Array<{ from: string; to: string; expected: number }> = [];
        for (let from = addDays(opts.asOf, 1); from < opts.until; from = addDays(from, BUCKET_DAYS)) {
            const to = addDays(from, BUCKET_DAYS) < opts.until ? addDays(from, BUCKET_DAYS) : opts.until;
            const rate = (c.past.length * days(from, to)) / RATE_DAYS;
            const listed = c.listed.filter((d) => d >= from && d < to).length;
            const projected = c.projected.filter((p) => p.date >= from && p.date < to).reduce((s, p) => s + p.chance, 0);
            buckets.push({ from, to, expected: Math.max(0, rate - listed - projected) });
        }
        const total = buckets.reduce((s, b) => s + Math.ceil(b.expected), 0);
        let j = 0;
        for (const b of buckets) {
            const k = Math.ceil(b.expected);
            for (let i = 0; i < k; i++, j++) {
                const template = templates[Math.floor(((j + 0.5) / total) * templates.length)];
                const start = addDays(b.from, Math.floor(((i + 0.5) / k) * days(b.from, b.to)));
                const duration = Math.max(0, days(str(template.startdate), str(template.enddate) || str(template.startdate)));
                const page = `Unannounced/${c.category}/${c.region}/${start}/${i + 1}`;
                out.push({
                    category: c.category,
                    region: c.region,
                    chance: b.expected / k,
                    row: {
                        ...template,
                        pagename: page,
                        name: `Unannounced ${LABELS[c.category]}${c.region === "global" ? "" : ` (${c.region})`}`,
                        shortname: "",
                        tickername: "",
                        startdate: start,
                        enddate: addDays(start, duration),
                        sortdate: addDays(start, duration),
                        status: "",
                        previous: "",
                        previous2: "",
                        next: "",
                        next2: "",
                        parent: "",
                        seriespage: "",
                        organizers: "",
                        participantsnumber: teamsOf(template),
                    },
                });
            }
        }
    }
    return out.sort((a, b) => str(a.row.startdate).localeCompare(str(b.row.startdate)) || str(a.row.pagename).localeCompare(str(b.row.pagename)));
};
