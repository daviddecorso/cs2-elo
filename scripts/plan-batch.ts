import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PlanIndex, PlanTeamFile, SeasonIndex, SeasonStandings, SeasonTeamSchedule } from "../src/sim/types.ts";
import { type BatchCandidate, bubbleRosters, groupsOf, planEvents, prune, selectTeams } from "./lib/sim/plan/batch.ts";
import { saveJson } from "./lib/writeJson.ts";

const BATCH_OPTIONS = ["max", "group", "budget-minutes", "min-invite", "max-invite", "keep-days"];
const BATCH_FLAGS = ["dry-run"];
/** vite-node drops a `--` separator, so every flag the batch doesn't own goes to plan-schedule. */
const args: string[] = [];
const passthrough: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, "");
    if (BATCH_OPTIONS.includes(name)) args.push(argv[i], argv[++i]);
    else if (BATCH_FLAGS.includes(name)) args.push(argv[i]);
    else passthrough.push(argv[i]);
}
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const max = Number(option("max", "Infinity"));
/** Teams planned on one set of shared season runs; each keeps its runs' scoring inputs in every worker's memory. */
const group = Number(option("group", "10"));
const budgetMinutes = Number(option("budget-minutes", "240"));
const minInvite = Number(option("min-invite", "0.1"));
const maxInvite = Number(option("max-invite", "0.9"));
const keepDays = Number(option("keep-days", "21"));
const dryRun = args.includes("--dry-run");
const outIndex = passthrough.indexOf("--out");
const OUT_DIR = path.resolve(outIndex >= 0 ? passthrough[outIndex + 1] : "public/data/sim/plan");
const SEASON_DIR = "public/data/sim/season";
/** About 60 KB per team. */
const SIZE_BUDGET = 3_000_000;

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const season = readJson<SeasonIndex>(path.join(SEASON_DIR, "index.json"));
const known: BatchCandidate[] = (season.schedules ?? []).flatMap((entry) => {
    const file = readJson<SeasonTeamSchedule>(path.join(SEASON_DIR, "teams", entry.file));
    return file.rules.invite === null ? [] : [{ team: entry.team, teamName: entry.teamName, region: entry.region, invite: file.rules.invite }];
});
const standingsPath = path.join(SEASON_DIR, "standings.json");
const withFile = new Set(known.map((c) => c.teamName));
const extra = fs.existsSync(standingsPath) ? bubbleRosters(readJson<SeasonStandings>(standingsPath).rosters, known, (name) => withFile.has(name)) : [];
const picked = selectTeams([...known, ...extra], { max, min: minInvite, maxInvite });
console.log(
    `${picked.length} team(s): ${known.length} with season-rules invite odds in [${minInvite}, ${maxInvite}] or near the line (season as of ${season.asOf}), in groups of ${group}:\n${picked
        .map((c) => `  ${c.teamName} (${c.region}) ${c.invite === null ? "no odds, on the bubble" : `${(100 * c.invite).toFixed(0)}%`}`)
        .join("\n")}`
);
if (dryRun) process.exit(0);

const started = Date.now();
const minutes = (ms: number) => ms / 60_000;
let slowest = 0;
const failed: string[] = [];
const planned: string[] = [];
const plan = (teams: BatchCandidate[]) =>
    spawnSync("npm", ["run", "plan-schedule", "--", ...teams.flatMap((c) => ["--team", c.team]), ...passthrough], { stdio: "inherit" }).status === 0;
const indexPath = path.join(OUT_DIR, "index.json");
const groups = groupsOf(picked, group);
for (const [g, members] of groups.entries()) {
    if (g > 0 && minutes(Date.now() - started + slowest) > budgetMinutes) {
        console.log(`Budget of ${budgetMinutes} minutes reached; skipping ${picked.length - planned.length - failed.length} team(s).`);
        break;
    }
    const groupStarted = Date.now();
    console.log(`\n== Group ${g + 1} of ${groups.length}: ${members.map((c) => c.teamName).join(", ")}`);
    if (plan(members)) planned.push(...members.map((c) => c.teamName));
    else {
        const index = fs.existsSync(indexPath) ? readJson<PlanIndex>(indexPath) : { teams: [] };
        const fresh = new Set(index.teams.filter((t) => Date.parse(t.generatedAt) >= groupStarted).map((t) => t.teamName));
        const rest = members.filter((c) => !fresh.has(c.teamName));
        planned.push(...members.filter((c) => fresh.has(c.teamName)).map((c) => c.teamName));
        // A team the setup can't load fails the whole group's process before any planning.
        console.warn(`::warning::plan-schedule failed for group ${g + 1}; planning ${rest.length} of its teams one at a time`);
        for (const c of rest) {
            if (plan([c])) planned.push(c.teamName);
            else {
                failed.push(c.teamName);
                console.warn(`::warning::plan-schedule failed for ${c.teamName}`);
            }
        }
    }
    const took = Date.now() - groupStarted;
    slowest = Math.max(slowest, took);
    console.log(`== Group ${g + 1}: ${minutes(took).toFixed(1)} min`);
}

if (fs.existsSync(indexPath)) {
    const { index, removed } = prune(readJson<PlanIndex>(indexPath), new Date(), keepDays);
    for (const file of removed) fs.rmSync(path.join(OUT_DIR, file), { force: true });
    if (removed.length) {
        saveJson(indexPath, JSON.stringify({ ...index, generatedAt: new Date().toISOString() }));
        console.log(`Pruned ${removed.length} plan(s) older than ${keepDays} days: ${removed.join(", ")}`);
    }
    const files = index.teams.flatMap((t) => (fs.existsSync(path.join(OUT_DIR, t.file)) ? [readJson<PlanTeamFile>(path.join(OUT_DIR, t.file))] : []));
    saveJson(path.join(OUT_DIR, "events.json"), JSON.stringify(planEvents(files, new Date().toISOString())), `${files.length} plans`);
}
if (fs.existsSync(OUT_DIR)) {
    const bytes = fs.readdirSync(OUT_DIR).reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
    if (bytes > SIZE_BUDGET) console.warn(`::warning::${path.relative(process.cwd(), OUT_DIR)} is ${(bytes / 1e6).toFixed(2)} MB, over the ${SIZE_BUDGET / 1e6} MB budget.`);
}
console.log(`\nPlanned ${planned.length} team(s) in ${minutes(Date.now() - started).toFixed(0)} min${failed.length ? `; failed: ${failed.join(", ")}` : ""}.`);
if (picked.length > 0 && planned.length === 0) process.exit(1);
