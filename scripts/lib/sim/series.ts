import type { Region } from "../../../src/vrs/types.ts";
import type { EventKind } from "../../../src/sim/schedule.ts";
import type { RawRow } from "../elo/normalize.ts";
import { addDays } from "../liquipedia/rawStore.ts";
import { exclusionReason, isRanked, kindOf, locationOf, NO_RANKED_RULES, organizerOf, roleOf, type CountryRegion, type RankedRules } from "./catalog.ts";
import type { EventRole } from "./formats/genericFormat.ts";

const SEASON_WORD = /(?<=^|[/_])(?:Spring|Summer|Fall|Autumn|Winter)(?=$|[/_])/g;
const ROMAN = /(?<=^|[/_])(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})(?=$|[/_])/g;

/** One key per recurring series: the page with seasons, Roman numerals and every number replaced, so "CCT/2026/Europe/Series_14" joins "CCT/2025/Europe/Series_3" and "Stake_Pulse/Beat_II" joins "Beat_III". */
export const seriesKey = (page: string): string => page.replace(/ /g, "_").replace(SEASON_WORD, "{s}").replace(ROMAN, "{r}").replace(/\d+/g, "#");

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const DROPPED = /cancelled|postponed/i;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

export interface SeriesCluster {
    /** `seriesKey`, after joining linked keys; with kind, role and region, `id`. */
    key: string;
    id: string;
    kind: EventKind;
    role: EventRole;
    region: Region | null;
    /** Non-cancelled rows, one per start date, oldest first. */
    editions: RawRow[];
    /** The newest row of any status. */
    latest: RawRow;
}

const clusterId = (key: string, row: RawRow, countryRegion: CountryRegion) => `${key}|${kindOf(row)}|${roleOf(row)}|${locationOf(row, countryRegion)?.region ?? null}`;

/** Rows grouped into series: same `seriesKey`, or joined by `previous`/`next` links with the same organizer, then split by kind, role and region. */
export const seriesClusters = (tournamentRows: RawRow[], countryRegion: CountryRegion): SeriesCluster[] => {
    const byPage = new Map<string, RawRow>();
    for (const r of tournamentRows) if (str(r.liquipediatiertype) !== "Showmatch") byPage.set(str(r.pagename), r);

    const parent = new Map<string, string>();
    const find = (k: string): string => {
        let p = parent.get(k) ?? k;
        while (p !== (parent.get(p) ?? p)) p = parent.get(p)!;
        parent.set(k, p);
        return p;
    };
    for (const row of byPage.values()) {
        for (const link of [row.previous, row.previous2, row.next, row.next2].map(str).filter(Boolean)) {
            const other = byPage.get(link.replace(/ /g, "_"));
            if (!other || kindOf(other) !== kindOf(row) || roleOf(other) !== roleOf(row) || organizerOf(other) !== organizerOf(row)) continue;
            const [a, b] = [find(seriesKey(str(row.pagename))), find(seriesKey(str(other.pagename)))].sort();
            if (a !== b) parent.set(b, a);
        }
    }

    const groups = new Map<string, { key: string; rows: RawRow[] }>();
    for (const row of byPage.values()) {
        const key = find(seriesKey(str(row.pagename)));
        const id = clusterId(key, row, countryRegion);
        const g = groups.get(id) ?? { key, rows: [] };
        g.rows.push(row);
        groups.set(id, g);
    }
    return [...groups].map(([id, { key, rows }]) => {
        rows.sort((a, b) => str(a.startdate).localeCompare(str(b.startdate)) || str(a.pagename).localeCompare(str(b.pagename)));
        const editions: RawRow[] = [];
        for (const r of rows) if (!DROPPED.test(str(r.status)) && str(r.startdate) && str(editions.at(-1)?.startdate) !== str(r.startdate)) editions.push(r);
        const latest = rows.at(-1)!;
        return { key, id, kind: kindOf(latest), role: roleOf(latest), region: locationOf(latest, countryRegion)?.region ?? null, editions, latest };
    });
};

export interface Cadence {
    /** Median days between starts over the last `RECENT` gaps, at least `MIN_GAP`. */
    gapDays: number;
    durationDays: number;
    prizePool: number;
    /** 0 when no recent edition lists a team count. */
    teams: number;
    /** Gaps over twice the median, as [start of the edition before, start of the one after]: a winter break, a season's end. */
    breaks: Array<[string, string]>;
    /** Median editions between breaks, over runs that ended; Infinity for a series that never paused. */
    runLength: number;
    /** Median days across a break. */
    breakDays: number;
    /** Editions since the last break. */
    currentRun: number;
}

const RECENT = 8;
const MIN_EDITIONS = 3;
/** Qualifiers often come in bursts a day or two apart; projecting them closer than weekly overcounts. */
const MIN_GAP = 7;

export const cadence = (editions: RawRow[]): Cadence => {
    const starts = editions.map((e) => str(e.startdate));
    const gaps = starts.slice(1).map((s, i) => days(starts[i], s));
    const rawGap = Math.max(1, median(gaps.slice(-RECENT)));
    const breakAt = gaps.flatMap((g, i) => (g > 2 * rawGap ? [i] : []));
    const runs = [-1, ...breakAt].map((b, i, all) => (i + 1 < all.length ? all[i + 1] - b : starts.length - 1 - b));
    const last = (k: number) => editions.slice(-k);
    const listed = last(3)
        .map((e) => Number(e.participantsnumber))
        .filter((n) => n > 0);
    return {
        gapDays: Math.max(MIN_GAP, rawGap),
        durationDays: Math.max(0, median(last(5).map((e) => days(str(e.startdate), str(e.enddate) || str(e.startdate))))),
        prizePool: median(last(3).map((e) => Number(e.prizepool) || 0)),
        teams: listed.length ? median(listed) : 0,
        breaks: breakAt.map((i) => [starts[i], starts[i + 1]]),
        runLength: runs.length > 1 ? median(runs.slice(0, -1)) : Infinity,
        breakDays: breakAt.length ? median(breakAt.map((i) => gaps[i])) : 0,
        currentRun: runs.at(-1)!,
    };
};

/** A year as whole weeks, so a shifted date keeps its weekday. */
const YEAR = 364;

/** Where the series resumed, shifted forward again, when `date` falls in a break it took one or two years before. */
const resumeAfterBreak = (date: string, c: Cadence): string | null => {
    for (const k of [1, 2]) {
        const then = addDays(date, -YEAR * k);
        const hit = c.breaks.find(([from, to]) => addDays(from, c.gapDays) <= then && then < to);
        if (hit) return addDays(hit[1], YEAR * k);
    }
    return null;
};

/** Start dates after `asOf`, stepping by the gap from the last edition: through the series' usual run length then across its usual break, past last year's breaks, and re-anchored on listed editions. */
const stepDates = (anchor: string, c: Cadence, listed: string[], asOf: string, until: string): string[] => {
    const dates: string[] = [];
    let inRun = c.currentRun;
    let prev = anchor;
    let date = addDays(prev, c.gapDays);
    while (date <= until) {
        if (inRun >= c.runLength) {
            date = addDays(prev, c.breakDays);
            inRun = 0;
        }
        const resume = resumeAfterBreak(date, c);
        if (resume && resume > date) {
            date = resume;
            inRun = 0;
        }
        if (date > until) break;
        const near = listed.find((s) => Math.abs(days(s, date)) * 2 <= c.gapDays);
        if (near) date = near;
        else if (date > asOf) dates.push(date);
        inRun++;
        prev = date;
        date = addDays(date, c.gapDays);
    }
    return dates;
};

export interface ProjectionBasis {
    /** `SeriesCluster.id`. */
    series: string;
    editions: number;
    gapDays: number;
    lastPage: string;
    lastStart: string;
}

export interface ProjectedEdition {
    /** A tournament row as Liquipedia would list it, for `genericEvent`. */
    row: RawRow;
    basis: ProjectionBasis;
}

export interface ProjectOptions {
    asOf: string;
    /** Editions start in (asOf, asOf + days]. */
    days?: number;
    rules?: RankedRules;
}

export const PROJECTION_DAYS = 150;
/** Tier 1 editions are announced long before the horizon, so a missing one is news, not a gap. */
const SKIPPED_TIER = 1;
/** Bigger fields are open leagues and qualifiers filled mostly by teams the field model never draws, through unranked Bo1 rounds. */
const MAX_TEAMS = 64;

/** The text with the number that changed since `previous` (else its last number, else its Roman numeral) moved on by `k`; null when it has neither. */
export const nextNumbered = (text: string, k: number, previous?: string): string | null => {
    const numbers = [...text.matchAll(/\d+/g)];
    const before = previous ? [...previous.matchAll(/\d+/g)] : [];
    const changed = before.length === numbers.length ? numbers.findLastIndex((m, i) => m[0] !== before[i][0]) : -1;
    const digits = numbers.at(changed);
    if (digits) return text.slice(0, digits.index) + String(Number(digits[0]) + k) + text.slice(digits.index! + digits[0].length);
    const roman = [...text.matchAll(ROMAN)].filter((m) => m[0]).at(-1);
    if (!roman) return null;
    const values: Record<string, number> = { I: 1, V: 5, X: 10 };
    let n = [...roman[0]].reduce((sum, ch, i, all) => sum + (values[ch] < (values[all[i + 1]] ?? 0) ? -values[ch] : values[ch]), 0) + k;
    let out = "";
    for (const [s, v] of [["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1]] as const) {
        for (; n >= v; n -= v) out += s;
    }
    return text.slice(0, roman.index) + out + text.slice(roman.index! + roman[0].length);
};

/** Editions Liquipedia doesn't list yet, for every live series: at least `MIN_EDITIONS` ranked ones, the last within two gaps of `asOf`, in its usual break, or in a break it took a year before. */
export const projectEditions = (tournamentRows: RawRow[], countryRegion: CountryRegion, opts: ProjectOptions): ProjectedEdition[] => {
    const rules = opts.rules ?? NO_RANKED_RULES;
    const until = addDays(opts.asOf, opts.days ?? PROJECTION_DAYS);
    const pages = new Set(tournamentRows.map((r) => str(r.pagename)));
    const out: ProjectedEdition[] = [];
    for (const cluster of seriesClusters(tournamentRows, countryRegion)) {
        const ranked = cluster.editions.filter((e) => isRanked(e, rules));
        const model = ranked.at(-1);
        if (ranked.length < MIN_EDITIONS || !model || DROPPED.test(str(cluster.latest.status))) continue;
        if (Number(model.liquipediatier) === SKIPPED_TIER || exclusionReason(model, rules)) continue;
        const known = cluster.editions.filter((e) => str(e.startdate) <= opts.asOf);
        const anchor = known.at(-1);
        if (!anchor || known.length < MIN_EDITIONS) continue;
        const c = cadence(known);
        const sinceLast = days(str(anchor.startdate), opts.asOf);
        const listed = cluster.editions.filter((e) => str(e.startdate) > opts.asOf).map((e) => str(e.startdate));
        const paused = c.currentRun >= c.runLength && sinceLast <= c.breakDays + c.gapDays;
        if (sinceLast > 2 * c.gapDays && !paused && listed.length === 0 && !resumeAfterBreak(opts.asOf, c)) continue;

        const dates = stepDates(str(anchor.startdate), c, listed, opts.asOf, until);
        if (c.teams > MAX_TEAMS) continue;
        for (const date of dates) {
            const before = cluster.editions.filter((e) => str(e.startdate) < date);
            const [previous, base] = [before.at(-2), before.at(-1)!];
            const k = dates.filter((d) => d > str(base.startdate) && d <= date).length;
            const page = nextNumbered(str(base.pagename), k, previous && str(previous.pagename)) ?? `${str(base.pagename)}/Projected_${k}`;
            if (pages.has(page)) continue;
            out.push({
                row: {
                    ...model,
                    pagename: page,
                    name: nextNumbered(str(base.name), k, previous && str(previous.name)) ?? `${str(base.name)} (projected ${k})`,
                    shortname: "",
                    tickername: "",
                    startdate: date,
                    enddate: addDays(date, c.durationDays),
                    sortdate: addDays(date, c.durationDays),
                    prizepool: c.prizePool,
                    participantsnumber: c.teams || -1,
                    status: "",
                    previous: "",
                    previous2: "",
                    next: "",
                    next2: "",
                    parent: "",
                },
                basis: { series: cluster.id, editions: ranked.length, gapDays: c.gapDays, lastPage: str(anchor.pagename), lastStart: str(anchor.startdate) },
            });
        }
    }
    return out.sort((a, b) => str(a.row.startdate).localeCompare(str(b.row.startdate)) || str(a.row.pagename).localeCompare(str(b.row.pagename)));
};

export type ProjectionCategory = "lan" | "online" | "qualifier";
export const projectionCategory = (row: RawRow): ProjectionCategory => (roleOf(row) === "qualifier" ? "qualifier" : kindOf(row) === "lan" ? "lan" : "online");

export interface ProjectionScore {
    projected: number;
    matched: number;
    /** Ranked editions that started in the windows, and those in a series that was projected. */
    actual: number;
    actualInSeries: number;
    /** |projected − actual start| of each match, days. */
    dateErrors: number[];
}

export interface ProjectionBacktestOptions {
    asOf: string;
    rules?: RankedRules;
    /** Days projected from each month start. */
    window?: number;
    /** Month starts scored: the latest whose window ends by `asOf`. */
    months?: number;
}

/** Projects from each recent month start with only rows that had started by then, so nothing counts as listed ahead; projections match actual editions one to one within half a gap (at least a week). */
export const backtestProjections = (tournamentRows: RawRow[], countryRegion: CountryRegion, opts: ProjectionBacktestOptions): Map<ProjectionCategory | "all", ProjectionScore> => {
    const rules = opts.rules ?? NO_RANKED_RULES;
    const window = opts.window ?? 60;
    const latest = new Map<string, RawRow>();
    for (const r of tournamentRows) if (str(r.startdate) && str(r.startdate) <= opts.asOf) latest.set(str(r.pagename), r);
    const rows = [...latest.values()];
    const seriesOf = new Map<string, string>();
    for (const c of seriesClusters(rows, countryRegion)) for (const r of c.editions) seriesOf.set(str(r.pagename), c.id);

    const scores = new Map<ProjectionCategory | "all", ProjectionScore>();
    const score = (k: ProjectionCategory | "all") => {
        let s = scores.get(k);
        if (!s) scores.set(k, (s = { projected: 0, matched: 0, actual: 0, actualInSeries: 0, dateErrors: [] }));
        return s;
    };
    const starts: string[] = [];
    for (let m = `${opts.asOf.slice(0, 7)}-01`; starts.length < (opts.months ?? 10); m = `${addDays(m, -1).slice(0, 7)}-01`) {
        if (addDays(m, window) <= opts.asOf) starts.push(m);
    }
    for (const from of starts) {
        const to = addDays(from, window);
        const asOf = addDays(from, -1);
        const projected = projectEditions(
            rows.filter((r) => str(r.startdate) <= asOf),
            countryRegion,
            { asOf, days: window, rules }
        );
        const actual = rows.filter(
            (r) =>
                str(r.startdate) >= from &&
                str(r.startdate) < to &&
                !DROPPED.test(str(r.status)) &&
                str(r.liquipediatiertype) !== "Showmatch" &&
                Number(r.liquipediatier) !== SKIPPED_TIER &&
                isRanked(r, rules) &&
                !exclusionReason(r, rules)
        );
        // Later rows can add links that change a cluster's id, so series come from the full rows.
        const seriesOfProjection = (p: ProjectedEdition) => seriesOf.get(p.basis.lastPage) ?? p.basis.series;
        const projectedSeries = new Set(projected.map(seriesOfProjection));
        for (const r of actual) {
            for (const s of [score(projectionCategory(r)), score("all")]) {
                s.actual++;
                if (projectedSeries.has(seriesOf.get(str(r.pagename)) ?? "")) s.actualInSeries++;
            }
        }
        const used = new Set<RawRow>();
        for (const p of projected) {
            const tolerance = Math.max(7, p.basis.gapDays / 2);
            const hit = actual
                .filter((r) => !used.has(r) && seriesOf.get(str(r.pagename)) === seriesOfProjection(p))
                .map((r) => ({ r, d: Math.abs(days(str(r.startdate), str(p.row.startdate))) }))
                .filter((x) => x.d <= tolerance)
                .sort((a, b) => a.d - b.d)[0];
            if (hit) used.add(hit.r);
            for (const s of [score(projectionCategory(p.row)), score("all")]) {
                s.projected++;
                if (hit) {
                    s.matched++;
                    s.dateErrors.push(hit.d);
                }
            }
        }
    }
    return scores;
};

/** Share of past projections in each category that happened: the chance a run plays a projected edition. */
export const projectionChances = (scores: Map<ProjectionCategory | "all", ProjectionScore>): ((category: ProjectionCategory) => number) => {
    const precision = (s: ProjectionScore | undefined) => (s && s.projected >= 10 ? s.matched / s.projected : null);
    const all = precision(scores.get("all")) ?? 1;
    return (category) => precision(scores.get(category)) ?? all;
};
