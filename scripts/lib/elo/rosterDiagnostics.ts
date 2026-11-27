import { seriesSinceBreak, type BreakWindow } from "./breaks.ts";
import type { SeriesPrediction } from "./engine.ts";
import { clusterCi } from "./encompassing.ts";
import { calibrationSlope, logit, score } from "./metrics.ts";

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export interface SideRow {
    pred: SeriesPrediction;
    side: 0 | 1;
    /** Elo's probability that this side wins. */
    p: number;
    y: 0 | 1;
}

export const sideRows = (predictions: SeriesPrediction[]): SideRow[] =>
    predictions.flatMap((pred) =>
        ([0, 1] as const).map((side) => ({
            pred,
            side,
            p: side === 0 ? pred.p : 1 - pred.p,
            y: (side === 0 ? pred.y : 1 - pred.y) as 0 | 1,
        })),
    );

/** Wins minus Elo's expectation per side, and its z against binomial noise. */
export const residual = (rows: SideRow[]) => {
    let r = 0;
    let v = 0;
    for (const row of rows) {
        r += row.y - row.p;
        v += row.p * (1 - row.p);
    }
    return { n: rows.length, mean: rows.length ? r / rows.length : NaN, z: v ? r / Math.sqrt(v) : NaN };
};

/** Series each side has played since its lineage last came back from `days`+ idle, or null if it never has; in prediction order. */
export function seriesSinceReturn(predictions: SeriesPrediction[], days: number): Map<string, [number | null, number | null]> {
    const count = new Map<number, number>();
    const out = new Map<string, [number | null, number | null]>();
    for (const p of predictions) {
        const pair: [number | null, number | null] = [null, null];
        for (const s of [0, 1] as const) {
            const l = p.lineages[s];
            const idle = p.sideIdleDays[s];
            if (idle !== null && idle >= days) count.set(l, 0);
            const c = count.get(l);
            pair[s] = c ?? null;
            if (c !== undefined) count.set(l, c + 1);
        }
        out.set(p.id, pair);
    }
    return out;
}

/** `--debuts`: where new, rebuilt and returning lineages beat or miss Elo, by year and tier group. */
export function debutsReport(predictions: SeriesPrediction[]): void {
    const since = seriesSinceReturn(predictions, 60);
    const rows = sideRows(predictions);
    const maps = (r: SideRow) => r.pred.sideMaps[r.side];
    const idle = (r: SideRow) => r.pred.sideIdleDays[r.side];
    const young = (r: SideRow) => maps(r) < 30;
    const slices: Array<[string, (r: SideRow) => boolean]> = [
        ["new lineage, maps 0–10", (r) => maps(r) < 10],
        ["new lineage, maps 10–30", (r) => maps(r) >= 10 && maps(r) < 30],
        ["new lineage, maps 30–100", (r) => maps(r) >= 30 && maps(r) < 100],
        ["  < 30 maps, 0 unrated seeds", (r) => young(r) && r.pred.seedsFromMean[r.side] === 0],
        ["  < 30 maps, 1–2 unrated seeds", (r) => young(r) && r.pred.seedsFromMean[r.side] >= 1 && r.pred.seedsFromMean[r.side] <= 2],
        ["  < 30 maps, 3–5 unrated seeds", (r) => young(r) && r.pred.seedsFromMean[r.side] >= 3],
        ["  < 30 maps, stalest seed idle 180+ d", (r) => young(r) && (r.pred.seedAgeDays[r.side] ?? 0) >= 180],
        ["  < 30 maps, stalest seed idle < 180 d", (r) => young(r) && r.pred.seedAgeDays[r.side] !== null && r.pred.seedAgeDays[r.side]! < 180],
        ["return after 30–59 idle days", (r) => (idle(r) ?? 0) >= 30 && idle(r)! < 60],
        ["return after 60–179 idle days", (r) => (idle(r) ?? 0) >= 60 && idle(r)! < 180],
        ["return after 180+ idle days", (r) => (idle(r) ?? 0) >= 180],
        ["series 2–5 after a 60+ day return", (r) => {
            const c = since.get(r.pred.id)![r.side];
            return c !== null && c >= 1 && c <= 4;
        }],
        ["established (100+ maps, idle < 30)", (r) => maps(r) >= 100 && (idle(r) ?? Infinity) < 30],
    ];
    const groups: Array<[string, (r: SideRow) => boolean]> = [
        ["all tiers", () => true],
        ["tier 1–2", (r) => r.pred.tier <= 2],
        ["tier 3+", (r) => r.pred.tier >= 3],
    ];
    console.log("\nNew and returning lineages: wins − Elo expectation per side (z)");
    console.log(`  ${"Slice".padEnd(40)} ${groups.map(([g]) => `${g}: 2025`.padStart(26) + "2026".padStart(22)).join("")}`);
    for (const [label, inSlice] of slices) {
        const cells = groups.flatMap(([, inGroup]) =>
            ["2025", "2026"].map((year) => {
                const { n, mean, z } = residual(rows.filter((r) => dayOf(r.pred.t).startsWith(year) && inGroup(r) && inSlice(r)));
                return n < 30 ? `n ${n}`.padStart(22) : `${String(n).padStart(5)} ${(mean >= 0 ? "+" : "") + mean.toFixed(3)} (${z.toFixed(1)})`.padStart(22);
            }),
        );
        console.log(`  ${label.padEnd(40)} ${cells.join("")}`);
    }
    staleReport(predictions, groups);
}

const DEBUT_MAPS = 30;
const RECENT_SERIES = 20;

/** Stale cores (no core change in 100 maps) by age and by how much of their recent schedule was against debut lineages, to separate "figured out" from rating farmed off overrated debuts. */
function staleReport(predictions: SeriesPrediction[], groups: Array<[string, (r: SideRow) => boolean]>): void {
    const isDebut = (p: SeriesPrediction, side: 0 | 1) => p.sideMaps[side] < DEBUT_MAPS && p.seedsFromMean[side] >= 3;
    const recent = new Map<number, boolean[]>();
    const debutShare = new Map<string, [number, number]>();
    for (const p of predictions) {
        const share = ([0, 1] as const).map((s) => {
            const h = recent.get(p.lineages[s]) ?? [];
            return h.length < 5 ? NaN : h.filter(Boolean).length / h.length;
        }) as [number, number];
        debutShare.set(p.id, share);
        for (const s of [0, 1] as const) {
            const h = recent.get(p.lineages[s]) ?? [];
            h.push(isDebut(p, s === 0 ? 1 : 0));
            if (h.length > RECENT_SERIES) h.shift();
            recent.set(p.lineages[s], h);
        }
    }
    const rows = sideRows(predictions);
    const since = (r: SideRow) => r.pred.mapsSinceCoreChange[r.side];
    const age = (r: SideRow) => r.pred.sideMaps[r.side];
    const stale = (r: SideRow) => age(r) >= 100 && (since(r) === null || since(r)! >= 100);
    const vsDebut = (r: SideRow) => isDebut(r.pred, r.side === 0 ? 1 : 0);
    const share = (r: SideRow) => debutShare.get(r.pred.id)![r.side];
    const slices: Array<[string, (r: SideRow) => boolean]> = [
        ["stale core (100+ maps, no change in 100)", stale],
        ["changed in last 100 maps (100+ maps)", (r) => age(r) >= 100 && !stale(r)],
        ["  stale, lineage 100–300 maps", (r) => stale(r) && age(r) < 300],
        ["  stale, lineage 300–1000 maps", (r) => stale(r) && age(r) >= 300 && age(r) < 1000],
        ["  stale, lineage 1000+ maps", (r) => stale(r) && age(r) >= 1000],
        ["  stale, never changed core", (r) => stale(r) && since(r) === null],
        ["  stale v debut opponent", (r) => stale(r) && vsDebut(r)],
        ["  stale v non-debut opponent", (r) => stale(r) && !vsDebut(r)],
        [`  stale v non-debut, debut share 0 (last ${RECENT_SERIES})`, (r) => stale(r) && !vsDebut(r) && share(r) === 0],
        ["  stale v non-debut, debut share 0–20%", (r) => stale(r) && !vsDebut(r) && share(r) > 0 && share(r) < 0.2],
        ["  stale v non-debut, debut share 20%+", (r) => stale(r) && !vsDebut(r) && share(r) >= 0.2],
        ["  changed v non-debut, debut share 20%+", (r) => age(r) >= 100 && !stale(r) && !vsDebut(r) && share(r) >= 0.2],
        ["  any 100+ maps v non-debut, share 0", (r) => age(r) >= 100 && !vsDebut(r) && share(r) === 0],
        ["  any 100+ maps v non-debut, share 20%+", (r) => age(r) >= 100 && !vsDebut(r) && share(r) >= 0.2],
    ];
    console.log(`\nStale cores: wins − Elo expectation per side (z). Debut = < ${DEBUT_MAPS} maps and 3+ unrated seeds.`);
    console.log(`  ${"Slice".padEnd(48)} ${groups.map(([g]) => `${g}: 2025`.padStart(26) + "2026".padStart(22)).join("")}`);
    for (const [label, inSlice] of slices) {
        const cells = groups.flatMap(([, inGroup]) =>
            ["2025", "2026"].map((year) => {
                const { n, mean, z } = residual(rows.filter((r) => dayOf(r.pred.t).startsWith(year) && inGroup(r) && inSlice(r)));
                return n < 30 ? `n ${n}`.padStart(22) : `${String(n).padStart(5)} ${(mean >= 0 ? "+" : "") + mean.toFixed(3)} (${z.toFixed(1)})`.padStart(22);
            }),
        );
        console.log(`  ${label.padEnd(48)} ${cells.join("")}`);
    }
}

/** `--breaks`: are series right after a player break harder to call, and would a temperature fit on earlier breaks help 2026? */
export function breaksReport(predictions: SeriesPrediction[], windows: BreakWindow[], gateIds: Set<string>, firstSeries = 3): void {
    const since = seriesSinceBreak(predictions, windows);
    const post = (p: SeriesPrediction) => since.get(p.id)!.some((c) => c !== null && c < firstSeries);
    const windowOf = (p: SeriesPrediction) => windows.findIndex((w) => p.t >= w.start + 2 * 86400 && p.t <= w.end + 30 * 86400);
    const fmt = (x: number, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);

    console.log("\nPlayer breaks (tier-1 LAN gaps of 25+ days from June, July or December)");
    for (const w of windows) {
        if (dayOf(w.end) < "2022-02-01") continue;
        const n = predictions.filter((p) => post(p) && windowOf(p) === windows.indexOf(w)).length;
        console.log(`  ${dayOf(w.start)} → ${dayOf(w.end)}  ${Math.round((w.end - w.start) / 86400)} days, ${n} post-break series`);
    }

    const upset = (p: SeriesPrediction) => (p.p >= 0.5 ? 1 - p.y : p.y);
    const line = (label: string, ps: SeriesPrediction[]) => {
        if (ps.length < 30) return console.log(`  ${label.padEnd(34)} n ${ps.length}`);
        const s = score(ps.map(({ p, y }) => ({ p, y })));
        const { slope } = calibrationSlope(ps.map(({ p, y }) => ({ p, y })));
        const expected = ps.reduce((a, p) => a + Math.min(p.p, 1 - p.p), 0) / ps.length;
        const actual = ps.reduce((a, p) => a + upset(p), 0) / ps.length;
        console.log(`  ${label.padEnd(34)} n ${String(ps.length).padStart(5)}  log loss ${s.logLoss.toFixed(4)}  slope ${slope.toFixed(3)}  upsets ${(actual * 100).toFixed(1)}% vs ${(expected * 100).toFixed(1)}% expected`);
    };
    const inAfter = predictions.filter((p) => windowOf(p) >= 0);
    console.log(`\nFirst ${firstSeries} series of a side that sat the break out, vs other series in the same 30 days`);
    for (const year of ["2022", "2023", "2024", "2025", "2026", "2022–2025"]) {
        const ofYear = inAfter.filter((p) => (year.length === 4 ? dayOf(p.t).startsWith(year) : dayOf(p.t) < "2026"));
        line(`${year} post-break`, ofYear.filter(post));
        line(`${year} same weeks, others`, ofYear.filter((p) => !post(p)));
    }
    for (const [label, inYears] of [["2022–2025", (d: string) => d < "2026"], ["2026", (d: string) => d >= "2026"]] as const) {
        const top = inAfter.filter((p) => p.tier <= 2 && inYears(dayOf(p.t)));
        line(`${label} tier 1–2 post-break`, top.filter(post));
        line(`${label} tier 1–2 others`, top.filter((p) => !post(p)));
    }
    const postAll = inAfter.filter(post);
    const excess = postAll.map((p) => upset(p) - Math.min(p.p, 1 - p.p));
    const [elo, ehi] = clusterCi(excess, postAll.map((p) => String(windowOf(p))));
    console.log(`  Upset excess, all post-break series: ${fmt(excess.reduce((a, b) => a + b, 0) / excess.length, 3)} (90% CI ${fmt(elo, 3)} to ${fmt(ehi, 3)}, breaks resampled)`);

    const rows = sideRows(postAll).filter((r) => {
        const c = since.get(r.pred.id)!;
        return c[r.side] !== null && c[r.side]! < firstSeries && !(c[1 - r.side] !== null && c[1 - r.side]! < firstSeries);
    });
    const res = residual(rows);
    const fav = residual(rows.filter((r) => r.p >= 0.5));
    const dog = residual(rows.filter((r) => r.p < 0.5));
    console.log(
        `  Side back from the break vs one that kept playing: ${res.n} sides, wins − Elo ${fmt(res.mean, 3)} (z ${res.z.toFixed(1)}); as favourite ${fmt(fav.mean, 3)} (z ${fav.z.toFixed(1)}, n ${fav.n}), as underdog ${fmt(dog.mean, 3)} (z ${dog.z.toFixed(1)}, n ${dog.n})`,
    );

    const temper = (ps: SeriesPrediction[], slope: number) => ps.map(({ p, y }) => ({ p: 1 / (1 + Math.exp(-slope * logit(p))), y }));
    const before = postAll.filter((p) => dayOf(p.t) < "2026");
    const test = postAll.filter((p) => dayOf(p.t) >= "2026");
    const fitSlope = calibrationSlope(before.map(({ p, y }) => ({ p, y }))).slope;
    const ceiling = calibrationSlope(test.map(({ p, y }) => ({ p, y }))).slope;
    const all2026 = predictions.filter((p) => dayOf(p.t) >= "2026").length;
    const gate = test.filter((p) => gateIds.has(p.id));
    const gain = (ps: SeriesPrediction[], slope: number, over: number) =>
        (ps.length * (score(ps.map(({ p, y }) => ({ p, y }))).logLoss - score(temper(ps, slope)).logLoss)) / over;
    console.log(`\nTemperature for post-break series, fit on 2022–2025 (${before.length} series): slope ${fitSlope.toFixed(3)}`);
    console.log(`  2026 post-break: ${test.length} series, ${gate.length} in the gate`);
    console.log(`  gain spread over all 2026 series: ${gain(test, fitSlope, all2026).toFixed(5)}; ceiling (2026 slope ${ceiling.toFixed(3)}) ${gain(test, ceiling, all2026).toFixed(5)}`);
    console.log(`  gain spread over the gate (${gateIds.size}): ${gain(gate, fitSlope, gateIds.size).toFixed(5)}; ceiling ${gain(gate, ceiling, gateIds.size).toFixed(5)}`);
}

/** `--compare`: paired log-loss gain of `adjusted` over `base` per set, with event-resampled 90% CIs. */
export function compareReport(
    base: SeriesPrediction[],
    adjusted: SeriesPrediction[],
    sets: Array<[string, (p: SeriesPrediction) => boolean]>,
    eventOf: Map<string, string>,
): void {
    const clip = (q: number) => Math.min(1 - 1e-6, Math.max(1e-6, q));
    const loss = (q: number, y: number) => -Math.log(clip(y ? q : 1 - q));
    const byId = new Map(adjusted.map((p) => [p.id, p]));
    console.log("\nGain over current params (positive = adjusted better)");
    for (const [label, inSet] of sets) {
        const pairs = base.filter(inSet).flatMap((b) => {
            const a = byId.get(b.id);
            return a ? [[b, a] as const] : [];
        });
        if (!pairs.length) continue;
        const gains = pairs.map(([b, a]) => loss(b.p, b.y) - loss(a.p, a.y));
        const [lo, hi] = clusterCi(gains, pairs.map(([b]) => eventOf.get(b.id)!));
        const mean = gains.reduce((s, g) => s + g, 0) / gains.length;
        const baseLoss = pairs.reduce((s, [b]) => s + loss(b.p, b.y), 0) / pairs.length;
        const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(5);
        console.log(`  ${label.padEnd(28)} n ${String(pairs.length).padStart(6)}  ${baseLoss.toFixed(4)} → ${(baseLoss - mean).toFixed(4)}  gain ${f(mean)} (${f(lo)} to ${f(hi)})`);
    }
}

/** Each side's VRS rank from the last snapshot before the series; null when Valve doesn't rank that roster. */
export type VrsRanks = Map<string, [number | null, number | null]>;

/** Splits series by how many sides Valve ranks, and checks Elo's bias toward the ranked side where only one is. */
export function rankedReport(
    predictions: SeriesPrediction[],
    ranks: VrsRanks,
    eventOf: Map<string, string>,
    periods: Array<[string, (p: SeriesPrediction) => boolean]>,
): void {
    const rankedCount = (p: SeriesPrediction) => ranks.get(p.id)?.filter((r) => r !== null).length;
    const line = (label: string, ps: SeriesPrediction[]) => {
        if (ps.length < 30) return;
        const s = score(ps);
        const { slope, intercept } = calibrationSlope(ps);
        console.log(`  ${label.padEnd(34)} n ${String(ps.length).padStart(6)}  logloss ${s.logLoss.toFixed(4)}  slope ${slope.toFixed(3)}  intercept ${intercept.toFixed(3)}`);
    };
    // Residual is the ranked side's wins minus Elo's expectation for it.
    const bias = (label: string, rows: SideRow[]) => {
        if (rows.length < 30) return;
        const res = rows.map((r) => r.y - r.p);
        const [lo, hi] = clusterCi(res, rows.map((r) => eventOf.get(r.pred.id)!));
        const mean = res.reduce((s, x) => s + x, 0) / res.length;
        const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
        const { slope } = calibrationSlope(rows);
        const p = rows.reduce((s, r) => s + r.p, 0) / rows.length;
        console.log(`    ${label.padEnd(32)} n ${String(rows.length).padStart(6)}  P(ranked) ${p.toFixed(3)}  won ${(p + mean).toFixed(3)}  residual ${f(mean)} (${f(lo)} to ${f(hi)})  slope ${slope.toFixed(2)}`);
    };
    for (const [period, inPeriod] of periods) {
        const ps = predictions.filter(inPeriod);
        console.log(`\n${period}: by sides Valve ranks`);
        line("both ranked", ps.filter((p) => rankedCount(p) === 2));
        line("one ranked", ps.filter((p) => rankedCount(p) === 1));
        line("neither ranked", ps.filter((p) => rankedCount(p) === 0));
        line("no snapshot yet", ps.filter((p) => !ranks.has(p.id)));

        const rows = ps
            .filter((p) => rankedCount(p) === 1)
            .map((pred) => {
                const side: 0 | 1 = ranks.get(pred.id)![0] !== null ? 0 : 1;
                return {
                    pred,
                    side,
                    p: side === 0 ? pred.p : 1 - pred.p,
                    y: (side === 0 ? pred.y : 1 - pred.y) as 0 | 1,
                    rank: ranks.get(pred.id)![side]!,
                    otherMaps: pred.sideMaps[1 - side],
                };
            });
        console.log(`  One ranked: the ranked side's wins against Elo (positive = Elo underrates the ranked side)`);
        bias("all", rows);
        bias("ranked side is teams[0]", rows.filter((r) => r.side === 0));
        bias("ranked side is teams[1]", rows.filter((r) => r.side === 1));
        bias("LAN, unranked side < 30 maps", rows.filter((r) => r.pred.lan && r.otherMaps < 30));
        bias("LAN, unranked side 30+ maps", rows.filter((r) => r.pred.lan && r.otherMaps >= 30));
        bias("online, unranked side < 30 maps", rows.filter((r) => !r.pred.lan && r.otherMaps < 30));
        bias("online, unranked side 30+ maps", rows.filter((r) => !r.pred.lan && r.otherMaps >= 30));
        for (const [lo, hi] of [[0, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 1.01]])
            bias(`P(ranked) ${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}`, rows.filter((r) => r.p >= lo && r.p < hi));
        for (const [lo, hi] of [[1, 30], [31, 100], [101, 200], [201, Infinity]])
            bias(`ranked side #${lo}–${hi === Infinity ? "" : hi}`, rows.filter((r) => r.rank >= lo && r.rank <= hi));
        for (const [lo, hi] of [[0, 30], [30, 100], [100, 300], [300, Infinity]])
            bias(`unranked side ${lo}–${hi === Infinity ? "" : hi} maps`, rows.filter((r) => r.otherMaps >= lo && r.otherMaps < hi));
        for (const tier of [1, 2, 3, 4, 5]) bias(`tier ${tier}`, rows.filter((r) => r.pred.tier === tier));
        bias("LAN", rows.filter((r) => r.pred.lan));
        bias("online", rows.filter((r) => !r.pred.lan));
        bias("cross-region", rows.filter((r) => r.pred.crossRegion));
        bias("same region", rows.filter((r) => !r.pred.crossRegion));
    }
}
