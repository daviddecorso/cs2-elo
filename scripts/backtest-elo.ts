import fs from "node:fs";
import path from "node:path";
import { EloEngine, makeSkillLookup, type LuckLookup, type LuckRow, type PlayerSkill, type SeriesPrediction } from "./lib/elo/engine.ts";
import { clusterCi, clusterWeights, lambdaCi, lcg } from "./lib/elo/encompassing.ts";
import { loadFeed } from "./lib/elo/history.ts";
import {
    fitBeta,
    fitRankBeta,
    HLTV_POINTS_LINKS,
    logisticProbability,
    rankProbability,
    readHltvRanks,
} from "./lib/elo/hltvBaseline.ts";
import {
    calibration,
    calibrationSlope,
    expectedCalibrationError,
    logit,
    score,
    type CalibrationBin,
    type Forecast,
    type Score,
} from "./lib/elo/metrics.ts";
import { DEFAULT_PARAMS, TUNED_PARAMS_PATH, type EloParams } from "./lib/elo/params.ts";
import { findVrsRoster, makeNickLookup, readGlobalSnapshots, snapshotBefore, vrsProbability } from "./lib/elo/vrsBaseline.ts";
import type { Overrides } from "./lib/vrs/buildMatchdata.ts";
import { saveJson } from "./lib/writeJson.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const trainFrom = option("train-from", "2025-01-01");
const trainTo = option("train-to", "2025-12-31");
const testFrom = option("test-from", "2026-01-01");
const testTo = option("test-to", "9999-12-31");
const testYears = option("test-years", "").split(",").filter(Boolean);

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const isTrain = (p: SeriesPrediction) => dayOf(p.t) >= trainFrom && dayOf(p.t) <= trainTo;
const isTest = (p: SeriesPrediction) =>
    dayOf(p.t) >= testFrom && dayOf(p.t) <= testTo && (!testYears.length || testYears.includes(dayOf(p.t).slice(0, 4)));

const feed = loadFeed();
console.log(`Feed: ${feed.matches.length} series, ${dayOf(feed.matches[0]?.t ?? 0)} to ${dayOf(feed.matches.at(-1)?.t ?? 0)}.`);

const run = (params: EloParams) => new EloEngine(params, feed.players).run(feed.matches);
const trainLoss = (params: EloParams) => score(run(params).filter(isTrain)).logLoss;

interface Step {
    key: keyof EloParams;
    step: number;
    min: number;
    max: number;
    integer?: boolean;
}

// The rating scale is left out: with a fixed starting rating, scaling it and every K together leaves probabilities unchanged.
const STEPS: Step[] = [
    { key: "k", step: 4, min: 2, max: 120 },
    { key: "marginWeight", step: 0.25, min: 0, max: 3 },
    { key: "otMargin", step: 1, min: 0, max: 6 },
    { key: "onlineK", step: 0.1, min: 0.2, max: 1.5 },
    { key: "tierK", step: 0.05, min: 0.5, max: 1.2 },
    { key: "crossRegionK", step: 0.25, min: 0.5, max: 4 },
    { key: "provisionalK", step: 0.5, min: 0, max: 5 },
    { key: "provisionalMaps", step: 10, min: 5, max: 100, integer: true },
    { key: "regress", step: 0.1, min: 0, max: 1 },
    { key: "newRosterRegress", step: 0.1, min: 0, max: 1 },
    { key: "kMap", step: 2, min: 0, max: 30 },
    { key: "mapShrink", step: 0.01, min: 0, max: 0.2 },
    { key: "coreWindow", step: 1, min: 3, max: 12, integer: true },
    { key: "tierGap", step: 25, min: 0, max: 800 },
    { key: "standInK", step: 0.2, min: 0.2, max: 1.6 },
    { key: "seriesMapTemp", step: 0.05, min: 0.5, max: 1.2 },
    { key: "seriesMapTempOnline", step: 0.05, min: 0.5, max: 1.2 },
    { key: "burstMaps", step: 8, min: 0, max: 128 },
    { key: "burstDays", step: 2, min: 1, max: 30 },
];

const tune = (start: EloParams): EloParams => {
    let best = { ...start };
    let bestLoss = trainLoss(best);
    console.log(`Tuning on ${trainFrom} to ${trainTo}; start log loss ${bestLoss.toFixed(5)}`);
    for (let pass = 1; pass <= 4; pass++) {
        let improved = false;
        for (const s of STEPS) {
            for (const dir of [1, -1]) {
                let moved = false;
                while (true) {
                    const raw = (best[s.key] as number) + dir * s.step;
                    const value = Math.min(s.max, Math.max(s.min, s.integer ? Math.round(raw) : Math.round(raw * 1e6) / 1e6));
                    if (value === best[s.key]) break;
                    const candidate = { ...best, [s.key]: value };
                    const loss = trainLoss(candidate);
                    if (loss >= bestLoss - 1e-6) break;
                    best = candidate;
                    bestLoss = loss;
                    moved = improved = true;
                    console.log(`  pass ${pass} ${s.key}=${value} → ${loss.toFixed(5)}`);
                }
                if (moved) break;
            }
        }
        if (!improved) break;
    }
    return best;
};

// `--set key=value` (repeatable) overrides a parameter for one run, before any tuning.
// `seriesMapTemp` carries to `seriesMapTempOnline` unless that's set too, so commands from before the split behave as they did.
let params: EloParams = { ...DEFAULT_PARAMS };
const setKeys = new Set<string>();
args.forEach((arg, i) => {
    if (arg !== "--set") return;
    const [key, value] = (args[i + 1] ?? "").split("=");
    if (!(key in params) || value === undefined || Number.isNaN(Number(value))) throw new Error(`Bad --set ${args[i + 1]}`);
    params = { ...params, [key]: Number(value) };
    setKeys.add(key);
});
if (setKeys.has("seriesMapTemp") && !setKeys.has("seriesMapTempOnline")) params.seriesMapTempOnline = params.seriesMapTemp;
if (flag("tune")) {
    params = tune(params);
    if (flag("write")) {
        fs.writeFileSync(TUNED_PARAMS_PATH, `${JSON.stringify(params, null, 4)}\n`);
        console.log(`Wrote ${TUNED_PARAMS_PATH}`);
    }
}

const predictions = run(params);

// VRS baseline: points from the last published snapshot before each series, for rosters Valve ranks.
const overrides = JSON.parse(fs.readFileSync(path.resolve("data/overrides.json"), "utf8")) as Overrides;
const snapshots = readGlobalSnapshots();
const nicksOf = makeNickLookup(feed.players, overrides.playerAliases);
const vrsDiff = new Map<string, number>();
const vrsRanks = new Map<string, [number, number]>();
for (const p of predictions) {
    const snapshot = snapshotBefore(snapshots, p.t);
    if (!snapshot) continue;
    const a = findVrsRoster(snapshot, p.lineups[0], nicksOf);
    const b = findVrsRoster(snapshot, p.lineups[1], nicksOf);
    if (a && b && a !== b) {
        vrsDiff.set(p.id, a.points - b.points);
        vrsRanks.set(p.id, [a.rank, b.rank]);
    }
}

const fitVrsScale = (forecasts: Array<{ diff: number; y: 0 | 1 }>): number => {
    let best = { scale: 400, loss: Infinity };
    for (let scale = 50; scale <= 3000; scale += 10) {
        const loss = score(forecasts.map(({ diff, y }) => ({ p: vrsProbability(diff, scale), y }))).logLoss;
        if (loss < best.loss) best = { scale, loss };
    }
    return best.scale;
};
const vrsFit = predictions.filter((p) => isTrain(p) && vrsDiff.has(p.id)).map((p) => ({ diff: vrsDiff.get(p.id)!, y: p.y }));
const vrsScale = vrsFit.length >= 200 ? fitVrsScale(vrsFit) : 400;
if (vrsFit.length < 200) console.warn(`Only ${vrsFit.length} training series have VRS points; using scale 400.`);

const elo = (ps: SeriesPrediction[]): Forecast[] => ps.map(({ p, y }) => ({ p, y }));
const vrs = (ps: SeriesPrediction[]): Forecast[] => ps.map((p) => ({ p: vrsProbability(vrsDiff.get(p.id)!, vrsScale), y: p.y }));
const maps = (ps: SeriesPrediction[]): Forecast[] => ps.flatMap((p) => p.maps);
const fmt = (label: string, s: Score) =>
    `  ${label.padEnd(28)} n=${String(s.n).padStart(6)}  logloss=${s.logLoss.toFixed(4)}  brier=${s.brier.toFixed(4)}  acc=${(s.accuracy * 100).toFixed(1)}%`;

const train = predictions.filter(isTrain);
const test = predictions.filter(isTest);
const gateSet = test.filter((p) => vrsDiff.has(p.id));
const crossGate = gateSet.filter((p) => p.crossRegion);

console.log(`\nParams: ${JSON.stringify(params)}`);
console.log(`VRS scale ${vrsScale} (fit on ${vrsFit.length} series)\n`);
console.log(`Train ${trainFrom} to ${trainTo}`);
console.log(fmt("Elo series", score(elo(train))));
console.log(fmt("Elo maps", score(maps(train))));
console.log(`\nTest from ${testFrom}`);
console.log(fmt("Elo series, all", score(elo(test))));
console.log(fmt("Elo maps, all", score(maps(test))));
console.log(fmt("Elo series, stand-in", score(elo(test.filter((p) => p.standIn)))));
console.log(fmt("Elo series, gate set", score(elo(gateSet))));
console.log(fmt("VRS series, gate set", score(vrs(gateSet))));
console.log(fmt("Elo series, cross-region", score(elo(crossGate))));
console.log(fmt("VRS series, cross-region", score(vrs(crossGate))));

const diag = (label: string, forecasts: Forecast[]) => {
    const { slope, intercept } = calibrationSlope(forecasts);
    const s = score(forecasts);
    console.log(
        `  ${label.padEnd(28)} n=${String(s.n).padStart(6)}  logloss=${s.logLoss.toFixed(4)}  slope=${slope.toFixed(3)}  intercept=${intercept.toFixed(3)}  ece=${expectedCalibrationError(forecasts).toFixed(4)}`
    );
};
console.log(`\nCalibration (slope < 1 is overconfident)`);
diag("train series", elo(train));
diag("train maps", maps(train));
diag("test series", elo(test));
diag("test maps", maps(test));
diag("test gate set", elo(gateSet));
for (const bo of [1, 3, 5]) diag(`test Bo${bo}`, elo(test.filter((p) => p.bestOf === bo)));
diag("test provisional", elo(test.filter((p) => p.minMaps < params.provisionalMaps)));
diag("test established", elo(test.filter((p) => p.minMaps >= params.provisionalMaps)));
diag("test idle > 30 days", elo(test.filter((p) => p.idleDays > 30)));
diag("test idle ≤ 30 days", elo(test.filter((p) => p.idleDays <= 30)));
for (const tier of [1, 2, 3, 4, 5]) diag(`test tier ${tier}`, elo(test.filter((p) => p.tier === tier)));
diag("train LAN", elo(train.filter((p) => p.lan)));
diag("train online", elo(train.filter((p) => !p.lan)));
diag("test LAN", elo(test.filter((p) => p.lan)));
diag("test online", elo(test.filter((p) => !p.lan)));
for (const year of ["2024", "2025", "2026"]) {
    const ofYear = predictions.filter((p) => dayOf(p.t).startsWith(year));
    for (const [venue, lan] of [["LAN", true], ["online", false]] as const) {
        const slice = ofYear.filter((p) => p.lan === lan);
        diag(`${year} ${venue} maps`, maps(slice));
        diag(`${year} ${venue} Bo1`, elo(slice.filter((p) => p.bestOf === 1)));
        diag(`${year} ${venue} Bo3+`, elo(slice.filter((p) => p.bestOf > 1)));
    }
}

// Post-hoc temperature fit on train: the ceiling for a pure calibration fix, never applied to published numbers.
const temperature = calibrationSlope(elo(train)).slope;
const tempered = (ps: SeriesPrediction[]): Forecast[] => ps.map(({ p, y }) => ({ p: 1 / (1 + Math.exp(-temperature * logit(p))), y }));
console.log(`\nPost-hoc temperature ${temperature.toFixed(3)} (fit on train)`);
console.log(fmt("Tempered series, gate set", score(tempered(gateSet))));
diag("tempered test series", tempered(test));

const eloGate = score(elo(gateSet));
const vrsGate = score(vrs(gateSet));
const passed = gateSet.length > 0 && eloGate.logLoss < vrsGate.logLoss;
console.log(`\nGate: Elo ${eloGate.logLoss.toFixed(4)} vs VRS ${vrsGate.logLoss.toFixed(4)} on ${gateSet.length} series → ${passed ? "PASS" : "FAIL"}`);

if (flag("residual-lead")) {
    residualLead();
    process.exit(0);
}

const eventOf = new Map(feed.matches.map((m) => [m.id, m.event]));

if (flag("luck") || flag("skill")) {
    adjustmentExperiment(flag("skill") ? "skillWeight" : "luckWeight");
    process.exit(0);
}

const CAL_PATH = path.resolve("public/data/elo/calibration.json");
const existingCal = fs.existsSync(CAL_PATH) ? (JSON.parse(fs.readFileSync(CAL_PATH, "utf8")) as { hltv?: unknown }) : null;
const match2idOf = (id: string) => id.slice(id.lastIndexOf(":") + 1);
const hltvRanks = readHltvRanks();
interface HltvPointsBlock {
    link: string;
    beta: number;
    score: Score;
    gain: { mean: number; lo: number; hi: number };
    bins: CalibrationBin[];
}
interface HltvBlock {
    through: string;
    n: number;
    rankBeta: number;
    vrsRankBeta: number;
    elo: Score;
    hltv: Score;
    vrs: Score;
    vrsRank: Score;
    gain: { mean: number; lo: number; hi: number };
    points?: HltvPointsBlock;
}
let hltvBlock: HltvBlock | undefined;
if (hltvRanks) {
    const hasAnyPoints = [...hltvRanks.values()].some((r) => r.points !== null);
    const inHltvSet = (p: SeriesPrediction) => {
        const entry = hltvRanks.get(match2idOf(p.id));
        return Boolean(entry) && vrsDiff.has(p.id) && (!hasAnyPoints || entry!.points !== null);
    };
    const hltvTrain = predictions.filter((p) => isTrain(p) && inHltvSet(p));
    const hltvTest = predictions.filter((p) => isTest(p) && inHltvSet(p));
    if (hltvTrain.length > 0 && hltvTest.length > 0) {
        const rankBeta = fitRankBeta(
            hltvTrain.map((p) => {
                const [rankA, rankB] = hltvRanks.get(match2idOf(p.id))!.ranks;
                return { rankA, rankB, y: p.y };
            })
        );
        const vrsRankBeta = fitRankBeta(
            hltvTrain.map((p) => {
                const [rankA, rankB] = vrsRanks.get(p.id)!;
                return { rankA, rankB, y: p.y };
            })
        );
        const hltvForecasts = (ps: SeriesPrediction[]): Forecast[] =>
            ps.map((p) => {
                const [rankA, rankB] = hltvRanks.get(match2idOf(p.id))!.ranks;
                return { p: rankProbability(rankA, rankB, rankBeta), y: p.y };
            });
        const vrsRankForecasts = (ps: SeriesPrediction[]): Forecast[] =>
            ps.map((p) => {
                const [rankA, rankB] = vrsRanks.get(p.id)!;
                return { p: rankProbability(rankA, rankB, vrsRankBeta), y: p.y };
            });
        const eloScore = score(elo(hltvTest));
        const hltvScore = score(hltvForecasts(hltvTest));
        const vrsScore = score(vrs(hltvTest));
        const vrsRankScore = score(vrsRankForecasts(hltvTest));
        const seriesLoss = (q: number, y: 0 | 1) => -Math.log(clip(y ? q : 1 - q));
        const hltvPreds = hltvForecasts(hltvTest);
        const gains = hltvTest.map((p, i) => seriesLoss(hltvPreds[i].p, p.y) - seriesLoss(p.p, p.y));
        const [lo, hi] = clusterCi(gains, hltvTest.map((p) => eventOf.get(p.id)!));
        const mean = gains.reduce((s, g) => s + g, 0) / gains.length;
        const testEvents = hltvTest.map((p) => eventOf.get(p.id)!);
        const encompassing = (alt: Forecast[]) => {
            const offsets = hltvTest.map((p) => logit(clip(p.p)));
            const deltas = alt.map((f, i) => logit(clip(f.p)) - offsets[i]);
            return lambdaCi(offsets, deltas, hltvTest.map((p) => p.y), testEvents);
        };
        const rankLambda = encompassing(hltvPreds);
        let pointsLambda: ReturnType<typeof encompassing> | undefined;
        const through = dayOf(hltvTest.at(-1)!.t);
        const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}`;

        let pointsBlock: HltvPointsBlock | undefined;
        let pointsFits: Array<{
            link: (typeof HLTV_POINTS_LINKS)[number];
            beta: number;
            loss: number;
            forecasts: (ps: SeriesPrediction[]) => Forecast[];
            testScore: Score;
        }> = [];
        if (hasAnyPoints) {
            pointsFits = HLTV_POINTS_LINKS.map((link) => {
                const fit = fitBeta(
                    hltvTrain.map((p) => {
                        const [ptsA, ptsB] = hltvRanks.get(match2idOf(p.id))!.points!;
                        return { diff: link.diff(ptsA, ptsB), y: p.y };
                    })
                );
                const forecasts = (ps: SeriesPrediction[]): Forecast[] =>
                    ps.map((p) => {
                        const [ptsA, ptsB] = hltvRanks.get(match2idOf(p.id))!.points!;
                        return { p: logisticProbability(link.diff(ptsA, ptsB), fit.beta), y: p.y };
                    });
                return { link, ...fit, forecasts, testScore: score(forecasts(hltvTest)) };
            });
            const winner = pointsFits.reduce((a, b) => (a.loss <= b.loss ? a : b));
            const ptsPreds = winner.forecasts(hltvTest);
            const ptsGains = hltvTest.map((p, i) => seriesLoss(ptsPreds[i].p, p.y) - seriesLoss(p.p, p.y));
            const [pLo, pHi] = clusterCi(ptsGains, hltvTest.map((p) => eventOf.get(p.id)!));
            const pMean = ptsGains.reduce((s, g) => s + g, 0) / ptsGains.length;
            pointsLambda = encompassing(ptsPreds);
            pointsBlock = {
                link: winner.link.label,
                beta: winner.beta,
                score: winner.testScore,
                gain: { mean: pMean, lo: pLo, hi: pHi },
                bins: calibration(ptsPreds),
            };
        }

        hltvBlock = {
            through,
            n: hltvTest.length,
            rankBeta,
            vrsRankBeta,
            elo: eloScore,
            hltv: hltvScore,
            vrs: vrsScore,
            vrsRank: vrsRankScore,
            gain: { mean, lo, hi },
            ...(pointsBlock ? { points: pointsBlock } : {}),
        };
        console.log(`\nHLTV set (tier-1 LAN, ${hltvTrain.length} train / ${hltvTest.length} test through ${through}; β=${rankBeta.toFixed(2)}, VRS rank β=${vrsRankBeta.toFixed(2)})`);
        console.log(fmt("Elo series", eloScore));
        if (pointsBlock) console.log(fmt("HLTV points", pointsBlock.score));
        console.log(fmt("HLTV rank", hltvScore));
        console.log(fmt("VRS points", vrsScore));
        console.log(fmt("VRS rank", vrsRankScore));
        console.log(`  Elo − HLTV rank log-loss gain:   ${signed(mean)}, 90% CI (${signed(lo)}, ${signed(hi)}), events resampled`);
        if (pointsBlock) {
            console.log(
                `  Elo − HLTV points log-loss gain: ${signed(pointsBlock.gain.mean)}, 90% CI (${signed(pointsBlock.gain.lo)}, ${signed(pointsBlock.gain.hi)}), events resampled [${pointsBlock.link}, β=${pointsBlock.beta.toFixed(2)}]`
            );
            for (const f of pointsFits) {
                console.log(
                    `  HLTV points link ${f.link.label.padEnd(20)} train=${f.loss.toFixed(4)}  test=${f.testScore.logLoss.toFixed(4)}  β=${f.beta.toFixed(2)}`
                );
            }
        }
        const fmtLambda = (l: { lambda: number; lo: number; hi: number }) =>
            `λ ${l.lambda.toFixed(3)}, 90% CI (${l.lo.toFixed(3)}, ${l.hi.toFixed(3)}), events resampled`;
        if (pointsLambda) console.log(`  Encompassing over Elo, HLTV points: ${fmtLambda(pointsLambda)}`);
        console.log(`  Encompassing over Elo, HLTV rank:   ${fmtLambda(rankLambda)}`);
    }
} else if (existingCal?.hltv) {
    hltvBlock = existingCal.hltv as HltvBlock;
}

saveJson(
    CAL_PATH,
    JSON.stringify({
        generatedAt: new Date().toISOString(),
        testFrom,
        vrsScale,
        gate: { n: gateSet.length, elo: eloGate, vrs: vrsGate, passed },
        all: score(elo(test)),
        maps: score(maps(test)),
        crossRegion: { n: crossGate.length, elo: score(elo(crossGate)), vrs: score(vrs(crossGate)) },
        bins: { elo: calibration(elo(test)), vrs: calibration(vrs(gateSet)) },
        ...(hltvBlock ? { hltv: hltvBlock } : {}),
    })
);

if (flag("gate") && !passed) process.exit(1);

// `--residual-lead`: does a lineage's decayed mean past map residual (y − p) predict its next maps? A negative
// coefficient means Elo over-reacts. Shrink and decay match `cs2wp veto`'s `u` (40 maps, 365 days) for comparability.
function residualLead(): void {
    const SHRINK_MAPS = 40;
    const TAU = 365 * 86400;
    const FEW_SERIES = 20;
    const RECENT = 7 * 86400;
    const BLOWOUT = 8;
    // Each past residual keeps its tags so `u` can be split into parts that share one denominator.
    type Past = { r: number; t: number; blowout: boolean; later: boolean };
    const history = new Map<number, { past: Past[]; series: number }>();
    const SPLITS = ["recent", "blowout", "later"] as const;
    const parts = (lineage: number, t: number) => {
        const h = history.get(lineage);
        const out = { all: 0, recent: 0, blowout: 0, later: 0 };
        if (!h) return out;
        let n = 0;
        for (const e of h.past) {
            const d = Math.exp(-(t - e.t) / TAU);
            n += d;
            out.all += e.r * d;
            if (t - e.t <= RECENT) out.recent += e.r * d;
            if (e.blowout) out.blowout += e.r * d;
            if (e.later) out.later += e.r * d;
        }
        for (const k of Object.keys(out) as Array<keyof typeof out>) out[k] /= n + SHRINK_MAPS;
        return out;
    };
    const add = (lineage: number, e: Past) => {
        const h = history.get(lineage) ?? { past: [], series: 0 };
        h.past.push(e);
        history.set(lineage, h);
    };
    type Row = { offset: number; x: number[]; y: 0 | 1; tier: number; few: boolean; split: Record<string, number[]> };
    const rows: Row[] = [];
    for (const s of predictions) {
        const [a, b] = s.lineages;
        if (isTest(s)) {
            const pa = parts(a, s.t);
            const pb = parts(b, s.t);
            const x = pa.all - pb.all;
            const split = Object.fromEntries(SPLITS.map((k) => [k, [pa[k] - pb[k], x - (pa[k] - pb[k])]]));
            const few = Math.min(history.get(a)?.series ?? 0, history.get(b)?.series ?? 0) < FEW_SERIES;
            for (const m of s.maps) rows.push({ offset: logit(m.p), x: [x], y: m.y, tier: s.tier, few, split });
        }
        s.maps.forEach((m, index) => {
            const tags = { t: s.t, blowout: Math.abs(m.margin) >= BLOWOUT, later: index >= 1 };
            add(a, { r: m.y - m.p, ...tags });
            add(b, { r: m.p - m.y, ...tags });
        });
        for (const l of [a, b]) {
            const h = history.get(l);
            if (h) h.series++;
        }
    }
    // Logistic regression with offset logit(p), no intercept; Newton steps on the 1- or 2-feature design.
    const fitN = (rs: Array<{ offset: number; y: 0 | 1 }>, xs: number[][]) => {
        const kf = xs[0]?.length ?? 0;
        const beta = new Array<number>(kf).fill(0);
        let H: number[][] = [];
        for (let iter = 0; iter < 25; iter++) {
            const g = new Array<number>(kf).fill(0);
            H = Array.from({ length: kf }, () => new Array<number>(kf).fill(0));
            rs.forEach((r, i) => {
                const x = xs[i];
                const q = 1 / (1 + Math.exp(-(r.offset + x.reduce((s, v, j) => s + v * beta[j], 0))));
                for (let j = 0; j < kf; j++) {
                    g[j] += (r.y - q) * x[j];
                    for (let l = 0; l < kf; l++) H[j][l] += q * (1 - q) * x[j] * x[l];
                }
            });
            const inv = invert(H);
            for (let j = 0; j < kf; j++) beta[j] += inv[j].reduce((s, v, l) => s + v * g[l], 0);
        }
        const inv = invert(H);
        return beta.map((b, j) => `${b.toFixed(2)} ± ${Math.sqrt(inv[j][j]).toFixed(2)}`);
    };
    const invert = (m: number[][]) => {
        if (m.length === 1) return [[1 / m[0][0]]];
        const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
        return [[m[1][1] / det, -m[0][1] / det], [-m[1][0] / det, m[0][0] / det]];
    };
    const fit = (rs: Row[]) => `${fitN(rs, rs.map((r) => r.x))[0]}  (n=${rs.length})`;
    console.log(`\nTrain series logloss ${score(elo(train)).logLoss.toFixed(5)}, gate ${eloGate.logLoss.toFixed(5)}`);
    console.log(`Residual lead on test maps (coefficient on Δ decayed mean residual, offset logit(p); < 0 is over-reaction)`);
    console.log(`  all maps              ${fit(rows)}`);
    console.log(`  tier 1                ${fit(rows.filter((r) => r.tier === 1))}`);
    console.log(`  either < ${FEW_SERIES} series     ${fit(rows.filter((r) => r.few))}`);
    console.log(`  both ≥ ${FEW_SERIES} series       ${fit(rows.filter((r) => !r.few))}`);
    const labels = { recent: ["≤ 7 days", "older"], blowout: [`margin ≥ ${BLOWOUT}`, "closer"], later: ["map 2+ of series", "map 1"] };
    console.log(`Split (one fit per row, both parts together, all maps)`);
    for (const k of SPLITS) {
        const [b1, b2] = fitN(rows, rows.map((r) => r.split[k]));
        console.log(`  ${labels[k][0].padEnd(18)} ${b1}   ${labels[k][1].padEnd(8)} ${b2}`);
    }
}

// `--luck` / `--skill`: tune luckWeight or skillWeight on 2025 series where both rosters have recent luck maps, score 2026.
// Flags `--luck-variant` (docs/war.md, Luck-adjusted Elo) and, with `--skill`, `--luck-weight w` held fixed; the baseline is unadjusted.
// `--skill-weight w` (with `--skill`) or `--luck-weight w` (with `--luck`) scores that weight with no grid.
// `--test-from` / `--test-to` / `--test-years 2024,2026` set the scored window; `--simulate n` adds the gate power simulation on 2025 treated series.
function adjustmentExperiment(key: "luckWeight" | "skillWeight"): void {
    const LUCK_PATH = path.resolve("data/elo/luck-maps.jsonl");
    const SKILL_PATH = path.resolve("data/elo/player-skill.json");
    const MIN_TREATED_MAPS = 5;
    const WINDOW = 120 * 86400;
    const SUFFIX: Record<string, string> = { raw: "", skill: "Skill", value: "Value", full: "Full", skillonly: "SkillOnly" };
    const variant = option("luck-variant", "skill");
    if (!(variant in SUFFIX)) throw new Error(`Bad --luck-variant ${variant}`);
    const rows = new Map<string, LuckRow>();
    for (const line of fs.readFileSync(LUCK_PATH, "utf8").split("\n")) {
        if (!line) continue;
        const r = JSON.parse(line) as { match2id: string; index: number } & Record<string, number>;
        rows.set(`${r.match2id}:${r.index}`, { xMargin: r[`xMargin${SUFFIX[variant]}`], yHat: r[`yHat${SUFFIX[variant]}`] });
    }
    const lookup: LuckLookup = (id, index) => rows.get(`${id.slice(id.lastIndexOf(":") + 1)}:${index}`);
    const skill = key === "skillWeight" ? makeSkillLookup(JSON.parse(fs.readFileSync(SKILL_PATH, "utf8")) as PlayerSkill) : undefined;
    const fixed: Partial<EloParams> = key === "skillWeight" ? { luckWeight: Number(option("luck-weight", "0")) } : {};
    const runWith = (adjust: Partial<EloParams>) =>
        new EloEngine({ ...params, luckWeight: 0, skillWeight: 0, ...adjust }, feed.players, lookup, skill).run(feed.matches);

    const history = new Map<number, number[]>();
    const treated = new Set<string>();
    const base = runWith({});
    for (const p of base) {
        const recent = (l: number) => (history.get(l) ?? []).filter((t) => t >= p.t - WINDOW && t < p.t).length;
        if (p.lineages.every((l) => recent(l) >= MIN_TREATED_MAPS)) treated.add(p.id);
        p.maps.forEach((_, index) => {
            if (!lookup(p.id, index)) return;
            for (const l of p.lineages) history.set(l, [...(history.get(l) ?? []), p.t]);
        });
    }
    const inYear = (year: string) => (p: SeriesPrediction) => treated.has(p.id) && dayOf(p.t).startsWith(year);
    const isTreatedTrain = inYear("2025");
    const isTreatedTest = (p: SeriesPrediction) => treated.has(p.id) && isTest(p);

    const fixedLabel = Object.entries(fixed).filter(([, v]) => v).map(([k, v]) => ` ${k}=${v}`).join("");
    console.log(`\n${key} experiment (luck variant ${variant}${fixedLabel}): ${rows.size} luck maps; treated series (both sides ` +
        `${MIN_TREATED_MAPS}+ luck maps in 120 days): ${base.filter(isTreatedTrain).length} in 2025, ${base.filter(isTreatedTest).length} from ${testFrom}`);

    const pinned = key === "skillWeight" ? option("skill-weight", "") : option("luck-weight", "");
    let grid: Array<{ w: number; label: string }>;
    if (key === "luckWeight") {
        const ws = pinned ? [Number(pinned)] : Array.from({ length: 11 }, (_, i) => i / 10);
        grid = ws.map((w) => ({ w, label: `w=${w.toFixed(1)}` }));
    } else {
        const gaps = base.filter(isTreatedTrain).map((p) => p.skillGap);
        const m = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - m) ** 2, 0) / (gaps.length - 1));
        console.log(`  2025 treated skill gap: mean ${m.toFixed(4)}, SD ${sd.toFixed(4)} θ; ` +
            `${gaps.filter((g) => g !== 0).length} of ${gaps.length} nonzero`);
        const ws = pinned ? [Number(pinned)] : Array.from({ length: 11 }, (_, i) => (10 * i) / sd);
        grid = ws.map((w) => ({ w, label: `${(w * sd).toFixed(0).padStart(3)} pts/SD` }));
    }
    if (grid.some((g) => !Number.isFinite(g.w))) throw new Error(`Bad pinned weight ${pinned}`);
    const labelOf = new Map(grid.map((g) => [g.w, g.label]));

    const baseLoss = score(elo(base.filter(isTreatedTrain))).logLoss;
    if (fixedLabel) console.log(`  no adjustment  2025 treated series logloss=${baseLoss.toFixed(5)}`);
    const runs = new Map<number, SeriesPrediction[]>();
    let best = { w: 0, loss: Infinity };
    for (const { w, label } of grid) {
        const preds = w === 0 && !fixedLabel ? base : runWith({ ...fixed, [key]: w });
        runs.set(w, preds);
        const loss = score(elo(preds.filter(isTreatedTrain))).logLoss;
        console.log(`  ${label}  2025 treated series logloss=${loss.toFixed(5)}`);
        if (loss < best.loss - 1e-6) best = { w, loss };
    }
    const bestLabel = labelOf.get(best.w)!.trim();
    console.log(pinned
        ? `Pinned ${key} ${best.w.toFixed(2)} (${bestLabel}), not tuned`
        : `Tuned ${key} ${best.w.toFixed(2)} (${bestLabel})${best.w === grid.at(-1)!.w ? ", at the grid edge" : ""}`);
    const isTrain2025 = (p: SeriesPrediction) => dayOf(p.t).startsWith("2025");
    console.log(`  2025 all series logloss: none ${score(elo(base.filter(isTrain2025))).logLoss.toFixed(5)}, ` +
        `${bestLabel} ${score(elo(runs.get(best.w)!.filter(isTrain2025))).logLoss.toFixed(5)}`);

    const tuned = runs.get(best.w)!;
    const byIdTuned = new Map(tuned.map((p) => [p.id, p]));
    const report = (label: string, keep: (p: SeriesPrediction) => boolean) => {
        const b = base.filter(keep);
        const t = b.map((p) => byIdTuned.get(p.id)!);
        console.log(fmt(`${label}, none`, score(elo(b))));
        console.log(fmt(`${label}, ${bestLabel}`, score(elo(t))));
        return { b, t };
    };
    console.log(`\nTest from ${testFrom}`);
    const { b, t } = report("treated series", isTreatedTest);
    console.log(fmt("treated maps, none", score(maps(b))));
    console.log(fmt(`treated maps, ${bestLabel}`, score(maps(t))));
    const gateIds = new Set(gateSet.map((p) => p.id));
    report("gate set series", (p) => gateIds.has(p.id));
    report("all series", isTest);

    const loss = (p: SeriesPrediction) => -Math.log(Math.min(1 - 1e-6, Math.max(1e-6, p.y ? p.p : 1 - p.p)));
    const gains = b.map((p, i) => loss(p) - loss(t[i]));
    const [lo, hi] = clusterCi(gains, b.map((p) => eventOf.get(p.id)!));
    const gain = gains.reduce((s, g) => s + g, 0) / Math.max(1, gains.length);
    const pass = tuned !== base && lo > 0;
    console.log(`\nGate (${key}): treated series log-loss gain ${gain.toFixed(4)}, 90% CI (${lo.toFixed(4)}, ${hi.toFixed(4)}), ` +
        `events resampled → ${pass ? "PASS" : "FAIL"}`);
    const enc = lambdaCi(...encompassingInputs(b, t), b.map((p) => eventOf.get(p.id)!));
    const encPass = tuned !== base && enc.lo > 0 && gain > 0;
    console.log(`Encompassing (${key}): λ ${enc.lambda.toFixed(3)}, 90% CI (${enc.lo.toFixed(3)}, ${enc.hi.toFixed(3)}), ` +
        `gain ${gain.toFixed(4)} → ${encPass ? "PASS" : "FAIL"} (λ CI above 0 and gain above 0)`);

    const sims = Number(option("simulate", "0"));
    if (sims > 0) {
        const b25 = base.filter(isTreatedTrain);
        simulateGates(b25, b25.map((p) => byIdTuned.get(p.id)!), b25.map((p) => eventOf.get(p.id)!), sims);
    }

    // Exploratory: the same ratings scored on next-map round margin, predicted as slope · logit(p) with the slope fit on 2025.
    const logit = (q: number) => Math.log(q / (1 - q));
    const marginRun = (preds: SeriesPrediction[]) => {
        const train = preds.filter(isTreatedTrain).flatMap((p) => p.maps);
        const slope = train.reduce((s, m) => s + m.margin * logit(m.p), 0) / train.reduce((s, m) => s + logit(m.p) ** 2, 0);
        const errors = (keep: (p: SeriesPrediction) => boolean) =>
            preds.filter(keep).flatMap((p) => p.maps.map((m) => ({ event: eventOf.get(p.id)!, se: (m.margin - slope * logit(m.p)) ** 2 })));
        return { train: errors(isTreatedTrain), test: errors(isTreatedTest) };
    };
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    const marginRuns = new Map([...runs].map(([w, preds]) => [w, marginRun(preds)]));
    console.log(`\nMargin score (exploratory): 2025 treated maps, round-margin MSE`);
    let bestMargin = { w: 0, mse: Infinity };
    for (const [w, r] of marginRuns) {
        const mse = mean(r.train.map((e) => e.se));
        console.log(`  ${labelOf.get(w)}  mse=${mse.toFixed(4)}`);
        if (mse < bestMargin.mse - 1e-9) bestMargin = { w, mse };
    }
    console.log(`Margin-tuned ${key} ${bestMargin.w.toFixed(2)} (${labelOf.get(bestMargin.w)!.trim()})`);
    const baseErrors = marginRun(base).test;
    const baseMse = mean(baseErrors.map((e) => e.se));
    console.log(`Test from ${testFrom}: ${baseErrors.length} treated maps, no adjustment mse=${baseMse.toFixed(4)}`);
    for (const w of new Set([bestMargin.w, best.w, grid[Math.min(5, grid.length - 1)].w])) {
        if (runs.get(w) === base) continue;
        const errors = marginRuns.get(w)!.test;
        const marginGains = baseErrors.map((e, i) => e.se - errors[i].se);
        const [mLo, mHi] = clusterCi(marginGains, baseErrors.map((e) => e.event));
        const g = mean(marginGains);
        console.log(`  ${labelOf.get(w)}  mse=${mean(errors.map((e) => e.se)).toFixed(4)}  gain ${g.toFixed(4)} (${((100 * g) / baseMse).toFixed(2)}%), ` +
            `90% CI (${mLo.toFixed(4)}, ${mHi.toFixed(4)})`);
    }
}

function clip(q: number): number {
    return Math.min(1 - 1e-6, Math.max(1e-6, q));
}

function encompassingInputs(base: SeriesPrediction[], adjusted: SeriesPrediction[]): [number[], number[], number[]] {
    const offsets = base.map((p) => logit(clip(p.p)));
    return [offsets, adjusted.map((p, i) => logit(clip(p.p)) - offsets[i]), base.map((p) => p.y)];
}

/** Gain-gate and encompassing-gate pass rates on event resamples of `base`, outcomes drawn at true λ = 0, 0.5 and 1. */
function simulateGates(base: SeriesPrediction[], adjusted: SeriesPrediction[], events: string[], sims: number, innerDraws = 400): void {
    const [offsets, deltas] = encompassingInputs(base, adjusted);
    const outer = clusterWeights(events, sims, 7);
    console.log(`\nGate power simulation: ${sims} resamples of ${base.length} series in ${new Set(events).size} events, ${innerDraws} inner draws`);
    for (const lambdaTrue of [0, 0.5, 1]) {
        const rand = lcg(11);
        let gainPass = 0;
        let encPass = 0;
        const lambdas: number[] = [];
        let rows = 0;
        for (const weights of outer) {
            const o: number[] = [];
            const d: number[] = [];
            const ys: number[] = [];
            const clusters: string[] = [];
            weights.forEach((w, i) => {
                for (let c = 0; c < w; c++) {
                    o.push(offsets[i]);
                    d.push(deltas[i]);
                    ys.push(rand() < 1 / (1 + Math.exp(-(offsets[i] + lambdaTrue * deltas[i]))) ? 1 : 0);
                    clusters.push(`${events[i]}#${c}`);
                }
            });
            const loss = (x: number, y: number) => -Math.log(clip(y ? 1 / (1 + Math.exp(-x)) : 1 / (1 + Math.exp(x))));
            const gains = o.map((x, i) => loss(x, ys[i]) - loss(x + d[i], ys[i]));
            const gain = gains.reduce((s, g) => s + g, 0) / gains.length;
            const [gLo] = clusterCi(gains, clusters, innerDraws, 3);
            const enc = lambdaCi(o, d, ys, clusters, innerDraws, 5);
            if (gLo > 0) gainPass++;
            if (enc.lo > 0 && gain > 0) encPass++;
            lambdas.push(enc.lambda);
            rows += o.length;
        }
        const m = lambdas.reduce((s, x) => s + x, 0) / sims;
        const sd = Math.sqrt(lambdas.reduce((s, x) => s + (x - m) ** 2, 0) / (sims - 1));
        console.log(`  true λ ${lambdaTrue.toFixed(1)}: mean n ${(rows / sims).toFixed(0)}, λ̂ mean ${m.toFixed(3)} SD ${sd.toFixed(3)}, ` +
            `pass rate gain gate ${((100 * gainPass) / sims).toFixed(1)}%, encompassing gate ${((100 * encPass) / sims).toFixed(1)}%`);
    }
}
