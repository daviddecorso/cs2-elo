import fs from "node:fs";
import path from "node:path";
import { INVITE_CUTOFFS } from "../src/vrs/inviteCutoffs.ts";
import { compareStandings } from "./lib/vrs/compareStandings.ts";
import { validateMatchdata } from "./lib/vrs/matchdataSchema.ts";
import { readPublishedSnapshot } from "./lib/vrs/publishedStandings.ts";
import { computeStandings } from "./lib/vrs/valveModel.ts";

const args = process.argv.slice(2);

let date = "";
let matchdataPath = "";
let valveRoot = path.resolve(process.cwd(), "vendor/counter-strike_regional_standings");
let jsonOutput = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) {
        date = args[++i];
    } else if (args[i] === "--matchdata" && args[i + 1]) {
        matchdataPath = args[++i];
    } else if (args[i] === "--valve-root" && args[i + 1]) {
        valveRoot = path.resolve(process.cwd(), args[++i]);
    } else if (args[i] === "--json") {
        jsonOutput = true;
    }
}

if (!date || !matchdataPath) {
    console.error(
        "Usage: vite-node scripts/verify-vrs.ts --date <YYYY-MM-DD> --matchdata <path> [--valve-root <dir>] [--json]"
    );
    process.exit(1);
}

const resolvedMatchdata = path.resolve(process.cwd(), matchdataPath);
if (!fs.existsSync(resolvedMatchdata)) {
    console.error(`Matchdata file not found: ${resolvedMatchdata}`);
    process.exit(1);
}

const raw = fs.readFileSync(resolvedMatchdata, "utf8");
let matchJson: { matches: unknown[]; events: unknown[] };
try {
    matchJson = JSON.parse(raw);
} catch (err) {
    console.error(`Failed to parse matchdata JSON: ${String(err)}`);
    process.exit(1);
}

// 1. Validate schema
const validation = validateMatchdata(matchJson);
if (validation.errors.length > 0) {
    console.error(`Matchdata validation failed with ${validation.errors.length} errors:`);
    for (const err of validation.errors) {
        console.error(`  - ${err}`);
    }
    process.exit(1);
}

// 2. Compute model standings
let modelStandings;
try {
    modelStandings = computeStandings(matchJson.matches, matchJson.events, date);
} catch (err) {
    console.error(`Failed to run model: ${String(err)}`);
    process.exit(1);
}

// 3. Read published standings
let publishedStandings;
try {
    publishedStandings = readPublishedSnapshot(valveRoot, date);
} catch (err) {
    console.error(`Failed to read published snapshot: ${String(err)}`);
    process.exit(1);
}

// 4. Compare
const report = compareStandings(modelStandings, publishedStandings, INVITE_CUTOFFS);

if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log("==================================================");
    console.log(`VRS Model Verification Report — Snapshot: ${date}`);
    console.log("==================================================");
    console.log(`Status: ${report.passed ? "PASS" : "FAIL"}`);
    console.log(`Strict mismatches: ${report.strictMismatches.length}`);
    console.log("\nRegional Exact Matches:");
    for (const [reg, stat] of Object.entries(report.exactMatchesPerRegion)) {
        const pct = stat.total > 0 ? ((stat.exact / stat.total) * 100).toFixed(1) : "0.0";
        console.log(`  - ${reg.padEnd(9)}: ${stat.exact}/${stat.total} (${pct}%)`);
    }

    console.log("\nPoints Error:");
    console.log(`  - Mean: ${report.pointsError.mean.toFixed(2)} pts`);
    console.log(`  - Max : ${report.pointsError.max.toFixed(2)} pts`);

    if (report.largestRankDeviation) {
        console.log("\nLargest Rank Deviation:");
        console.log(
            `  - ${report.largestRankDeviation.teamName}: deviation ${report.largestRankDeviation.deviation} (model #${report.largestRankDeviation.modelRank} vs pub #${report.largestRankDeviation.publishedRank})`
        );
    }

    if (report.cutoffMismatches.length > 0) {
        console.log(`\nCutoff Mismatches (±3 band) [${report.cutoffMismatches.length}]:`);
        for (const cm of report.cutoffMismatches.slice(0, 10)) {
            console.log(
                `  - [${cm.region}] ${cm.teamName}: model rank ${cm.modelRegionalRank} vs pub ${cm.publishedRegionalRank} (cutoff ${cm.cutoff})`
            );
        }
        if (report.cutoffMismatches.length > 10) {
            console.log(`    ... and ${report.cutoffMismatches.length - 10} more`);
        }
    }

    if (report.strictMismatches.length > 0) {
        console.log(`\nFirst Strict Mismatches (showing up to 10 of ${report.strictMismatches.length}):`);
        for (const sm of report.strictMismatches.slice(0, 10)) {
            console.log(`  - ${sm.teamName}: ${sm.reason}`);
        }
    }
    console.log("==================================================");
}

process.exit(report.passed ? 0 : 1);
