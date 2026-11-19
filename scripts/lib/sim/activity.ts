import type { Region } from "../../../src/vrs/types.ts";
import { bandOf } from "./fieldModel.ts";
import { CATEGORIES, type ActivityCategory, type PastEdition } from "./history.ts";
import { makeRng, subSeed, type Rng } from "./rng.ts";

export type Rates = Record<ActivityCategory, number>;

/** Matchdata team id with its rank and region today, so rates shrink toward similar teams. */
export interface ActivityTeam {
    teamId: string;
    globalRank: number | null;
    region: Region | null;
}

export interface ActivityOptions {
    asOf: string;
    windowDays?: number;
    /** Prior strength in days of the team's rank band and region. */
    priorDays?: number;
}

/** Chosen by `npm run backtest-fields`. */
export const ACTIVITY_WINDOW_DAYS = 365;
export const ACTIVITY_PRIOR_DAYS = 365;

export interface ActivityModel {
    /** Events per day by category. */
    rates(teamId: string): Rates;
    /** Events per day by category of an average team in the same rank band and region. */
    bandRates(globalRank: number | null, region: Region | null): Rates;
}

const zero = (): Rates => ({ lan1: 0, lan2: 0, lan34: 0, online: 0, qualifier: 0 });
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

/** Per-team category rates over the last `windowDays`, shrunk toward the mean of the team's rank band and region. */
export const fitActivity = (editions: PastEdition[], population: ActivityTeam[], opts: ActivityOptions): ActivityModel => {
    const windowDays = opts.windowDays ?? ACTIVITY_WINDOW_DAYS;
    const priorDays = opts.priorDays ?? ACTIVITY_PRIOR_DAYS;
    const from = new Date(Date.parse(opts.asOf) - windowDays * 86400000).toISOString().slice(0, 10);
    const counts = new Map<string, Rates>();
    for (const e of editions) {
        if (e.startDate < from || e.endDate > opts.asOf) continue;
        for (const a of e.attendees) {
            const c = counts.get(a.teamId) ?? zero();
            c[e.category]++;
            counts.set(a.teamId, c);
        }
    }
    const groupKey = (globalRank: number | null, region: Region | null) => `${bandOf(globalRank)}|${region ?? "?"}`;
    type Group = { sum: Rates; n: number };
    const groups = new Map<string, Group>();
    const bandGroups = new Map<number, Group>();
    const everyone: Group = { sum: zero(), n: 0 };
    const add = <K>(into: Map<K, Group>, key: K, c: Rates) => {
        const g = into.get(key) ?? { sum: zero(), n: 0 };
        for (const cat of CATEGORIES) g.sum[cat] += c[cat];
        g.n++;
        into.set(key, g);
    };
    const known = new Map(population.map((t) => [t.teamId, t]));
    for (const t of population) {
        const c = counts.get(t.teamId) ?? zero();
        add(groups, groupKey(t.globalRank, t.region), c);
        add(bandGroups, bandOf(t.globalRank), c);
        for (const cat of CATEGORIES) everyone.sum[cat] += c[cat];
        everyone.n++;
    }
    const perDay = (g: { sum: Rates; n: number } | undefined): Rates | undefined => {
        if (!g || g.n === 0) return undefined;
        const out = zero();
        for (const cat of CATEGORIES) out[cat] = g.sum[cat] / g.n / windowDays;
        return out;
    };
    const bandRates = (globalRank: number | null, region: Region | null): Rates =>
        perDay(groups.get(groupKey(globalRank, region))) ?? perDay(bandGroups.get(bandOf(globalRank))) ?? perDay(everyone) ?? zero();
    const cache = new Map<string, Rates>();
    return {
        bandRates,
        rates: (teamId) => {
            let r = cache.get(teamId);
            if (!r) {
                const t = known.get(teamId);
                const prior = bandRates(t?.globalRank ?? null, t?.region ?? null);
                const c = counts.get(teamId) ?? zero();
                r = zero();
                for (const cat of CATEGORIES) r[cat] = (c[cat] + priorDays * prior[cat]) / (windowDays + priorDays);
                cache.set(teamId, r);
            }
            return r;
        },
    };
};

export const poisson = (lambda: number, rng: Rng): number => {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng())));
    const limit = Math.exp(-lambda);
    let k = 0;
    for (let p = rng(); p > limit; p *= rng()) k++;
    return k;
};

export const poissonQuantile = (lambda: number, q: number): number => {
    let k = 0;
    let term = Math.exp(-lambda);
    let cdf = term;
    while (cdf < q && k < 1000) {
        k++;
        term *= lambda / k;
        cdf += term;
    }
    return k;
};

const LAN_CATEGORIES: ActivityCategory[] = ["lan1", "lan2", "lan34"];
const ONLINE_CATEGORIES: ActivityCategory[] = ["online", "qualifier"];
const sumOf = (r: Rates, cats: ActivityCategory[]) => cats.reduce((s, c) => s + r[c], 0);

/** Most LAN and online events a team takes over `horizonDays`: its own `quantile` on habit, at least `lanFloor` LANs and 2 online events. */
export const capsFor = (model: ActivityModel, teamId: string, horizonDays: number, lanFloor: number, quantile = 0.9) => {
    const r = model.rates(teamId);
    return {
        lan: Math.max(lanFloor, poissonQuantile(sumOf(r, LAN_CATEGORIES) * horizonDays, quantile)),
        online: Math.max(2, poissonQuantile(sumOf(r, ONLINE_CATEGORIES) * horizonDays, quantile)),
    };
};

export const PACE_FLOOR = 0.1;
const PACE_CEILING = 2;

/** One run's appetite: a Poisson budget per team and category, and how far ahead of or behind it each team is. */
export class Pacer {
    private state = new Map<string, { budget: Rates; used: Rates }>();
    private model: ActivityModel;
    private end: string;
    private horizonDays: number;
    private seed: number;

    constructor(model: ActivityModel, end: string, horizonDays: number, seed: number) {
        this.model = model;
        this.end = end;
        this.horizonDays = horizonDays;
        this.seed = seed;
    }

    private of(teamId: string) {
        let s = this.state.get(teamId);
        if (!s) {
            const rng = makeRng(subSeed(this.seed, `budget|${teamId}`));
            const r = this.model.rates(teamId);
            const budget = zero();
            for (const cat of CATEGORIES) budget[cat] = poisson(r[cat] * this.horizonDays, rng);
            s = { budget, used: zero() };
            this.state.set(teamId, s);
        }
        return s;
    }

    /** Multiplies a team's chance to take a place in a `category` event starting `date`: 1 on budget, lower past it, higher when behind. */
    pace(teamId: string, category: ActivityCategory, date: string): number {
        const s = this.of(teamId);
        const expected = this.model.rates(teamId)[category] * Math.max(0, daysBetween(date, this.end));
        return Math.min(PACE_CEILING, Math.max(PACE_FLOOR, (s.budget[category] - s.used[category] + 1) / (expected + 1)));
    }

    record(teamId: string, category: ActivityCategory) {
        this.of(teamId).used[category]++;
    }
}
