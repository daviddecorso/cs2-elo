import fs from "node:fs";
import path from "node:path";
import { EloEngine, type SeriesPrediction } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { calibration, score, type Forecast, type Score } from "./lib/elo/metrics.ts";
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

const trainFrom = option("train-from", "2024-01-01");
const trainTo = option("train-to", "2025-12-31");
const testFrom = option("test-from", "2026-01-01");

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const isTrain = (p: SeriesPrediction) => dayOf(p.t) >= trainFrom && dayOf(p.t) <= trainTo;
const isTest = (p: SeriesPrediction) => dayOf(p.t) >= testFrom;

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
    { key: "tierGap", step: 25, min: 0, max: 400 },
    { key: "standInK", step: 0.2, min: 0.2, max: 1.6 },
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

let params = DEFAULT_PARAMS;
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
for (const p of predictions) {
    const snapshot = snapshotBefore(snapshots, p.t);
    if (!snapshot) continue;
    const a = findVrsRoster(snapshot, p.lineups[0], nicksOf);
    const b = findVrsRoster(snapshot, p.lineups[1], nicksOf);
    if (a && b && a !== b) vrsDiff.set(p.id, a.points - b.points);
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

const eloGate = score(elo(gateSet));
const vrsGate = score(vrs(gateSet));
const passed = gateSet.length > 0 && eloGate.logLoss < vrsGate.logLoss;
console.log(`\nGate: Elo ${eloGate.logLoss.toFixed(4)} vs VRS ${vrsGate.logLoss.toFixed(4)} on ${gateSet.length} series → ${passed ? "PASS" : "FAIL"}`);

saveJson(
    path.resolve("public/data/elo/calibration.json"),
    JSON.stringify({
        generatedAt: new Date().toISOString(),
        testFrom,
        vrsScale,
        gate: { n: gateSet.length, elo: eloGate, vrs: vrsGate, passed },
        all: score(elo(test)),
        maps: score(maps(test)),
        crossRegion: { n: crossGate.length, elo: score(elo(crossGate)), vrs: score(vrs(crossGate)) },
        bins: { elo: calibration(elo(test)), vrs: calibration(vrs(gateSet)) },
    })
);

if (flag("gate") && !passed) process.exit(1);
