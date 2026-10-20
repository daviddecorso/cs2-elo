import fs from "node:fs";
import path from "node:path";
import { INVITE_CUTOFFS } from "../src/vrs/inviteCutoffs.ts";
import { compareStandings } from "./lib/vrs/compareStandings.ts";
import { validateMatchdata } from "./lib/vrs/matchdataSchema.ts";
import { findLatestSnapshot, readPublishedSnapshot } from "./lib/vrs/publishedStandings.ts";
import { computeStandings } from "./lib/vrs/valveModel.ts";
import { saveJson } from "./lib/writeJson.ts";

const main = async () => {
    const valveRoot = path.resolve(process.cwd(), "vendor/counter-strike_regional_standings");
    const latestDate = findLatestSnapshot(valveRoot);
    console.log(`Parsing published snapshot for ${latestDate}...`);

    const standings = readPublishedSnapshot(valveRoot, latestDate);
    const jsonStr = JSON.stringify(standings, null, 2);

    const publicVrsDir = path.resolve(process.cwd(), "public/data/vrs");
    const dateFile = path.join(publicVrsDir, `${latestDate}.json`);
    const latestFile = path.join(publicVrsDir, "latest.json");

    saveJson(dateFile, jsonStr, `${standings.rosters.length} rosters for ${latestDate}`);
    saveJson(latestFile, jsonStr, "symlinked latest snapshot");

    const matchdataPath = process.env.VRS_MATCHDATA;
    if (matchdataPath) {
        console.log(`Running model verification with ${matchdataPath}...`);
        const raw = fs.readFileSync(path.resolve(process.cwd(), matchdataPath), "utf8");
        const matchJson = JSON.parse(raw);
        const validation = validateMatchdata(matchJson);
        if (validation.errors.length > 0) {
            throw new Error(`Matchdata validation failed: ${validation.errors.join("; ")}`);
        }
        const modelStandings = computeStandings(matchJson.matches, matchJson.events, latestDate);
        const report = compareStandings(modelStandings, standings, INVITE_CUTOFFS);
        if (!report.gate.passed) {
            console.warn(
                `::warning::Model verification failed the gate: ${report.gate.withinMaxMiss}/${report.gate.total} top rosters within ±2, mean points error ${report.gate.meanPointsError.toFixed(2)}.`
            );
        } else {
            console.log("Model verification passed the gate.");
        }

        const today = new Date().toISOString().slice(0, 10);
        const previousRanks = new Map(modelStandings.rosters.map((r) => [r.rosterKey, r.globalRank]));
        const live = computeStandings(matchJson.matches, matchJson.events, today, { windowEndsAtPull: true });
        const lastMatch = Math.max(...(matchJson.matches as Array<{ matchStartTime: number }>).map((m) => m.matchStartTime));
        const liveJson = JSON.stringify(
            {
                ...live,
                asOf: new Date(lastMatch * 1000).toISOString().slice(0, 10),
                previousSnapshot: latestDate,
                rosters: live.rosters.map((r) => ({ ...r, previousRank: previousRanks.get(r.rosterKey) ?? null })),
            },
            null,
            2
        );
        saveJson(path.join(publicVrsDir, "live.json"), liveJson, `${live.rosters.length} rosters for ${today}`);
    } else {
        console.log(
            "::warning::Model verification skipped: VRS_MATCHDATA environment variable not set (Valve does not publish model input data)."
        );
    }
};

main().catch((err) => {
    console.error("update-data failed:", err);
    process.exit(1);
});
