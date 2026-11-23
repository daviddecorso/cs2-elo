import type { Roster } from "../../../src/vrs/types.ts";
import type { SeriesPrediction } from "../elo/engine.ts";
import { AffinityIndex, busyAt, type AffinityEvent } from "./affinity.ts";
import { LOWER_TIER_TOP_RANK } from "./attendance.ts";
import { bandOf, BANDS } from "./fieldModel.ts";
import type { PastEdition } from "./history.ts";

/** Strength against an event's field joins habit in who attends and who accepts a VRS invite; see `docs/vrs-simulator.md`, "Value in attendance". */

/** Per candidate: affinity's repeat, organizer and home bits, strength against the field (hundreds of Elo, clipped to ±4), its square, and no Elo lineage. */
export const CHOICE_FEATURES = ["repeat", "organizer", "home", "strength", "strength2", "unrated"] as const;
export const HABIT_ONLY = [0, 1, 2];
/** Habit plus *unrated*: what free choices use, since strength adds under 0.01 held out once an attendee is left out of its own field. */
export const CHOICE_USE = [0, 1, 2, 5];
export const ALL_FEATURES = [0, 1, 2, 3, 4, 5];
const PRIOR_SD = 2;
const MIN_SHARED_PLAYERS = 3;

export const strengthGap = (rating: number, fieldMean: number) => Math.max(-4, Math.min(4, (rating - fieldMean) / 100));

/** A candidate's feature row from its affinity pattern and as-of rating; no field rating leaves strength at 0. */
export const choiceRow = (pattern: number, rating: number | null, fieldMean: number | null): number[] => {
    const v = rating !== null && fieldMean !== null ? strengthGap(rating, fieldMean) : 0;
    return [pattern & 1, (pattern >> 1) & 1, (pattern >> 2) & 1, v, v * v, rating === null ? 1 : 0];
};

/** Each Elo team's rating and lineup after its latest series, swept forward in time; querying an earlier date restarts the sweep. */
export class EloTimeline {
    private sorted: SeriesPrediction[];
    private nickOf: (link: string) => string;
    private cursor = 0;
    private time = -Infinity;
    private latest = new Map<string, { t: number; rating: number; nicks: string[] }>();
    private index = new Map<string, string[]>();

    constructor(predictions: SeriesPrediction[], nickOf: (link: string) => string) {
        this.sorted = [...predictions].sort((a, b) => a.t - b.t);
        this.nickOf = (link) => nickOf(link).toLowerCase();
    }

    advanceTo(date: string): this {
        const t = Date.parse(`${date}T00:00:00Z`) / 1000;
        if (t < this.time) {
            this.cursor = 0;
            this.latest.clear();
        }
        this.time = t;
        let moved = false;
        while (this.cursor < this.sorted.length && this.sorted[this.cursor].t < t) {
            const p = this.sorted[this.cursor++];
            p.teams.forEach((team, side) => this.latest.set(team, { t: p.t, rating: p.after[side], nicks: p.lineups[side].map(this.nickOf) }));
            moved = true;
        }
        if (moved || this.index.size === 0) {
            this.index = new Map();
            for (const [team, l] of this.latest) for (const n of l.nicks) this.index.set(n, [...(this.index.get(n) ?? []), team]);
        }
        return this;
    }

    /** Rating of the team whose latest lineup shares the most players (3+) with `nicks`; null when none does. */
    ratingOf(nicks: string[]): number | null {
        const shared = new Map<string, number>();
        for (const n of nicks) for (const team of this.index.get(n.toLowerCase()) ?? []) shared.set(team, (shared.get(team) ?? 0) + 1);
        const best = [...shared].filter(([, k]) => k >= MIN_SHARED_PLAYERS).sort((a, b) => b[1] - a[1] || this.latest.get(b[0])!.t - this.latest.get(a[0])!.t)[0];
        return best ? this.latest.get(best[0])!.rating : null;
    }
}

/** One free choice: the attendee's index among its cell's candidates, each a `CHOICE_FEATURES` row. */
export interface ChoiceSample {
    date: string;
    chosen: number;
    rows: number[][];
}

/** One VRS invite that reached a team, accepted or not. */
export interface OfferSample {
    date: string;
    band: number;
    accepted: boolean;
    row: number[];
}

/** Free choices within band and region cells (as `affinitySamples`) and VRS offers (as `fitFieldModel` derives them) of labelled editions in [from, to), with strength from `timeline`. */
export const valueSamples = (
    editions: PastEdition[],
    lists: Array<{ date: string; rosters: Roster[] }>,
    index: AffinityIndex,
    countries: Map<string, string>,
    timeline: EloTimeline,
    range: { from: string; to: string }
): { choices: ChoiceSample[]; offers: OfferSample[] } => {
    const listByDate = new Map(lists.map((l) => [l.date, l.rosters]));
    const busy = busyAt(editions);
    const choices: ChoiceSample[] = [];
    const offers: OfferSample[] = [];
    for (const e of [...editions].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
        if (e.startDate < range.from || e.startDate >= range.to || !e.listDate || !e.labeled) continue;
        const rosters = listByDate.get(e.listDate);
        if (!rosters) continue;
        timeline.advanceTo(e.startDate);
        const attendeeRating = new Map<number, number>();
        let fieldSum = 0;
        let fieldCount = 0;
        for (const a of e.attendees) {
            const r = timeline.ratingOf((a.players ?? []).map((p) => p.nick));
            if (r === null) continue;
            fieldSum += r;
            fieldCount++;
            if (a.globalRank !== null) attendeeRating.set(a.globalRank, r);
        }
        // An attendee is left out of its own field: counting it pulls every attendee toward the mean, which reads as a taste for even fields.
        const fieldMeanFor = (r: Roster): number | null => {
            const own = r.globalRank === null ? undefined : attendeeRating.get(r.globalRank);
            const count = fieldCount - (own === undefined ? 0 : 1);
            return count >= 2 ? (fieldSum - (own ?? 0)) / count : null;
        };
        const event: AffinityEvent = { series: e.series, organizer: e.organizer ?? "", country: e.country ?? "", startDate: e.startDate };
        const clashes = busy(e);
        const isBusy = (r: Roster) => clashes.some((nicks) => r.players.filter((p) => nicks.has(p.toLowerCase())).length >= MIN_SHARED_PLAYERS);
        const rows = new Map<Roster, number[]>();
        const rowOf = (r: Roster) => {
            let row = rows.get(r);
            if (!row) {
                const pattern = index.pattern(
                    r.players.map((nick) => ({ nick, country: countries.get(nick.toLowerCase()) ?? "" })),
                    event
                );
                rows.set(r, (row = choiceRow(pattern, timeline.ratingOf(r.players), fieldMeanFor(r))));
            }
            return row;
        };

        const invited = new Set(e.attendees.flatMap((a) => (a.label === "vrs" && a.globalRank !== null ? [a.globalRank] : [])));
        const chosen = new Set(e.attendees.flatMap((a) => (a.label !== "vrs" && a.globalRank !== null ? [a.globalRank] : [])));
        const cellOf = (r: Roster) => bandOf(r.globalRank) * 2 + (e.region !== null && r.region === e.region ? 1 : 0);
        const pool = rosters.filter((r) => r.globalRank !== null && !invited.has(r.globalRank) && (chosen.has(r.globalRank) || !isBusy(r)));
        const byCell = new Map<number, Roster[]>();
        for (const r of pool) byCell.set(cellOf(r), [...(byCell.get(cellOf(r)) ?? []), r]);
        for (const rank of chosen) {
            const r = pool.find((x) => x.globalRank === rank);
            if (!r) continue;
            const cell = byCell.get(cellOf(r))!;
            choices.push({ date: e.startDate, chosen: cell.indexOf(r), rows: cell.map(rowOf) });
        }

        const attending = new Set(e.attendees.flatMap((a) => (a.globalRank === null ? [] : [a.globalRank])));
        const lowerTier = /^Tier 2/.test(e.publisherTier);
        const byList = new Map<string, number[]>();
        for (const a of e.attendees) {
            const list = a.vrs?.list;
            if (a.label !== "vrs" || !list || list === "North America" || list === "South America" || a.globalRank === null) continue;
            const rank = list === "Global" ? a.globalRank : a.region === list ? a.regionalRank : null;
            if (rank !== null) byList.set(list, [...(byList.get(list) ?? []), rank]);
        }
        for (const [list, ranks] of byList) {
            const cutoff = Math.max(...ranks);
            for (const r of rosters) {
                const rank = list === "Global" ? r.globalRank : r.region === list ? r.regionalRank : null;
                if (rank === null || rank > cutoff || r.globalRank === null) continue;
                const accepted = attending.has(r.globalRank);
                if (accepted && !ranks.includes(rank)) continue;
                if (!accepted && ((lowerTier && r.globalRank <= LOWER_TIER_TOP_RANK) || isBusy(r))) continue;
                offers.push({ date: e.startDate, band: bandOf(r.globalRank), accepted, row: rowOf(r) });
            }
        }
    }
    return { choices, offers };
};

/** Gaussian elimination with partial pivoting for a small positive-definite system. */
const solve = (a: number[][], b: number[]): number[] => {
    const n = b.length;
    const m = a.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
        [m[c], m[p]] = [m[p], m[c]];
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

const dot = (beta: number[], row: number[]) => row.reduce((s, x, i) => s + x * beta[i], 0);

/** Conditional-logit coefficients over `CHOICE_FEATURES` by Newton's method with a Gaussian prior; features outside `use` stay 0. */
export const fitChoice = (samples: ChoiceSample[], use: number[] = ALL_FEATURES): number[] => {
    const k = CHOICE_FEATURES.length;
    const beta = new Array<number>(k).fill(0);
    for (let iter = 0; iter < 30; iter++) {
        const grad = beta.map((b) => -b / PRIOR_SD ** 2);
        const hess = beta.map((_, i) => beta.map((__, j) => (i === j ? -1 / PRIOR_SD ** 2 : 0)));
        for (const s of samples) {
            const w = s.rows.map((r) => Math.exp(dot(beta, r)));
            const z = w.reduce((a, b) => a + b, 0);
            const mean = beta.map((_, i) => s.rows.reduce((a, r, c) => a + w[c] * r[i], 0) / z);
            for (const i of use) {
                grad[i] += s.rows[s.chosen][i] - mean[i];
                for (const j of use) hess[i][j] -= s.rows.reduce((a, r, c) => a + w[c] * r[i] * r[j], 0) / z - mean[i] * mean[j];
            }
        }
        const step = solve(
            use.map((i) => use.map((j) => -hess[i][j])),
            use.map((i) => grad[i])
        );
        use.forEach((i, n) => (beta[i] += step[n]));
        if (Math.max(...step.map(Math.abs)) < 1e-6) break;
    }
    return beta;
};

/** Mean log-likelihood per sample of each attendee against its cell. */
export const choiceLogLikelihood = (beta: number[], samples: ChoiceSample[]) => {
    let ll = 0;
    for (const s of samples) {
        const scores = s.rows.map((r) => dot(beta, r));
        const top = Math.max(...scores);
        ll += scores[s.chosen] - top - Math.log(scores.reduce((a, v) => a + Math.exp(v - top), 0));
    }
    return samples.length ? ll / samples.length : 0;
};

/** Logistic acceptance with an intercept per rank band; `center` is the mean of β·row over each band's training offers. */
export interface AcceptanceModel {
    intercepts: number[];
    beta: number[];
    center: number[];
}

export const fitAcceptance = (samples: OfferSample[], use: number[] = ALL_FEATURES): AcceptanceModel => {
    const k = CHOICE_FEATURES.length;
    const theta = new Array<number>(BANDS + k).fill(0);
    const active = [...Array(BANDS).keys(), ...use.map((f) => BANDS + f)];
    const design = (s: OfferSample) => [...Array.from({ length: BANDS }, (_, b) => (s.band === b ? 1 : 0)), ...s.row];
    for (let iter = 0; iter < 30; iter++) {
        const grad = theta.map((t) => -t / PRIOR_SD ** 2);
        const hess = theta.map((_, i) => theta.map((__, j) => (i === j ? -1 / PRIOR_SD ** 2 : 0)));
        for (const s of samples) {
            const x = design(s);
            const p = 1 / (1 + Math.exp(-dot(theta, x)));
            for (const i of active) {
                grad[i] += (Number(s.accepted) - p) * x[i];
                for (const j of active) hess[i][j] -= p * (1 - p) * x[i] * x[j];
            }
        }
        const step = solve(
            active.map((i) => active.map((j) => -hess[i][j])),
            active.map((i) => grad[i])
        );
        active.forEach((i, n) => (theta[i] += step[n]));
        if (Math.max(...step.map(Math.abs)) < 1e-6) break;
    }
    const beta = theta.slice(BANDS);
    const center = Array.from({ length: BANDS }, (_, b) => {
        const inBand = samples.filter((s) => s.band === b);
        return inBand.length ? inBand.reduce((a, s) => a + dot(beta, s.row), 0) / inBand.length : 0;
    });
    return { intercepts: theta.slice(0, BANDS), beta, center };
};

export const acceptanceLogLikelihood = (model: AcceptanceModel, samples: OfferSample[]) => {
    let ll = 0;
    for (const s of samples) {
        const p = 1 / (1 + Math.exp(-(model.intercepts[s.band] + dot(model.beta, s.row))));
        const c = Math.min(1 - 1e-6, Math.max(1e-6, p));
        ll += s.accepted ? Math.log(c) : Math.log(1 - c);
    }
    return samples.length ? ll / samples.length : 0;
};

/** Log-odds a team's features add to its band's acceptance, centered so the band's average offer keeps the band's rate. */
export const acceptanceShift = (model: AcceptanceModel, band: number, row: number[]) => dot(model.beta, row) - model.center[band];
