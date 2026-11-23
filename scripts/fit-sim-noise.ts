import { EloEngine, expectedScore } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";
import { seriesLength, seriesWinProbability } from "./lib/elo/series.ts";
import { roleOf } from "./lib/sim/catalog.ts";
import { readHistoryRows } from "./lib/sim/history.ts";

// Method of moments: with a shared form offset ε ~ N(0, σ²) per team per event, residuals of one team's series in
// the same event covary by about g_i · g_j · σ², where g is the series probability's slope per Elo point.

const { scale, seriesMapTemp } = DEFAULT_PARAMS;
const seriesP = (d: number, bo: number) => seriesWinProbability(expectedScore(d, scale), seriesLength(bo), seriesMapTemp);

/** Rating gap (Elo points) whose series probability is `p`. */
export const gapFor = (p: number, bo: number): number => {
    let lo = -2000;
    let hi = 2000;
    for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        if (seriesP(mid, bo) < p) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
};

const feed = loadFeed();
const eventOf = new Map(feed.matches.map((m) => [m.id, m.event]));
const predictions = new EloEngine(DEFAULT_PARAMS, feed.players).run(feed.matches);

const estimate = (from: string, to: string) => {
    const groups = new Map<string, Array<{ r: number; g: number }>>();
    for (const p of predictions) {
        const day = new Date(p.t * 1000).toISOString().slice(0, 10);
        if (day < from || day > to || p.p <= 0.001 || p.p >= 0.999) continue;
        const d = gapFor(p.p, p.bestOf);
        const g = (seriesP(d + 1, p.bestOf) - seriesP(d - 1, p.bestOf)) / 2;
        const r = p.y - p.p;
        const event = eventOf.get(p.id)!;
        for (const [i, sign] of [[0, 1], [1, -1]] as const) {
            const key = `${p.teams[i]}|${event}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push({ r: sign * r, g });
        }
    }
    let num = 0;
    let den = 0;
    let pairs = 0;
    const perGroup: Array<{ num: number; den: number }> = [];
    for (const items of groups.values()) {
        let gn = 0;
        let gd = 0;
        for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
                gn += items[i].r * items[j].r;
                gd += items[i].g * items[j].g;
                pairs++;
            }
        }
        num += gn;
        den += gd;
        if (gd > 0) perGroup.push({ num: gn, den: gd });
    }
    // Jackknife over groups for a standard error on σ².
    const n = perGroup.length;
    const loo = perGroup.map((x) => (num - x.num) / (den - x.den));
    const mean = loo.reduce((a, b) => a + b, 0) / n;
    const se = Math.sqrt(((n - 1) / n) * loo.reduce((a, b) => a + (b - mean) ** 2, 0));
    const variance = num / den;
    console.log(
        `${from} to ${to}: ${groups.size} team-events, ${pairs} series pairs. σ² = ${variance.toFixed(0)} ± ${se.toFixed(0)}, σ = ${Math.sqrt(Math.max(variance, 0)).toFixed(1)} Elo`
    );
};

estimate("2024-01-01", "2024-12-31");
estimate("2025-01-01", "2025-12-31");
estimate("2026-01-01", "2026-12-31");

// Drift: Var(rating(t + h) - rating(t)) = c + q·h, where c is Elo's update jitter and q the true random-walk rate.
const DRIFT_FROM = Date.parse("2025-01-01") / 1000;
const byTeam = new Map<string, Array<{ t: number; r: number }>>();
for (const p of predictions) {
    if (p.t < DRIFT_FROM) continue;
    p.teams.forEach((team, i) => {
        if (!byTeam.has(team)) byTeam.set(team, []);
        byTeam.get(team)!.push({ t: p.t, r: p.ratings[i] });
    });
}
const horizons = [7, 15, 30, 45, 60, 90, 120];
const points = horizons.map((h) => {
    let sum = 0;
    let n = 0;
    for (const obs of byTeam.values()) {
        if (obs.length < 20) continue;
        let j = 0;
        for (let i = 0; i < obs.length; i += 5) {
            const target = obs[i].t + h * 86400;
            while (j < obs.length - 1 && obs[j].t < target) j++;
            if (Math.abs(obs[j].t - target) > Math.max(3, h * 0.15) * 86400) continue;
            sum += (obs[j].r - obs[i].r) ** 2;
            n++;
        }
    }
    return { h, v: sum / n, n };
});
for (const { h, v, n } of points) console.log(`h = ${h} days: Var(Δrating) = ${v.toFixed(0)} (${n} pairs)`);
const mh = points.reduce((a, p) => a + p.h, 0) / points.length;
const mv = points.reduce((a, p) => a + p.v, 0) / points.length;
const q = points.reduce((a, p) => a + (p.h - mh) * (p.v - mv), 0) / points.reduce((a, p) => a + (p.h - mh) ** 2, 0);
console.log(`Drift q = ${q.toFixed(2)} Elo²/day (σ at 30 days ${Math.sqrt(30 * q).toFixed(1)}), jitter c = ${(mv - q * mh).toFixed(0)}`);

// Tier temperature: series odds with the map-level Elo gap multiplied by τ, per event tier; fit on 2025, scored on 2026.
type TierItem = { d: number; bo: number; y: 0 | 1 };
const TIER_BUCKETS = [1, 2, 3] as const;
const bucketOf = (tier: number) => Math.min(3, tier);
const clampP = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));
const logLoss = (items: TierItem[], tau: number) =>
    items.reduce((s, x) => {
        const p = clampP(seriesP(tau * x.d, x.bo));
        return s - (x.y ? Math.log(p) : Math.log(1 - p));
    }, 0) / Math.max(1, items.length);
/** Logistic slope of outcome on the series logit, by Newton's method; 1 is calibrated, below 1 overconfident. */
const slopeOf = (items: TierItem[], tau: number) => {
    let b = 1;
    for (let it = 0; it < 30; it++) {
        let g = 0;
        let h = 0;
        for (const x of items) {
            const p = clampP(seriesP(tau * x.d, x.bo));
            const z = Math.log(p / (1 - p));
            const s = 1 / (1 + Math.exp(-b * z));
            g += (x.y - s) * z;
            h += s * (1 - s) * z * z;
        }
        if (h === 0) break;
        b += g / h;
    }
    return b;
};
const fitTau = (items: TierItem[]) => {
    let lo = 0.3;
    let hi = 1.5;
    for (let i = 0; i < 60; i++) {
        const a = lo + (hi - lo) / 3;
        const b = hi - (hi - lo) / 3;
        if (logLoss(items, a) < logLoss(items, b)) hi = b;
        else lo = a;
    }
    return (lo + hi) / 2;
};
const tierItems = (from: string, to: string, bucket: number): TierItem[] =>
    predictions.flatMap((p) => {
        const day = new Date(p.t * 1000).toISOString().slice(0, 10);
        if (day < from || day > to || bucketOf(p.tier) !== bucket || p.p <= 0.001 || p.p >= 0.999) return [];
        return [{ d: gapFor(p.p, p.bestOf), bo: p.bestOf, y: p.y }];
    });
console.log("\nTier temperature (τ scales the map-level Elo gap; fit on 2025, scored on 2026):");
for (const bucket of TIER_BUCKETS) {
    const train = tierItems("2025-01-01", "2025-12-31", bucket);
    const test = tierItems("2026-01-01", "2026-12-31", bucket);
    const tau = fitTau(train);
    console.log(
        `  tier ${bucket === 3 ? "3+" : bucket}: τ ${tau.toFixed(3)} (2025 n ${train.length}); 2026 n ${test.length}: log loss ${logLoss(test, 1).toFixed(4)} → ${logLoss(test, tau).toFixed(4)}, slope ${slopeOf(test, 1).toFixed(3)} → ${slopeOf(test, tau).toFixed(3)}`
    );
}

// Qualifier series on their own, which the planner's qualifying odds rest on; reported, no temperature applied.
const qualifierPages = new Set(
    readHistoryRows()
        .tournamentRows.filter((r) => roleOf(r) === "qualifier")
        .map((r) => String(r.pagename))
);
const isQualifier = (event: string) => qualifierPages.has(event) || qualifierPages.has(event.replace(/ /g, "_"));
console.log("\nQualifier series (role from the tournament row), as played at τ 1:");
for (const [from, to] of [
    ["2025-01-01", "2025-12-31"],
    ["2026-01-01", "2026-12-31"],
]) {
    const items: TierItem[] = predictions.flatMap((p) => {
        const day = new Date(p.t * 1000).toISOString().slice(0, 10);
        if (day < from || day > to || p.p <= 0.001 || p.p >= 0.999 || !isQualifier(eventOf.get(p.id)!)) return [];
        return [{ d: gapFor(p.p, p.bestOf), bo: p.bestOf, y: p.y }];
    });
    const tau = fitTau(items);
    console.log(
        `  ${from.slice(0, 4)}: n ${items.length}, slope ${slopeOf(items, 1).toFixed(3)}, log loss ${logLoss(items, 1).toFixed(4)}; best τ ${tau.toFixed(3)} would give ${logLoss(items, tau).toFixed(4)}`
    );
}
