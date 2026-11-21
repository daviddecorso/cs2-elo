import fs from "node:fs";
import path from "node:path";
import { EloEngine } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import type { RawRow } from "./lib/elo/normalize.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";
import { findVrsRoster, makeNickLookup, readGlobalSnapshots, snapshotBefore, vrsProbability } from "./lib/elo/vrsBaseline.ts";
import {
    brier,
    calibration,
    championOf,
    logLoss,
    pickemCorrect,
    pickemSets,
    scoreEvent,
    scoreStage,
    stageOutcomes,
    tallyEvent,
    type EventScore,
    type Forecast,
    type StageScore,
} from "./lib/sim/backtest.ts";
import type { EventConfig } from "./lib/sim/config.ts";
import { externalTally, readExternalForecasts } from "./lib/sim/externalBaseline.ts";
import { knownMatches, type KnownMatch } from "./lib/sim/locks.ts";
import { DRIFT_PER_DAY, Predictor, type SeriesModel } from "./lib/sim/predict.ts";
import { makeRng } from "./lib/sim/rng.ts";
import { eventTeams, runEvent } from "./lib/sim/simulate.ts";
import type { Overrides } from "./lib/vrs/buildMatchdata.ts";

// Scores the Major simulator on every past Major in fixtures/events: before the event and at the start of each stage,
// against VRS points and a coin flip, plus how its Pick'em sets would have done.

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const n = Number(option("n", "10000"));
const pickemN = Number(option("pickem-n", "20000"));
const seed = Number(option("seed", "1"));
const leadDays = Number(option("lead", "0"));
const only = option("majors", "").split(",").filter(Boolean);

const FIXTURES = path.resolve("fixtures/events");
/** Elo parameters were tuned on 2025 series (elo-model.md). */
const TUNING_YEAR = "2025";
const DAY = 86400;

const configs = fs
    .readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8")) as EventConfig)
    .filter((c) => only.length === 0 || only.includes(c.slug))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

const readJson = <T>(file: string, fallback: T): T => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback);
const rawRows: RawRow[] = [
    ...readJson<{ done: string[] }>("data/raw/archive/meta.json", { done: [] }).done.flatMap((month) =>
        readJson<RawRow[]>(`data/raw/archive/matches-${month}.json`, [])
    ),
    ...readJson<RawRow[]>("data/raw/matches.json", []),
];

const feed = loadFeed(undefined, { csgo: !args.includes("--no-csgo") });
const engines = new Map<number, EloEngine>();
const engineAt = (t: number) => {
    if (!engines.has(t)) {
        const engine = new EloEngine(DEFAULT_PARAMS, feed.players);
        engine.run(feed.matches.filter((m) => m.t < t));
        engines.set(t, engine);
    }
    return engines.get(t)!;
};
const unrated = new Set<string>();
const eloAt = (t: number, drift = 0, horizon = 0): Predictor => {
    const engine = engineAt(t);
    return new Predictor(engine, DEFAULT_PARAMS, t, { driftPerDay: drift, horizons: [horizon], fallbackRating: engine.tierMean(2, t) });
};
const coinFlip: SeriesModel = { resample: () => {}, setHorizon: () => {}, seriesProbability: () => 0.5 };

const overrides = readJson<Overrides>("data/overrides.json", {} as Overrides);
const snapshots = readGlobalSnapshots();
const nicksOf = makeNickLookup(feed.players, overrides.playerAliases);

/** Series-level logistic on VRS points, as the Elo backtest's baseline, with its scale fit on the year before `t`. */
const vrsScaleBefore = (t: number): number | null => {
    const fit: Array<{ diff: number; y: number }> = [];
    for (const m of feed.matches) {
        if (m.t < t - 365 * DAY || m.t >= t) continue;
        const snapshot = snapshotBefore(snapshots, m.t);
        if (!snapshot) continue;
        const a = findVrsRoster(snapshot, m.lineups[0], nicksOf);
        const b = findVrsRoster(snapshot, m.lineups[1], nicksOf);
        if (a && b) fit.push({ diff: a.points - b.points, y: m.winner === 0 ? 1 : 0 });
    }
    if (fit.length < 200) return null;
    let best = { scale: 400, loss: Infinity };
    for (let scale = 50; scale <= 3000; scale += 10) {
        const loss = logLoss(fit.map(({ diff, y }) => ({ p: vrsProbability(diff, scale), y: y as 0 | 1 })));
        if (loss < best.loss) best = { scale, loss };
    }
    return best.scale;
};

const vrsAt = (config: EventConfig, t: number, scale: number): { model: SeriesModel; missing: string[] } | null => {
    const snapshot = snapshotBefore(snapshots, t);
    if (!snapshot) return null;
    const pages = config.stages.map((s) => `${s.page}:`);
    const lineups = new Map<string, string[]>();
    for (const m of feed.matches) {
        if (!pages.some((p) => m.id.startsWith(p))) continue;
        m.teams.forEach((team, i) => lineups.has(team) || lineups.set(team, m.lineups[i]));
    }
    const points = new Map<string, number>();
    const missing: string[] = [];
    for (const team of eventTeams(config)) {
        const roster = findVrsRoster(snapshot, lineups.get(team) ?? [], nicksOf);
        if (roster) points.set(team, roster.points);
        else missing.push(team);
    }
    const floor = Math.min(...points.values());
    for (const team of missing) points.set(team, floor);
    return {
        model: { resample: () => {}, setHorizon: () => {}, seriesProbability: (a, b) => vrsProbability(points.get(a)! - points.get(b)!, scale) },
        missing,
    };
};

const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "—");
const f4 = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : "—");

interface StageRow {
    major: string;
    stage: string;
    model: string;
    score: StageScore;
}
interface PickemRow {
    major: string;
    stage: string;
    model: string;
    coin: number;
    favourites: number;
}
const stageRows: StageRow[] = [];
const eventRows: Array<{ major: string; model: string; score: EventScore }> = [];
const pickemRows: PickemRow[] = [];
/** Every played Major series, priced at its stage's start. */
const seriesRows: Array<{ model: string; bestOf: number; f: Forecast; label: string; regions: Array<number | null> }> = [];

const EXTERNAL = "Supercomputer";
const external = readExternalForecasts("data/external/supercomputer.json");

for (const config of configs) {
    const teams = new Set(eventTeams(config));
    // Drops showmatches that share a page with a stage.
    const known = new Map(
        config.stages.map((s) => [s.id, knownMatches(rawRows, s.page, s.sections).filter((k) => k.teams.every((t) => teams.has(t)))])
    );
    const actual = runEvent({ config, known, horizon: 0 }, coinFlip, makeRng(seed));
    const unlocked = actual.matches.filter((m) => !m.locked).length;
    const sample = config.startDate.startsWith(TUNING_YEAR) ? "in-sample" : "out of sample";
    console.log(`\n## ${config.name} (${config.startDate}, Elo ${sample})`);
    if (unlocked || actual.diverged.length) {
        console.log(`Replay failed: ${unlocked} matches not on Liquipedia, ${actual.diverged.length} unreached. Check the fixture's seeds.`);
        continue;
    }
    // Rebuilds every round's pairings from seeds and results alone, which checks the fixture's seeds and our pairing rules.
    const unpaired = new Map([...known].map(([id, ks]) => [id, ks.map((k): KnownMatch => ({ ...k, round: null }))]));
    const rebuilt = runEvent({ config, known: unpaired, horizon: 0 }, coinFlip, makeRng(seed));
    const byStage = config.stages.map((s) => `${s.id} ${rebuilt.diverged.filter((k) => known.get(s.id)!.some((x) => x.id === k.id)).length}`);
    console.log(`Champion ${championOf(actual)}. Pairings rebuilt from seeds, unreached matches per stage: ${byStage.join(", ")}`);

    const starts = config.stages.map((s) => dayStart(Math.min(...known.get(s.id)!.map((k) => k.t))));
    const scale = vrsScaleBefore(starts[0]);
    for (let k = 0; k < config.stages.length; k++) {
        const stage = config.stages[k];
        const lockedBefore = new Map(config.stages.map((s, i) => [s.id, i < k ? known.get(s.id)! : []]));
        const t = starts[k];
        const models: Array<{ name: string; model: SeriesModel; horizon?: number }> = [
            { name: "Elo", model: eloAt(t) },
            { name: "Coin", model: coinFlip },
        ];
        const vrs = scale === null ? null : vrsAt(config, t, scale);
        if (vrs) models.push({ name: "VRS", model: vrs.model });
        if (k === 0 && leadDays > 0) models.push({ name: `Elo −${leadDays}d`, model: eloAt(t - leadDays * DAY, DRIFT_PER_DAY, leadDays), horizon: leadDays });
        if (k === 0 && vrs?.missing.length) console.log(`VRS: no roster for ${vrs.missing.join(", ")} (given the field's lowest points)`);

        for (const { name, model, horizon } of models) {
            const tally = tallyEvent(config, lockedBefore, model, { n, seed, horizon });
            stageRows.push({ major: config.slug, stage: stage.id, model: name, score: scoreStage(config, actual, tally, stage) });
            if (k === 0) eventRows.push({ major: config.slug, model: name, score: scoreEvent(config, actual, tally) });
            if (model instanceof Predictor) for (const team of model.unrated) unrated.add(`${team} (${config.slug})`);
            if (name === "Elo" || name === "VRS")
                for (const m of actual.matches.filter((x) => x.stage === stage.id))
                    seriesRows.push({
                        model: name,
                        bestOf: m.bestOf,
                        f: { p: model.seriesProbability(m.teams[0], m.teams[1], m.bestOf), y: m.winner === 0 ? 1 : 0 },
                        label: `${config.slug} ${stage.id}: ${m.teams[0]} v ${m.teams[1]} (Bo${m.bestOf})`,
                        regions: model instanceof Predictor ? m.teams.map((team) => model.lineageOf(team)?.fineRegion ?? null) : [null, null],
                    });
        }

        const seeds = actual.entrants.get(stage.id)!;
        const rows = external?.majors[config.slug]?.stages[stage.id];
        if (rows) {
            const { tally, buckets } = externalTally(stage, config.stages[k + 1]?.id, seeds, rows);
            const score = scoreStage(config, actual, tally, stage);
            if (!buckets) score.logLoss = NaN;
            if (stage.format === "swiss") Object.assign(score, { pChampion: NaN, championRank: NaN });
            stageRows.push({ major: config.slug, stage: stage.id, model: EXTERNAL, score });
        }

        if (stage.format !== "swiss") continue;
        const truth = stageOutcomes(actual, config, stage);
        for (const { name, model } of models.filter((m) => m.name === "Elo" || m.name === "VRS")) {
            const sets = pickemSets(stage, seeds, (a, b, bo) => model.seriesProbability(a, b, bo), { n: pickemN, seed });
            if (sets) pickemRows.push({ major: config.slug, stage: stage.id, model: name, coin: pickemCorrect(sets.coin, truth), favourites: pickemCorrect(sets.favourites, truth) });
        }
        const picks = external?.majors[config.slug]?.picks?.[stage.id];
        if (picks) {
            const correct = pickemCorrect(picks, truth);
            if (picks.published !== undefined && picks.published !== correct)
                console.log(`${EXTERNAL} ${stage.id}: our scoring gives ${correct} correct, the source reported ${picks.published}. Check the team mapping.`);
            pickemRows.push({ major: config.slug, stage: stage.id, model: EXTERNAL, coin: correct, favourites: NaN });
        }
    }

    const rows = eventRows.filter((r) => r.major === config.slug);
    console.log("\nBefore the event:");
    console.log("| Model | Placement log loss | Champion Brier | P(actual champion) | Champion's rank |");
    console.log("| --- | --- | --- | --- | --- |");
    for (const r of rows) {
        const first = stageRows.find((s) => s.major === config.slug && s.model === r.model && s.stage === config.stages[0].id)!.score;
        console.log(`| ${r.model} | ${f4(r.score.placementLogLoss)} | ${f4(r.score.championBrier)} | ${pct(first.pChampion)} | ${first.championRank} |`);
    }
    console.log("\nAt each stage's start (earlier stages played): stage outcome log loss · P(actual champion)");
    const names = [...new Set(stageRows.filter((s) => s.major === config.slug).map((s) => s.model))];
    console.log(`| Stage | ${names.join(" | ")} |`);
    console.log(`| --- |${names.map(() => " --- |").join("")}`);
    for (const stage of config.stages) {
        const cells = names.map((name) => {
            const s = stageRows.find((r) => r.major === config.slug && r.stage === stage.id && r.model === name)?.score;
            return s ? `${f4(s.logLoss)} · ${pct(s.pChampion)}` : "—";
        });
        console.log(`| ${stage.name} | ${cells.join(" | ")} |`);
    }
}

const pooled = (model: string) => stageRows.filter((r) => r.model === model);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const finite = (xs: number[]) => xs.filter(Number.isFinite);

type Metric = (s: StageScore) => number;
const stageLogLoss: Metric = (s) => s.logLoss;
const advanceLogLoss: Metric = (s) => logLoss(s.advance);

/** Paired per-block difference `a − b` in `metric`, with a 90% interval from resampling (Major, stage) blocks. */
const pairedDiff = (a: string, b: string, metric: Metric = stageLogLoss) => {
    const pairs = pooled(a)
        .map((r) => {
            const other = stageRows.find((x) => x.model === b && x.major === r.major && x.stage === r.stage)?.score;
            return other ? metric(r.score) - metric(other) : NaN;
        })
        .filter(Number.isFinite);
    const rng = makeRng(seed);
    const boots = Array.from({ length: 2000 }, () => mean(pairs.map(() => pairs[Math.floor(rng() * pairs.length)]))).sort((x, y) => x - y);
    return { diff: mean(pairs), lo: boots[100], hi: boots[1899], blocks: pairs.length };
};
const printDiff = (a: string, b: string, metric: Metric, label: string) => {
    const d = pairedDiff(a, b, metric);
    if (d.blocks) console.log(`${a} − ${b}${label}: ${d.diff.toFixed(4)} (90% CI ${d.lo.toFixed(4)}, ${d.hi.toFixed(4)}) over ${d.blocks} blocks`);
};

console.log("\n## All Majors");
console.log("\nStage outcome log loss at each stage's start, mean over (Major, stage) blocks:");
console.log("| Model | Blocks | Log loss | Advance log loss | Advance Brier |");
console.log("| --- | --- | --- | --- | --- |");
for (const model of [...new Set(stageRows.map((r) => r.model))]) {
    const rows = pooled(model);
    const advance = rows.flatMap((r) => r.score.advance);
    const losses = finite(rows.map((r) => r.score.logLoss));
    const blocks = losses.length === rows.length ? `${rows.length}` : `${losses.length} (${rows.length} for advance)`;
    console.log(`| ${model} | ${blocks} | ${f4(mean(losses))} | ${f4(logLoss(advance))} | ${f4(brier(advance))} |`);
}
for (const [a, b] of [
    ["Elo", "Coin"],
    ["Elo", "VRS"],
    ["Elo", EXTERNAL],
    ["VRS", EXTERNAL],
]) {
    printDiff(a, b, stageLogLoss, "");
    if (b === EXTERNAL) printDiff(a, b, advanceLogLoss, " (advance log loss)");
}

/** Slope β of `y ~ β · logit(p)`, clamped to [−5, 5]; 1 is calibrated, below 1 overconfident. */
const slopeOf = (fs: Forecast[]) => {
    const xs = fs.map((f) => Math.log(f.p / (1 - f.p)));
    const gradient = (beta: number) => fs.reduce((g, f, i) => g + (f.y - 1 / (1 + Math.exp(-beta * xs[i]))) * xs[i], 0);
    let [lo, hi] = [-5, 5];
    for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        if (gradient(mid) > 0) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
};
const slopeInterval = (fs: Forecast[]) => {
    const rng = makeRng(seed);
    const boots = Array.from({ length: 1000 }, () => slopeOf(fs.map(() => fs[Math.floor(rng() * fs.length)]))).sort((x, y) => x - y);
    return `${slopeOf(fs).toFixed(2)} (90% CI ${boots[50].toFixed(2)}, ${boots[949].toFixed(2)})`;
};

console.log("\nPlayed Major series, priced at their stage's start:");
console.log("| Model | Best of | Series | Log loss | Slope |");
console.log("| --- | --- | --- | --- | --- |");
for (const model of ["Elo", "VRS"]) {
    for (const [label, keep] of [
        ["all", () => true],
        ["1", (bo: number) => bo === 1],
        ["3+", (bo: number) => bo > 1],
    ] as const) {
        const fs = seriesRows.filter((r) => r.model === model && keep(r.bestOf)).map((r) => r.f);
        if (fs.length) console.log(`| ${model} | ${label} | ${fs.length} | ${f4(logLoss(fs))} | ${slopeInterval(fs)} |`);
    }
}
console.log("\nThe same by Major:");
console.log("| Major | Model | Series | Log loss | Slope |");
console.log("| --- | --- | --- | --- | --- |");
for (const config of configs) {
    for (const model of ["Elo", "VRS"]) {
        const fs = seriesRows.filter((r) => r.model === model && r.label.startsWith(`${config.slug} `)).map((r) => r.f);
        if (fs.length) console.log(`| ${config.slug} | ${model} | ${fs.length} | ${f4(logLoss(fs))} | ${slopeInterval(fs)} |`);
    }
}
console.log("\nElo favourite's series odds against how often the favourite won:");
console.log("| Favourite's odds | n | Mean forecast | Observed |");
console.log("| --- | --- | --- | --- |");
const favourites = seriesRows.filter((r) => r.model === "Elo").map(({ f }) => (f.p >= 0.5 ? f : { p: 1 - f.p, y: (1 - f.y) as 0 | 1 }));
for (const b of calibration(favourites)) {
    if (b.n) console.log(`| ${b.from.toFixed(1)}–${b.to.toFixed(1)} | ${b.n} | ${pct(b.forecast)} | ${pct(b.observed)} |`);
}
const REGIONS = ["Europe", "Americas", "Asia", "Oceania"];
console.log("\nElo on cross-region Major series, by region: actual minus expected series wins (positive = underrated):");
console.log("| Region | Major | Series | Wins − expected | Per series |");
console.log("| --- | --- | --- | --- | --- |");
for (const [r, region] of REGIONS.entries()) {
    for (const major of [...configs.map((c) => c.slug), "all"]) {
        let n = 0;
        let resid = 0;
        for (const row of seriesRows) {
            if (row.model !== "Elo" || (major !== "all" && !row.label.startsWith(`${major} `))) continue;
            const [ra, rb] = row.regions;
            if (ra === null || rb === null || ra === rb || (ra !== r && rb !== r)) continue;
            n++;
            resid += ra === r ? row.f.y - row.f.p : row.f.p - row.f.y;
        }
        if (n) console.log(`| ${region} | ${major} | ${n} | ${resid >= 0 ? "+" : ""}${resid.toFixed(1)} | ${(resid / n).toFixed(3)} |`);
    }
}

console.log("\nElo's 15 costliest series (P is the first team's):");
for (const r of seriesRows
    .filter((r) => r.model === "Elo")
    .sort((a, b) => Math.abs(b.f.y - b.f.p) - Math.abs(a.f.y - a.f.p))
    .slice(0, 15))
    console.log(`- ${r.label}: P ${pct(r.f.p)}, ${r.f.y ? "won" : "lost"}`);

console.log("\nBefore each event:");
console.log("| Model | Majors | Placement log loss | Champion Brier | Mean P(actual champion) | Reach log loss |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const model of [...new Set(eventRows.map((r) => r.model))]) {
    const rows = eventRows.filter((r) => r.model === model);
    const firsts = rows.map((r) => stageRows.find((s) => s.major === r.major && s.model === model && s.stage === configs.find((c) => c.slug === r.major)!.stages[0].id)!.score);
    const reach: Forecast[] = rows.flatMap((r) => r.score.reach);
    console.log(
        `| ${model} | ${rows.length} | ${f4(mean(rows.map((r) => r.score.placementLogLoss)))} | ${f4(mean(rows.map((r) => r.score.championBrier)))} | ${pct(mean(firsts.map((s) => s.pChampion)))} | ${f4(logLoss(reach))} |`
    );
}

console.log("\nPick'em (correct out of 10; a coin upgrade needs 5):");
console.log(`| Major | Stage | Elo coin set | Elo favourites | VRS coin set | ${EXTERNAL} picks |`);
console.log("| --- | --- | --- | --- | --- | --- |");
const pick = (major: string, stage: string, model: string) => pickemRows.find((r) => r.major === major && r.stage === stage && r.model === model);
for (const r of pickemRows.filter((p) => p.model === "Elo")) {
    const v = pick(r.major, r.stage, "VRS");
    const x = pick(r.major, r.stage, EXTERNAL);
    console.log(`| ${r.major} | ${r.stage} | ${r.coin} | ${r.favourites} | ${v ? v.coin : "—"} | ${x ? x.coin : "—"} |`);
}
for (const model of ["Elo", "VRS", EXTERNAL]) {
    const rows = pickemRows.filter((r) => r.model === model);
    if (!rows.length) continue;
    const favourites = model === EXTERNAL ? "" : `; favourites ${mean(rows.map((r) => r.favourites)).toFixed(2)} correct, ${rows.filter((r) => r.favourites >= 5).length}/${rows.length}`;
    const set = model === EXTERNAL ? "published picks" : "coin set";
    console.log(`${model}: ${set} ${mean(rows.map((r) => r.coin)).toFixed(2)} correct, ${rows.filter((r) => r.coin >= 5).length}/${rows.length} stages earn the coin${favourites}`);
}

for (const model of ["Elo", EXTERNAL]) {
    const advance = pooled(model).flatMap((r) => r.score.advance);
    if (!advance.length) continue;
    console.log(`\nCalibration of P(advance from stage) for ${model}, every stage start pooled:`);
    console.log("| Forecast | n | Mean forecast | Observed |");
    console.log("| --- | --- | --- | --- |");
    for (const b of calibration(advance)) {
        if (b.n) console.log(`| ${b.from.toFixed(1)}–${b.to.toFixed(1)} | ${b.n} | ${pct(b.forecast)} | ${pct(b.observed)} |`);
    }
}
const ranks = (xs: number[]) => {
    const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < order.length; ) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
        for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
        i = j + 1;
    }
    return r;
};
const correlation = (xs: number[], ys: number[]) => {
    const mx = mean(xs);
    const my = mean(ys);
    const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    return cov / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
};
const spread = (ps: number[]) => mean(ps.map((p) => Math.abs(p - 0.5)));

/** Per-team P(advance) from two models on the blocks both forecast. */
const headToHead = (a: string, b: string) =>
    pooled(a).flatMap((r) => {
        const other = stageRows.find((x) => x.model === b && x.major === r.major && x.stage === r.stage)?.score;
        if (!other) return [];
        const pOther = new Map(other.entrants.map((t, i) => [t, other.advance[i].p]));
        return [{ major: r.major, stage: r.stage, teams: r.score.entrants.map((team, i) => ({ team, a: r.score.advance[i].p, b: pOther.get(team)!, y: r.score.advance[i].y })) }];
    });

const blocks = headToHead("Elo", EXTERNAL);
if (blocks.length) {
    console.log(`\n## Elo against ${EXTERNAL}: P(advance), or P(title) in playoffs`);
    console.log(`| Block | Rank correlation | Mean gap | Elo spread | ${EXTERNAL} spread | Elo − ${EXTERNAL} advance log loss |`);
    console.log("| --- | --- | --- | --- | --- | --- |");
    for (const { major, stage, teams } of blocks) {
        const as = teams.map((t) => t.a);
        const bs = teams.map((t) => t.b);
        const loss = logLoss(teams.map((t) => ({ p: t.a, y: t.y }))) - logLoss(teams.map((t) => ({ p: t.b, y: t.y })));
        console.log(
            `| ${major} ${stage} | ${correlation(ranks(as), ranks(bs)).toFixed(2)} | ${pct(mean(teams.map((t) => Math.abs(t.a - t.b))))} | ${pct(spread(as))} | ${pct(spread(bs))} | ${loss.toFixed(4)} |`
        );
    }
    const all = blocks.flatMap((b) => b.teams.map((t) => ({ ...t, block: `${b.major} ${b.stage}` })));
    console.log(`\nBiggest disagreements (closer forecast in bold):`);
    for (const t of all.sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b)).slice(0, 15)) {
        const eloCloser = Math.abs(t.a - t.y) < Math.abs(t.b - t.y);
        const [ea, eb] = eloCloser ? [`**${pct(t.a)}**`, pct(t.b)] : [pct(t.a), `**${pct(t.b)}**`];
        console.log(`- ${t.block}: ${t.team}, Elo ${ea}, ${EXTERNAL} ${eb}, ${t.y ? "advanced" : "out"}`);
    }
}

const singapore = "pgl-major-singapore-2026";
const liveRows = external?.majors[singapore]?.stages.stage1;
const live = readJson<{ teams: Array<{ team: string; reach: Record<string, number> }> } | null>(`public/data/sim/events/${singapore}.json`, null);
if (liveRows && live) {
    const elo = new Map(live.teams.map((t) => [t.team, t.reach.stage2]));
    const teams = Object.entries(liveRows).map(([team, r]) => ({ team, b: r[0]! / 100, a: elo.get(team) ?? NaN }));
    console.log(`\n## ${singapore} Stage 1, today's event file against ${EXTERNAL}: P(advance)`);
    console.log(`Rank correlation ${correlation(ranks(teams.map((t) => t.a)), ranks(teams.map((t) => t.b))).toFixed(2)}, mean gap ${pct(mean(teams.map((t) => Math.abs(t.a - t.b))))}`);
    console.log(`| Team | Elo | ${EXTERNAL} | Gap |`);
    console.log("| --- | --- | --- | --- |");
    for (const t of teams.sort((x, y) => y.a - x.a)) console.log(`| ${t.team} | ${pct(t.a)} | ${pct(t.b)} | ${((t.a - t.b) * 100).toFixed(1)} |`);
}

if (unrated.size) console.log(`\nNo Elo lineage (tier 2 mean used): ${[...unrated].join(", ")}`);
