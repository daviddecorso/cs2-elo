import type { Roster } from "../../../src/vrs/types.ts";
import { bandOf } from "./fieldModel.ts";
import type { PastEdition } from "./history.ts";

/** Which teams within a rank band and region an event draws: ones that played the series, the organizer, or at home. */
export const AFFINITY_FEATURES = ["repeat", "organizer", "home"] as const;
export type AffinityFeature = (typeof AFFINITY_FEATURES)[number];
const PATTERNS = 1 << AFFINITY_FEATURES.length;

/** Past attendance counts this many days back. */
export const AFFINITY_DAYS = 400;
/** Players a lineup must share with a past attendee, or with the venue's country, to count as the same team or at home. */
const SHARED_PLAYERS = 3;
/** Standard deviation of the Gaussian prior on each coefficient. */
const PRIOR_SD = 2;

export interface AffinityEvent {
    series: string;
    organizer: string;
    /** ISO country of the venue; "" for online. */
    country: string;
    startDate: string;
}

export interface AffinityPlayer {
    nick: string;
    /** ISO country; "" when unknown. */
    country: string;
}

const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);

/** When each player attended each series and each organizer's events, to tell whether a lineup has history there. */
export class AffinityIndex {
    private bySeries = new Map<string, Map<string, string[]>>();
    private byOrganizer = new Map<string, Map<string, string[]>>();

    constructor(editions: PastEdition[]) {
        const add = (into: Map<string, Map<string, string[]>>, key: string, nick: string, date: string) => {
            let byNick = into.get(key);
            if (!byNick) into.set(key, (byNick = new Map()));
            const dates = byNick.get(nick) ?? [];
            dates.push(date);
            byNick.set(nick, dates);
        };
        for (const e of [...editions].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
            for (const a of e.attendees) {
                for (const p of a.players ?? []) {
                    add(this.bySeries, e.series, p.nick, e.startDate);
                    if (e.organizer) add(this.byOrganizer, e.organizer, p.nick, e.startDate);
                }
            }
        }
    }

    private sharedSince(index: Map<string, string[]> | undefined, players: AffinityPlayer[], from: string, to: string) {
        if (!index) return false;
        let k = 0;
        for (const p of players) {
            const dates = index.get(p.nick.toLowerCase());
            if (dates && dates.some((d) => d >= from && d < to) && ++k >= SHARED_PLAYERS) return true;
        }
        return false;
    }

    /** Bitmask of `AFFINITY_FEATURES`; organizer only counts outside the series. */
    pattern(players: AffinityPlayer[], event: AffinityEvent): number {
        const from = addDays(event.startDate, -AFFINITY_DAYS);
        const repeat = this.sharedSince(this.bySeries.get(event.series), players, from, event.startDate);
        const organizer = !repeat && !!event.organizer && this.sharedSince(this.byOrganizer.get(event.organizer), players, from, event.startDate);
        const home = !!event.country && players.filter((p) => p.country.toLowerCase() === event.country.toLowerCase()).length >= SHARED_PLAYERS;
        return Number(repeat) | (Number(organizer) << 1) | (Number(home) << 2);
    }
}

/** One drawn attendee: its feature pattern, and how many teams of each pattern its rank band and region cell held. */
export interface AffinitySample {
    chosen: number;
    cell: number[];
    /** Edition start. */
    date: string;
}

export const emptyCell = () => new Array<number>(PATTERNS).fill(0);

/** Each player's latest country among past attendees, for lineups known only by nick. */
export const nickCountries = (editions: PastEdition[]): Map<string, string> => {
    const out = new Map<string, string>();
    for (const e of [...editions].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
        for (const a of e.attendees) for (const p of a.players ?? []) if (p.country) out.set(p.nick, p.country);
    }
    return out;
};

/** Nicks at editions overlapping `e` where either is a LAN, which the simulation treats as a clash (online events never clash with each other). */
export const busyAt = (editions: PastEdition[]) => {
    const byStart = [...editions].sort((a, b) => a.startDate.localeCompare(b.startDate));
    return (e: PastEdition): Array<Set<string>> =>
        byStart
            .filter((o) => o !== e && o.startDate <= e.endDate && o.endDate >= e.startDate && (o.kind === "lan" || e.kind === "lan"))
            .map((o) => new Set(o.attendees.flatMap((a) => (a.players ?? []).map((p) => p.nick))));
};

/** One sample per non-VRS listed attendee of labelled editions in [from, to), against its band and region cell less rosters busy at a clashing edition; unlabelled editions would count VRS invitees as free choices. */
export const affinitySamples = (
    editions: PastEdition[],
    lists: Array<{ date: string; rosters: Roster[] }>,
    index: AffinityIndex,
    countries: Map<string, string>,
    range: { from: string; to: string }
): AffinitySample[] => {
    const listByDate = new Map(lists.map((l) => [l.date, l.rosters]));
    const busy = busyAt(editions);
    const out: AffinitySample[] = [];
    for (const e of editions) {
        if (e.startDate < range.from || e.startDate >= range.to || !e.listDate || !e.labeled) continue;
        const rosters = listByDate.get(e.listDate);
        if (!rosters) continue;
        const invited = new Set(e.attendees.flatMap((a) => (a.label === "vrs" && a.globalRank !== null ? [a.globalRank] : [])));
        const chosen = e.attendees.flatMap((a) => (a.label !== "vrs" && a.globalRank !== null ? [a.globalRank] : []));
        if (chosen.length === 0) continue;
        const chosenRanks = new Set(chosen);
        const clashes = busy(e);
        const isBusy = (r: Roster) => clashes.some((nicks) => r.players.filter((p) => nicks.has(p.toLowerCase())).length >= SHARED_PLAYERS);
        const cellOf = (r: Roster) => bandOf(r.globalRank) * 2 + (e.region !== null && r.region === e.region ? 1 : 0);
        const pool = rosters.filter((r) => r.globalRank !== null && !invited.has(r.globalRank) && (chosenRanks.has(r.globalRank) || !isBusy(r)));
        const byRank = new Map(pool.map((r) => [r.globalRank!, r]));
        const wanted = new Set(chosen.flatMap((rank) => (byRank.has(rank) ? [cellOf(byRank.get(rank)!)] : [])));
        const event: AffinityEvent = { series: e.series, organizer: e.organizer ?? "", country: e.country ?? "", startDate: e.startDate };
        const patterns = new Map<Roster, number>();
        const cells = new Map<number, number[]>();
        for (const r of pool) {
            const c = cellOf(r);
            if (!wanted.has(c)) continue;
            const p = index.pattern(
                r.players.map((nick) => ({ nick, country: countries.get(nick.toLowerCase()) ?? "" })),
                event
            );
            patterns.set(r, p);
            const cell = cells.get(c) ?? emptyCell();
            cell[p]++;
            cells.set(c, cell);
        }
        for (const rank of chosen) {
            const r = byRank.get(rank);
            if (r) out.push({ chosen: patterns.get(r)!, cell: cells.get(cellOf(r))!, date: e.startDate });
        }
    }
    return out;
};

const score = (beta: number[], pattern: number) => beta.reduce((s, b, f) => s + ((pattern >> f) & 1 ? b : 0), 0);

/** exp(β·x) for a pattern: multiplies a team's weight within its cell. */
export const affinityWeight = (beta: number[], pattern: number) => Math.exp(score(beta, pattern));

/** Mean log-likelihood per sample of drawing the chosen team from its cell, against drawing uniformly. */
export const affinityLogLikelihood = (beta: number[], samples: AffinitySample[]) => {
    let ll = 0;
    for (const s of samples) {
        let z = 0;
        for (let p = 0; p < PATTERNS; p++) z += s.cell[p] * affinityWeight(beta, p);
        ll += score(beta, s.chosen) - Math.log(z);
    }
    return samples.length ? ll / samples.length : 0;
};

/** Conditional-logit coefficients by Newton's method with a Gaussian prior; features outside `use` stay 0. */
export const fitAffinity = (samples: AffinitySample[], use: AffinityFeature[] = [...AFFINITY_FEATURES]): number[] => {
    const active = AFFINITY_FEATURES.map((f) => use.includes(f));
    const beta = AFFINITY_FEATURES.map(() => 0);
    const k = beta.length;
    for (let iter = 0; iter < 25; iter++) {
        const grad = beta.map((b) => -b / PRIOR_SD ** 2);
        const hess = beta.map((_, i) => beta.map((__, j) => (i === j ? -1 / PRIOR_SD ** 2 : 0)));
        for (const s of samples) {
            let z = 0;
            const mean = new Array<number>(k).fill(0);
            const second = beta.map(() => new Array<number>(k).fill(0));
            for (let p = 0; p < PATTERNS; p++) {
                if (s.cell[p] === 0) continue;
                const w = s.cell[p] * affinityWeight(beta, p);
                z += w;
                for (let i = 0; i < k; i++) {
                    if (!((p >> i) & 1)) continue;
                    mean[i] += w;
                    for (let j = 0; j < k; j++) if ((p >> j) & 1) second[i][j] += w;
                }
            }
            for (let i = 0; i < k; i++) {
                grad[i] += ((s.chosen >> i) & 1) - mean[i] / z;
                for (let j = 0; j < k; j++) hess[i][j] -= second[i][j] / z - (mean[i] / z) * (mean[j] / z);
            }
        }
        const idx = beta.flatMap((_, i) => (active[i] ? [i] : []));
        const step = solve(
            idx.map((i) => idx.map((j) => -hess[i][j])),
            idx.map((i) => grad[i])
        );
        let moved = 0;
        idx.forEach((i, n) => {
            beta[i] += step[n];
            moved = Math.max(moved, Math.abs(step[n]));
        });
        if (moved < 1e-6) break;
    }
    return beta;
};

/** Gaussian elimination with partial pivoting for a small positive-definite system. */
const solve = (a: number[][], b: number[]): number[] => {
    const n = b.length;
    const m = a.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        const pivot = m.slice(c).reduce((best, row, i) => (Math.abs(row[c]) > Math.abs(m[best][c]) ? c + i : best), c);
        [m[c], m[pivot]] = [m[pivot], m[c]];
        for (let r = c + 1; r < n; r++) {
            const f = m[r][c] / m[c][c];
            for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
        }
    }
    const x = new Array<number>(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
        let s = m[r][n];
        for (let j = r + 1; j < n; j++) s -= m[r][j] * x[j];
        x[r] = s / m[r][r];
    }
    return x;
};
