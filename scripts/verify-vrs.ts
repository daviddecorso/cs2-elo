import fs from "node:fs";
import path from "node:path";
import { INVITE_CUTOFFS } from "../src/vrs/inviteCutoffs.ts";
import { type ComparisonReport, GATE, compareStandings } from "./lib/vrs/compareStandings.ts";
import { validateMatchdata } from "./lib/vrs/matchdataSchema.ts";
import { readPublishedSnapshot } from "./lib/vrs/publishedStandings.ts";
import { calibratedSnapshotDates, computeStandings, getSnapshotWindow } from "./lib/vrs/valveModel.ts";

const USAGE =
    "Usage: vite-node scripts/verify-vrs.ts (--date <YYYY-MM-DD> | --all-calibrated) [--matchdata <path>] [--strict] [--valve-root <dir>] [--json]";

const args = process.argv.slice(2);

let date = "";
let allCalibrated = false;
let strict = false;
let matchdataPath = "data/matchdata.json";
let valveRoot = path.resolve(process.cwd(), "vendor/counter-strike_regional_standings");
let jsonOutput = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && args[i + 1]) {
        date = args[++i];
    } else if (args[i] === "--all-calibrated") {
        allCalibrated = true;
    } else if (args[i] === "--strict") {
        strict = true;
    } else if (args[i] === "--matchdata" && args[i + 1]) {
        matchdataPath = args[++i];
    } else if (args[i] === "--valve-root" && args[i + 1]) {
        valveRoot = path.resolve(process.cwd(), args[++i]);
    } else if (args[i] === "--json") {
        jsonOutput = true;
    }
}

if (!date === !allCalibrated) {
    console.error(USAGE);
    process.exit(1);
}

const resolvedMatchdata = path.resolve(process.cwd(), matchdataPath);
if (!fs.existsSync(resolvedMatchdata)) {
    console.error(`Matchdata file not found: ${resolvedMatchdata}`);
    process.exit(1);
}

let matchJson: { matches: unknown[]; events: unknown[] };
try {
    matchJson = JSON.parse(fs.readFileSync(resolvedMatchdata, "utf8"));
} catch (err) {
    console.error(`Failed to parse matchdata JSON: ${String(err)}`);
    process.exit(1);
}

const validation = validateMatchdata(matchJson);
if (validation.errors.length > 0) {
    console.error(`Matchdata validation failed with ${validation.errors.length} errors:`);
    for (const err of validation.errors) {
        console.error(`  - ${err}`);
    }
    process.exit(1);
}

const earliestMatch = Math.min(
    ...(matchJson.matches as Array<{ matchStartTime: number }>).map((m) => m.matchStartTime)
);

const verify = (snapshotDate: string): ComparisonReport => {
    const windowStart = getSnapshotWindow(snapshotDate).pullTime - 180 * 86400;
    if (earliestMatch > windowStart) {
        const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
        throw new Error(
            `matchdata starts ${iso(earliestMatch)}, but the ${snapshotDate} window starts ${iso(windowStart)}`
        );
    }
    const model = computeStandings(matchJson.matches, matchJson.events, snapshotDate);
    const published = readPublishedSnapshot(valveRoot, snapshotDate);
    return compareStandings(model, published, INVITE_CUTOFFS);
};

const passed = (report: ComparisonReport) => (strict ? report.passed : report.gate.passed);

const printReport = (snapshotDate: string, report: ComparisonReport) => {
    const { gate } = report;
    console.log("==================================================");
    console.log(`VRS verification — snapshot ${snapshotDate}`);
    console.log("==================================================");
    console.log(`Gate: ${gate.passed ? "PASS" : "FAIL"}    Strict: ${report.passed ? "PASS" : "FAIL"}`);
    console.log(`\nPublished global top ${gate.total}:`);
    console.log(`  - Exact rank      : ${gate.exactRank}`);
    console.log(`  - Within ±${GATE.maxRankMiss}       : ${gate.withinMaxMiss}`);
    console.log(
        `  - Points error    : mean ${gate.meanPointsError.toFixed(2)} (gate < ${GATE.maxMeanPointsError}), p90 ${gate.p90PointsError.toFixed(2)}`
    );
    for (const miss of gate.rankMisses) {
        console.log(`    ${miss.teamName}: model #${miss.modelRank ?? "unranked"} vs pub #${miss.publishedRank}`);
    }

    console.log("\nInvite-cutoff membership:");
    for (const [region, c] of Object.entries(gate.cutoffMembership)) {
        const exact = c.missing.length === 0 && c.extra.length === 0;
        console.log(`  - ${region.padEnd(9)} (top ${c.cutoff}): ${exact ? "exact" : "DIFFERS"}`);
        if (c.missing.length > 0) console.log(`      model misses: ${c.missing.join(", ")}`);
        if (c.extra.length > 0) console.log(`      model adds  : ${c.extra.join(", ")}`);
    }

    console.log("\nRegional exact matches (all rosters):");
    for (const [region, stat] of Object.entries(report.exactMatchesPerRegion)) {
        const pct = stat.total > 0 ? ((stat.exact / stat.total) * 100).toFixed(1) : "0.0";
        console.log(`  - ${region.padEnd(9)}: ${stat.exact}/${stat.total} (${pct}%)`);
    }

    if (strict && report.strictMismatches.length > 0) {
        console.log(`\nFirst strict mismatches (up to 10 of ${report.strictMismatches.length}):`);
        for (const sm of report.strictMismatches.slice(0, 10)) {
            console.log(`  - ${sm.teamName}: ${sm.reason}`);
        }
    }
    console.log("");
};

const dates = allCalibrated ? calibratedSnapshotDates() : [date];
const reports: Record<string, ComparisonReport> = {};
for (const d of dates) {
    try {
        reports[d] = verify(d);
    } catch (err) {
        console.error(`Failed to verify ${d}: ${String(err)}`);
        process.exit(1);
    }
}

const allPassed = dates.every((d) => passed(reports[d]));
const enoughSnapshots = !allCalibrated || strict || dates.length >= GATE.minSnapshots;

if (jsonOutput) {
    console.log(JSON.stringify(allCalibrated ? reports : reports[date], null, 2));
} else {
    for (const d of dates) printReport(d, reports[d]);
    if (allCalibrated) {
        const passCount = dates.filter((d) => passed(reports[d])).length;
        console.log(`${passCount}/${dates.length} calibrated snapshots pass the ${strict ? "strict check" : "gate"}.`);
        if (!enoughSnapshots) {
            console.log(`The gate needs at least ${GATE.minSnapshots} calibrated snapshots.`);
        }
    }
}

// exitCode rather than exit(), which can truncate piped stdout.
process.exitCode = allPassed && enoughSnapshots ? 0 : 1;
