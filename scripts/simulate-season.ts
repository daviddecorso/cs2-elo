import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { popcount } from "../src/sim/schedule.ts";
import type {
    ErrorStats,
    FieldSource,
    RecommendedSchedule,
    ScheduleSummary,
    SeasonEvent,
    SeasonImpact,
    SeasonIndex,
    SeasonOptimizerStats,
    SeasonRoster,
    SeasonScheduleEntry,
    SeasonStandings,
    SeasonTeamSchedule,
} from "../src/sim/types.ts";
import { addDays } from "./lib/liquipedia/rawStore.ts";
import { BAND_LABELS, bandOf } from "./lib/sim/fieldModel.ts";
import { CATEGORIES } from "./lib/sim/history.ts";
import { feedersFor, MAX_UNIVERSE, MIN_REACH, pickSchedules, summarize, VOLUMES, type RescoreJob, type Summary } from "./lib/sim/optimizer.ts";
import { range, type EventTally } from "./lib/sim/season.ts";
import { playSeason } from "./lib/sim/seasonPool.ts";
import { loadSeasonSetup, type CalendarEntry } from "./lib/sim/seasonSetup.ts";
import { saveJson } from "./lib/writeJson.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const n = Number(option("season-n", "300"));
const seed = Number(option("seed", "1"));
/** Each worker, and the main thread, holds a loaded setup of about 2 GB; past the machine's memory they swap and get slower. */
const SETUP_BYTES = 3e9;
const workers = Number(
    option("workers", String(Math.max(1, Math.min(os.availableParallelism() - 1, 8, Math.floor(os.totalmem() / SETUP_BYTES) - 1))))
);
const rescoreN = Math.min(n, Number(option("rescore-n", "30")));
const impactCheckN = Math.min(n, Number(option("impact-check-n", "20")));
const OUT_DIR = path.resolve(option("out", "public/data/sim/season"));
const TEAMS_DIR = "teams";
const IMPACT_DIR = "impact";
const MIN_IMPACT_RUNS = 20;
const SIZE_BUDGET = 1_000_000;
/** Rosters published: those at or above this global rank today or at p50 at any checkpoint. */
const TOP = 60;
const MIN_ATTEND = 0.01;
/** Most likely attendees published per tier 1 event, and per other event. */
const FIELD_ROWS = 24;
const FIELD_ROWS_LOWER = 10;
/** Liquipedia lists online events only weeks ahead, so simulated activity is compared with habit over this many days. */
const ACTIVITY_CHECK_DAYS = 30;

const started = Date.now();
const setup = loadSeasonSetup({ n, seed });
const { input, calendar, asOf, target, today } = setup;
const opt = setup.optimizer.opt;
const checkpoints = input.checkpoints.map((c) => c.date);
console.log(
    `Season ${asOf} → ${target.snapshotDate} (${target.name}): ${input.events.length} of ${calendar.length} events simulated (${setup.unranked.length} unranked teams drawable, ${setup.blocked.size} kept out to avoid relinks), checkpoints ${checkpoints.join(", ")}; loaded in ${((Date.now() - started) / 1000).toFixed(1)} s.`
);
if (setup.unmatchedRosters.length) console.warn(`No team page for ${setup.unmatchedRosters.length} top-80 rosters: ${setup.unmatchedRosters.join(", ")}`);
console.log(
    `Optimizer: ${opt.teams.length} teams, ${opt.teams.reduce((s, t) => s + t.masks.length, 0)} subsets in all (most ${Math.max(0, ...opt.teams.map((t) => t.masks.length))} for one team), caps ${opt.caps.low} / ${opt.caps.average} / ${opt.caps.high}.`
);

const runStarted = Date.now();
const played = await playSeason(setup, { n, seed, rescoreN, impactCheckN, workers }, (done) => {
    if (done % 50 === 0) console.log(`  ${done}/${n} (${Math.round((Date.now() - runStarted) / 1000)} s)`);
});
const seasonSeconds = (Date.now() - runStarted) / 1000;
const tally = played.season;
const scores = played.optimizer;
console.log(`${n} runs on ${Math.min(workers, n)} worker(s) in ${seasonSeconds.toFixed(1)} s; ${tally.inexact} inexact reruns fell back to a full run.`);
for (const [reason, count] of [...tally.inexactReasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${count}× ${reason}`);
console.log(
    `  ${scores.scores.toLocaleString("en-US")} one-team scores, ${scores.replays} replays (${scores.skippedReplays} skipped), ${scores.pathReplays} qualifier replays,${scores.inexactTargets} inexact targets, ${scores.missingRosters} team-runs without a roster.`
);

// --- Activity check: events per team in the next ACTIVITY_CHECK_DAYS, simulated vs habit, by rank band

if (input.fields) {
    const population = [...input.listEntries(today.rosters), ...setup.unranked].filter((e) => input.fields!.drawable.has(e.team));
    // The first window is mostly listed events; the later one leans on projected editions.
    for (const offset of [0, 2 * ACTIVITY_CHECK_DAYS]) {
        const from = addDays(asOf, offset);
        const to = addDays(from, ACTIVITY_CHECK_DAYS);
        const simulated = new Map<string, number>();
        for (const e of input.events.filter((e) => e.config.startDate > from && e.config.startDate <= to)) {
            for (const [team, s] of tally.events.get(e.config.slug)?.teams ?? []) simulated.set(team, (simulated.get(team) ?? 0) + s.attend / tally.n);
        }
        const rows = BAND_LABELS.map((label, band) => {
            const teams = population.filter((e) => bandOf(e.globalRank) === band);
            const habit = teams.reduce((s, e) => {
                const r = input.fields!.activity.rates(input.teamIdOf(e.team));
                return s + CATEGORIES.reduce((t, c) => t + r[c], 0) * ACTIVITY_CHECK_DAYS;
            }, 0);
            const sim = teams.reduce((s, e) => s + (simulated.get(e.team) ?? 0), 0);
            return `${label} ${teams.length} teams ${(sim / Math.max(1, teams.length)).toFixed(2)}/${(habit / Math.max(1, teams.length)).toFixed(2)} (${habit > 0 ? (sim / habit).toFixed(2) : "–"})`;
        });
        console.log(`Activity, events per team in ${from}…${to}, simulated/habit: ${rows.join("; ")}`);
    }
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const share = (k: number) => Math.round((k / tally.n) * 1000) / 1000;

const fieldOf = (entry: CalendarEntry, t: EventTally | undefined): SeasonEvent["field"] => {
    if (!entry.season || !t) return entry.catalog.announced.map((team) => ({ team, attend: 1, source: "announced" as const, win: null }));
    return [...t.teams]
        .map(([team, s]) => ({
            team,
            // The page shows whole percents, so two decimals keep the index under budget.
            attend: Math.round((s.attend / tally.n) * 100) / 100,
            source: [...s.sources].sort((a, b) => b[1] - a[1])[0][0] as FieldSource,
            win: Math.round(((s.placements.get("1") ?? 0) / tally.n) * 100) / 100,
        }))
        .filter((f) => f.attend >= MIN_ATTEND)
        .sort((a, b) => b.attend - a.attend || (b.win ?? 0) - (a.win ?? 0))
        .slice(0, entry.catalog.tier === 1 ? FIELD_ROWS : FIELD_ROWS_LOWER);
};

const feedersOf = new Map<string, typeof input.events>();
for (const e of input.events) if (e.feeds) feedersOf.set(e.feeds.slug, [...(feedersOf.get(e.feeds.slug) ?? []), e]);
const unannounced = new Map<string, number>();
for (const e of input.events) if (e.unannounced) unannounced.set(e.category, (unannounced.get(e.category) ?? 0) + (e.chance ?? 1));
const events: SeasonEvent[] = calendar.filter((entry) => !entry.catalog.unannounced).map((entry) => {
    const { catalog } = entry;
    const c = catalog.config;
    const t = tally.events.get(c.slug);
    return {
        slug: c.slug,
        name: c.name,
        liquipedia: c.liquipedia,
        startDate: c.startDate,
        endDate: c.endDate,
        location: c.location ?? null,
        tier: catalog.tier,
        prizePool: Math.round(catalog.prizePool),
        prizeSource: catalog.prizeSource,
        generic: catalog.generic,
        kind: catalog.kind,
        ...(catalog.projection
            ? {
                  projection: {
                      editions: catalog.projection.editions,
                      gapDays: catalog.projection.gapDays,
                      lastPage: catalog.projection.lastPage,
                      lastStart: catalog.projection.lastStart,
                      chance: round3(catalog.projection.chance),
                  },
              }
            : {}),
        assumed: c.assumed ?? [],
        simulated: !!entry.season,
        ...(entry.reason ? { reason: entry.reason } : {}),
        shortRuns: t?.shortRuns ?? 0,
        field: fieldOf(entry, t),
        ...(feedersOf.has(c.slug) ? { fedBy: feedersOf.get(c.slug)!.map((e) => ({ slug: e.config.slug, name: e.config.name, slots: e.feeds!.count })) } : {}),
    };
});

const linkedRows = [...feedersOf].map(([slug, feeders]) => {
    const t = tally.events.get(slug);
    const played = t ? t.runs - t.shortRuns : 0;
    const slots = feeders.reduce((s, e) => s + e.feeds!.count, 0);
    return `${slug} ${played > 0 ? (t!.linked / (played * slots)).toFixed(2) : "–"} of ${slots}`;
});
if (linkedRows.length) console.log(`Linked qualifier places filled by feeders' finishers (rest drawn): ${linkedRows.join("; ")}`);

const todayByKey = new Map(today.rosters.map((r) => [r.rosterKey, r]));
const keys = new Set(today.rosters.filter((r) => r.globalRank !== null && r.globalRank <= TOP).map((r) => r.rosterKey));
for (const cp of tally.standings) {
    for (const [key, t] of cp) {
        const p50 = range(t.globalRanks, tally.n, Infinity).p50;
        if (p50 !== null && p50 <= TOP) keys.add(key);
    }
}
const rosters: SeasonRoster[] = [...keys]
    .map((rosterKey): SeasonRoster => {
        const seen = [...tally.standings].reverse().map((cp) => cp.get(rosterKey)).find(Boolean);
        const now = todayByKey.get(rosterKey);
        return {
            rosterKey,
            teamName: seen?.teamName ?? now!.teamName,
            region: seen?.region ?? now!.region,
            players: seen?.players ?? now!.players,
            today: now ? { points: round1(now.points), globalRank: now.globalRank, regionalRank: now.regionalRank } : null,
            checkpoints: tally.standings.map((cp) => {
                const t = cp.get(rosterKey);
                return {
                    points: range(t?.points ?? [], tally.n, 0, round1),
                    globalRank: range(t?.globalRanks ?? [], tally.n, Infinity),
                    regionalRank: range(t?.regionalRanks ?? [], tally.n, Infinity),
                    ranked: share(t?.globalRanks.length ?? 0),
                };
            }),
        };
    })
    .sort((a, b) => (a.checkpoints.at(-1)!.globalRank.p50 ?? Infinity) - (b.checkpoints.at(-1)!.globalRank.p50 ?? Infinity) || (b.today?.points ?? 0) - (a.today?.points ?? 0));

// --- Schedule optimizer: pick from one-team scores, then re-score the picks with exact reruns

const picks = opt.teams.map((_, k) => pickSchedules(scores, opt, input, k));
const jobs: RescoreJob[] = picks.flatMap((pick, k) =>
    pick.recommended.flatMap((rec) => pick.runs.filter((run) => run < rescoreN).map((run) => ({ run, team: k, mask: rec.m })))
);
const rescoreStarted = Date.now();
console.log(`Re-scoring ${jobs.length} (team, schedule, run) jobs with exact reruns...`);
const results = await played.rescore(jobs);
await played.close();
const rescoreSeconds = (Date.now() - rescoreStarted) / 1000;
const inexactRescores = results.filter((r) => r.inexact).length;
console.log(`  done in ${rescoreSeconds.toFixed(1)} s; ${inexactRescores} inexact reruns fell back to a full run.`);

const exactByPick = new Map<string, typeof results>();
for (const r of results) {
    const key = `${r.team}|${r.mask}`;
    exactByPick.set(key, [...(exactByPick.get(key) ?? []), r]);
}
const exactSummary = (rows: typeof results): Summary => {
    const sorted = rows.map((r) => r.points).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    const known = rows.filter((r) => scores.slotsKnown[r.run]);
    return {
        mean: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
        p10: at(0.1),
        p90: at(0.9),
        invite: known.length === 0 ? null : known.filter((r) => r.invited).length / known.length,
    };
};
const rounded = (s: Summary): ScheduleSummary => ({ mean: round1(s.mean), p10: round1(s.p10), p90: round1(s.p90), invite: s.invite === null ? null : round3(s.invite) });
const errorStats = (values: number[]): ErrorStats => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
        n: sorted.length,
        mean: round3(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
        p95: round3(sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0),
        max: round3(sorted.at(-1) ?? 0),
    };
};

const generatedAt = new Date().toISOString();
const estimateErrors: number[] = [];
const regrets: number[] = [];
const fileOf = (team: string) => `${team.replace(/ /g, "_").replace(/[/\\]/g, "-")}.json`;
const teamFiles: Array<[string, SeasonTeamSchedule]> = [];
const schedules: SeasonScheduleEntry[] = [];

opt.teams.forEach((team, k) => {
    const pick = picks[k];
    const t = scores.teams[k];
    if (pick.runs.length === 0) return;
    const seen = pick.runs.length;
    const eventAt = (u: number) => input.events[team.universe[u]].config;
    const remap = (universeMask: number) => pick.candidates.reduce((m, u, i) => ((universeMask >> u) & 1 ? m | (1 << i) : m), 0);
    const announcedSlugs = pick.candidates.filter((u) => team.announced.has(eventAt(u).slug)).map((u) => eventAt(u).slug);

    const rescoredRuns = pick.runs.filter((run) => run < rescoreN);
    const recommended: RecommendedSchedule[] = pick.recommended.map((rec) => {
        const rows = exactByPick.get(`${k}|${rec.m}`) ?? [];
        const exact = exactSummary(rows);
        if (rows.length) estimateErrors.push(Math.abs(exact.mean - summarize(scores, k, rec.m, rows.map((r) => r.run)).mean));
        const estimate = pick.subsets.find((s) => s.m === rec.m)!.summary;
        const mask = team.masks[rec.m];
        const chosen = new Set(pick.candidates.filter((u) => (mask >> u) & 1).map((u) => eventAt(u).slug));
        return {
            volumes: rec.volumes,
            goals: rec.goals,
            mask: remap(mask),
            dropsAnnounced: announcedSlugs.filter((s) => !chosen.has(s)),
            exact: rounded(exact),
            estimate: rounded(estimate),
        };
    });
    for (const volume of VOLUMES) {
        const cap = opt.caps[volume] - team.committed.length;
        const chosen = pick.recommended.find((rec) => rec.volumes.includes(volume) && rec.goals.includes("points"));
        if (!chosen) continue;
        const exactMean = (m: number) => exactSummary(exactByPick.get(`${k}|${m}`) ?? []).mean;
        const best = Math.max(...pick.recommended.filter((rec) => popcount(team.masks[rec.m]) <= cap).map((rec) => exactMean(rec.m)));
        regrets.push(best - exactMean(chosen.m));
    }

    const file = fileOf(team.team);
    schedules.push({ team: team.team, teamName: team.teamName, rosterKey: team.rosterKey, region: team.region, file });
    teamFiles.push([
        file,
        {
            generatedAt,
            team: team.team,
            teamName: team.teamName,
            rosterKey: team.rosterKey,
            region: team.region,
            asOf,
            target: { slug: target.slug, name: target.name, date: target.snapshotDate, estimated: target.snapshotEstimated },
            n: tally.n,
            rescoreN,
            volume: setup.volume,
            committed: team.committed.map((slug) => ({ slug, name: input.events.find((e) => e.config.slug === slug)!.config.name })),
            candidates: pick.candidates.map((u) => {
                const e = input.events[team.universe[u]];
                const c = e.config;
                const entry = calendar.find((x) => x.season === e)!.catalog;
                return {
                    slug: c.slug,
                    name: c.name,
                    startDate: c.startDate,
                    endDate: c.endDate,
                    region: c.location?.region ?? null,
                    announced: team.announced.has(c.slug),
                    reach: round3(t.reach[u] / seen),
                    attend: round3(t.attended[u] / seen),
                    generic: entry.generic,
                    ...(entry.projection ? { projected: round3(entry.projection.chance) } : {}),
                    assumedInvite: t.viaOpen[u] * 2 > t.reach[u],
                };
            }),
            requiresQualifying: [
                ...pick.requiresQualifying
                    .filter((u) => !pick.paths.some((p) => team.paths[p.p] === team.universe[u]))
                    .map((u) => {
                        const c = eventAt(u);
                        return { slug: c.slug, name: c.name, startDate: c.startDate, endDate: c.endDate, reach: round3(t.reach[u] / seen) };
                    }),
                ...pick.paths.map(({ p, entered, qualified }) => {
                    const c = input.events[team.paths[p]].config;
                    const via = feedersFor(input.events, c.slug, team.region).map((e) => ({ slug: e.config.slug, name: e.config.name }));
                    return { slug: c.slug, name: c.name, startDate: c.startDate, endDate: c.endDate, reach: round3(entered), via, qualified: round3(qualified) };
                }),
            ],
            rules: rounded(summarize(scores, k, "rules", rescoredRuns)),
            recommended,
            // Whole points and invite shares to 0.01: the one-team estimate is off by about 3 points, and this keeps the output under budget.
            subsets: pick.subsets.map(({ m, summary: s }) => [
                remap(team.masks[m]),
                Math.round(s.mean),
                Math.round(s.p10),
                Math.round(s.p90),
                s.invite === null ? null : Math.round(s.invite * 100) / 100,
            ]),
        },
    ]);
});

const optimizer: SeasonOptimizerStats = {
    teams: teamFiles.length,
    universeCap: MAX_UNIVERSE,
    minReach: MIN_REACH,
    rescoreN,
    estimateError: errorStats(estimateErrors),
    regret: errorStats(regrets),
    inexactTargets: scores.inexactTargets,
    inexactRescores,
    replays: scores.replays,
    skippedReplays: scores.skippedReplays,
    pathReplays: scores.pathReplays,
    missingRosters: scores.missingRosters,
    scores: scores.scores,
    seconds: { season: Math.round(seasonSeconds), rescore: Math.round(rescoreSeconds) },
};
console.log(
    `Optimizer: estimate error mean ${optimizer.estimateError.mean}, p95 ${optimizer.estimateError.p95} (n ${optimizer.estimateError.n}); regret mean ${optimizer.regret.mean}, max ${optimizer.regret.max}.`
);

// --- Event impact

const impactCheck = errorStats(tally.impactErrors);
const placementOrder = (a: string, b: string) => Number(/^\d+/.exec(a)?.[0] ?? 99) - Number(/^\d+/.exec(b)?.[0] ?? 99);
const impactFiles: Array<[string, SeasonImpact]> = input.events.flatMap((e): Array<[string, SeasonImpact]> => {
    const c = e.config;
    const byTeam = tally.impact.get(c.slug);
    const checkpoint = checkpoints.find((d) => d > c.endDate);
    if (!byTeam || !checkpoint) return [];
    const teams = [...byTeam]
        .map(([team, byPlacement]) => {
            const cells = [...byPlacement].sort((a, b) => placementOrder(a[0], b[0]));
            const runs = cells.reduce((s, [, x]) => s + x.count, 0);
            return {
                team,
                attend: share(tally.events.get(c.slug)?.teams.get(team)?.attend ?? 0),
                expected: round1(cells.reduce((s, [, x]) => s + x.sumDelta, 0) / runs),
                placements: cells.map(([placement, x]) => ({
                    placement,
                    p: round3(x.count / runs),
                    runs: x.count,
                    delta: round1(x.sumDelta / x.count),
                    start: round1(x.sumStart / x.count),
                    h2h: round1((x.sumDelta - x.sumStart) / x.count),
                })),
            };
        })
        .filter((t) => t.attend >= MIN_ATTEND)
        .sort((a, b) => b.attend - a.attend || b.expected - a.expected);
    return [
        [
            `${c.slug}.json`,
            { generatedAt, asOf, slug: c.slug, name: c.name, liquipedia: c.liquipedia, checkpoint, n: tally.n, minRuns: MIN_IMPACT_RUNS, check: impactCheck, teams },
        ],
    ];
});
console.log(`Impact: ${impactFiles.length} events; check error mean ${impactCheck.mean}, p95 ${impactCheck.p95} (n ${impactCheck.n}); ${tally.impactFullLoads} checkpoints loaded in full after an inexact rerun.`);

const index: SeasonIndex = {
    generatedAt,
    asOf,
    target: { slug: target.slug, name: target.name, date: target.snapshotDate, estimated: target.snapshotEstimated },
    n: tally.n,
    seed,
    checkpoints,
    inexactReruns: tally.inexact,
    volume: setup.volume,
    unmatchedRosters: setup.unmatchedRosters,
    events,
    unannounced: [...unannounced].map(([category, expected]) => ({ category, expected: round1(expected) })),
    optimizer,
    schedules,
    impact: {
        events: impactFiles.map(([, f]) => ({ slug: f.slug, checkpoint: f.checkpoint })),
        check: impactCheck,
        fullLoads: tally.impactFullLoads,
    },
};
const standings: SeasonStandings = { generatedAt, asOf, todayDate: today.snapshotDate, n: tally.n, checkpoints, rosters };

const files: Array<[string, string, string]> = [
    ["index.json", JSON.stringify(index), `${events.length} events, ${input.events.length} simulated, ${schedules.length} team schedules`],
    ["standings.json", JSON.stringify(standings), `${rosters.length} rosters × ${checkpoints.length} checkpoints`],
    ...teamFiles.map(([file, schedule]): [string, string, string] => [
        path.join(TEAMS_DIR, file),
        JSON.stringify(schedule),
        `${schedule.candidates.length} candidates, ${schedule.subsets.length} subsets`,
    ]),
    ...impactFiles.map(([file, impact]): [string, string, string] => [path.join(IMPACT_DIR, file), JSON.stringify(impact), `${impact.teams.length} teams`]),
];
const size = files.reduce((s, [, json]) => s + Buffer.byteLength(json), 0);
if (size > SIZE_BUDGET) {
    const part = (prefix: string) => files.filter(([f]) => f.startsWith(prefix)).reduce((s, [, json]) => s + Buffer.byteLength(json), 0);
    console.error(
        `Season output is ${size} bytes (index ${part("index")}, standings ${part("standings")}, teams ${part(TEAMS_DIR)}, impact ${part(IMPACT_DIR)}), over the ${SIZE_BUDGET}-byte budget; nothing written.`
    );
    process.exit(1);
}
for (const [subdir, names] of [
    [TEAMS_DIR, teamFiles.map(([file]) => file)],
    [IMPACT_DIR, impactFiles.map(([file]) => file)],
] as const) {
    const dir = path.join(OUT_DIR, subdir);
    fs.mkdirSync(dir, { recursive: true });
    const written = new Set(names);
    for (const stale of fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !written.has(f))) fs.rmSync(path.join(dir, stale));
}
for (const [file, json, detail] of files) {
    if (file.startsWith(TEAMS_DIR)) fs.writeFileSync(path.join(OUT_DIR, file), json);
    else saveJson(path.join(OUT_DIR, file), json, detail);
}
console.log(`Season output ${(size / 1000).toFixed(0)} KB (${teamFiles.length} team files, ${impactFiles.length} impact files).`);
