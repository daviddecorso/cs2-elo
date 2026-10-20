import { EloEngine, expectedScore } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";
import { seriesLength, seriesWinProbability } from "./lib/elo/series.ts";

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
