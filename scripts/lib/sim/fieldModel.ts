import type { Region, Roster } from "../../../src/vrs/types.ts";
import type { Subregion } from "./attendance.ts";
import type { InviteRule, VrsList } from "./config.ts";
import type { ActivityCategory, PastEdition } from "./history.ts";
import { seriesKey } from "./series.ts";

/** Upper global rank of each band; past the last edge, and unranked teams, fall in the last band. */
export const BAND_EDGES = [10, 20, 35, 60, 100, 150, 250];
export const BANDS = BAND_EDGES.length + 1;
export const BAND_LABELS = ["1-10", "11-20", "21-35", "36-60", "61-100", "101-150", "151-250", "251+"];

export const bandOf = (globalRank: number | null): number => {
    if (globalRank === null) return BANDS - 1;
    const i = BAND_EDGES.findIndex((edge) => globalRank <= edge);
    return i < 0 ? BANDS - 1 : i;
};

/** What the model needs to know about an event to fill it. */
export interface FieldModelEvent {
    page: string;
    name: string;
    category: ActivityCategory;
    region: Region | null;
    prizePool: number;
    publisherTier: string;
    startDate: string;
}

/** How one event's open slots fill, learned from its series and similar past events. */
export interface EventFieldModel {
    /** Band probabilities of an attendee in a slot with no invite rule. */
    open: number[];
    /** Band probabilities of an attendee who came through a qualifier. */
    qualifier: number[];
    region: Region | null;
    subregion: Subregion | null;
    /** Share of attendees from the event's own region; null for a global event. */
    sameRegion: number | null;
    /** Chance a team in each band takes a VRS invite it is offered. */
    acceptance: number[];
    /** Slot mix of the series' latest labeled edition, sized to this event, when it invited from a VRS list. */
    learnedRule: InviteRule | null;
    /** Weighted attendees behind the series level, 0 when the event has no past editions. */
    seriesWeight: number;
}

export interface FieldModelOptions {
    asOf: string;
    /** Prior strength in attendees at each shrinkage level. */
    kappa?: number;
    /** An edition's weight halves every this many days. */
    halfLifeDays?: number;
    /** Prior strength of acceptance, in offers. */
    acceptanceKappa?: number;
}

export interface FieldModel {
    /** `series: false` stops at the tier, kind, region and prize fallback, for the backtest's comparison. */
    forEvent(event: FieldModelEvent, teams: number, opts?: { series?: boolean }): EventFieldModel;
    /** The region a series' past attendees mostly came from, for events whose page doesn't say. */
    seriesRegion(page: string): Region | null;
}

const PRIZE_BANDS = [10_000, 50_000, 250_000];
const prizeBandOf = (prize: number) => PRIZE_BANDS.filter((p) => prize >= p).length;
const SERIES_REGION_SHARE = 0.7;
/** The learned slot mix only comes from an edition this recent. */
const RULE_MAX_AGE_DAYS = 400;
const LOWER_TIER_TOP_RANK = 12;

const subregionFromName = (text: string): Subregion | null =>
    /south[_ ]america/i.test(text) ? "South America" : /north[_ ]america/i.test(text) ? "North America" : null;

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const monthOf = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;

class Counts {
    bands = new Array<number>(BANDS).fill(0);
    n = 0;
    same = 0;
    regioned = 0;
    add(band: number, w: number) {
        this.bands[band] += w;
        this.n += w;
    }
}

const shrink = (c: Counts | undefined, prior: number[], kappa: number): number[] =>
    prior.map((p, b) => ((c?.bands[b] ?? 0) + kappa * p) / ((c?.n ?? 0) + kappa));

const shrinkShare = (hits: number, n: number, prior: number, kappa: number) => (hits + kappa * prior) / (n + kappa);

/** Fits band histograms, region affinity and VRS acceptance from past editions; `lists` are the published lists editions were ranked on. */
export const fitFieldModel = (editions: PastEdition[], lists: Array<{ date: string; rosters: Roster[] }>, opts: FieldModelOptions): FieldModel => {
    const kappa = opts.kappa ?? 16;
    const halfLife = opts.halfLifeDays ?? 365;
    const acceptanceKappa = opts.acceptanceKappa ?? 4;
    const past = editions.filter((e) => e.endDate < opts.asOf);
    const weightOf = (e: PastEdition) => 0.5 ** (Math.max(0, daysBetween(e.startDate, opts.asOf)) / halfLife);

    const seriesRegions = new Map<string, Region | null>();
    {
        const tallies = new Map<string, Map<Region, number>>();
        for (const e of past) {
            const t = tallies.get(e.series) ?? new Map<Region, number>();
            for (const a of e.attendees) if (a.region) t.set(a.region, (t.get(a.region) ?? 0) + 1);
            tallies.set(e.series, t);
        }
        for (const [series, t] of tallies) {
            const total = [...t.values()].reduce((a, b) => a + b, 0);
            const best = [...t].sort((a, b) => b[1] - a[1])[0];
            seriesRegions.set(series, best && best[1] >= SERIES_REGION_SHARE * total ? best[0] : null);
        }
    }
    const regionOf = (e: { page: string; region: Region | null }) => e.region ?? seriesRegions.get(seriesKey(e.page)) ?? null;

    const keys = (e: { page: string; category: ActivityCategory; region: Region | null; prizePool: number }) => {
        const region = regionOf(e) ?? "global";
        return [e.category, `${e.category}|${region}`, `${e.category}|${region}|${prizeBandOf(e.prizePool)}`, `series:${seriesKey(e.page)}`];
    };
    const open = new Map<string, Counts>();
    const qualified = new Map<string, Counts>();
    const tally = (into: Map<string, Counts>, key: string) => {
        let c = into.get(key);
        if (!c) into.set(key, (c = new Counts()));
        return c;
    };
    for (const e of past) {
        const w = weightOf(e);
        const region = regionOf(e);
        for (const key of keys(e)) {
            const c = tally(open, key);
            const q = tally(qualified, key);
            for (const a of e.attendees) {
                const band = bandOf(a.globalRank);
                c.add(band, w);
                if (a.label === "qualifier") q.add(band, w);
                if (region && a.region) {
                    c.regioned += w;
                    if (a.region === region) c.same += w;
                }
            }
        }
    }

    // --- VRS acceptance: on the list an edition was ranked on, every team above the last one to accept was offered first.
    const accepted = new Map<string, number[]>();
    const declined = new Map<string, number[]>();
    const bump = (into: Map<string, number[]>, key: string, band: number) => {
        let row = into.get(key);
        if (!row) into.set(key, (row = new Array<number>(BANDS).fill(0)));
        row[band]++;
    };
    const listByDate = new Map(lists.map((l) => [l.date, l.rosters]));
    const busy = new Map<string, Array<{ page: string; start: string; end: string; ranks: Set<number> }>>();
    for (const e of past) {
        if (!e.listDate) continue;
        const ranks = new Set(e.attendees.flatMap((a) => (a.globalRank === null ? [] : [a.globalRank])));
        busy.set(e.listDate, [...(busy.get(e.listDate) ?? []), { page: e.page, start: e.startDate, end: e.endDate, ranks }]);
    }
    const onListRank = (r: Roster, list: VrsList): number | null =>
        list === "Global" ? r.globalRank : r.region === list ? r.regionalRank : null;
    for (const e of past) {
        const rosters = e.listDate ? listByDate.get(e.listDate) : undefined;
        if (!rosters || !e.labeled) continue;
        const attending = new Set(e.attendees.flatMap((a) => (a.globalRank === null ? [] : [a.globalRank])));
        const lowerTier = /^Tier 2/.test(e.publisherTier);
        const overlapping = (busy.get(e.listDate!) ?? []).filter((o) => o.start <= e.endDate && o.end >= e.startDate && o.page !== e.page);
        const byList = new Map<VrsList, number[]>();
        for (const a of e.attendees) {
            const list = a.vrs?.list;
            if (a.label !== "vrs" || !list || list === "North America" || list === "South America" || a.globalRank === null) continue;
            const rank = list === "Global" ? a.globalRank : a.region === list ? a.regionalRank : null;
            if (rank !== null) byList.set(list, [...(byList.get(list) ?? []), rank]);
        }
        for (const [list, ranks] of byList) {
            const cutoff = Math.max(...ranks);
            for (const r of rosters) {
                const rank = onListRank(r, list);
                if (rank === null || rank > cutoff || r.globalRank === null) continue;
                const band = bandOf(r.globalRank);
                const groupKeys = [e.category, `series:${e.series}`];
                if (attending.has(r.globalRank)) {
                    if (ranks.includes(rank)) for (const k of ["all", ...groupKeys]) bump(accepted, k, band);
                    continue;
                }
                if (lowerTier && r.globalRank <= LOWER_TIER_TOP_RANK) continue;
                if (overlapping.some((o) => o.ranks.has(r.globalRank!))) continue;
                for (const k of ["all", ...groupKeys]) bump(declined, k, band);
            }
        }
    }
    const acceptanceFor = (category: ActivityCategory, series: string): number[] => {
        let prior = new Array<number>(BANDS).fill(0.5);
        for (const key of ["all", category, `series:${series}`]) {
            const acc = accepted.get(key);
            const dec = declined.get(key);
            prior = prior.map((p, b) => shrinkShare(acc?.[b] ?? 0, (acc?.[b] ?? 0) + (dec?.[b] ?? 0), p, acceptanceKappa));
        }
        return prior;
    };

    // --- Slot mix of the latest labeled edition per series
    const latestLabeled = new Map<string, PastEdition>();
    for (const e of past) if (e.labeled && daysBetween(e.startDate, opts.asOf) <= RULE_MAX_AGE_DAYS) latestLabeled.set(e.series, e);
    const learnedRule = (event: FieldModelEvent, teams: number): InviteRule | null => {
        const e = latestLabeled.get(seriesKey(event.page));
        if (!e) return null;
        const slots = new Map<string, { list: VrsList; offset: number; count: number }>();
        let qualifiers = 0;
        for (const a of e.attendees) {
            if (a.label === "vrs" && a.vrs?.list) {
                const offset = a.vrs.month ? monthIndex(a.vrs.month) - monthIndex(e.startDate) : e.listDate ? monthIndex(e.listDate) - monthIndex(e.startDate) : -1;
                const key = `${a.vrs.list}|${offset}`;
                const slot = slots.get(key) ?? { list: a.vrs.list, offset, count: 0 };
                slot.count++;
                slots.set(key, slot);
            } else if (a.label === "qualifier") qualifiers++;
        }
        if (slots.size === 0) return null;
        const scale = teams / e.attendees.length;
        const ruleSlots = [...slots.values()].map((s) => ({
            list: s.list,
            month: monthOf(monthIndex(event.startDate) + Math.min(0, s.offset)),
            count: Math.max(1, Math.round(s.count * scale)),
        }));
        let used = ruleSlots.reduce((n, s) => n + s.count, 0);
        while (used > teams) {
            const biggest = ruleSlots.reduce((a, b) => (b.count > a.count ? b : a));
            biggest.count--;
            used--;
        }
        const qualifierCount = Math.min(teams - used, Math.round(qualifiers * scale));
        return {
            slots: ruleSlots.filter((s) => s.count > 0),
            qualifiers: qualifierCount > 0 ? [{ label: "Qualifier", count: qualifierCount }] : [],
            verified: false,
        };
    };

    return {
        seriesRegion: (page) => seriesRegions.get(seriesKey(page)) ?? null,
        forEvent: (event, teams, opts = {}) => {
            const k = opts.series === false ? keys(event).slice(0, 3) : keys(event);
            let openP = new Array<number>(BANDS).fill(1 / BANDS);
            let same = 0.8;
            for (const key of k) {
                const c = open.get(key);
                openP = shrink(c, openP, kappa);
                same = shrinkShare(c?.same ?? 0, c?.regioned ?? 0, same, kappa);
            }
            let qualP = shrink(open.get(k[0]), new Array<number>(BANDS).fill(1 / BANDS), kappa);
            for (const key of k) qualP = shrink(qualified.get(key), qualP, kappa);
            const region = regionOf(event);
            return {
                open: openP,
                qualifier: qualP,
                region,
                subregion: subregionFromName(`${event.page} ${event.name}`),
                sameRegion: region ? same : null,
                acceptance: acceptanceFor(event.category, seriesKey(event.page)),
                learnedRule: opts.series === false ? null : learnedRule(event, teams),
                seriesWeight: k[3] ? (open.get(k[3])?.n ?? 0) : 0,
            };
        },
    };
};
