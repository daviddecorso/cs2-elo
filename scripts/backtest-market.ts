import fs from "node:fs";
import path from "node:path";
import { playerBreaks, seriesSinceBreak } from "./lib/elo/breaks.ts";
import { liveEngine } from "./lib/elo/adjustments.ts";
import { clusterCi, clusterWeights, fitLambda, lambdaCi } from "./lib/elo/encompassing.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { calibrationSlope, logit, score, type Forecast } from "./lib/elo/metrics.ts";
import { applySets, DEFAULT_PARAMS } from "./lib/elo/params.ts";
import { clip, eloGain, loss, printDiagnosis, weightedSlope, type MarketRow } from "./lib/markets/diagnose.ts";
import { closeAndOpen, matchMarkets, normalizeTeam, type MarketSide } from "./lib/markets/match.ts";
import { parseStart, readEvents, readPrices, type PmMarket } from "./lib/markets/polymarket.ts";

// Offline benchmark against Polymarket match prices; console only, never written to public/ (docs/elo-model.md, Market benchmark).
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const testFrom = option("test-from", "2026-01-01");
const minVolume = Number(option("min-volume", "500"));
/** Takes "close" this many minutes before the scheduled start, to check the close's edge isn't late or in-play news. */
const closeLeadMin = Number(option("close-lead", "0"));
const ALIASES_PATH = path.resolve("data/markets/polymarketAliases.json");
const TEAM_MAP_PATH = path.resolve("data/elo/vrsTeamMap.json");
const BLEND_SPLIT = option("blend-split", "2026-07-01");

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

const feed = loadFeed();
const params = applySets(args, DEFAULT_PARAMS);
const predictions = liveEngine(params, feed.players).run(feed.matches);
const matchById = new Map(feed.matches.map((m) => [m.id, m]));
const predById = new Map(predictions.map((p) => [p.id, p]));

const teamMap = JSON.parse(fs.readFileSync(TEAM_MAP_PATH, "utf8")) as Record<string, { vrsTeam: string }>;
const names = new Map(Object.entries(teamMap).map(([page, v]) => [page, [v.vrsTeam]]));
const aliases = fs.existsSync(ALIASES_PATH) ? (JSON.parse(fs.readFileSync(ALIASES_PATH, "utf8")) as Record<string, string>) : {};

const markets = new Map<string, PmMarket>();
for (const e of readEvents()) for (const m of e.markets) if (m.type === "moneyline" && m.volume >= minVolume) markets.set(m.id, m);
const sides: MarketSide[] = [...markets.values()]
    .map((m) => ({ marketId: m.id, outcomes: m.outcomes, start: parseStart(m.gameStartTime) ?? NaN }))
    .filter((m) => Number.isFinite(m.start) && dayOf(m.start) >= testFrom);
const candidates = predictions.filter((p) => dayOf(p.t) >= dayOf(Date.parse(testFrom) / 1000 - 2 * 86400));
const { matches, unmatched, ambiguous } = matchMarkets(candidates, sides, names, aliases);

let noPrices = 0;
let resultMismatch = 0;
const best = new Map<string, MarketRow>();
for (const mm of matches) {
    const market = markets.get(mm.marketId)!;
    const pred = predById.get(mm.seriesId);
    const prices = readPrices(mm.marketId);
    const start = parseStart(market.gameStartTime)!;
    const co = prices && closeAndOpen(prices.history, start);
    const closing = closeLeadMin && prices ? closeAndOpen(prices.history, start - closeLeadMin * 60)?.close : co?.close;
    if (!pred || !co || !closing) {
        noPrices++;
        continue;
    }
    const winnerOutcome = market.outcomePrices.indexOf("1");
    const marketWinner = winnerOutcome < 0 ? null : mm.swapped ? 1 - winnerOutcome : winnerOutcome;
    if (marketWinner !== null && marketWinner !== 1 - pred.y) {
        resultMismatch++;
        continue;
    }
    const orient = (p: number) => clip(mm.swapped ? 1 - p : p);
    const m = matchById.get(mm.seriesId)!;
    const row: MarketRow = {
        pred,
        event: m.event,
        tier: pred.tier,
        lan: pred.lan,
        volume: market.volume,
        close: orient(closing.p),
        open: co.open && orient(co.open.p),
        closeAgeMin: (start - closing.t) / 60,
    };
    const prev = best.get(mm.seriesId);
    if (!prev || prev.volume < row.volume) best.set(mm.seriesId, row);
}
const rows = [...best.values()].sort((a, b) => a.pred.t - b.pred.t);

console.log(`Markets (moneyline, volume ≥ $${minVolume}, from ${testFrom}): ${sides.length}`);
console.log(
    `  matched ${matches.length}, unmatched ${unmatched.length}, ambiguous ${ambiguous.length}, no prices ${noPrices}, result mismatch ${resultMismatch}`,
);
console.log(`  scored series: ${rows.length} (${dayOf(rows[0]?.pred.t ?? 0)} to ${dayOf(rows.at(-1)?.pred.t ?? 0)})`);
const ages = rows.map((r) => r.closeAgeMin).sort((a, b) => a - b);
console.log(`  close price age before start: median ${ages[Math.floor(ages.length / 2)]?.toFixed(0)} min, p90 ${ages[Math.floor(ages.length * 0.9)]?.toFixed(0)} min`);

const knownKeys = new Set(candidates.flatMap((p) => p.teams.flatMap((t) => [t, ...(names.get(t) ?? [])]).map(normalizeTeam)));
const unknownNames = new Map<string, number>();
for (const m of unmatched) {
    for (const o of m.outcomes) {
        if (!knownKeys.has(normalizeTeam(aliases[o] ?? o))) unknownNames.set(o, (unknownNames.get(o) ?? 0) + (markets.get(m.marketId)?.volume ?? 0));
    }
}
const topUnknown = [...unknownNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log(`  outcome names matching no feed team (add to polymarketAliases.json): ${topUnknown.map(([n, v]) => `${n} ($${Math.round(v / 1000)}k)`).join(", ")}`);

const fmt = (x: number, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);

const section = (label: string, rs: MarketRow[]) => {
    if (rs.length < 30) {
        console.log(`\n${label}: ${rs.length} series, too few`);
        return;
    }
    const ys = rs.map((r) => r.pred.y);
    const clusters = rs.map((r) => r.event);
    const elo: Forecast[] = rs.map((r) => ({ p: r.pred.p, y: r.pred.y }));
    const close: Forecast[] = rs.map((r) => ({ p: r.close, y: r.pred.y }));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const row = (name: string, fs_: Forecast[]) => {
        const s = score(fs_);
        console.log(`  ${name.padEnd(13)} ${s.logLoss.toFixed(4)}    ${s.brier.toFixed(4)}  ${(s.accuracy * 100).toFixed(1)}%   ${calibrationSlope(fs_).slope.toFixed(3)}`);
    };
    console.log(`\n${label}: ${rs.length} series, ${new Set(clusters).size} events`);
    console.log("  Model         Log loss  Brier   Acc     Cal slope");
    row("Elo", elo);
    row("Market close", close);
    const gainVsClose = rs.map(eloGain);
    const [cl, ch] = clusterCi(gainVsClose, clusters);
    console.log(`  Elo gain vs close ${fmt(mean(gainVsClose))} (90% CI ${fmt(cl)} to ${fmt(ch)})`);

    const le = rs.map((r) => logit(r.pred.p));
    const lc = rs.map((r) => logit(r.close));
    const eloGivenClose = lambdaCi(lc, le.map((x, i) => x - lc[i]), ys, clusters);
    const closeGivenElo = lambdaCi(le, lc.map((x, i) => x - le[i]), ys, clusters);
    console.log(
        `  Encompassing: λ(Elo | close) ${eloGivenClose.lambda.toFixed(2)} (${eloGivenClose.lo.toFixed(2)} to ${eloGivenClose.hi.toFixed(2)}), ` +
            `λ(close | Elo) ${closeGivenElo.lambda.toFixed(2)} (${closeGivenElo.lo.toFixed(2)} to ${closeGivenElo.hi.toFixed(2)})`,
    );

    // Out of sample: λ(Elo | close) fit before BLEND_SPLIT, scored on and after it.
    const fitIdx = rs.map((r, i) => (dayOf(r.pred.t) < BLEND_SPLIT ? i : -1)).filter((i) => i >= 0);
    const evalIdx = rs.map((r, i) => (dayOf(r.pred.t) >= BLEND_SPLIT ? i : -1)).filter((i) => i >= 0);
    if (fitIdx.length >= 30 && evalIdx.length >= 30) {
        const lambda = fitLambda(fitIdx.map((i) => lc[i]), fitIdx.map((i) => le[i] - lc[i]), fitIdx.map((i) => ys[i]));
        const blend = (i: number) => 1 / (1 + Math.exp(-(lc[i] + lambda * (le[i] - lc[i]))));
        const gains = evalIdx.map((i) => loss(rs[i].close, ys[i]) - loss(blend(i), ys[i]));
        const [bl, bh] = clusterCi(gains, evalIdx.map((i) => clusters[i]));
        console.log(`  Blend (λ ${lambda.toFixed(2)} fit before ${BLEND_SPLIT}) gain vs close on ${evalIdx.length} later series: ${fmt(mean(gains))} (${fmt(bl)} to ${fmt(bh)})`);
    }

    const opened = rs.filter((r) => r.open !== null);
    if (opened.length < 30) return;
    console.log(`  Markets priced 24h out: ${opened.length}`);
    row("Elo", opened.map((r) => ({ p: r.pred.p, y: r.pred.y })));
    row("Market open", opened.map((r) => ({ p: r.open!, y: r.pred.y })));
    row("Market close", opened.map((r) => ({ p: r.close, y: r.pred.y })));
    const gainVsOpen = opened.map((r) => loss(r.open!, r.pred.y) - loss(r.pred.p, r.pred.y));
    const [ol, oh] = clusterCi(gainVsOpen, opened.map((r) => r.event));
    console.log(`  Elo gain vs open ${fmt(mean(gainVsOpen))} (90% CI ${fmt(ol)} to ${fmt(oh)})`);

    // Slope of the open→close move on Elo's disagreement with the open; > 0 means the market moved toward Elo.
    const x = opened.map((r) => logit(r.pred.p) - logit(r.open!));
    const y = opened.map((r) => logit(r.close) - logit(r.open!));
    const slope = (w?: ArrayLike<number>) => weightedSlope(x, y, w);
    const draws = clusterWeights(opened.map((r) => r.event), 2000, 1).map(slope).sort((a, b) => a - b);
    console.log(`  Line movement toward Elo: slope ${slope().toFixed(3)} (${draws[100].toFixed(3)} to ${draws[1900].toFixed(3)})`);
};

section("All matched series", rows);
section("Volume < $10k", rows.filter((r) => r.volume < 10_000));
section("Volume $10k–100k", rows.filter((r) => r.volume >= 10_000 && r.volume < 100_000));
section("Volume ≥ $100k", rows.filter((r) => r.volume >= 100_000));
section("Tier 1", rows.filter((r) => r.tier === 1));
section("Tier 2+", rows.filter((r) => r.tier > 1));
section("LAN", rows.filter((r) => r.lan));
section("Online", rows.filter((r) => !r.lan));
for (const bo of [1, 3, 5]) section(`Bo${bo}`, rows.filter((r) => (bo === 3 ? r.pred.bestOf === 2 || r.pred.bestOf === 3 : r.pred.bestOf === bo)));
section("Provisional (either side < provisionalMaps)", rows.filter((r) => r.pred.minMaps < params.provisionalMaps));
const sinceBreak = seriesSinceBreak(predictions, playerBreaks(feed.matches));
const postBreak = (r: MarketRow) => sinceBreak.get(r.pred.id)!.some((c) => c !== null && c < 3);
section("Post-break (a side's first 3 series after sitting out a player break)", rows.filter(postBreak));
section("Post-break, tier 1–2", rows.filter((r) => postBreak(r) && r.tier <= 2));

const late = rows.filter((r) => dayOf(r.pred.t) >= BLEND_SPLIT);
if (late.length >= 30) {
    const lc = late.map((r) => logit(r.close));
    const le = late.map((r) => logit(r.pred.p));
    const lambda = lambdaCi(lc, le.map((x, i) => x - lc[i]), late.map((r) => r.pred.y), late.map((r) => r.event));
    const gains = late.map(eloGain);
    const [gl, gh] = clusterCi(gains, late.map((r) => r.event));
    console.log(
        `\nMarket gap (from ${BLEND_SPLIT}, ${late.length} series): Elo gain vs close ${fmt(gains.reduce((a, b) => a + b, 0) / gains.length)} (${fmt(gl)} to ${fmt(gh)}), ` +
            `λ(Elo | close) ${lambda.lambda.toFixed(2)} (${lambda.lo.toFixed(2)} to ${lambda.hi.toFixed(2)})`,
    );
}
if (args.includes("--diagnose")) printDiagnosis(rows, predictions, BLEND_SPLIT, params.provisionalMaps);
