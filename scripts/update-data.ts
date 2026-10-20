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
        if (!report.passed) {
            console.warn(
                `::warning::Model verification reported ${report.strictMismatches.length} strict mismatches against published standings.`
            );
        } else {
            console.log("Model verification passed!");
        }
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
