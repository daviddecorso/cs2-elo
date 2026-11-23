import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Roster } from "../src/vrs/types.ts";
import { cohortOf, REGION_INDEX, scoreCohort, type CohortRoster, type CohortScores } from "./lib/sim/hindcast/cohorts.ts";
import { playHindcast } from "./lib/sim/hindcast/hindcastPool.ts";
import { brier, crps, mean, median, quantile, spearman } from "./lib/sim/hindcast/metrics.ts";
import { checkPlanner, simGainKey, type PlannerCheck, type RealizedRow, type SimGains } from "./lib/sim/hindcast/plannerCheck.ts";
import { fitCalibration, SEASON_CALIBRATION } from "./lib/sim/calibration.ts";
import type { Oracle, SeasonSetupOptions } from "./lib/sim/seasonSetup.ts";
import { publishedSnapshotDates, readPublishedSnapshot } from "./lib/vrs/publishedStandings.ts";

/** Season simulations from several past as-of dates, scored at each later published list against persistence and simple baselines; see `docs/vrs-simulator.md`, "Rolling hindcast". */

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const VALVE_ROOT = path.resolve("vendor/counter-strike_regional_standings");
const OUT_DIR = path.resolve(".cache/hindcast");
/** Valve changed its model on 2025-08-05; list pairs before this train nothing. */
const BASELINE_FROM = "2025-09-01";
const MAX_RANK = 150;
const BANDS: Array<[string, number, number]> = [
    ["1-14", 1, 14],
    ["15-80", 15, 80],
    ["81-150", 81, 150],
];
const HEADLINE = "15-80";
/** Invites per region at the Singapore Major (stages 1–3), a proxy for "inside the line" at any date. */
const INVITE_SLOTS: Record<string, number> = { Europe: 18, Americas: 9, Asia: 5 };
const GATE = { medianError: 30, coverage: [0.7, 0.9] as const, spearmanSlack: 0.02 };

const ORACLES: Oracle[] = ["calendar", "attendance", "results", "matches"];
const SETUPS: Record<string, Omit<SeasonSetupOptions, "n" | "seed" | "asOf" | "until">> = {
    full: {},
    projected: { unannounced: false },
    listed: { projections: false },
    "lan-only": { learned: false, scope: "lan" },
};

export interface HindcastRow {
    origin: string;
    date: string;
    horizon: number;
    rosterKey: string;
    teamName: string;
    band: string;
    asOfRank: number;
    truth: number;
    persistence: number;
    decay: number;
    regression: number;
    sim: { p10: number; p50: number; p90: number; mean: number; crps: number };
    invite: { truth: number; sim: number; persistence: number };
}

interface Output {
    label: string;
    setup: string;
    n: number;
    seed: number;
    generatedAt: string;
    origins: Array<{ origin: string; asOf: string; today: string; checkpoints: string[]; events: number; inexact: number; seconds: number }>;
    rows: HindcastRow[];
    /** With `--planner`: attendance odds and event gains against the realized-gain dataset. */
    planner?: PlannerCheck;
}

const REALIZED = path.resolve(".cache/realized-gains.json");

const published = publishedSnapshotDates(VALVE_ROOT, ["invitation"]).sort();
const lists = new Map<string, Roster[]>();
const listAt = (date: string) => {
    let rosters = lists.get(date);
    if (!rosters) lists.set(date, (rosters = readPublishedSnapshot(VALVE_ROOT, date).rosters));
    return rosters;
};
const bandOfRank = (rank: number) => BANDS.find(([, lo, hi]) => rank >= lo && rank <= hi)?.[0] ?? "";
const insideLine = (regionalRank: number, region: number) => (regionalRank > 0 && region >= 0 && regionalRank <= INVITE_SLOTS[REGION_INDEX[region]] ? 1 : 0);

/** Per band and horizon in months, a least-squares line from points at one published list to points `h` lists later, on pairs ending by `before`. */
const fitRegression = (before: string, horizons: number) => {
    const dates = published.filter((d) => d >= BASELINE_FROM && d <= before);
    const fits = new Map<string, { a: number; b: number }>();
    for (let h = 1; h <= horizons; h++) {
        const xs = new Map<string, number[]>();
        const ys = new Map<string, number[]>();
        for (let i = 0; i + h < dates.length; i++) {
            const cohort = cohortOf(listAt(dates[i]), MAX_RANK);
            const later = scoreCohort(cohort, listAt(dates[i + h]));
            cohort.forEach((c, k) => {
                const band = bandOfRank(c.globalRank);
                xs.set(band, [...(xs.get(band) ?? []), c.points]);
                ys.set(band, [...(ys.get(band) ?? []), later.points[k]]);
            });
        }
        for (const [band] of BANDS) {
            const x = xs.get(band) ?? [];
            const y = ys.get(band) ?? [];
            if (x.length < 10) continue;
            const [mx, my] = [mean(x), mean(y)];
            const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
            const b = sxx > 0 ? x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx : 1;
            fits.set(`${band}|${h}`, { a: my - b * mx, b });
        }
    }
    return (band: string, h: number, points: number) => {
        const f = fits.get(`${band}|${h}`);
        return f ? f.a + f.b * points : points;
    };
};

const runOrigin = async (
    origin: string,
    setupName: string,
    oracle: Oracle | undefined,
    value: boolean,
    n: number,
    seed: number,
    months: number,
    workers: number,
    simGains?: SimGains
) => {
    const started = Date.now();
    const asOfDate = published.filter((d) => d <= origin).at(-1);
    if (!asOfDate) throw new Error(`No published list on or before ${origin}`);
    const later = published.filter((d) => d > origin);
    const until = later[Math.min(months, later.length) - 1];
    if (!until) throw new Error(`No published list after ${origin} to score against`);
    const cohort: CohortRoster[] = cohortOf(listAt(asOfDate), MAX_RANK);
    let shown = 0;
    const played = await playHindcast(
        {
            setup: { n, seed, asOf: origin, until, value, ...SETUPS[setupName], ...(oracle ? { oracle } : {}) },
            cohort: cohort.map((c) => ({ players: c.players })),
            gains: simGains !== undefined,
        },
        n,
        workers,
        (done) => {
            if (done * 10 >= (shown + 1) * n) {
                shown = Math.floor((done * 10) / n);
                process.stdout.write(`  ${origin}: ${done}/${n} runs\r`);
            }
        }
    );
    if (simGains) {
        for (const run of played.gains) {
            for (const g of run) {
                const key = simGainKey(origin, played.info.checkpoints[g.c], g.i, g.eventId);
                const s = simGains.get(key) ?? { runs: 0, gain: 0 };
                s.runs++;
                s.gain += g.gain;
                simGains.set(key, s);
            }
        }
    }
    const regression = fitRegression(origin, played.info.checkpoints.length);
    const rows: HindcastRow[] = [];
    played.info.checkpoints.forEach((date, c) => {
        if (!published.includes(date)) return;
        const truth: CohortScores = scoreCohort(cohort, listAt(date));
        cohort.forEach((team, i) => {
            const samples = played.runs.map((r) => r[c].points[i]).sort((a, b) => a - b);
            const band = bandOfRank(team.globalRank);
            rows.push({
                origin,
                date,
                horizon: c + 1,
                rosterKey: team.rosterKey,
                teamName: team.teamName,
                band,
                asOfRank: team.globalRank,
                truth: truth.points[i],
                persistence: team.points,
                decay: played.decay[c].points[i],
                regression: regression(band, c + 1, team.points),
                sim: {
                    p10: quantile(samples, 0.1),
                    p50: quantile(samples, 0.5),
                    p90: quantile(samples, 0.9),
                    mean: mean(samples),
                    crps: crps(samples, truth.points[i]),
                },
                invite: {
                    truth: insideLine(truth.regionalRanks[i], truth.regions[i]),
                    sim: mean(played.runs.map((r) => insideLine(r[c].regionalRanks[i], r[c].regions[i]))),
                    persistence: insideLine(team.regionalRank, REGION_INDEX.indexOf(team.region)),
                },
            });
        });
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`  ${origin}: as-of ${played.info.asOf} (list ${played.info.today}), ${played.info.events} events, ${n} runs, ${played.inexact} inexact reruns, ${seconds} s\n`);
    return { meta: { origin, ...played.info, inexact: played.inexact, seconds }, rows, cohort };
};

interface Summary {
    n: number;
    spearman: Record<"sim" | "persistence" | "decay" | "regression", number>;
    mae: Record<"sim" | "persistence" | "decay" | "regression", number>;
    medianError: Record<"sim" | "persistence", number>;
    crps: Record<"sim" | "persistence" | "decay" | "regression", number>;
    coverage: number;
    invite: { sim: number; persistence: number; base: number };
}

const summarize = (rows: HindcastRow[]): Summary => {
    const byOrigin = new Map<string, HindcastRow[]>();
    for (const r of rows) byOrigin.set(`${r.origin}|${r.date}`, [...(byOrigin.get(`${r.origin}|${r.date}`) ?? []), r]);
    const rho = (f: (r: HindcastRow) => number) => mean([...byOrigin.values()].filter((g) => g.length > 2).map((g) => spearman(g.map(f), g.map((r) => r.truth))));
    const abs = (f: (r: HindcastRow) => number) => mean(rows.map((r) => Math.abs(f(r) - r.truth)));
    const y = rows.map((r) => r.invite.truth);
    const base = mean(y);
    return {
        n: rows.length,
        spearman: { sim: rho((r) => r.sim.p50), persistence: rho((r) => r.persistence), decay: rho((r) => r.decay), regression: rho((r) => r.regression) },
        mae: { sim: abs((r) => r.sim.p50), persistence: abs((r) => r.persistence), decay: abs((r) => r.decay), regression: abs((r) => r.regression) },
        medianError: { sim: median(rows.map((r) => r.sim.p50 - r.truth)), persistence: median(rows.map((r) => r.persistence - r.truth)) },
        crps: { sim: mean(rows.map((r) => r.sim.crps)), persistence: abs((r) => r.persistence), decay: abs((r) => r.decay), regression: abs((r) => r.regression) },
        coverage: mean(rows.map((r) => Number(r.sim.p10 <= r.truth && r.truth <= r.sim.p90))),
        invite: { sim: brier(rows.map((r) => r.invite.sim), y), persistence: brier(rows.map((r) => r.invite.persistence), y), base: base * (1 - base) },
    };
};

const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "–");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "–");

const printTable = (title: string, groups: Array<[string, HindcastRow[]]>) => {
    console.log(`\n${title}`);
    console.log("  group                 n | Spearman sim/pers/decay/reg | MAE sim/pers/decay/reg | med err sim/pers | CRPS sim/pers | skill | cover | invite Brier sim/pers/base");
    for (const [name, rows] of groups) {
        if (rows.length === 0) continue;
        const s = summarize(rows);
        console.log(
            `  ${name.padEnd(18)} ${String(s.n).padStart(4)} | ${[s.spearman.sim, s.spearman.persistence, s.spearman.decay, s.spearman.regression].map(f2).join(" / ")} | ` +
                `${[s.mae.sim, s.mae.persistence, s.mae.decay, s.mae.regression].map(f0).join(" / ")} | ${f0(s.medianError.sim)} / ${f0(s.medianError.persistence)} | ` +
                `${f0(s.crps.sim)} / ${f0(s.crps.persistence)} | ${f2(1 - s.crps.sim / s.crps.persistence)} | ${f2(s.coverage)} | ` +
                `${[s.invite.sim, s.invite.persistence, s.invite.base].map(f3).join(" / ")}`
        );
    }
};

const report = (out: Output) => {
    const headline = out.rows.filter((r) => r.band === HEADLINE);
    const horizons = [...new Set(out.rows.map((r) => r.horizon))].sort((a, b) => a - b);
    printTable(
        `Ranks ${HEADLINE} at as-of, by origin and horizon (${out.setup}, ${out.n} runs):`,
        out.origins.flatMap((o) => horizons.map((h): [string, HindcastRow[]] => [`${o.origin} +${h}m`, headline.filter((r) => r.origin === o.origin && r.horizon === h)]))
    );
    printTable(
        "Pooled over origins, by horizon and band:",
        BANDS.flatMap(([band]) => horizons.map((h): [string, HindcastRow[]] => [`${band} +${h}m`, out.rows.filter((r) => r.band === band && r.horizon === h)]))
    );
    printTable(
        "Pooled over origins and horizons:",
        BANDS.map(([band]): [string, HindcastRow[]] => [band, out.rows.filter((r) => r.band === band)])
    );

    const all = summarize(headline);
    const perHorizon = horizons.map((h) => summarize(headline.filter((r) => r.horizon === h)));
    const checks: Array<[string, boolean]> = [
        ["CRPS below persistence overall", all.crps.sim < all.crps.persistence],
        ["CRPS below persistence at every horizon", perHorizon.every((s) => s.crps.sim < s.crps.persistence)],
        ["MAE no worse than persistence", all.mae.sim <= all.mae.persistence],
        [`Spearman at least persistence − ${GATE.spearmanSlack}`, all.spearman.sim >= all.spearman.persistence - GATE.spearmanSlack],
        [`|median error| ≤ ${GATE.medianError}`, Math.abs(all.medianError.sim) <= GATE.medianError],
        [`${GATE.coverage[0] * 100}–${GATE.coverage[1] * 100}% inside p10–p90`, all.coverage >= GATE.coverage[0] && all.coverage <= GATE.coverage[1]],
        ["invite Brier below persistence", all.invite.sim < all.invite.persistence],
    ];
    const pass = checks.every(([, ok]) => ok);
    console.log(`\nGate on ranks ${HEADLINE}: ${pass ? "PASS" : "FAIL"} (${checks.map(([label, ok]) => `${label} ${ok ? "✓" : "✗"}`).join(", ")}).`);
    if (out.planner) {
        const { attendance: a, gain: g } = out.planner;
        console.log(`\nPlanner inputs against real seasons, every cohort roster × real event the runs simulated:`);
        console.log(
            `  Attendance: ${a.pairs} pairs, ${a.attended} really attended; Brier ${f3(a.brier)} (base rate ${f3(a.base)}), log loss ${f3(a.logLoss)}; mean odds ${f3(a.meanAttended)} for teams that went, ${f3(a.meanOthers)} for the rest.`
        );
        console.log(
            `  Gain where the team went and played it in 5+ runs: ${g.pairs} pairs, mean predicted ${f0(g.predicted)} vs realized ${f0(g.realized)}; slope of realized on predicted ${f2(g.slope)} (LAN ${f2(g.lan.slope)}, n ${g.lan.pairs}; online ${f2(g.online.slope)}, n ${g.online.pairs}); correlation ${f2(g.correlation)}.`
        );
    }
    return pass;
};

/** Paired CRPS difference (b − a) on shared rows, with a bootstrap over rosters, which repeat across origins and horizons. */
const compare = (a: Output, b: Output) => {
    const key = (r: HindcastRow) => `${r.origin}|${r.date}|${r.rosterKey}`;
    const before = new Map(a.rows.map((r) => [key(r), r]));
    const pairs = b.rows.flatMap((r) => (before.has(key(r)) ? [{ band: r.band, horizon: r.horizon, roster: r.rosterKey, d: r.sim.crps - before.get(key(r))!.sim.crps }] : []));
    console.log(`Paired CRPS, ${b.label} − ${a.label} (negative is better), bootstrap over rosters:`);
    for (const [band] of BANDS) {
        const rows = pairs.filter((p) => p.band === band);
        if (rows.length === 0) continue;
        const byRoster = new Map<string, number[]>();
        for (const p of rows) byRoster.set(p.roster, [...(byRoster.get(p.roster) ?? []), p.d]);
        const groups = [...byRoster.values()];
        let state = 12345;
        const rand = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
        const boot: number[] = [];
        for (let k = 0; k < 2000; k++) {
            const pick = groups.map(() => groups[Math.floor(rand() * groups.length)]).flat();
            boot.push(mean(pick));
        }
        boot.sort((x, y) => x - y);
        console.log(`  ${band.padEnd(7)} n ${String(rows.length).padStart(4)}: ${f2(mean(rows.map((p) => p.d)))} (95% ${f2(quantile(boot, 0.025))} to ${f2(quantile(boot, 0.975))})`);
    }
};

const main = async () => {
    if (args[0] === "--compare") {
        const [a, b] = [args[1], args[2]].map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as Output);
        compare(a, b);
        return;
    }
    if (args[0] === "--calibrate") {
        const run = JSON.parse(fs.readFileSync(args[1], "utf8")) as Output;
        const cal = fitCalibration(run.rows, BANDS, run.label);
        fs.mkdirSync(path.dirname(SEASON_CALIBRATION), { recursive: true });
        fs.writeFileSync(SEASON_CALIBRATION, `${JSON.stringify(cal, null, 2)}\n`);
        console.log(`Wrote ${SEASON_CALIBRATION} from ${run.label} (${run.rows.length} rows):`);
        for (const b of cal.bands) console.log(`  ${b.band.padEnd(7)} λ ${b.lambda.join(" / ")}, widen ${b.widen.join(" / ")}`);
        console.log(`  invites: ${cal.invite.a} + ${cal.invite.b} × share`);
        return;
    }
    if (args.includes("--report")) {
        const out = JSON.parse(fs.readFileSync(option("report", ""), "utf8")) as Output;
        if (!report(out)) process.exitCode = 1;
        return;
    }
    const origins = option("origins", "2026-06-01,2026-07-06,2026-08-03,2026-09-07,2026-10-05").split(",");
    const setupName = option("setup", "full");
    if (!SETUPS[setupName]) throw new Error(`Unknown setup ${setupName}; one of ${Object.keys(SETUPS).join(", ")}`);
    const n = Number(option("n", "40"));
    const seed = Number(option("seed", "1"));
    const months = Number(option("months", "4"));
    const workers = Number(option("workers", String(Math.max(1, Math.min(4, Math.floor(os.totalmem() / 3e9) - 1)))));
    const oracle = (option("oracle", "") || undefined) as Oracle | undefined;
    if (oracle && !ORACLES.includes(oracle)) throw new Error(`Unknown oracle ${oracle}; one of ${ORACLES.join(", ")}`);
    const value = option("value", "on") !== "off";
    const name = [setupName, ...(oracle ? [`oracle ${oracle}`] : []), ...(value ? [] : ["value off"])].join(", ");
    const label = option("label", [setupName, ...(oracle ? [oracle] : []), ...(value ? [] : ["novalue"])].join("-"));
    console.log(`Rolling hindcast (${name}): ${origins.length} origins, up to ${months} months ahead, ${n} runs each, ${workers} workers.`);
    const planner = args.includes("--planner");
    if (planner && !fs.existsSync(REALIZED)) throw new Error(`--planner needs ${REALIZED}; run npm run realized-gains first`);
    const simGains: SimGains | undefined = planner ? new Map() : undefined;
    const checked: Parameters<typeof checkPlanner>[0] = [];
    const out: Output = { label, setup: name, n, seed, generatedAt: new Date().toISOString(), origins: [], rows: [] };
    for (const origin of origins) {
        const { meta, rows, cohort } = await runOrigin(origin, setupName, oracle, value, n, seed, months, workers, simGains);
        out.origins.push(meta);
        out.rows.push(...rows);
        checked.push({ origin, dates: meta.checkpoints.filter((d) => published.includes(d)), cohort: cohort.map((c) => ({ players: c.players })), n });
    }
    if (simGains) out.planner = checkPlanner(checked, simGains, JSON.parse(fs.readFileSync(REALIZED, "utf8")) as RealizedRow[]);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${label}.json`);
    fs.writeFileSync(file, JSON.stringify(out));
    console.log(`Wrote ${file}.`);
    if (!report(out)) process.exitCode = 1;
};

await main();
