import fs from "node:fs";
import path from "node:path";
import type { SeriesPrediction } from "./engine.ts";
import { clusterCi, clusterWeights, fitLambda, lambdaCi } from "./encompassing.ts";
import { calibrationSlope, fitOffsetLogit, logit, score } from "./metrics.ts";

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const yearOf = (p: SeriesPrediction) => dayOf(p.t).slice(0, 4);
const isTier1Lan = (p: SeriesPrediction) => p.tier === 1 && p.lan;
const signed = (x: number, d = 3) => (x >= 0 ? "+" : "") + x.toFixed(d);
const DAY = 86400;

const quantiles90 = (xs: number[]): [number, number] => {
    const sorted = [...xs].sort((a, b) => a - b);
    return [sorted[Math.floor(0.05 * sorted.length)], sorted[Math.floor(0.95 * sorted.length)]];
};

const SHARE_MAPS = 100;
const SHARE_MIN_MAPS = 30;

/** Each side's share of its lineage's last `SHARE_MAPS` maps played by this series' lineup; null under `SHARE_MIN_MAPS` maps. */
export function coreShares(predictions: SeriesPrediction[]): Map<string, [number | null, number | null]> {
    const history = new Map<number, Array<{ maps: number; lineup: Set<string> }>>();
    const out = new Map<string, [number | null, number | null]>();
    for (const p of predictions) {
        const pair = ([0, 1] as const).map((s) => {
            const h = history.get(p.lineages[s]);
            if (p.sideMaps[s] < SHARE_MIN_MAPS || !h?.length) return null;
            const lineup = p.lineups[s];
            let total = 0;
            let shared = 0;
            for (let i = h.length - 1; i >= 0 && total < SHARE_MAPS; i--) {
                const take = Math.min(h[i].maps, SHARE_MAPS - total);
                const overlap = lineup.filter((player) => h[i].lineup.has(player)).length;
                total += take;
                shared += (take * Math.min(1, overlap / Math.max(5, lineup.length)));
            }
            return total ? shared / total : null;
        }) as [number | null, number | null];
        out.set(p.id, pair);
        for (const s of [0, 1] as const) {
            const h = history.get(p.lineages[s]) ?? [];
            h.push({ maps: p.maps.length, lineup: new Set(p.lineups[s]) });
            if (h.length > SHARE_MAPS) h.shift();
            history.set(p.lineages[s], h);
        }
    }
    return out;
}

/** `--turnover`: does a lineage whose recent maps were played by other players want more player-Elo weight than today's blend? */
export function turnoverReport(predictions: SeriesPrediction[], playerOnly: SeriesPrediction[], eventOf: Map<string, string>): void {
    const shares = coreShares(predictions);
    const player = new Map(playerOnly.map((p) => [p.id, p.p]));
    const bins: Array<[string, (s: number) => boolean]> = [
        ["share ≥ 0.9", (s) => s >= 0.9],
        ["share 0.7–0.9", (s) => s >= 0.7 && s < 0.9],
        ["share < 0.7", (s) => s < 0.7],
    ];
    const binOf = (p: SeriesPrediction) => {
        const pair = shares.get(p.id)!;
        if (pair[0] === null || pair[1] === null) return -1;
        const low = Math.min(pair[0], pair[1]);
        return bins.findIndex(([, inBin]) => inBin(low));
    };
    console.log(`\nTurnover: λ of player-only odds over today's blend, by the lower core share of the two sides (last ${SHARE_MAPS} maps; sides under ${SHARE_MIN_MAPS} maps left out)`);
    console.log("  λ > 0: that bin wants more player weight than today's blend. 90% CIs resample events.");
    for (const [scope, inScope] of [["all tiers", () => true], ["tier-1 LAN", isTier1Lan]] as const) {
        for (const year of ["2024", "2025"]) {
            const ps = predictions.filter((p) => yearOf(p) === year && inScope(p) && player.has(p.id) && binOf(p) >= 0);
            const offsets = ps.map((p) => logit(p.p));
            const deltas = ps.map((p) => logit(player.get(p.id)!) - logit(p.p));
            const ys = ps.map((p) => p.y);
            const binIdx = ps.map(binOf);
            const clusters = ps.map((p) => eventOf.get(p.id)!);
            console.log(`  ${scope}, ${year}`);
            for (const [b, [label]] of bins.entries()) {
                const idx = binIdx.flatMap((x, i) => (x === b ? [i] : []));
                if (idx.length < 30) {
                    console.log(`    ${label.padEnd(16)} n ${idx.length}`);
                    continue;
                }
                const pick = <T>(xs: T[]) => idx.map((i) => xs[i]);
                const { lambda, lo, hi } = lambdaCi(pick(offsets), pick(deltas), pick(ys), pick(clusters));
                console.log(`    ${label.padEnd(16)} n ${String(idx.length).padStart(6)}  λ ${signed(lambda, 2)} (${signed(lo, 2)} to ${signed(hi, 2)})`);
            }
            const lowIdx = bins.length - 1;
            if (binIdx.filter((x) => x === lowIdx).length < 30 || binIdx.filter((x) => x === 0).length < 30) continue;
            const maskOf = (b: number) => Float64Array.from(binIdx, (x) => (x === b ? 1 : 0));
            const [low, high] = [maskOf(lowIdx), maskOf(0)];
            const diff = (w?: Float64Array) => {
                const wl = w ? low.map((m, i) => m * w[i]) : low;
                const wh = w ? high.map((m, i) => m * w[i]) : high;
                return fitLambda(offsets, deltas, ys, wl) - fitLambda(offsets, deltas, ys, wh);
            };
            const [lo, hi] = quantiles90(clusterWeights(clusters, 1000, 1).map(diff));
            console.log(`    λ(< 0.7) − λ(≥ 0.9): ${signed(diff(), 2)} (${signed(lo, 2)} to ${signed(hi, 2)})`);
        }
    }
}

const BELOW_WINDOW_DAYS = 90;

/** `--below-tier`: do rating changes a lineage picked up below tier 1 carry into tier-1 LANs the way its tier-1 changes do? */
export function belowTierReport(predictions: SeriesPrediction[], eventOf: Map<string, string>): void {
    const history = new Map<number, Array<{ t: number; tier: number; delta: number }>>();
    const tierHistory = new Map<number, number[]>();
    type Row = { p: SeriesPrediction; offset: number; y: 0 | 1; at: number; below: number; regulars: boolean; absAt: number; absBelow: number };
    const rows: Row[] = [];
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    for (const p of predictions) {
        if (isTier1Lan(p)) {
            const sums = ([0, 1] as const).map((s) => {
                let at = 0;
                let below = 0;
                for (const e of history.get(p.lineages[s]) ?? []) {
                    if (e.t < p.t - BELOW_WINDOW_DAYS * DAY) continue;
                    if (e.tier === 1) at += e.delta;
                    else below += e.delta;
                }
                return { at, below };
            });
            const regulars = ([0, 1] as const).every((s) => {
                const tiers = tierHistory.get(p.lineages[s]) ?? [];
                return tiers.length >= 5 && median(tiers) === 1;
            });
            rows.push({
                p,
                offset: logit(p.p),
                y: p.y,
                at: (sums[0].at - sums[1].at) / 100,
                below: (sums[0].below - sums[1].below) / 100,
                regulars,
                absAt: (Math.abs(sums[0].at) + Math.abs(sums[1].at)) / 2,
                absBelow: (Math.abs(sums[0].below) + Math.abs(sums[1].below)) / 2,
            });
        }
        for (const s of [0, 1] as const) {
            const l = p.lineages[s];
            const h = (history.get(l) ?? []).filter((e) => e.t >= p.t - BELOW_WINDOW_DAYS * DAY);
            h.push({ t: p.t, tier: p.tier, delta: p.after[s] - p.ratings[s] });
            history.set(l, h);
            const tiers = tierHistory.get(l) ?? [];
            tiers.push(p.tier);
            if (tiers.length > 10) tiers.shift();
            tierHistory.set(l, tiers);
        }
    }
    console.log(`\nBelow-tier results: tier-1 LAN series, logit offset by Elo, on each side's rating change over the last ${BELOW_WINDOW_DAYS} days (A − B, per 100 points)`);
    console.log("  Negative β: that part of the rating change reverts at tier-1 LANs. 90% CIs resample events.");
    const fit = (label: string, rs: Row[]) => {
        if (rs.length < 100) return console.log(`  ${label.padEnd(30)} n ${rs.length}`);
        const xs = rs.map((r) => [r.at, r.below]);
        const { beta, se } = fitOffsetLogit(rs, xs);
        const draws = clusterWeights(rs.map((r) => eventOf.get(r.p.id)!), 1000, 1).map((w) => {
            const b = fitOffsetLogit(rs, xs, w).beta;
            return b[1] - b[0];
        });
        const [lo, hi] = quantiles90(draws);
        const meanAbs = (f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
        console.log(
            `  ${label.padEnd(30)} n ${String(rs.length).padStart(5)}  β_at ${signed(beta[0])} ± ${se[0].toFixed(3)}  β_below ${signed(beta[1])} ± ${se[1].toFixed(3)}  ` +
                `β_below − β_at ${signed(beta[1] - beta[0])} (${signed(lo)} to ${signed(hi)})  mean |at| ${meanAbs((r) => r.absAt).toFixed(0)}, |below| ${meanAbs((r) => r.absBelow).toFixed(0)}`,
        );
    };
    const inYears = (years: string[]) => (r: Row) => years.includes(yearOf(r.p));
    for (const [label, years] of [["2024", ["2024"]], ["2025", ["2025"]], ["2024–25 (decision)", ["2024", "2025"]]] as const) {
        fit(label, rows.filter(inYears([...years])));
        fit(`  both sides tier-1 regulars`, rows.filter((r) => inYears([...years])(r) && r.regulars));
    }
}

/** `--rematch`: when two lineages meet again at the same tournament, does the earlier loser beat Elo more than other sides coming off a loss there? */
export function rematchReport(predictions: SeriesPrediction[], eventOf: Map<string, string>): void {
    const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    const meetings = new Map<string, { t: number; event: string; loser: number }>();
    const lastSeries = new Map<number, { event: string; opponent: number; won: boolean }>();
    type Row = { p: number; y: number; year: string; tier1Lan: boolean; days?: number };
    const rematch: Row[] = [];
    const control: Row[] = [];
    const byGap: Row[] = [];
    for (const p of predictions) {
        const event = eventOf.get(p.id)!;
        const [A, B] = p.lineages;
        const key = pairKey(A, B);
        const prior = meetings.get(key);
        const sideOf = (l: number): 0 | 1 => (l === A ? 0 : 1);
        const row = (s: 0 | 1, days?: number): Row => ({
            p: s === 0 ? p.p : 1 - p.p,
            y: s === 0 ? p.y : 1 - p.y,
            year: yearOf(p),
            tier1Lan: isTier1Lan(p),
            days,
        });
        if (p.tier <= 2 && p.lan) {
            const sameEvent = prior !== undefined && prior.event === event;
            if (sameEvent) rematch.push(row(sideOf(prior.loser)));
            else {
                for (const s of [0, 1] as const) {
                    const last = lastSeries.get(p.lineages[s]);
                    if (last && last.event === event && !last.won && last.opponent !== p.lineages[1 - s]) control.push(row(s));
                }
            }
            if (prior) byGap.push(row(sideOf(prior.loser), (p.t - prior.t) / DAY));
        }
        const loser = p.y ? B : A;
        meetings.set(key, { t: p.t, event, loser });
        lastSeries.set(A, { event, opponent: B, won: p.y === 1 });
        lastSeries.set(B, { event, opponent: A, won: p.y === 0 });
    }
    const stats = (rs: Row[]) => {
        let r = 0;
        let v = 0;
        for (const x of rs) {
            r += x.y - x.p;
            v += x.p * (1 - x.p);
        }
        return { n: rs.length, mean: rs.length ? r / rs.length : NaN, varMean: rs.length ? v / rs.length ** 2 : NaN };
    };
    console.log("\nRematches at the same tournament: the earlier loser's wins − Elo expectation, against sides whose previous series there was a loss to someone else");
    const periods: Array<[string, (r: Row) => boolean]> = [
        ["2024–25 (decision)", (r) => r.year === "2024" || r.year === "2025"],
        ["2024", (r) => r.year === "2024"],
        ["2025", (r) => r.year === "2025"],
        ["2026", (r) => r.year === "2026"],
    ];
    for (const [scope, inScope] of [["tier-1 LAN", (r: Row) => r.tier1Lan], ["tier 1–2 LAN (information)", () => true]] as const) {
        console.log(`  ${scope}`);
        for (const [label, inPeriod] of periods) {
            const a = stats(rematch.filter((r) => inScope(r) && inPeriod(r)));
            const b = stats(control.filter((r) => inScope(r) && inPeriod(r)));
            const z = (a.mean - b.mean) / Math.sqrt(a.varMean + b.varMean);
            console.log(
                `    ${label.padEnd(20)} rematch n ${String(a.n).padStart(4)} ${signed(a.mean)}  control n ${String(b.n).padStart(4)} ${signed(b.mean)}  excess ${signed(a.mean - b.mean)} (z ${z.toFixed(1)})`,
            );
        }
    }
    console.log("  Earlier loser by days since the pair last met (any event), tier-1 LAN");
    for (const [label, lo, hi] of [["≤ 14 days", 0, 14], ["15–90 days", 14, 90], ["91–365 days", 90, 365]] as const) {
        const cells = periods.map(([period, inPeriod]) => {
            const s = stats(byGap.filter((r) => r.tier1Lan && inPeriod(r) && r.days! > lo && r.days! <= hi));
            return `${period} n ${s.n} ${signed(s.mean)} (z ${(s.mean / Math.sqrt(s.varMean)).toFixed(1)})`;
        });
        console.log(`    ${label.padEnd(12)} ${cells.join("   ")}`);
    }
}

interface BracketRow {
    bracketId: string;
    type: string;
}

const readJson = <T>(file: string, fallback: T): T => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback);

/** Liquipedia bracket id and type ("bracket" or "matchlist") per feed series id, from the local raw store. */
export function readBracketIndex(rawDir = path.resolve("data/raw")): Map<string, BracketRow> {
    const out = new Map<string, BracketRow>();
    const add = (rows: Array<Record<string, unknown>>) => {
        for (const r of rows) {
            const data = (r.match2bracketdata ?? {}) as Record<string, unknown>;
            out.set(`${String(r.pagename)}:${String(r.match2id ?? r.objectname ?? "")}`, {
                bracketId: String(r.match2bracketid ?? ""),
                type: String(data.type ?? ""),
            });
        }
    };
    const archive = path.join(rawDir, "archive");
    for (const month of readJson<{ done: string[] }>(path.join(archive, "meta.json"), { done: [] }).done)
        add(readJson(path.join(archive, `matches-${month}.json`), []));
    add(readJson(path.join(rawDir, "matches.json"), []));
    return out;
}

/** `--stage`: tier-1 LAN calibration in a tournament's final bracket against its earlier stages. */
export function stageReport(predictions: SeriesPrediction[], eventOf: Map<string, string>, brackets: Map<string, BracketRow>): void {
    const lastOfEvent = new Map<string, SeriesPrediction>();
    for (const p of predictions) if (brackets.has(p.id)) lastOfEvent.set(eventOf.get(p.id)!, p);
    const stageOf = (p: SeriesPrediction) => {
        const b = brackets.get(p.id);
        if (!b) return "no raw row";
        const last = brackets.get(lastOfEvent.get(eventOf.get(p.id)!)!.id)!;
        if (b.bracketId === last.bracketId) return "final bracket";
        return b.type === "matchlist" ? "earlier, matchlist" : "earlier, bracket";
    };
    console.log("\nTier-1 LAN series by stage: the final bracket holds the tournament's last match (Majors grouped by parent page)");
    console.log("  Favourite residual is the favourite's wins − Elo expectation; 90% CI resamples events.");
    for (const year of ["2024", "2025", "2026"]) {
        console.log(`  ${year}`);
        const ofYear = predictions.filter((p) => yearOf(p) === year && isTier1Lan(p));
        for (const stage of ["final bracket", "earlier, bracket", "earlier, matchlist", "no raw row"]) {
            const ps = ofYear.filter((p) => stageOf(p) === stage);
            if (ps.length < 30) {
                console.log(`    ${stage.padEnd(20)} n ${ps.length}`);
                continue;
            }
            const forecasts = ps.map(({ p, y }) => ({ p, y }));
            const fav = ps.map((p) => (p.p >= 0.5 ? p.y - p.p : p.p - p.y));
            const [lo, hi] = clusterCi(fav, ps.map((p) => eventOf.get(p.id)!));
            const mean = fav.reduce((s, x) => s + x, 0) / fav.length;
            const bo5 = ps.filter((p) => p.bestOf === 5).length;
            console.log(
                `    ${stage.padEnd(20)} n ${String(ps.length).padStart(4)} (Bo5 ${bo5})  log loss ${score(forecasts).logLoss.toFixed(4)}  slope ${calibrationSlope(forecasts).slope.toFixed(3)}  favourite ${signed(mean)} (${signed(lo)} to ${signed(hi)})`,
            );
        }
    }
}
