import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ErrorStats, PlanIndex, PlanOdds, PlanSchedule, PlanTeamFile, PlanVolume } from "../src/sim/types.ts";
import { capsFor } from "./lib/sim/activity.ts";
import { calibrateInvite, calibrateInviteGain, readCalibration } from "./lib/sim/calibration.ts";
import { GAIN_PARTS, summarizeWhy } from "./lib/sim/gain.ts";
import { MIN_REACH, type OptimizerTeam } from "./lib/sim/optimizer.ts";
import { feasible, focalOptions, type OptionSet } from "./lib/sim/plan/options.ts";
import { counts, eventRef, oddsOf, pairedDiff, rulesSmooth } from "./lib/sim/plan/planOutput.ts";
import { playPlan, type PlanPool } from "./lib/sim/plan/planPool.ts";
import type { PlanRunInfo } from "./lib/sim/plan/planShard.ts";
import { feasibleSchedules, keyOf, ScoreCache, searchSchedules, type SearchProblem } from "./lib/sim/plan/search.ts";
import type { Caps } from "./lib/sim/schedule.ts";
import { loadSeasonSetup } from "./lib/sim/seasonSetup.ts";
import { saveJson } from "./lib/writeJson.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const focal = [
    ...args.flatMap((a, i) => (a === "--team" && args[i + 1] ? [args[i + 1]] : [])),
    ...option("teams", "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
];
if (focal.length === 0) {
    console.error(
        'Usage: npm run plan-schedule -- --team "100 Thieves" [--team …] [--teams a,b,c] [--n 300] [--holdout-n 300] [--exact-n 100] [--seed 1] [--workers N] [--lan-cap a,b,c] [--online-cap a,b,c] [--beam 16] [--restarts 4] [--check-exhaustive] [--out <dir>]'
    );
    process.exit(1);
}
const searchN = Number(option("n", "300"));
const holdoutN = Number(option("holdout-n", "300"));
const exactN = Math.min(holdoutN, Number(option("exact-n", "100")));
const seed = Number(option("seed", "1"));
const beam = Number(option("beam", "16"));
const restarts = Number(option("restarts", "4"));
const checkExhaustive = args.includes("--check-exhaustive");
/** Options searched: those that gain the most alone; the rest rarely matter and each one widens every beam step. */
const maxOptions = Number(option("max-options", "40"));
/** Each worker, and the main thread, holds a loaded setup of about 2 GB. */
const SETUP_BYTES = 3e9;
const workers = Number(option("workers", String(Math.max(1, Math.min(os.availableParallelism() - 1, 8, Math.floor(os.totalmem() / SETUP_BYTES) - 1)))));
const OUT_DIR = path.resolve(option("out", "public/data/sim/plan"));
const VOLUMES: PlanVolume[] = ["low", "average", "high"];
const QUANTILES: Record<PlanVolume, number> = { low: 0.5, average: 0.75, high: 0.9 };
const HOLDOUT_TOP = 50;
const MAX_SCHEDULES = 8;
const EXHAUSTIVE_MAX_OPTIONS = 14;
const total = searchN + holdoutN;
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
const seconds = (since: number) => Math.round((Date.now() - since) / 1000);
const round = (x: number, digits = 3) => Number(x.toFixed(digits));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

let started = Date.now();
const setup = loadSeasonSetup({ n: total, seed, focal });
const calibration = readCalibration();
const { input, asOf, target } = setup;
const teams = setup.optimizer.opt.teams;
const sets = focalOptions(setup);
const fields = input.fields;
if (!fields) throw new Error("The planner needs learned fields and activity");
const overrides = (name: string) => option(name, "").split(",").filter(Boolean).map(Number);
const lanCaps = overrides("lan-cap");
const onlineCaps = overrides("online-cap");
const capsOf = (team: OptimizerTeam) =>
    Object.fromEntries(
        VOLUMES.map((v, i) => {
            const own = capsFor(fields.activity, team.teamId, fields.horizonDays, 1, QUANTILES[v]);
            return [v, { lan: lanCaps[i] ?? own.lan, online: onlineCaps[i] ?? own.online }];
        })
    ) as Record<PlanVolume, Caps>;
const setupSeconds = seconds(started);
const generic = new Map(setup.calendar.map((c) => [c.catalog.config.slug, c.catalog.generic]));
const ref = (i: number) => eventRef(input.events[i], generic.get(input.events[i].config.slug) ?? false);
console.log(`Loaded ${teams.length} focal team(s) for target ${target.snapshotDate} in ${setupSeconds} s.`);

// --- Runs, shared by every focal team

started = Date.now();
const searchRuns = range(0, searchN);
const holdoutRuns = range(searchN, total);
const exactRuns = range(searchN, searchN + exactN);
const shared = await playPlan(setup, sets, { n: total, seed, focal, exactRuns, workers }, (done) => {
    if (done % 50 === 0) console.log(`  ${done}/${total} runs (${seconds(started)} s)`);
});
const runSeconds = seconds(started);
console.log(`${total} runs on ${Math.min(workers, total)} worker(s) for ${teams.length} team(s) in ${runSeconds} s.`);

const planTeam = async (team: OptimizerTeam, set: OptionSet, pool: PlanPool) => {
    const caps = capsOf(team);
    const infos = pool.infos;
    const sum = (f: (i: PlanRunInfo) => number) => infos.reduce((s, i) => s + f(i), 0);
    console.log(
        `\n${team.teamName} (${team.team}, ${team.region}): ${set.options.length} options, ${set.locked.length} announced, ${set.committed.length} under way; caps LAN / online ${VOLUMES.map((v) => `${caps[v].lan}/${caps[v].online}`).join(", ")}.`
    );
    console.log(
        `  ${sum((i) => i.replays)} replays, ${sum((i) => i.skipped)} skipped option-runs, ${sum((i) => i.noSlot)} qualifications with no place to take, ${sum((i) => Number(!i.seen))} runs without the roster, ${sum((i) => Number(!i.slotsKnown))} without known slots.`
    );

    const seenSearch = searchRuns.filter((r) => infos[r].seen);
    const share = (runs: number[], f: (i: PlanRunInfo) => boolean) => (runs.length ? runs.filter((r) => f(infos[r])).length / runs.length : 0);
    const optionStats = set.options.map((_, k) => {
        const entered = share(seenSearch, (i) => i.entered[k] === 1);
        return {
            reached: share(seenSearch, (i) => i.reached[k] === 1),
            entered,
            qualified: entered > 0 ? share(seenSearch, (i) => i.qualified[k] === 1) / entered : null,
            usable: share(seenSearch, (i) => i.reached[k] === 1 || i.entered[k] === 1) >= MIN_REACH,
        };
    });
    const reachable = set.options.flatMap((_, k) => (optionStats[k].usable ? [k] : []));

    // --- Search

    type Values = { points: number[]; smooth: number[]; invited: boolean[] };
    const scoreOn = async (schedules: number[][], runs: number[]): Promise<Values[]> => {
        const b = await pool.score(schedules, runs);
        return schedules.map((_, s) => ({
            points: runs.map((_, j) => b.points[s * runs.length + j]),
            smooth: runs.map((_, j) => b.smooth[s * runs.length + j]),
            invited: runs.map((_, j) => b.invited[s * runs.length + j] === 1),
        }));
    };
    const odds = (runs: number[], v: Values): PlanOdds => oddsOf(runs.map((r, j) => ({ info: infos[r], points: v.points[j], smooth: v.smooth[j], invited: v.invited[j] })));
    const searchCounted = searchRuns.filter((r) => counts(infos[r]));
    if (searchCounted.length === 0) console.warn("No search run knows the invite slots; every schedule scores 0.");

    started = Date.now();
    const [aloneBase, ...alone] = await scoreOn([[], ...reachable.map((k) => [k])], searchRuns);
    const baseOdds = odds(searchRuns, aloneBase);
    const gains = reachable.map((k, i) => {
        const o = odds(searchRuns, alone[i]);
        return { k, smooth: o.smooth - baseOdds.smooth, invite: o.invite - baseOdds.invite, points: o.points.mean - baseOdds.points.mean };
    });
    const usable = gains
        .filter((g) => g.smooth > 0 || g.points > 0)
        .sort((a, b) => b.smooth - a.smooth || b.points - a.points || a.k - b.k)
        .slice(0, maxOptions)
        .map((g) => g.k)
        .sort((a, b) => a - b);
    const toOptions = (positions: number[]) => positions.map((p) => usable[p]).sort((a, b) => a - b);
    console.log(
        `  ${reachable.length} of ${set.options.length} options reached in at least ${MIN_REACH * 100}% of search runs; searching the ${usable.length} with the best gain alone (${seconds(started)} s).`
    );

    const searchOdds = new Map<string, { smooth: number; invite: number }>();
    const evaluate = async (schedules: number[][]) => {
        const values = await scoreOn(schedules.map(toOptions), searchRuns);
        return values.map((v, s) => {
            const o = odds(searchRuns, v);
            searchOdds.set(keyOf(schedules[s]), { smooth: o.smooth, invite: o.invite });
            return o.smooth;
        });
    };
    const cache = new ScoreCache(evaluate);
    const problem = (v: PlanVolume): SearchProblem => ({ size: usable.length, feasible: (chosen) => feasible(input.events, set, toOptions(chosen), caps[v]), evaluate });

    started = Date.now();
    const best = {} as Record<PlanVolume, { chosen: number[]; value: number }>;
    for (const [i, v] of VOLUMES.entries()) {
        best[v] = await searchSchedules(problem(v), cache, { beam, restarts, seed: seed * 31 + i });
        console.log(`  ${v}: best search smooth ${best[v].value.toFixed(3)} with ${best[v].chosen.length} options (${cache.size} schedules scored so far, ${seconds(started)} s)`);
    }
    let exhaustiveRegret: Record<PlanVolume, number> | null = null;
    if (checkExhaustive) {
        if (usable.length > EXHAUSTIVE_MAX_OPTIONS) console.log(`  Exhaustive check skipped: ${usable.length} options, over ${EXHAUSTIVE_MAX_OPTIONS}.`);
        else {
            exhaustiveRegret = {} as Record<PlanVolume, number>;
            for (const v of VOLUMES) {
                const all = feasibleSchedules(problem(v));
                if (!all) throw new Error(`Too many feasible schedules at ${v} for the exhaustive check`);
                const top = Math.max(...(await cache.score(all)).map((s) => s.value));
                exhaustiveRegret[v] = round(top - best[v].value, 4);
                console.log(`  exhaustive ${v}: ${all.length} schedules, regret ${exhaustiveRegret[v]}`);
            }
        }
    }
    const searchSeconds = seconds(started);

    // --- Hold-out re-rank, exact re-score, marginal values

    started = Date.now();
    const fitsAt = (positions: number[]) => VOLUMES.find((v) => problem(v).feasible(positions)) ?? null;
    const candidates = cache
        .all()
        .filter((s) => fitsAt(s.chosen) !== null)
        .slice(0, HOLDOUT_TOP);
    for (const v of VOLUMES) if (!candidates.some((c) => keyOf(c.chosen) === keyOf(best[v].chosen))) candidates.push(best[v]);
    const [lockedOnlyValues, ...holdoutValues] = await scoreOn([[], ...candidates.map((c) => toOptions(c.chosen))], holdoutRuns);
    const holdout = candidates.map((c, k) => ({ ...c, values: holdoutValues[k], odds: odds(holdoutRuns, holdoutValues[k]) }));
    const byHoldout = (a: (typeof holdout)[number], b: (typeof holdout)[number]) =>
        b.odds.smooth - a.odds.smooth || b.odds.invite - a.odds.invite || b.odds.points.mean - a.odds.points.mean || keyOf(a.chosen).localeCompare(keyOf(b.chosen));
    const bestFor = new Map<string, PlanVolume[]>();
    for (const v of VOLUMES) {
        const top = holdout.filter((h) => problem(v).feasible(h.chosen)).sort(byHoldout)[0];
        if (top) bestFor.set(keyOf(top.chosen), [...(bestFor.get(keyOf(top.chosen)) ?? []), v]);
    }
    const finals = [...holdout.filter((h) => bestFor.has(keyOf(h.chosen))).sort(byHoldout), ...holdout.filter((h) => !bestFor.has(keyOf(h.chosen))).sort(byHoldout)].slice(
        0,
        MAX_SCHEDULES
    );
    const habitual = holdoutRuns.map((r) => infos[r]);
    const habitualOdds = oddsOf(habitual.map((info) => ({ info, points: info.rules.points, smooth: rulesSmooth(info), invited: info.rules.invited })));

    const marginalJobs = finals.flatMap((f, k) => f.chosen.map((p) => ({ k, option: usable[p], without: toOptions(f.chosen.filter((x) => x !== p)) })));
    const marginalValues = await scoreOn(
        marginalJobs.map((j) => j.without),
        holdoutRuns
    );
    const holdoutSeconds = seconds(started);

    started = Date.now();
    const exactJobs = finals.flatMap((f, k) => exactRuns.filter((r) => infos[r].seen).map((run) => ({ k, run, chosen: toOptions(f.chosen) })));
    const exactResults = await pool.exact(exactJobs.map(({ run, chosen }) => ({ run, chosen })));
    const exactSeconds = seconds(started);
    const exactByKey = new Map(exactResults.map((r) => [`${keyOf(r.chosen)}|${r.run}`, r]));
    const gaps: number[] = [];

    const schedules: PlanSchedule[] = finals.map((f, k) => {
        const chosen = toOptions(f.chosen);
        const counted = holdoutRuns.flatMap((r, j) => (counts(infos[r]) ? [j] : []));
        const runsHere = exactRuns.filter((r) => infos[r].seen);
        const exact = runsHere.map((r) => exactByKey.get(`${keyOf(chosen)}|${r}`)!);
        const estimate = runsHere.map((r) => f.values.points[holdoutRuns.indexOf(r)]);
        const exactCounted = runsHere.filter((r) => counts(infos[r]));
        const exactPoints = mean(exact.map((e) => e.points));
        const estimatePoints = mean(estimate);
        if (exact.length) gaps.push(Math.abs(exactPoints - estimatePoints));
        const seenHoldout = holdoutRuns.filter((r) => infos[r].seen);
        return {
            options: chosen,
            bestFor: bestFor.get(keyOf(f.chosen)) ?? [],
            fits: fitsAt(f.chosen)!,
            search: searchOdds.get(keyOf(f.chosen))!,
            holdout: f.odds,
            vsHabitual: {
                invite: pairedDiff(counted.map((j) => Number(f.values.invited[j]) - Number(infos[holdoutRuns[j]].rules.invited))),
                smooth: pairedDiff(counted.map((j) => f.values.smooth[j] - rulesSmooth(infos[holdoutRuns[j]]))),
            },
            exact: exact.length
                ? {
                      n: exact.length,
                      invite: exactCounted.length ? exactCounted.filter((r) => exactByKey.get(`${keyOf(chosen)}|${r}`)!.invited).length / exactCounted.length : 0,
                      points: exactPoints,
                      estimatePoints,
                  }
                : null,
            marginal: marginalJobs.flatMap((j, i) => {
                if (j.k !== k) return [];
                const without = odds(holdoutRuns, marginalValues[i]);
                return [{ option: j.option, smooth: f.odds.smooth - without.smooth, invite: f.odds.invite - without.invite }];
            }),
            branches: chosen
                .filter((o) => set.options[o].kind !== "event")
                .map((o) => {
                    const entered = seenHoldout.filter((r) => infos[r].entered[o] === 1);
                    return {
                        option: o,
                        invited: seenHoldout.length ? seenHoldout.filter((r) => infos[r].reached[o] === 1).length / seenHoldout.length : 0,
                        entered: seenHoldout.length ? entered.length / seenHoldout.length : 0,
                        qualified: entered.length ? entered.filter((r) => infos[r].qualified[o] === 1).length / entered.length : 0,
                    };
                }),
        };
    });
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const estimateError: ErrorStats = {
        n: gaps.length,
        mean: round(mean(gaps), 2),
        p95: round(sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(0.95 * sortedGaps.length))] ?? 0, 2),
        max: round(sortedGaps.at(-1) ?? 0, 2),
    };

    // --- Why each searched option is worth what it is, from the search runs

    const k = GAIN_PARTS.length;
    const whyOf = (o: number) => {
        const place = new Uint16Array(total);
        const gain = new Float32Array(total * k);
        for (const r of seenSearch) {
            place[r] = infos[r].place[o];
            for (let p = 0; p < k; p++) gain[r * k + p] = infos[r].gain[o * k + p];
        }
        return summarizeWhy(place, gain, 0, seenSearch, input.events[set.options[o].event].projection.prizes);
    };
    const gainByOption = new Map(gains.map((g) => [g.k, g]));

    // --- Output

    const generatedAt = new Date().toISOString();
    // Major invite shares and their differences are shown on the rolling hindcast's calibrated scale; the search ran on raw ones.
    const inviteShare = (p: number) => round(calibrateInvite(calibration, p));
    const gain = (d: number) => round(calibrateInviteGain(calibration, d));
    const roundOdds = (o: PlanOdds): PlanOdds => ({
        smooth: round(o.smooth),
        invite: inviteShare(o.invite),
        points: { mean: round(o.points.mean, 1), p10: round(o.points.p10, 1), p50: round(o.points.p50, 1), p90: round(o.points.p90, 1) },
    });
    const roundDiff = (d: { mean: number; low: number; high: number }) => ({ mean: gain(d.mean), low: gain(d.low), high: gain(d.high) });
    const targetRef = { slug: target.slug, name: target.name, date: target.snapshotDate, estimated: target.snapshotEstimated };
    const searched = new Set(usable);
    const file: PlanTeamFile = {
        generatedAt,
        team: team.team,
        teamName: team.teamName,
        rosterKey: team.rosterKey,
        region: team.region,
        asOf,
        target: targetRef,
        seed,
        runs: { search: searchN, holdout: holdoutN, exact: exactN },
        caps: Object.fromEntries(VOLUMES.map((v) => [v, { lan: caps[v].lan, online: caps[v].online }])) as PlanTeamFile["caps"],
        locked: set.locked.map(ref),
        committed: set.committed.map(ref),
        options: set.options.map((o, i) => {
            const g = searched.has(i) ? gainByOption.get(i) : undefined;
            const why = searched.has(i) ? whyOf(i) : undefined;
            return {
                id: i,
                kind: o.kind,
                event: ref(o.event),
                feeders: o.holds.slice(1).map(ref),
                reached: round(optionStats[i].reached),
                entered: round(optionStats[i].entered),
                qualified: optionStats[i].qualified === null ? null : round(optionStats[i].qualified!),
                ...(g ? { alone: { invite: gain(g.invite), smooth: round(g.smooth), points: round(g.points, 1) } } : {}),
                ...(why ? { why } : {}),
            };
        }),
        minReach: MIN_REACH,
        searched: usable,
        baselines: { habitual: roundOdds(habitualOdds), lockedOnly: roundOdds(odds(holdoutRuns, lockedOnlyValues)) },
        schedules: schedules.map((s) => ({
            ...s,
            search: { smooth: round(s.search.smooth), invite: inviteShare(s.search.invite) },
            holdout: roundOdds(s.holdout),
            vsHabitual: {
                invite: roundDiff(s.vsHabitual.invite),
                smooth: { mean: round(s.vsHabitual.smooth.mean), low: round(s.vsHabitual.smooth.low), high: round(s.vsHabitual.smooth.high) },
            },
            exact: s.exact && { n: s.exact.n, invite: inviteShare(s.exact.invite), points: round(s.exact.points, 1), estimatePoints: round(s.exact.estimatePoints, 1) },
            marginal: s.marginal.map((m) => ({ option: m.option, smooth: round(m.smooth), invite: gain(m.invite) })),
            branches: s.branches.map((b) => ({ option: b.option, invited: round(b.invited), entered: round(b.entered), qualified: round(b.qualified) })),
        })),
        check: {
            estimateError,
            exhaustiveRegret,
            evaluated: cache.size,
            inexactExact: exactResults.filter((r) => r.inexact).length,
            skippedOptions: sum((i) => i.skipped),
            noSlot: sum((i) => i.noSlot),
            seconds: { setup: setupSeconds, runs: runSeconds, search: searchSeconds, holdout: holdoutSeconds, exact: exactSeconds },
        },
    };

    const fileName = `${team.team.replace(/ /g, "_").replace(/[/\\]/g, "-")}.json`;
    saveJson(path.join(OUT_DIR, fileName), JSON.stringify(file), `${schedules.length} schedules`);
    const indexPath = path.join(OUT_DIR, "index.json");
    const index: PlanIndex = fs.existsSync(indexPath) ? (JSON.parse(fs.readFileSync(indexPath, "utf8")) as PlanIndex) : { generatedAt, teams: [] };
    index.teams = [...index.teams.filter((t) => t.team !== team.team), { team: team.team, teamName: team.teamName, file: fileName, asOf, target: targetRef, generatedAt }].sort((a, b) =>
        a.team.localeCompare(b.team)
    );
    saveJson(indexPath, JSON.stringify({ ...index, generatedAt }));

    // --- Summary

    const describe = (o: number) => {
        const opt = set.options[o];
        const name = input.events[opt.event].config.name;
        return opt.kind === "event" ? name : `${name} (${opt.kind === "qualify" ? "qualify" : "invite or qualify"})`;
    };
    console.log(`  Habitual: invite ${pct(habitualOdds.invite)}, smooth ${habitualOdds.smooth.toFixed(3)}, points ${habitualOdds.points.mean.toFixed(0)} (hold-out).`);
    for (const s of schedules.filter((x) => x.bestFor.length)) {
        console.log(
            `  Best for ${s.bestFor.join(", ")}: invite ${pct(s.holdout.invite)} (${s.vsHabitual.invite.mean >= 0 ? "+" : ""}${pct(s.vsHabitual.invite.mean)} vs habitual, 95% ${pct(s.vsHabitual.invite.low)} to ${pct(s.vsHabitual.invite.high)})${s.exact ? `, exact ${pct(s.exact.invite)} on ${s.exact.n} runs` : ""}, points ${s.holdout.points.mean.toFixed(0)}`
        );
        for (const o of s.options) {
            const branch = s.branches.find((b) => b.option === o);
            const marginal = s.marginal.find((m) => m.option === o);
            const route = branch ? `: ${branch.invited ? `place ${pct(branch.invited)}, ` : ""}enters a qualifier ${pct(branch.entered)}, qualifies ${pct(branch.qualified)} of those` : "";
            console.log(`    - ${describe(o)}${route}; worth ${marginal ? pct(marginal.invite) : "?"} invite`);
        }
    }
    console.log(
        `  Estimate error (exact vs one-team mean points) mean ${estimateError.mean}, p95 ${estimateError.p95} (n ${estimateError.n}); ${file.check.inexactExact} inexact exact reruns; ${cache.size} schedules scored. Search ${searchSeconds} s, hold-out ${holdoutSeconds} s, exact ${exactSeconds} s.`
    );
};

const failed: string[] = [];
try {
    for (const [k, team] of teams.entries()) {
        try {
            await planTeam(team, sets[k], shared.teams[k]);
        } catch (err) {
            failed.push(team.teamName);
            console.error(`Planning ${team.teamName} failed: ${(err as Error).stack ?? err}`);
        }
    }
} finally {
    await shared.close();
}
if (failed.length) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exit(1);
}
