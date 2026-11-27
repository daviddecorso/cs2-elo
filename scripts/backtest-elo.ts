import fs from "node:fs";
import path from "node:path";
import { ASIA, EloEngine, FINE_OCEANIA, isOceaniaInternal, makeSkillLookup, type LuckLookup, type LuckRow, type PlayerSkill, type SeriesPrediction, type SkillLookup } from "./lib/elo/engine.ts";
import { liveEngine } from "./lib/elo/adjustments.ts";
import { clusterCi, clusterWeights, lambdaCi, lcg } from "./lib/elo/encompassing.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { countryRegion } from "./lib/elo/region.ts";
import { seriesWinProbability } from "./lib/elo/series.ts";
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
    fitOffsetLogit,
    logit,
    score,
    type CalibrationBin,
    type Forecast,
    type Score,
} from "./lib/elo/metrics.ts";
import { applySets, DEFAULT_PARAMS, TUNED_PARAMS_PATH, type EloParams } from "./lib/elo/params.ts";
import { playerBreaks } from "./lib/elo/breaks.ts";
import { breaksReport, compareReport, debutsReport, rankedReport, type VrsRanks } from "./lib/elo/rosterDiagnostics.ts";
import { belowTierReport, readBracketIndex, rematchReport, stageReport, turnoverReport } from "./lib/elo/tier1Diagnostics.ts";
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

const feed = loadFeed(undefined, { csgo: !flag("no-csgo") });
console.log(`Feed: ${feed.matches.length} series, ${dayOf(feed.matches[0]?.t ?? 0)} to ${dayOf(feed.matches.at(-1)?.t ?? 0)}.`);

const run = (params: EloParams) => liveEngine(params, feed.players).run(feed.matches);
// `--train-halflife <days>`: weight each training series by its age back from `--train-to` (0 = unweighted).
const trainHalflife = Number(option("train-halflife", "0"));
const trainEnd = Date.parse(`${trainTo}T23:59:59Z`) / 1000;
// Oceania-internal series are played but left out of the fit objective unless `--train-include-oceania` (2026-11-24 rule in elo-experiments.md).
const includeOceania = flag("train-include-oceania");
const isFit = (p: SeriesPrediction) => isTrain(p) && (includeOceania || !isOceaniaInternal(p));
const trainLoss = (params: EloParams) => fitLoss(run(params));
const fitLoss = (predictions: SeriesPrediction[]) => {
    const train = predictions.filter(isFit);
    if (!trainHalflife) return score(train).logLoss;
    let total = 0;
    let weight = 0;
    for (const { p, y, t } of train) {
        const w = 0.5 ** ((trainEnd - t) / 86400 / trainHalflife);
        const q = Math.min(1 - 1e-9, Math.max(1e-9, y ? p : 1 - p));
        total -= w * Math.log(q);
        weight += w;
    }
    return total / weight;
};

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
    { key: "provisionalMaps", step: 10, min: 5, max: 400, integer: true },
    { key: "regress", step: 0.1, min: 0, max: 1 },
    { key: "gameRegress", step: 0.1, min: 0, max: 1 },
    { key: "newRosterRegress", step: 0.1, min: 0, max: 1 },
    { key: "debutOffset", step: 50, min: 0, max: 600 },
    { key: "debutMaps", step: 5, min: 5, max: 60, integer: true },
    { key: "newLanOffset", step: 20, min: 0, max: 300 },
    { key: "newLanMaps", step: 10, min: 10, max: 150, integer: true },
    { key: "kMap", step: 2, min: 0, max: 80 },
    { key: "mapShrink", step: 0.01, min: 0, max: 0.2 },
    { key: "coreWindow", step: 1, min: 3, max: 12, integer: true },
    { key: "tierGap", step: 25, min: 0, max: 1200 },
    { key: "standInK", step: 0.2, min: 0.2, max: 1.6 },
    { key: "seriesMapTemp", step: 0.05, min: 0.5, max: 1.2 },
    { key: "seriesMapTempOnline", step: 0.05, min: 0.5, max: 1.2 },
    { key: "burstMaps", step: 8, min: 0, max: 128 },
    { key: "burstDays", step: 2, min: 1, max: 30 },
    { key: "regionPriorOceania", step: 25, min: -500, max: 0 },
    { key: "oceaniaTemp", step: 0.1, min: 0.5, max: 3 },
    { key: "playerBlend", step: 0.05, min: 0, max: 0.8 },
    { key: "playerTemp", step: 0.05, min: 0.4, max: 1.2 },
    { key: "playerK", step: 2, min: 2, max: 40 },
    { key: "playerTierGap", step: 50, min: 0, max: 1200 },
    { key: "playerProvisionalK", step: 0.5, min: 0, max: 12 },
    { key: "playerProvisionalMaps", step: 10, min: 10, max: 200, integer: true },
    { key: "playerMarginWeight", step: 0.25, min: 0, max: 2 },
    { key: "playerTierK", step: 0.05, min: 0.6, max: 1.2 },
];

// `--tune-keys k1,k2,…` tunes only those keys; the rest hold their starting values.
const tuneKeys = option("tune-keys", "").split(",").filter(Boolean);
for (const key of tuneKeys) if (!STEPS.some((s) => s.key === key)) throw new Error(`--tune-keys: ${key} isn't a tuning step`);
const tuneSteps = tuneKeys.length ? STEPS.filter((s) => tuneKeys.includes(s.key)) : STEPS;

const tune = (start: EloParams): EloParams => {
    let best = { ...start };
    const startRun = run(best);
    let bestLoss = fitLoss(startRun);
    const skipped = startRun.filter((p) => isTrain(p) && !isFit(p)).length;
    console.log(`Tuning on ${trainFrom} to ${trainTo} (${skipped} Oceania-internal series left out); start log loss ${bestLoss.toFixed(5)}`);
    for (let pass = 1; pass <= 4; pass++) {
        let improved = false;
        for (const s of tuneSteps) {
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
let params: EloParams = applySets(args, DEFAULT_PARAMS);
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
const sideRanks: VrsRanks = new Map();
for (const p of predictions) {
    const snapshot = snapshotBefore(snapshots, p.t);
    if (!snapshot) continue;
    const a = findVrsRoster(snapshot, p.lineups[0], nicksOf);
    const b = findVrsRoster(snapshot, p.lineups[1], nicksOf);
    if (a !== b || !a) sideRanks.set(p.id, [a?.rank ?? null, b?.rank ?? null]);
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

const train = predictions.filter(isFit);
const test = predictions.filter(isTest);
const gateSet = test.filter((p) => vrsDiff.has(p.id));
/** The decision set for shared-param levers: the gate without Oceania-internal series. */
const gateExOceania = gateSet.filter((p) => !isOceaniaInternal(p));
// `--dump-gate <path>`: gate series ids, for offline challengers scored against the same set.
if (flag("dump-gate")) fs.writeFileSync(option("dump-gate", ""), JSON.stringify(gateSet.map((p) => p.id)));
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
console.log(fmt("Elo series, gate ex-Oceania", score(elo(gateExOceania))));
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
    diag(`${year} tier-1 LAN series`, elo(ofYear.filter((p) => p.tier === 1 && p.lan)));
    diag(`${year} tier-1 LAN maps`, maps(ofYear.filter((p) => p.tier === 1 && p.lan)));
}

// Post-hoc temperature fit on train: the ceiling for a pure calibration fix, never applied to published numbers.
const temperature = calibrationSlope(elo(train)).slope;
const tempered = (ps: SeriesPrediction[]): Forecast[] => ps.map(({ p, y }) => ({ p: 1 / (1 + Math.exp(-temperature * logit(p))), y }));
console.log(`\nPost-hoc temperature ${temperature.toFixed(3)} (fit on train)`);
console.log(fmt("Tempered series, gate set", score(tempered(gateSet))));
diag("tempered test series", tempered(test));

// Each slice's temperature is applied to that slice only; the gain is spread over the whole gate set so it compares to the 0.0005 bar.
const sinceChange = (p: SeriesPrediction): number => Math.min(...p.mapsSinceCoreChange.map((n) => n ?? Infinity));
const coreChangeSlices: Array<[string, (p: SeriesPrediction) => boolean]> = [
    ["< 30 maps since core change", (p) => sinceChange(p) < 30],
    ["30–100 maps since core change", (p) => sinceChange(p) >= 30 && sinceChange(p) < 100],
    ["≥ 100 maps or no core change", (p) => sinceChange(p) >= 100],
];
const temper = (ps: SeriesPrediction[], slope: number): Forecast[] => ps.map(({ p, y }) => ({ p: 1 / (1 + Math.exp(-slope * logit(p))), y }));
const gateGain = (ps: SeriesPrediction[], slope: number) =>
    (ps.length * (score(elo(ps)).logLoss - score(temper(ps, slope)).logLoss)) / gateSet.length;
if (flag("core-change")) console.log(`\nCore-change slices: slope, and the gate gain from tempering only that slice (fit on 2025 train, or on the slice itself as a ceiling)`);
for (const [label, inSlice] of flag("core-change") ? coreChangeSlices : []) {
    for (const [scope, filter] of [["", () => true], [", cross-region", (p: SeriesPrediction) => p.crossRegion]] as const) {
        const gate = gateSet.filter((p) => inSlice(p) && filter(p));
        if (gate.length < 30) continue;
        diag(`gate ${label}${scope}`, elo(gate));
        const trainSlope = calibrationSlope(elo(train.filter((p) => inSlice(p) && filter(p)))).slope;
        const oracleSlope = calibrationSlope(elo(gate)).slope;
        console.log(
            `    train slope ${trainSlope.toFixed(3)} → gate gain ${gateGain(gate, trainSlope).toFixed(5)}; ceiling (slope ${oracleSlope.toFixed(3)}) ${gateGain(gate, oracleSlope).toFixed(5)}`
        );
    }
}

const eloGate = score(elo(gateSet));
const vrsGate = score(vrs(gateSet));
const passed = gateSet.length > 0 && eloGate.logLoss < vrsGate.logLoss;
console.log(`\nGate: Elo ${eloGate.logLoss.toFixed(4)} vs VRS ${vrsGate.logLoss.toFixed(4)} on ${gateSet.length} series → ${passed ? "PASS" : "FAIL"}`);
console.log(
    `Gate ex-Oceania (decision set for shared params): Elo ${score(elo(gateExOceania)).logLoss.toFixed(4)} vs VRS ${score(vrs(gateExOceania)).logLoss.toFixed(4)} on ${gateExOceania.length} series`
);

if (flag("debuts")) {
    debutsReport(predictions);
    process.exit(0);
}
if (flag("breaks")) {
    breaksReport(predictions, playerBreaks(feed.matches), new Set(gateSet.map((p) => p.id)));
    process.exit(0);
}
if (flag("compare")) {
    const gateIds = new Set(gateSet.map((p) => p.id));
    compareReport(
        run(DEFAULT_PARAMS),
        predictions,
        [
            ["gate ex-Oceania (decision)", (p) => gateIds.has(p.id) && !isOceaniaInternal(p)],
            ["gate", (p) => gateIds.has(p.id)],
            ["tier-1 LAN", (p) => isTest(p) && p.tier === 1 && p.lan],
            ["all test series", isTest],
            ["unranked (test, not gate)", (p) => isTest(p) && !gateIds.has(p.id)],
            ["Oceania-internal", (p) => isTest(p) && isOceaniaInternal(p)],
            ["Oceania cross-region", (p) => isTest(p) && p.fineRegions.includes(FINE_OCEANIA) && !isOceaniaInternal(p)],
            ["Asia ex-Oceania involved", (p) => isTest(p) && p.fineRegions.includes(ASIA)],
            ["train series (fit objective)", isFit],
        ],
        new Map(feed.matches.map((m) => [m.id, m.event])),
    );
    process.exit(0);
}
if (flag("turnover") || flag("below-tier") || flag("rematch") || flag("stage")) {
    const eventOf = new Map(feed.matches.map((m) => [m.id, m.event]));
    if (flag("turnover")) turnoverReport(predictions, run({ ...params, playerBlend: 1 }), eventOf);
    if (flag("below-tier")) belowTierReport(predictions, eventOf);
    if (flag("rematch")) rematchReport(predictions, eventOf);
    if (flag("stage")) stageReport(predictions, eventOf, readBracketIndex());
    process.exit(0);
}
if (flag("ranked")) {
    rankedReport(predictions, sideRanks, new Map(feed.matches.map((m) => [m.id, m.event])), [
        ["Train", isTrain],
        ["Test", isTest],
    ]);
    process.exit(0);
}
if (flag("residual-lead")) {
    residualLead();
    process.exit(0);
}
if (flag("h2h")) {
    headToHead();
    process.exit(0);
}
if (flag("region-residual")) {
    regionResidual();
    process.exit(0);
}
if (flag("region-walk")) {
    regionWalk();
    process.exit(0);
}
if (flag("walk")) {
    walkForward();
    process.exit(0);
}

const eventOf = new Map(feed.matches.map((m) => [m.id, m.event]));

if (flag("luck-form")) {
    luckFormExperiment();
    process.exit(0);
}
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
    const fitN = (rs: Array<{ offset: number; y: 0 | 1 }>, xs: number[][]) => {
        const { beta, se } = fitOffsetLogit(rs, xs);
        return beta.map((b, j) => `${b.toFixed(2)} ± ${se[j].toFixed(2)}`);
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

// `--h2h`: does a pair's decayed past map residual against each other predict their next maps beyond each side's
// residual against everyone? Declared test in elo-experiments.md (head-to-head persistence).
function headToHead(): void {
    const TAU = 365 * 86400;
    const PAIR_SHRINK = 10;
    const TEAM_SHRINK = 40;
    type Past = { r: number; t: number; map: string };
    const team = new Map<number, Past[]>();
    const pair = new Map<string, Past[]>();
    const push = <K>(m: Map<K, Past[]>, k: K, e: Past) => m.set(k, [...(m.get(k) ?? []), e]);
    const mean = (ps: Past[] | undefined, t: number, shrink: number, map?: string) => {
        let n = 0;
        let s = 0;
        for (const e of ps ?? []) {
            if (map && e.map !== map) continue;
            const d = Math.exp(-(t - e.t) / TAU);
            n += d;
            s += e.r * d;
        }
        return s / (n + shrink);
    };
    const eventOfId = new Map(feed.matches.map((m) => [m.id, m.event]));
    type Row = { offset: number; y: 0 | 1; pair: number; sameMap: number; control: number; year: string; tier: number; met: number; event: string };
    const rows: Row[] = [];
    for (const s of predictions) {
        const [a, b] = s.lineages;
        const year = dayOf(s.t).slice(0, 4);
        if (year === "2025" || year === "2026") {
            const history = pair.get(`${a}:${b}`);
            const control = mean(team.get(a), s.t, TEAM_SHRINK) - mean(team.get(b), s.t, TEAM_SHRINK);
            for (const m of s.maps) {
                rows.push({
                    offset: logit(clip(m.p)),
                    y: m.y,
                    pair: mean(history, s.t, PAIR_SHRINK),
                    sameMap: mean(history, s.t, PAIR_SHRINK, m.map),
                    control,
                    year,
                    tier: s.tier,
                    met: history?.length ?? 0,
                    event: eventOfId.get(s.id)!,
                });
            }
        }
        for (const m of s.maps) {
            const r = m.y - m.p;
            push(team, a, { r, t: s.t, map: m.map });
            push(team, b, { r: -r, t: s.t, map: m.map });
            push(pair, `${a}:${b}`, { r, t: s.t, map: m.map });
            push(pair, `${b}:${a}`, { r: -r, t: s.t, map: m.map });
        }
    }
    const fit = (rs: Row[], feature: "pair" | "sameMap") => {
        const { beta, se } = fitOffsetLogit(rs, rs.map((r) => [r[feature], r.control]));
        return `${feature.padEnd(8)} ${beta[0].toFixed(3)} ± ${se[0].toFixed(3)} (z ${(beta[0] / se[0]).toFixed(2)})  control ${beta[1].toFixed(3)} ± ${se[1].toFixed(3)}  n=${rs.length}`;
    };
    console.log(`\nHead-to-head persistence (offset logit(p); coefficient on pair residual with each side's form as control)`);
    for (const year of ["2025", "2026"]) {
        const ys = rows.filter((r) => r.year === year);
        console.log(`${year}: ${ys.length} maps, ${ys.filter((r) => r.met > 0).length} with an earlier meeting`);
        console.log(`  all           ${fit(ys, "pair")}`);
        console.log(`  all           ${fit(ys, "sameMap")}`);
        console.log(`  tier 1        ${fit(ys.filter((r) => r.tier === 1), "pair")}`);
        console.log(`  met 3+ maps   ${fit(ys.filter((r) => r.met >= 3), "pair")}`);
        const sd = Math.sqrt(ys.filter((r) => r.met > 0).reduce((a, r) => a + r.pair ** 2, 0) / ys.filter((r) => r.met > 0).length);
        console.log(`  pair residual SD where met: ${sd.toFixed(4)}`);
    }
    const train25 = rows.filter((r) => r.year === "2025");
    const test26 = rows.filter((r) => r.year === "2026");
    const withPair = fitOffsetLogit(train25, train25.map((r) => [r.pair, r.control])).beta;
    const controlOnly = fitOffsetLogit(train25, train25.map((r) => [r.control])).beta;
    const loss = (x: number, y: number) => Math.log(1 + Math.exp(y ? -x : x));
    const gains = test26.map((r) => loss(r.offset + controlOnly[0] * r.control, r.y) - loss(r.offset + withPair[0] * r.pair + withPair[1] * r.control, r.y));
    const [lo, hi] = clusterCi(gains, test26.map((r) => r.event));
    console.log(
        `\n2026 map log loss gain from the 2025 pair coefficient (${withPair[0].toFixed(3)}) over control only: ` +
            `${(gains.reduce((a, g) => a + g, 0) / gains.length).toFixed(5)} (90% CI ${lo.toFixed(5)} to ${hi.toFixed(5)})`
    );
}

// `--luck` / `--skill`: tune luckWeight or skillWeight on 2025 series where both rosters have recent luck maps, score 2026.
// Flags `--luck-variant` (docs/war.md, Luck-adjusted Elo) and, with `--skill`, `--luck-weight w` held fixed; the baseline is unadjusted.
// `--skill-weight w` (with `--skill`) or `--luck-weight w` (with `--luck`) scores that weight with no grid.
// `--test-from` / `--test-to` / `--test-years 2024,2026` set the scored window; `--simulate n` adds the gate power simulation on 2025 treated series.
// `--scope wide` scores only tier-1 online and tier-2 treated series, the registered tier-2 holdout. `--exclude-file` drops
// the listed match2ids from the scored set; `--save-treated` writes the scored set's match2ids.
/** Series where both lineages have 5+ maps with a luck row in the 120 days before: the registered treated rule. */
function treatedSeries(preds: SeriesPrediction[], lookup: LuckLookup): Set<string> {
    const WINDOW = 120 * 86400;
    const history = new Map<number, number[]>();
    const treated = new Set<string>();
    for (const p of preds) {
        const recent = (l: number) => (history.get(l) ?? []).filter((t) => t >= p.t - WINDOW && t < p.t).length;
        if (p.lineages.every((l) => recent(l) >= 5)) treated.add(p.id);
        p.maps.forEach((_, index) => {
            if (!lookup(p.id, index)) return;
            for (const l of p.lineages) history.set(l, [...(history.get(l) ?? []), p.t]);
        });
    }
    return treated;
}

function seriesLoss(p: SeriesPrediction): number {
    return -Math.log(Math.min(1 - 1e-6, Math.max(1e-6, p.y ? p.p : 1 - p.p)));
}

// `--luck-form` (exploratory): changes to the live skill + luck term, each scored against it on treated series,
// tuned on 2024–25 and checked on 2026. Needs luck-maps.jsonl from `cs2wp luck`; variants whose columns are missing are skipped.
function luckFormExperiment(): void {
    const raw = new Map<string, Record<string, number>>();
    for (const line of fs.readFileSync(path.resolve("data/elo/luck-maps.jsonl"), "utf8").split("\n")) {
        if (!line) continue;
        const r = JSON.parse(line) as { match2id: string; index: number } & Record<string, number>;
        raw.set(`${r.match2id}:${r.index}`, r);
    }
    const columns = new Set(Object.keys(raw.values().next().value ?? {}));
    const lookups = new Map<string, LuckLookup>();
    const lookupFor = (suffix: string): LuckLookup => {
        let lookup = lookups.get(suffix);
        if (!lookup) {
            const rows = new Map([...raw].map(([k, r]) => [k, { xMargin: r[`xMargin${suffix}`], yHat: r[`yHat${suffix}`], reliability: r.reliability }]));
            lookups.set(suffix, (lookup = (id, index) => rows.get(`${id.slice(id.lastIndexOf(":") + 1)}:${index}`)));
        }
        return lookup;
    };
    const skillData = JSON.parse(fs.readFileSync(path.resolve("data/elo/player-skill.json"), "utf8")) as PlayerSkill;
    const skills = new Map<number, SkillLookup>();
    const skillFor = (h: number) => {
        if (!skills.has(h)) skills.set(h, makeSkillLookup(skillData, h));
        return skills.get(h)!;
    };
    const runWith = (adjust: Partial<EloParams>, suffix = "Value", skill?: SkillLookup) => {
        const p = { ...params, ...adjust };
        return new EloEngine(p, feed.players, lookupFor(suffix), skill ?? skillFor(p.skillHalfLife)).run(feed.matches);
    };

    const none = runWith({ luckWeight: 0, skillWeight: 0 });
    const live = runWith({});
    const shipped = predictions.every((p, i) => p.p === live[i].p);
    const treated = treatedSeries(none, lookupFor("Value"));
    const year = (p: SeriesPrediction) => dayOf(p.t).slice(0, 4);
    const isTune = (p: SeriesPrediction) => treated.has(p.id) && (year(p) === "2024" || year(p) === "2025");
    const isCheck = (p: SeriesPrediction) => treated.has(p.id) && year(p) === "2026";
    const meanLoss = (preds: SeriesPrediction[], keep: (p: SeriesPrediction) => boolean) => {
        const kept = preds.filter(keep);
        return kept.reduce((s, p) => s + seriesLoss(p), 0) / Math.max(1, kept.length);
    };
    const gainCi = (from: SeriesPrediction[], to: SeriesPrediction[], keep: (i: number) => boolean) => {
        const idx = from.map((_, i) => i).filter(keep);
        const gains = idx.map((i) => seriesLoss(from[i]) - seriesLoss(to[i]));
        const [lo, hi] = clusterCi(gains, idx.map((i) => eventOf.get(from[i].id)!));
        return { n: idx.length, gain: gains.reduce((s, g) => s + g, 0) / Math.max(1, gains.length), lo, hi };
    };
    const fmtGain = (g: { n: number; gain: number; lo: number; hi: number }) =>
        `${g.gain >= 0 ? "+" : ""}${g.gain.toFixed(4)} (${g.lo.toFixed(4)}, ${g.hi.toFixed(4)}) on ${g.n}`;

    console.log(`\nLuck form (exploratory): ${raw.size} luck maps; live run matches the shipped engine: ${shipped ? "yes" : "NO"}`);
    console.log(`Treated series: ${none.filter(isTune).length} in 2024–25 (tune), ${none.filter(isCheck).length} in 2026 (check)`);
    console.log(`  none  tune ${meanLoss(none, isTune).toFixed(5)}  check ${meanLoss(none, isCheck).toFixed(5)}`);
    console.log(`  live  tune ${meanLoss(live, isTune).toFixed(5)}  check ${meanLoss(live, isCheck).toFixed(5)}`);

    // Where the live gain sits, on every treated series 2024–26.
    const isTreated = (i: number) => treated.has(none[i].id) && year(none[i]) >= "2024";
    const newest = (p: SeriesPrediction) => Math.min(...p.mapsSinceCoreChange.map((m) => m ?? Infinity));
    const ages: Array<[string, (p: SeriesPrediction) => boolean]> = [
        ["under 30 maps", (p) => newest(p) < 30],
        ["30–99 maps", (p) => newest(p) >= 30 && newest(p) < 100],
        ["100+ maps or never", (p) => newest(p) >= 100],
    ];
    console.log(`\nLive gain over none by the newer side's maps since its core changed (treated 2024–26):`);
    for (const [label, keep] of ages) console.log(`  ${label.padEnd(20)} ${fmtGain(gainCi(none, live, (i) => isTreated(i) && keep(none[i])))}`);
    const gaps = none.filter((_, i) => isTreated(i)).map((p) => Math.abs(p.skillGap)).sort((a, b) => a - b);
    const [q1, q2] = [gaps[Math.floor(gaps.length / 3)], gaps[Math.floor((2 * gaps.length) / 3)]];
    console.log(`By |skill gap| tercile (cuts ${q1.toFixed(4)}, ${q2.toFixed(4)} θ):`);
    const terciles: Array<[string, (g: number) => boolean]> = [["low", (g) => g < q1], ["mid", (g) => g >= q1 && g < q2], ["high", (g) => g >= q2]];
    for (const [label, keep] of terciles) console.log(`  ${label.padEnd(20)} ${fmtGain(gainCi(none, live, (i) => isTreated(i) && keep(Math.abs(none[i].skillGap))))}`);

    // Each family: pick on tune, report the check against live.
    const family = (title: string, candidates: Array<{ label: string; adjust: Partial<EloParams>; suffix?: string; skill?: SkillLookup }>) => {
        console.log(`\n${title}`);
        let best: { label: string; preds: SeriesPrediction[]; loss: number } | undefined;
        for (const c of candidates) {
            const preds = runWith(c.adjust, c.suffix, c.skill);
            const loss = meanLoss(preds, isTune);
            console.log(`  ${c.label.padEnd(34)} tune ${loss.toFixed(5)}  check ${meanLoss(preds, isCheck).toFixed(5)}`);
            if (!best || loss < best.loss) best = { label: c.label, preds, loss };
        }
        if (!best) return;
        const tuneGain = gainCi(live, best.preds, (i) => isTune(live[i]));
        const checkGain = gainCi(live, best.preds, (i) => isCheck(live[i]));
        const keep = tuneGain.gain > 0 && checkGain.gain > 0;
        console.log(`  best on tune: ${best.label}; gain over live, tune ${fmtGain(tuneGain)}, check ${fmtGain(checkGain)} → ${keep ? "KEEP" : "drop"}`);
    };

    // A decayed θ has a different spread, so each half-life gets the live weight in points per SD of the 2024–25 treated gap, times 0.75–1.25.
    const sdOf = (preds: SeriesPrediction[]) => {
        const g = preds.filter(isTune).map((p) => p.skillGap);
        const m = g.reduce((s, x) => s + x, 0) / g.length;
        return Math.sqrt(g.reduce((s, x) => s + (x - m) ** 2, 0) / (g.length - 1));
    };
    const liveSd = sdOf(live);
    const skillCandidates = [180, 365, 730].flatMap((h) => {
        const weight = (params.skillWeight * liveSd) / sdOf(runWith({ skillHalfLife: h }));
        return [0.75, 1, 1.25].map((x) => ({ label: `half-life ${h}d, ${x}× live pts/SD`, adjust: { skillHalfLife: h, skillWeight: weight * x } }));
    });
    family("Skill θ half-life (skill term only; luck stays live)", skillCandidates);

    if (columns.has("reliability")) {
        family("Reliability-scaled luck weight", [0.6, 0.8, 1].map((w) => ({ label: `luckWeight ${w} × reliability`, adjust: { luckWeight: w, luckReliability: 1 } })));
    } else console.log("\nReliability-scaled luck weight: skipped, luck-maps.jsonl has no `reliability` (rerun `cs2wp luck`)");

    const decay = [180, 365, 730].filter((h) => columns.has(`xMarginValueH${h}`));
    if (decay.length) family("Luck θ half-life (value variant)", decay.map((h) => ({ label: `value, θ half-life ${h}d`, adjust: {}, suffix: `ValueH${h}` })));
    else console.log("Luck θ half-life: skipped, luck-maps.jsonl has no `xMarginValueH*` (rerun `cs2wp luck`)");

    const ADJ_SKILL_PATH = path.resolve("data/elo/player-skill-adj.json");
    if (columns.has("xMarginValueAdj") && fs.existsSync(ADJ_SKILL_PATH)) {
        const adjSkill = makeSkillLookup(JSON.parse(fs.readFileSync(ADJ_SKILL_PATH, "utf8")) as PlayerSkill);
        const weight = (params.skillWeight * liveSd) / sdOf(runWith({}, "Value", adjSkill));
        family("Opponent-adjusted θ", [
            { label: "luck only", adjust: {}, suffix: "ValueAdj" },
            ...[0.75, 1, 1.25].flatMap((x) => [
                { label: `skill only, ${x}× live pts/SD`, adjust: { skillWeight: weight * x }, skill: adjSkill },
                { label: `luck + skill, ${x}× live pts/SD`, adjust: { skillWeight: weight * x }, suffix: "ValueAdj", skill: adjSkill },
            ]),
        ]);
    } else console.log("Opponent-adjusted θ: skipped, no `xMarginValueAdj` or player-skill-adj.json (rerun `cs2wp luck`)");

    // Power for the tier-2 holdout: treated series outside tier-1 LAN if every tier 1–2 map since 2023-10 had a luck row.
    const lookup = lookupFor("Value");
    const inScope = (p: SeriesPrediction) => p.tier <= 2 && dayOf(p.t) >= "2023-10-01";
    const scoped = new Map(none.filter(inScope).map((p) => [p.id, p.maps.length]));
    const wider: LuckLookup = (id, index) => lookup(id, index) ?? (index < (scoped.get(id) ?? 0) ? { xMargin: 0, yHat: 0.5 } : undefined);
    const widerTreated = treatedSeries(none, wider);
    const isNew = (p: SeriesPrediction) => widerTreated.has(p.id) && inScope(p) && !(p.tier === 1 && p.lan);
    console.log(`\nWider scope, with full HLTV coverage of tier 1–2 assumed: treated series outside tier-1 LAN by year`);
    for (const y of ["2024", "2025", "2026"]) {
        const kept = none.filter((p) => isNew(p) && year(p) === y);
        const t1 = kept.filter((p) => p.tier === 1).length;
        console.log(`  ${y}: ${kept.length} (tier-1 online ${t1}, tier 2 ${kept.length - t1}); tier-1 LAN treated now ${none.filter((p) => treated.has(p.id) && year(p) === y && p.tier === 1 && p.lan).length}`);
    }
}

function adjustmentExperiment(key: "luckWeight" | "skillWeight"): void {
    const LUCK_PATH = path.resolve("data/elo/luck-maps.jsonl");
    const SKILL_PATH = path.resolve("data/elo/player-skill.json");
    const MIN_TREATED_MAPS = 5;
    const SUFFIX: Record<string, string> = { raw: "", skill: "Skill", value: "Value", valueadj: "ValueAdj", full: "Full", skillonly: "SkillOnly" };
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

    const base = runWith({});
    const treated = treatedSeries(base, lookup);
    const inYear = (year: string) => (p: SeriesPrediction) => treated.has(p.id) && dayOf(p.t).startsWith(year);
    const isTreatedTrain = inYear("2025");
    const scope = option("scope", "all");
    if (scope !== "all" && scope !== "wide") throw new Error(`Bad --scope ${scope}`);
    const inScope = (p: SeriesPrediction) => scope === "all" || (p.tier !== null && p.tier <= 2 && !(p.tier === 1 && p.lan));
    const matchId = (p: SeriesPrediction) => p.id.slice(p.id.lastIndexOf(":") + 1);
    const excludePath = option("exclude-file", "");
    const excluded = new Set<string>(excludePath ? (JSON.parse(fs.readFileSync(path.resolve(excludePath), "utf8")) as string[]) : []);
    const isTreatedTest = (p: SeriesPrediction) => treated.has(p.id) && isTest(p) && inScope(p) && !excluded.has(matchId(p));
    const savePath = option("save-treated", "");
    if (savePath) saveJson(path.resolve(savePath), `${JSON.stringify(base.filter(isTreatedTest).map(matchId).sort(), null, 1)}\n`);

    const fixedLabel = Object.entries(fixed).filter(([, v]) => v).map(([k, v]) => ` ${k}=${v}`).join("");
    console.log(`\n${key} experiment (luck variant ${variant}${fixedLabel}): ${rows.size} luck maps; treated series (both sides ` +
        `${MIN_TREATED_MAPS}+ luck maps in 120 days): ${base.filter(isTreatedTrain).length} in 2025, ${base.filter(isTreatedTest).length} from ${testFrom}${scope === "wide" ? " outside tier-1 LAN" : ""}`);

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

    const gains = b.map((p, i) => seriesLoss(p) - seriesLoss(t[i]));
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

// `--region-residual`: on cross-region maps, does one Valve region beat its ratings against another (a closed-pool
// level error), and are favourites overconfident when a side's last cross-region series is old?
function regionResidual(): void {
    const NAMES = ["Europe", "Americas", "Asia"];
    const toPoints = (logitUnits: number) => (logitUnits * params.scale) / Math.LN10;
    const cross = predictions.filter((p) => p.crossRegion && p.regions[0] !== null && p.regions[1] !== null);
    const periods: Array<[string, (p: SeriesPrediction) => boolean]> = [
        ["2024", (p) => dayOf(p.t).startsWith("2024")],
        ["2025", (p) => dayOf(p.t).startsWith("2025")],
        ["2024–25", (p) => dayOf(p.t) >= "2024-01-01" && dayOf(p.t) <= "2025-12-31"],
        ["2026", (p) => dayOf(p.t).startsWith("2026")],
    ];
    const pointsFit = (rows: Array<{ offset: number; y: 0 | 1; x: number }>) => {
        if (rows.length < 30) return `n=${rows.length}`.padStart(24);
        const { beta, se } = fitOffsetLogit(rows, rows.map((r) => [r.x]));
        const v = toPoints(beta[0]);
        return `${(v >= 0 ? "+" : "") + v.toFixed(1)} ± ${toPoints(se[0]).toFixed(1)} (n=${rows.length})`.padStart(24);
    };

    console.log(`\nRegion residual on cross-region maps (Elo points for the first region; offset logit(p))`);
    console.log(`  ${"pair".padEnd(20)}${periods.map(([l]) => l.padStart(24)).join("")}`);
    for (const [r1, r2] of [[0, 1], [0, 2], [1, 2]]) {
        const cells = periods.map(([, inPeriod]) =>
            pointsFit(
                cross
                    .filter((s) => inPeriod(s) && s.regions.includes(r1) && s.regions.includes(r2))
                    .flatMap((s) => s.maps.map((m) => ({ offset: logit(clip(m.p)), y: m.y, x: s.regions[0] === r1 ? 1 : -1 })))
            )
        );
        console.log(`  ${`${NAMES[r1]} v ${NAMES[r2]}`.padEnd(20)}${cells.join("")}`);
    }
    for (let r = 0; r < 3; r++) {
        const cells = periods.map(([, inPeriod]) =>
            pointsFit(
                cross
                    .filter((s) => inPeriod(s) && s.regions.includes(r))
                    .flatMap((s) => s.maps.map((m) => ({ offset: logit(clip(m.p)), y: m.y, x: s.regions[0] === r ? 1 : -1 })))
            )
        );
        console.log(`  ${`${NAMES[r]} v rest`.padEnd(20)}${cells.join("")}`);
    }

    const BUCKETS: Array<[string, (d: number) => boolean]> = [
        ["≤ 30 days", (d) => d <= 30],
        ["30–90 days", (d) => d > 30 && d <= 90],
        ["90–180 days", (d) => d > 90 && d <= 180],
        ["> 180 days or never", (d) => d > 180],
    ];
    const staleness = (s: SeriesPrediction) => Math.max(...s.crossGapDays.map((d) => d ?? Infinity));
    console.log(`\nCross-region calibration by the staler side's days since its last cross-region series (slope < 1 is overconfident)`);
    for (const [label, inPeriod] of periods) {
        for (const [bucket, inBucket] of BUCKETS) {
            const slice = cross.filter((s) => inPeriod(s) && inBucket(staleness(s)));
            if (slice.length < 30) continue;
            diag(`${label} ${bucket} series`, elo(slice));
            diag(`${label} ${bucket} maps`, maps(slice));
        }
    }

    console.log(`\nStale side (last cross-region > 90 days or never) against a fresh one (≤ 30 days), Elo points for the stale side`);
    const staleRows = (inPeriod: (p: SeriesPrediction) => boolean) =>
        cross.filter(inPeriod).flatMap((s) => {
            const [ga, gb] = s.crossGapDays.map((d) => d ?? Infinity);
            const stale = ga > 90 && gb <= 30 ? 1 : gb > 90 && ga <= 30 ? -1 : 0;
            return stale === 0 ? [] : s.maps.map((m) => ({ offset: logit(clip(m.p)), y: m.y, x: stale }));
        });
    for (const [label, inPeriod] of periods) console.log(`  ${label.padEnd(20)}${pointsFit(staleRows(inPeriod))}`);

    // Where does Asia's residual live? Splits that separate a pool-level rating error from travel or isolation.
    const rawDir = path.resolve("data/raw");
    const tournamentFiles = [
        ...fs.readdirSync(path.join(rawDir, "archive")).filter((f) => f.startsWith("tournaments-")).map((f) => path.join(rawDir, "archive", f)),
        path.join(rawDir, "tournaments.json"),
    ];
    const eventRegion = new Map<string, number | null>();
    for (const file of tournamentFiles) {
        for (const row of JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ pagename: string; locations?: Record<string, string> }>) {
            eventRegion.set(row.pagename, countryRegion(row.locations?.country1 ?? ""));
        }
    }
    const eventOfSeries = new Map(feed.matches.map((m) => [m.id, m.event]));
    const OCEANIA = new Set(["au", "nz"]);
    const isOceania = (lineup: string[]) =>
        lineup.filter((p) => OCEANIA.has((feed.players[p]?.country ?? "").toLowerCase())).length >= 3;

    // Share of each lineage's maps in the trailing 180 days against its own region, before each series.
    const insularity = new Map<string, [number | null, number | null]>();
    const history = new Map<number, Array<{ t: number; maps: number; same: boolean }>>();
    for (const s of predictions) {
        const shares = s.lineages.map((id) => {
            const h = (history.get(id) ?? []).filter((e) => e.t >= s.t - 180 * 86400);
            history.set(id, h);
            const total = h.reduce((n, e) => n + e.maps, 0);
            return total < 10 ? null : h.reduce((n, e) => n + (e.same ? e.maps : 0), 0) / total;
        }) as [number | null, number | null];
        insularity.set(s.id, shares);
        const same = s.regions[0] !== null && s.regions[0] === s.regions[1];
        s.lineages.forEach((id) => history.get(id)?.push({ t: s.t, maps: s.maps.length, same }) ?? history.set(id, [{ t: s.t, maps: s.maps.length, same }]));
    }

    const asiaSide = (s: SeriesPrediction) => (s.regions[0] === 2 ? 0 : s.regions[1] === 2 ? 1 : -1);
    // Splits only see series already filtered to `asiaSide(s) >= 0`.
    const asiaIndex = (s: SeriesPrediction) => asiaSide(s) as 0 | 1;
    const asiaRows = (slice: SeriesPrediction[]) =>
        slice.flatMap((s) => {
            const side = asiaSide(s);
            return side < 0 ? [] : s.maps.map((m) => ({ offset: logit(clip(m.p)), y: m.y, x: side === 0 ? 1 : -1 }));
        });
    const SPLITS: Array<[string, Array<[string, (s: SeriesPrediction) => boolean]>]> = [
        [
            "venue",
            [
                ["LAN in Asia", (s) => s.lan && eventRegion.get(eventOfSeries.get(s.id)!) === 2],
                ["LAN abroad", (s) => s.lan && eventRegion.get(eventOfSeries.get(s.id)!) !== undefined && eventRegion.get(eventOfSeries.get(s.id)!) !== 2],
                ["online", (s) => !s.lan],
            ],
        ],
        [
            "Asia side",
            [
                ["Oceania", (s) => isOceania(s.lineups[asiaIndex(s)])],
                ["rest of Asia", (s) => !isOceania(s.lineups[asiaIndex(s)])],
            ],
        ],
        [
            "Asia side's own-region share, 180 days",
            [
                ["< 50%", (s) => (insularity.get(s.id)![asiaIndex(s)] ?? -1) >= 0 && insularity.get(s.id)![asiaIndex(s)]! < 0.5],
                ["50–80%", (s) => (insularity.get(s.id)![asiaIndex(s)] ?? -1) >= 0.5 && insularity.get(s.id)![asiaIndex(s)]! < 0.8],
                ["≥ 80%", (s) => (insularity.get(s.id)![asiaIndex(s)] ?? -1) >= 0.8],
                ["< 10 maps", (s) => insularity.get(s.id)![asiaIndex(s)] === null],
            ],
        ],
        [
            "tier",
            [
                ["tier 1", (s) => s.tier === 1],
                ["tier 2+", (s) => s.tier > 1],
            ],
        ],
        [
            "Asia side's pre-series rating",
            [
                ["≥ 0", (s) => s.ratings[asiaIndex(s)] >= 0],
                ["< 0", (s) => s.ratings[asiaIndex(s)] < 0],
            ],
        ],
    ];
    console.log(`\nAsia v rest residual by split (Elo points for the Asia side, maps)`);
    for (const [title, groups] of SPLITS) {
        console.log(`  ${title}`);
        for (const [label, inGroup] of groups) {
            const cells = periods.map(([, inPeriod]) => pointsFit(asiaRows(cross.filter((s) => inPeriod(s) && asiaSide(s) >= 0 && inGroup(s)))));
            console.log(`    ${label.padEnd(18)}${cells.join("")}`);
        }
    }

    // Valve's Asia includes Oceania, so Oceania v East Asia never counts as cross-region. Split it out (3 = Oceania).
    const FINE = [...NAMES, "Oceania"];
    const fineRegion = (s: SeriesPrediction, side: number) => (isOceania(s.lineups[side]) ? 3 : s.regions[side]);
    console.log(`\nOceania v each region, every series with a known region (Elo points for Oceania, maps)`);
    for (const r of [0, 1, 2]) {
        const cells = periods.map(([, inPeriod]) =>
            pointsFit(
                predictions
                    .filter((s) => inPeriod(s) && [0, 1].some((i) => fineRegion(s, i) === 3 && fineRegion(s, 1 - i) === r))
                    .flatMap((s) => s.maps.map((m) => ({ offset: logit(clip(m.p)), y: m.y, x: fineRegion(s, 0) === 3 ? 1 : -1 })))
            )
        );
        console.log(`  ${`Oceania v ${FINE[r]}`.padEnd(20)}${cells.join("")}`);
    }

    // Within one region: does a side that has played abroad lately beat its rating against a home-only side?
    const fineSides = (s: SeriesPrediction) => [fineRegion(s, 0), fineRegion(s, 1)];
    console.log(`\nSame-region series, travelled side (cross-region series ≤ 90 days ago) v home side (none in 180 days or ever), points for the travelled side, maps`);
    for (const r of [0, 1, 2, 3]) {
        const rows = (inPeriod: (p: SeriesPrediction) => boolean) =>
            predictions
                .filter((s) => inPeriod(s) && fineSides(s).every((x) => x === r))
                .flatMap((s) => {
                    const [ga, gb] = s.crossGapDays.map((d) => d ?? Infinity);
                    const x = ga <= 90 && gb > 180 ? 1 : gb <= 90 && ga > 180 ? -1 : 0;
                    return x === 0 ? [] : s.maps.map((m) => ({ offset: logit(clip(m.p)), y: m.y, x }));
                });
        console.log(`  ${FINE[r].padEnd(20)}${periods.map(([, inPeriod]) => pointsFit(rows(inPeriod))).join("")}`);
    }

    console.log(`\nSame-region series calibration by region (slope > 1 is underconfident)`);
    for (const r of [0, 1, 2, 3]) {
        for (const [label, inPeriod] of periods) {
            diag(`${FINE[r]} ${label} series`, elo(predictions.filter((s) => inPeriod(s) && fineSides(s).every((x) => x === r))));
        }
    }
    console.log(`\nSame-region series calibration by region and tier`);
    for (const r of [0, 1, 2, 3]) {
        for (const tier of [1, 2, 3, 4]) {
            for (const [label, inPeriod] of [periods[1], periods[3]]) {
                const slice = predictions.filter((s) => inPeriod(s) && s.tier === tier && fineSides(s).every((x) => x === r));
                if (slice.length >= 100) diag(`${FINE[r]} tier ${tier} ${label}`, elo(slice));
            }
        }
    }

    // Seeding too high in a closed pool hands the excess to that pool's incumbents as the newcomer loses it.
    const engine = liveEngine(params, feed.players);
    engine.run(feed.matches);
    const born = engine.lineages.filter((l) => l.seed !== undefined && l.rating30 !== undefined && l.region !== null);
    const SEED_GROUPS: Array<[string, (n: number) => boolean]> = [
        ["all", () => true],
        ["0 unrated", (n) => n === 0],
        ["1–4 unrated", (n) => n > 0 && n < 5],
        ["5 unrated", (n) => n === 5],
    ];
    const drift = (ls: typeof born) => {
        if (ls.length < 10) return `n=${ls.length}`.padStart(26);
        const d = ls.map((l) => l.rating30! - l.seed!);
        const mean = d.reduce((s, x) => s + x, 0) / d.length;
        const se = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (d.length - 1) / d.length);
        return `${(mean >= 0 ? "+" : "") + mean.toFixed(1)} ± ${se.toFixed(1)} (n=${ls.length})`.padStart(26);
    };
    const bornIn: Array<[string, (l: (typeof born)[number]) => boolean]> = [
        ["2024–25", (l) => dayOf(l.firstT) >= "2024-01-01" && dayOf(l.firstT) <= "2025-12-31"],
        ["2026", (l) => dayOf(l.firstT).startsWith("2026")],
    ];
    console.log(`\nNew lineages: rating after 30 maps minus seed (negative means seeded too high), by region and unrated seeds`);
    for (const [label, inPeriod] of bornIn) {
        console.log(`  born ${label}`);
        console.log(`    ${"region".padEnd(10)}${SEED_GROUPS.map(([g]) => g.padStart(26)).join("")}`);
        for (let r = 0; r < 3; r++) {
            const ls = born.filter((l) => inPeriod(l) && l.region === r);
            console.log(`    ${NAMES[r].padEnd(10)}${SEED_GROUPS.map(([, g]) => drift(ls.filter((l) => g(l.seedsFromMean!)))).join("")}`);
        }
    }

    // Fixed Asia offset in the simulator: shift cross-region odds by `points` for the Asia side, scored on 2026.
    const eventOfId = new Map(feed.matches.map((m) => [m.id, m.event]));
    const shiftP = (q: number, points: number) => 1 / (1 + Math.exp(-(logit(clip(q)) + (points * Math.LN10) / params.scale)));
    const mapPOf = (s: SeriesPrediction) => {
        let [lo, hi] = [1e-6, 1 - 1e-6];
        for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            if (seriesWinProbability(mid, s.bestOf, params.seriesMapTemp) < s.p) lo = mid;
            else hi = mid;
        }
        return (lo + hi) / 2;
    };
    const shifted = (s: SeriesPrediction, asia: number): SeriesPrediction => {
        const points = !cross.includes(s) ? 0 : s.regions[0] === 2 ? asia : s.regions[1] === 2 ? -asia : 0;
        if (points === 0) return s;
        return {
            ...s,
            p: seriesWinProbability(shiftP(mapPOf(s), points), s.bestOf, params.seriesMapTemp),
            maps: s.maps.map((m) => ({ ...m, p: shiftP(m.p, points) })),
        };
    };
    const asiaCross = (s: SeriesPrediction) => cross.includes(s) && s.regions.includes(2);
    console.log(`\nFixed Asia offset on cross-region series (fit on 2024–25: −23 points), Elo series log loss`);
    for (const [label, slice] of [
        ["2024–25 cross-region", cross.filter(periods[2][1])],
        ["2026 cross-region", cross.filter(isTest)],
        ["2026 gate", gateSet],
        ["2026 gate cross-region", gateSet.filter((s) => cross.includes(s))],
        ["2026 cross-region, not in gate", cross.filter((s) => isTest(s) && !gateSet.includes(s))],
        ["2026 tier-1 cross-region", cross.filter((s) => isTest(s) && s.tier === 1)],
    ] as Array<[string, SeriesPrediction[]]>) {
        const base = score(elo(slice)).logLoss;
        const cells = [-10, -23, -35].map((asia) => {
            const adj = slice.map((s) => shifted(s, asia));
            const loss = (q: number, y: number) => -Math.log(clip(y ? q : 1 - q));
            const gains = slice.map((s, i) => loss(s.p, s.y) - loss(adj[i].p, s.y));
            const [lo, hi] = clusterCi(gains, slice.map((s) => eventOfId.get(s.id)!));
            const mean = gains.reduce((a, g) => a + g, 0) / gains.length;
            return `${asia}: ${score(elo(adj)).logLoss.toFixed(4)} (gain ${mean.toFixed(4)}, 90% CI ${lo.toFixed(4)} to ${hi.toFixed(4)}; slope ${calibrationSlope(elo(adj)).slope.toFixed(3)})`;
        });
        console.log(`  ${label} (${slice.length} series, ${slice.filter(asiaCross).length} with Asia): 0: ${base.toFixed(4)} (slope ${calibrationSlope(elo(slice)).slope.toFixed(3)})`);
        for (const c of cells) console.log(`    ${c}`);
    }
}

// `--region-walk` fits region priors on earlier years and scores the next; pass rule in elo-experiments.md (2026-11-19).
// `--region-walk-fixed` scores the params' own priors instead of fitting them.
function regionWalk(): void {
    const OCEANIA = new Set(["au", "nz"]);
    const fineOf = (lineup: string[], valve: number | null) =>
        lineup.filter((p) => OCEANIA.has((feed.players[p]?.country ?? "").toLowerCase())).length >= 3 ? 3 : valve;
    const fine = (s: SeriesPrediction): [number | null, number | null] => [fineOf(s.lineups[0], s.regions[0]), fineOf(s.lineups[1], s.regions[1])];
    const fineCross = (s: SeriesPrediction) => {
        const [a, b] = fine(s);
        return a !== null && b !== null && a !== b;
    };
    const toPoints = (beta: number) => (beta * params.scale) / Math.LN10;
    const yearOf = (s: SeriesPrediction) => dayOf(s.t).slice(0, 4);
    const eventOfId = new Map(feed.matches.map((m) => [m.id, m.event]));
    const KEYS = ["regionPriorAmericas", "regionPriorAsia", "regionPriorOceania"] as const;
    // `--region-walk-keys 3` fits Oceania only (1 Americas, 2 Asia, 3 Oceania).
    const fitRegions = option("region-walk-keys", "1,2,3").split(",").map(Number);
    const baseParams: EloParams = { ...params, regionPriorAmericas: 0, regionPriorAsia: 0, regionPriorOceania: 0, oceaniaCross: 0, oceaniaK: 1, oceaniaTemp: 1 };
    const base = run(baseParams);
    const baseById = new Map(base.map((s) => [s.id, s]));
    const loss = (q: number, y: number) => -Math.log(clip(y ? q : 1 - q));

    const folds: Array<[string[], string]> = [
        [["2024"], "2025"],
        [["2024", "2025"], "2026"],
    ];
    const gains: number[] = [];
    const clusters: string[] = [];
    for (const [trainYears, testYear] of folds) {
        let treated = { ...params };
        if (!flag("region-walk-fixed")) {
            const prior = [0, 0, 0];
            for (let iter = 0; iter < 3; iter++) {
                treated = { ...params, regionPriorAmericas: prior[0], regionPriorAsia: prior[1], regionPriorOceania: prior[2] };
                const rows = run(treated).filter((s) => trainYears.includes(yearOf(s)) && fineCross(s));
                const mapsRows = rows.flatMap((s) => s.maps.map((m) => ({ offset: logit(clip(m.p)), y: m.y, s })));
                const xs = mapsRows.map(({ s }) => {
                    const [a, b] = fine(s);
                    return fitRegions.map((r) => (a === r ? 1 : 0) - (b === r ? 1 : 0));
                });
                const { beta } = fitOffsetLogit(mapsRows, xs);
                beta.forEach((b, j) => (prior[fitRegions[j] - 1] += toPoints(b)));
            }
            treated = { ...params, regionPriorAmericas: prior[0], regionPriorAsia: prior[1], regionPriorOceania: prior[2] };
        }
        const after = run(treated);
        const test = after.filter((s) => yearOf(s) === testYear && baseById.has(s.id));
        const crossTest = test.filter((s) => fineCross(baseById.get(s.id)!));
        const foldGains = crossTest.map((s) => loss(baseById.get(s.id)!.p, s.y) - loss(s.p, s.y));
        gains.push(...foldGains);
        clusters.push(...crossTest.map((s) => eventOfId.get(s.id)!));
        const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
        const [lo, hi] = clusterCi(foldGains, crossTest.map((s) => eventOfId.get(s.id)!));
        const allGain = mean(test.map((s) => loss(baseById.get(s.id)!.p, s.y) - loss(s.p, s.y)));
        console.log(`\nFit ${trainYears.join("+")} → test ${testYear}: ${KEYS.map((k) => `${k} ${treated[k].toFixed(1)}`).join(", ")}, oceaniaCross ${treated.oceaniaCross}`);
        console.log(`  Cross-region (Oceania split) series: ${crossTest.length}, log loss ${mean(crossTest.map((s) => loss(baseById.get(s.id)!.p, s.y))).toFixed(4)} → ` +
            `${mean(crossTest.map((s) => loss(s.p, s.y))).toFixed(4)}, gain ${mean(foldGains).toFixed(4)} (90% CI ${lo.toFixed(4)} to ${hi.toFixed(4)})`);
        console.log(`  All ${testYear} series: ${test.length}, gain ${allGain.toFixed(4)}`);
        const oceOce = test.filter((s) => fine(baseById.get(s.id)!).every((r) => r === 3));
        const oceGains = oceOce.map((s) => loss(baseById.get(s.id)!.p, s.y) - loss(s.p, s.y));
        const [oLo, oHi] = clusterCi(oceGains, oceOce.map((s) => eventOfId.get(s.id)!));
        console.log(`  Oceania v Oceania series: ${oceOce.length}, gain ${mean(oceGains).toFixed(4)} (90% CI ${oLo.toFixed(4)} to ${oHi.toFixed(4)})`);
        const slopeOf = (ss: SeriesPrediction[]) => calibrationSlope(elo(ss));
        const [b0, b1] = [slopeOf(oceOce.map((s) => baseById.get(s.id)!)), slopeOf(oceOce)];
        console.log(`  Oceania v Oceania slope ${b0.slope.toFixed(3)} → ${b1.slope.toFixed(3)}, intercept ${b0.intercept.toFixed(3)} → ${b1.intercept.toFixed(3)}`);
        if (testYear === "2026") {
            const gateIds = new Set(gateSet.map((s) => s.id));
            const g = test.filter((s) => gateIds.has(s.id));
            console.log(`  2026 gate: ${g.length}, log loss ${mean(g.map((s) => loss(baseById.get(s.id)!.p, s.y))).toFixed(4)} → ${mean(g.map((s) => loss(s.p, s.y))).toFixed(4)}`);
            const gx = g.filter((s) => !isOceaniaInternal(baseById.get(s.id)!));
            console.log(`  2026 gate ex-Oceania: ${gx.length}, log loss ${mean(gx.map((s) => loss(baseById.get(s.id)!.p, s.y))).toFixed(4)} → ${mean(gx.map((s) => loss(s.p, s.y))).toFixed(4)}`);
            const oce = (ss: SeriesPrediction[]) => ss.filter((s) => fine(s).includes(3));
            const gateGain = (keep: (s: SeriesPrediction) => boolean) => {
                const ss = g.filter((s) => keep(baseById.get(s.id)!));
                const total = ss.reduce((a, s) => a + loss(baseById.get(s.id)!.p, s.y) - loss(s.p, s.y), 0);
                return `${ss.length} series, ${(total / g.length).toFixed(4)} of the gate gain`;
            };
            console.log(`  Gate gain from: Oceania involved ${gateGain((s) => fine(s).includes(3))}; ` +
                `other cross-region ${gateGain((s) => !fine(s).includes(3) && fineCross(s))}; ` +
                `same region ${gateGain((s) => !fine(s).includes(3) && !fineCross(s))}`);
            console.log(`  2026 Oceania cross-region series: ${oce(crossTest).length}, gain ${mean(oce(crossTest).map((s) => loss(baseById.get(s.id)!.p, s.y) - loss(s.p, s.y))).toFixed(4)}`);
        }
    }
    const [lo, hi] = clusterCi(gains, clusters);
    const pooled = gains.reduce((a, g) => a + g, 0) / gains.length;
    console.log(`\nPooled cross-region gain ${pooled.toFixed(4)} on ${gains.length} series (90% CI ${lo.toFixed(4)} to ${hi.toFixed(4)}) → ${lo > 0 ? "PASS" : "FAIL"} (gate check above)`);
}

// `--walk key=v1,v2,…` (repeatable; grids are crossed) picks the combination with the lowest log loss on earlier years'
// `--walk-fit` slice (all, cross or t1lan) and scores the next year against the current params; tier-1 LAN rule in elo-experiments.md.
function walkForward(): void {
    const grids = args.flatMap((arg, i) => (arg === "--walk" ? [args[i + 1] ?? ""] : [])).map((spec) => {
        const [key, values] = spec.split("=");
        if (!(key in params) || !values) throw new Error(`Bad --walk ${spec}`);
        return { key: key as keyof EloParams, values: values.split(",").map(Number) };
    });
    const fitSlice = option("walk-fit", "all");
    const slices: Record<string, (s: SeriesPrediction) => boolean> = {
        all: () => true,
        cross: (s) => s.crossRegion,
        t1lan: (s) => s.tier === 1 && s.lan,
    };
    if (!slices[fitSlice]) throw new Error(`Bad --walk-fit ${fitSlice}`);
    const combos = grids.reduce<Array<Partial<EloParams>>>((acc, g) => acc.flatMap((c) => g.values.map((v) => ({ ...c, [g.key]: v }))), [{}]);
    const yearOf = (s: SeriesPrediction) => dayOf(s.t).slice(0, 4);
    const eventOfId = new Map(feed.matches.map((m) => [m.id, m.event]));
    const loss = (q: number, y: number) => -Math.log(clip(y ? q : 1 - q));
    const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const label = (c: Partial<EloParams>) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ");
    const base = run(params);
    const baseById = new Map(base.map((s) => [s.id, s]));
    const gateIds = new Set(gateSet.map((s) => s.id));

    const folds: Array<[string[], string]> = [
        [["2024"], "2025"],
        [["2024", "2025"], "2026"],
    ];
    // Only each fold's best run is kept, so large grids fit in memory.
    const best = folds.map(() => ({ loss: Infinity, combo: {} as Partial<EloParams>, test: [] as SeriesPrediction[] }));
    for (const combo of combos) {
        const preds = run({ ...params, ...combo });
        folds.forEach(([trainYears, testYear], f) => {
            const foldLoss = mean(
                preds
                    .filter((s) => trainYears.includes(yearOf(s)) && slices[fitSlice](s) && (includeOceania || !isOceaniaInternal(s)))
                    .map((s) => loss(s.p, s.y))
            );
            if (foldLoss < best[f].loss) best[f] = { loss: foldLoss, combo, test: preds.filter((s) => yearOf(s) === testYear && baseById.has(s.id)) };
        });
    }
    const t1Gains: number[] = [];
    const t1Events: string[] = [];
    let gate2026 = NaN;
    for (const [f, [trainYears, testYear]] of folds.entries()) {
        const { combo, test } = best[f];
        console.log(`\nFit ${trainYears.join("+")} on ${fitSlice} → test ${testYear}: ${label(combo)}`);
        const report = (name: string, ss: SeriesPrediction[]) => {
            if (ss.length === 0) return [];
            const gains = ss.map((s) => loss(baseById.get(s.id)!.p, s.y) - loss(s.p, s.y));
            const [lo, hi] = clusterCi(gains, ss.map((s) => eventOfId.get(s.id)!));
            console.log(`  ${name.padEnd(14)} ${String(ss.length).padStart(6)} series, gain ${mean(gains).toFixed(4)} (90% CI ${lo.toFixed(4)} to ${hi.toFixed(4)})`);
            return gains;
        };
        report("all", test);
        report("cross-region", test.filter((s) => slices.cross(baseById.get(s.id)!)));
        const t1 = test.filter((s) => slices.t1lan(baseById.get(s.id)!));
        t1Gains.push(...report("tier-1 LAN", t1));
        t1Events.push(...t1.map((s) => eventOfId.get(s.id)!));
        if (testYear === "2026") {
            const gate = test.filter((s) => gateIds.has(s.id));
            report("gate", gate);
            gate2026 = mean(report("gate ex-Oceania", gate.filter((s) => !isOceaniaInternal(baseById.get(s.id)!))));
        }
    }
    const [lo, hi] = clusterCi(t1Gains, t1Events);
    const pass = lo > 0 && gate2026 >= -0.0002;
    console.log(
        `\nPooled tier-1 LAN gain ${mean(t1Gains).toFixed(4)} on ${t1Gains.length} series (90% CI ${lo.toFixed(4)} to ${hi.toFixed(4)}); ` +
            `2026 gate ex-Oceania ${gate2026.toFixed(4)} → ${pass ? "PASS" : "FAIL"}`
    );
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
