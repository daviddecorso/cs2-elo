import type { SeriesPrediction } from "../elo/engine.ts";
import { clusterCi, clusterWeights } from "../elo/encompassing.ts";
import { logit } from "../elo/metrics.ts";

export interface MarketRow {
    pred: SeriesPrediction;
    event: string;
    tier: number;
    lan: boolean;
    volume: number;
    close: number;
    /** Price 24h before start; null when the market wasn't trading yet or sat at its seed. */
    open: number | null;
    closeAgeMin: number;
}

const CLIP = 0.01;
export const clip = (p: number) => Math.min(1 - CLIP, Math.max(CLIP, p));
export const loss = (p: number, y: number) => -Math.log(clip(y ? p : 1 - p));
/** Close's log loss minus Elo's: positive when Elo was better. */
export const eloGain = (r: MarketRow) => loss(r.close, r.pred.y) - loss(r.pred.p, r.pred.y);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const wmean = (xs: number[], w: ArrayLike<number>) => {
    let s = 0;
    let sw = 0;
    xs.forEach((x, i) => {
        s += w[i] * x;
        sw += w[i];
    });
    return sw ? s / sw : NaN;
};
const fmt = (x: number, d = 4) => (Number.isNaN(x) ? "    n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const quantiles90 = (xs: number[]): [number, number] => {
    const s = [...xs].sort((a, b) => a - b);
    return [s[Math.floor(0.05 * s.length)], s[Math.floor(0.95 * s.length)]];
};

/** Elo's and the close's probabilities and the result, from side `a`'s view. */
export const oriented = (r: MarketRow, a: 0 | 1) =>
    a === 0 ? { elo: r.pred.p, close: r.close, y: r.pred.y } : { elo: 1 - r.pred.p, close: 1 - r.close, y: (1 - r.pred.y) as 0 | 1 };

export const weightedSlope = (x: number[], y: number[], w?: ArrayLike<number>) => {
    let sw = 0, sx = 0, sy = 0;
    for (let i = 0; i < x.length; i++) {
        const wi = w ? w[i] : 1;
        sw += wi;
        sx += wi * x[i];
        sy += wi * y[i];
    }
    const mx = sx / sw, my = sy / sw;
    let cov = 0, vx = 0;
    for (let i = 0; i < x.length; i++) {
        const wi = w ? w[i] : 1;
        cov += wi * (x[i] - mx) * (y[i] - my);
        vx += wi * (x[i] - mx) ** 2;
    }
    return vx ? cov / vx : 0;
};

const slopeCi = (x: number[], y: number[], clusters: string[]) => {
    const draws = clusterWeights(clusters, 2000, 1).map((w) => weightedSlope(x, y, w));
    return { slope: weightedSlope(x, y), ci: quantiles90(draws) };
};

const FORM_SERIES = 5;
const CATCH_UP_SERIES = 5;

interface LineageSeries {
    id: string;
    before: number;
    after: number;
}

export interface SideFeatures {
    /** Days since this side's own previous series; null for its first. */
    idleDays: [number | null, number | null];
    /** Maps rated before this series. */
    maps: [number, number];
    /** Rating now minus rating `FORM_SERIES` series ago; null with fewer. */
    form: [number | null, number | null];
    /** Rating change from just after this series to just before the side's `CATCH_UP_SERIES`-th next one; null if it hasn't played that many. */
    future: [number | null, number | null];
}

/** Per-side state each series was played in, replayed from every prediction in order. */
export function sideFeatures(predictions: SeriesPrediction[]): Map<string, SideFeatures> {
    const byLineage = new Map<number, LineageSeries[]>();
    const lastT = new Map<number, number>();
    const maps = new Map<number, number>();
    const out = new Map<string, SideFeatures>();
    const at = new Map<string, Array<{ lineage: number; index: number }>>();
    for (const p of predictions) {
        const f: SideFeatures = { idleDays: [null, null], maps: [0, 0], form: [null, null], future: [null, null] };
        const slots: Array<{ lineage: number; index: number }> = [];
        for (const s of [0, 1] as const) {
            const l = p.lineages[s];
            const hist = byLineage.get(l) ?? [];
            const prev = lastT.get(l);
            f.idleDays[s] = prev === undefined ? null : (p.t - prev) / 86400;
            f.maps[s] = maps.get(l) ?? 0;
            const past = hist.at(-FORM_SERIES);
            f.form[s] = past === undefined ? null : p.ratings[s] - past.before;
            slots.push({ lineage: l, index: hist.length });
            hist.push({ id: p.id, before: p.ratings[s], after: p.after[s] });
            byLineage.set(l, hist);
            lastT.set(l, p.t);
            maps.set(l, f.maps[s] + p.maps.length);
        }
        out.set(p.id, f);
        at.set(p.id, slots);
    }
    for (const [id, slots] of at) {
        const f = out.get(id)!;
        slots.forEach(({ lineage, index }, s) => {
            const hist = byLineage.get(lineage)!;
            const later = hist[index + CATCH_UP_SERIES];
            if (later) f.future[s] = later.before - hist[index].after;
        });
    }
    return out;
}

type Pick = (r: MarketRow, f: SideFeatures) => 0 | 1 | null;

/** Side A when exactly one side passes `test`. */
const onlyOne = (test: (r: MarketRow, f: SideFeatures, s: 0 | 1) => boolean): Pick => (r, f) => {
    const a = test(r, f, 0);
    const b = test(r, f, 1);
    return a === b ? null : a ? 0 : 1;
};
const eloFavorite = (r: MarketRow): 0 | 1 => (r.pred.p >= 0.5 ? 0 : 1);
const favBucket = (lo: number, hi: number): Pick => (r) => {
    const q = Math.max(r.pred.p, 1 - r.pred.p);
    return q >= lo && q < hi ? eloFavorite(r) : null;
};
const regionPair = (a: number, b: number): Pick => (r) =>
    r.pred.regions[0] === a && r.pred.regions[1] === b ? 0 : r.pred.regions[1] === a && r.pred.regions[0] === b ? 1 : null;
const coreBetween = (lo: number, hi: number) =>
    onlyOne((r, _f, s) => {
        const c = r.pred.mapsSinceCoreChange[s];
        return c !== null && c >= lo && c <= hi;
    });
const formLead = (lo: number, hi: number): Pick => (_r, f) => {
    const [a, b] = f.form;
    if (a === null || b === null) return null;
    const d = a - b;
    return Math.abs(d) >= lo && Math.abs(d) < hi ? (d > 0 ? 0 : 1) : null;
};

export function printDiagnosis(rows: MarketRow[], predictions: SeriesPrediction[], split: string, provisionalMaps: number) {
    const features = sideFeatures(predictions);
    const h1 = rows.filter((r) => dayOf(r.pred.t) < split);
    const h2 = rows.filter((r) => dayOf(r.pred.t) >= split);

    console.log("\n=== Diagnosis: where the gap to the close comes from ===");

    console.log("\nBy month (Elo gain vs close; negative = close better)");
    console.log("  Month     n     Elo LL   Close LL   Gain     90% CI");
    const months = [...new Set(rows.map((r) => dayOf(r.pred.t).slice(0, 7)))].sort();
    for (const m of months) {
        const rs = rows.filter((r) => dayOf(r.pred.t).startsWith(m));
        const g = rs.map(eloGain);
        const [lo, hi] = clusterCi(g, rs.map((r) => r.event));
        const ll = (pick: (r: MarketRow) => number) => mean(rs.map((r) => loss(pick(r), r.pred.y))).toFixed(4);
        console.log(`  ${m}  ${String(rs.length).padStart(5)}  ${ll((r) => r.pred.p)}   ${ll((r) => r.close)}   ${fmt(mean(g))}  ${fmt(lo)} to ${fmt(hi)}`);
    }

    const g1 = h1.map(eloGain);
    const g2 = h2.map(eloGain);
    const w1 = clusterWeights(h1.map((r) => r.event), 2000, 1);
    const w2 = clusterWeights(h2.map((r) => r.event), 2000, 2);
    const [dlo, dhi] = quantiles90(w1.map((w, d) => wmean(g2, w2[d]) - wmean(g1, w)));
    console.log(`\nGain after ${split} minus before: ${fmt(mean(g2) - mean(g1))} (90% CI ${fmt(dlo)} to ${fmt(dhi)})`);

    const volBucket = (v: number) => (v < 10_000 ? "<10k" : v < 100_000 ? "10k-100k" : "100k+");
    const cell = (r: MarketRow) => `${volBucket(r.volume)} tier ${r.tier >= 3 ? "3+" : r.tier}`;
    const share = (rs: MarketRow[]) => {
        const m = new Map<string, number>();
        for (const r of rs) m.set(cell(r), (m.get(cell(r)) ?? 0) + 1 / rs.length);
        return m;
    };
    const s1 = share(h1);
    const s2 = share(h2);
    const reweight = h2.map((r) => (s1.get(cell(r)) ?? 0) / s2.get(cell(r))!);
    const lls = (rs: MarketRow[], w?: number[]) => {
        const ww = w ?? rs.map(() => 1);
        const e = wmean(rs.map((r) => loss(r.pred.p, r.pred.y)), ww);
        const c = wmean(rs.map((r) => loss(r.close, r.pred.y)), ww);
        return `Elo ${e.toFixed(4)}  close ${c.toFixed(4)}  gain ${fmt(c - e)}`;
    };
    console.log("Mix control (volume × tier cells)");
    console.log(`  before ${split}:            ${lls(h1)}`);
    console.log(`  after, as played:          ${lls(h2)}`);
    console.log(`  after, at the earlier mix: ${lls(h2, reweight)}`);
    console.log("  Cell mix, before → after:");
    for (const c of [...new Set([...s1.keys(), ...s2.keys()])].sort()) {
        console.log(`    ${c.padEnd(18)} ${((s1.get(c) ?? 0) * 100).toFixed(1).padStart(5)}% → ${((s2.get(c) ?? 0) * 100).toFixed(1).padStart(5)}%`);
    }

    console.log("\nOriented features: A is the side carrying the feature. d = mean logit(close A) − logit(Elo A); > 0 means the market likes A more than Elo does.");
    console.log("  A is the side…                        n   Elo p(A)  Close p(A)  A won    d      Elo gain (90% CI)            gain after split");
    const bias = (label: string, pick: Pick) => {
        const picked: Array<{ r: MarketRow; a: 0 | 1 }> = [];
        for (const r of rows) {
            const a = pick(r, features.get(r.pred.id)!);
            if (a !== null) picked.push({ r, a });
        }
        if (picked.length < 30) {
            console.log(`  ${label.padEnd(36)} ${String(picked.length).padStart(5)}  too few`);
            return;
        }
        const o = picked.map(({ r, a }) => oriented(r, a));
        const g = picked.map(({ r }) => eloGain(r));
        const [lo, hi] = clusterCi(g, picked.map(({ r }) => r.event));
        const late = picked.filter(({ r }) => dayOf(r.pred.t) >= split).map(({ r }) => eloGain(r));
        const d = mean(o.map((x) => logit(clip(x.close)) - logit(clip(x.elo))));
        console.log(
            `  ${label.padEnd(36)} ${String(picked.length).padStart(5)}  ${mean(o.map((x) => x.elo)).toFixed(3)}     ${mean(o.map((x) => x.close)).toFixed(3)}      ` +
                `${mean(o.map((x) => x.y)).toFixed(3)}  ${fmt(d, 2)}  ${fmt(mean(g))} (${fmt(lo)} to ${fmt(hi)})  ${fmt(mean(late))} (n ${late.length})`,
        );
    };
    bias("Elo favorite, 50–60%", favBucket(0.5, 0.6));
    bias("Elo favorite, 60–75%", favBucket(0.6, 0.75));
    bias("Elo favorite, 75%+", favBucket(0.75, 1.01));
    bias("Elo favorite, Bo1", (r) => (r.pred.bestOf === 1 ? eloFavorite(r) : null));
    bias("Elo favorite, tier-1 LAN", (r) => (r.tier === 1 && r.lan ? eloFavorite(r) : null));
    bias("Elo favorite, the close disagrees", (r) => ((r.pred.p >= 0.5) !== (r.close >= 0.5) ? eloFavorite(r) : null));
    bias("Elo favorite, stand-in series", (r) => (r.pred.standIn ? eloFavorite(r) : null));
    bias("core changed ≤10 maps ago", coreBetween(0, 10));
    bias("core changed 11–30 maps ago", coreBetween(11, 30));
    bias("core changed 31–100 maps ago", coreBetween(31, 100));
    bias(`newer (< ${provisionalMaps} maps)`, onlyOne((_r, f, s) => f.maps[s] < provisionalMaps));
    bias("idle 21–59 days", onlyOne((_r, f, s) => (f.idleDays[s] ?? Infinity) >= 21 && (f.idleDays[s] ?? Infinity) < 60));
    bias("idle 60+ days or first series", onlyOne((_r, f, s) => (f.idleDays[s] ?? Infinity) >= 60));
    bias("Americas vs Europe", regionPair(1, 0));
    bias("Asia vs Europe", regionPair(2, 0));
    bias("Asia vs Americas", regionPair(2, 1));
    bias("cross-region, stale (90+ days)", (r) =>
        r.pred.crossRegion ? onlyOne((rr, _f, s) => (rr.pred.crossGapDays[s] ?? Infinity) >= 90)(r, features.get(r.pred.id)!) : null,
    );
    bias("better 5-series form by 0–25", formLead(0, 25));
    bias("better 5-series form by 25–60", formLead(25, 60));
    bias("better 5-series form by 60+", formLead(60, Infinity));

    console.log(`\nTeams after ${split}: each series' gain split half to each side, worst 15`);
    console.log("  Team                         n    gain sum   d      Elo p   Close p  won    core change (maps ago, first series)");
    interface TeamAcc { n: number; gain: number; d: number; elo: number; close: number; y: number; core: number | null }
    const teams = new Map<string, TeamAcc>();
    for (const r of h2) {
        const g = eloGain(r);
        for (const s of [0, 1] as const) {
            const name = r.pred.teams[s];
            const o = oriented(r, s);
            const t = teams.get(name) ?? { n: 0, gain: 0, d: 0, elo: 0, close: 0, y: 0, core: r.pred.mapsSinceCoreChange[s] };
            t.n++;
            t.gain += g / 2;
            t.d += logit(clip(o.close)) - logit(clip(o.elo));
            t.elo += o.elo;
            t.close += o.close;
            t.y += o.y;
            teams.set(name, t);
        }
    }
    const ranked = [...teams.entries()].sort((a, b) => a[1].gain - b[1].gain);
    for (const [name, t] of ranked.slice(0, 15)) {
        console.log(
            `  ${name.slice(0, 28).padEnd(28)} ${String(t.n).padStart(3)}  ${fmt(t.gain, 3)}   ${fmt(t.d / t.n, 2)}  ${(t.elo / t.n).toFixed(3)}   ${(t.close / t.n).toFixed(3)}    ` +
                `${(t.y / t.n).toFixed(3)}  ${t.core ?? "none"}`,
        );
    }
    const total = g2.reduce((a, b) => a + b, 0);
    const losing = ranked.filter(([, t]) => t.gain < 0);
    const top10 = ranked.slice(0, 10).reduce((a, [, t]) => a + t.gain, 0);
    console.log(
        `  Total gain sum ${total.toFixed(2)} over ${h2.length} series; worst 10 teams ${top10.toFixed(2)}; ${losing.length} of ${teams.size} teams net negative`,
    );

    console.log(`\nEvents after ${split}, worst 10 by gain sum`);
    const events = new Map<string, { n: number; gain: number; tier: number; lan: boolean }>();
    for (const r of h2) {
        const e = events.get(r.event) ?? { n: 0, gain: 0, tier: r.tier, lan: r.lan };
        e.n++;
        e.gain += eloGain(r);
        events.set(r.event, e);
    }
    for (const [name, e] of [...events.entries()].sort((a, b) => a[1].gain - b[1].gain).slice(0, 10)) {
        console.log(`  ${name.slice(0, 60).padEnd(60)} n ${String(e.n).padStart(3)}  tier ${e.tier} ${e.lan ? "LAN   " : "online"}  ${fmt(e.gain, 3)}`);
    }

    // Logit of Elo's series probability per rating point, to express a full catch-up in rating points.
    const xs = rows.map((r) => r.pred.ratings[0] + r.pred.regionPriors[0] - r.pred.ratings[1] - r.pred.regionPriors[1]);
    const perPoint = weightedSlope(xs, rows.map((r) => logit(clip(r.pred.p))));
    console.log(`\nCatch-up: does the market's disagreement predict each side's next ${CATCH_UP_SERIES}-series rating change?`);
    console.log(
        `  Elo's series logit moves ${perPoint.toFixed(4)} per rating point, so a lasting edge split across both sides would show as a slope near ${(1 / (2 * perPoint)).toFixed(0)} points per logit.`,
    );
    const catchUp = (label: string, keep: (r: MarketRow, s: 0 | 1) => boolean) => {
        const x: number[] = [];
        const y: number[] = [];
        const clusters: string[] = [];
        for (const r of rows) {
            const f = features.get(r.pred.id)!;
            for (const s of [0, 1] as const) {
                const future = f.future[s];
                if (future === null || !keep(r, s)) continue;
                const o = oriented(r, s);
                x.push(logit(clip(o.close)) - logit(clip(o.elo)));
                y.push(future);
                clusters.push(r.event);
            }
        }
        if (x.length < 60) {
            console.log(`  ${label.padEnd(34)} too few`);
            return;
        }
        const { slope, ci } = slopeCi(x, y, clusters);
        console.log(`  ${label.padEnd(34)} n ${String(x.length).padStart(5)}  slope ${slope.toFixed(1)} points per logit (${ci[0].toFixed(1)} to ${ci[1].toFixed(1)})`);
    };
    catchUp("all", () => true);
    catchUp(`before ${split}`, (r) => dayOf(r.pred.t) < split);
    catchUp(`after ${split}`, (r) => dayOf(r.pred.t) >= split);
    catchUp("side's core changed ≤30 maps ago", (r, s) => (r.pred.mapsSinceCoreChange[s] ?? Infinity) <= 30);
    catchUp("side's core settled (>30 maps)", (r, s) => (r.pred.mapsSinceCoreChange[s] ?? Infinity) > 30);
    catchUp("stand-in series", (r) => r.pred.standIn);
}
