import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { PlanIndex, SeasonIndex, SeasonTeamSchedule } from "../src/sim/types.ts";
import { type BatchCandidate, prune, selectTeams } from "./lib/sim/plan/batch.ts";
import { saveJson } from "./lib/writeJson.ts";

const BATCH_OPTIONS = ["max", "budget-minutes", "min-invite", "max-invite", "keep-days"];
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
const max = Number(option("max", "8"));
const budgetMinutes = Number(option("budget-minutes", "240"));
const minInvite = Number(option("min-invite", "0.1"));
const maxInvite = Number(option("max-invite", "0.9"));
const keepDays = Number(option("keep-days", "14"));
const dryRun = args.includes("--dry-run");
const outIndex = passthrough.indexOf("--out");
const OUT_DIR = path.resolve(outIndex >= 0 ? passthrough[outIndex + 1] : "public/data/sim/plan");
const SEASON_DIR = "public/data/sim/season";
const SIZE_BUDGET = 1_000_000;

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const season = readJson<SeasonIndex>(path.join(SEASON_DIR, "index.json"));
const candidates: BatchCandidate[] = (season.schedules ?? []).flatMap((entry) => {
    const file = readJson<SeasonTeamSchedule>(path.join(SEASON_DIR, "teams", entry.file));
    return file.rules.invite === null ? [] : [{ team: entry.team, teamName: entry.teamName, region: entry.region, invite: file.rules.invite }];
});
const picked = selectTeams(candidates, { max, min: minInvite, maxInvite });
console.log(
    `${picked.length} of ${candidates.length} teams with season-rules invite odds in [${minInvite}, ${maxInvite}] (season as of ${season.asOf}):\n${picked.map((c) => `  ${c.teamName} (${c.region}) ${(100 * c.invite).toFixed(0)}%`).join("\n")}`
);
if (dryRun) process.exit(0);

const started = Date.now();
const minutes = (ms: number) => ms / 60_000;
let slowest = 0;
const failed: string[] = [];
const planned: string[] = [];
for (const c of picked) {
    if (planned.length + failed.length > 0 && minutes(Date.now() - started + slowest) > budgetMinutes) {
        console.log(`Budget of ${budgetMinutes} minutes reached; skipping ${picked.length - planned.length - failed.length} team(s).`);
        break;
    }
    const teamStarted = Date.now();
    console.log(`\n== ${c.teamName}`);
    const result = spawnSync("npm", ["run", "plan-schedule", "--", "--team", c.team, ...passthrough], { stdio: "inherit" });
    const took = Date.now() - teamStarted;
    slowest = Math.max(slowest, took);
    if (result.status === 0) planned.push(c.teamName);
    else {
        failed.push(c.teamName);
        console.warn(`::warning::plan-schedule failed for ${c.teamName} (exit ${result.status ?? result.signal})`);
    }
    console.log(`== ${c.teamName}: ${minutes(took).toFixed(1)} min`);
}

const indexPath = path.join(OUT_DIR, "index.json");
if (fs.existsSync(indexPath)) {
    const { index, removed } = prune(readJson<PlanIndex>(indexPath), new Date(), keepDays);
    for (const file of removed) fs.rmSync(path.join(OUT_DIR, file), { force: true });
    if (removed.length) {
        saveJson(indexPath, JSON.stringify({ ...index, generatedAt: new Date().toISOString() }));
        console.log(`Pruned ${removed.length} plan(s) older than ${keepDays} days: ${removed.join(", ")}`);
    }
}
if (fs.existsSync(OUT_DIR)) {
    const bytes = fs.readdirSync(OUT_DIR).reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
    if (bytes > SIZE_BUDGET) console.warn(`::warning::${path.relative(process.cwd(), OUT_DIR)} is ${(bytes / 1e6).toFixed(2)} MB, over the 1 MB budget.`);
}
console.log(`\nPlanned ${planned.length} team(s) in ${minutes(Date.now() - started).toFixed(0)} min${failed.length ? `; failed: ${failed.join(", ")}` : ""}.`);
if (picked.length > 0 && planned.length === 0) process.exit(1);
