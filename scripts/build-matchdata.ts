import fs from "node:fs";
import path from "node:path";
import { getRowDedupeKey } from "./lib/liquipedia/client.ts";
import { buildAndValidateMatchdata, type Overrides } from "./lib/vrs/buildMatchdata.ts";

const parseArgs = () => {
    const args = process.argv.slice(2);
    let rawDir = path.resolve(process.cwd(), "data/raw");
    let overridesPath = path.resolve(process.cwd(), "data/overrides.json");
    let outPath = path.resolve(process.cwd(), "data/matchdata.json");
    let snapshotDate: string | undefined = undefined;
    let includeArchive = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--raw-dir" && args[i + 1]) {
            rawDir = path.resolve(process.cwd(), args[++i]);
        } else if (args[i] === "--overrides" && args[i + 1]) {
            overridesPath = path.resolve(process.cwd(), args[++i]);
        } else if (args[i] === "--out" && args[i + 1]) {
            outPath = path.resolve(process.cwd(), args[++i]);
        } else if ((args[i] === "--date" || args[i] === "--snapshot-date") && args[i + 1]) {
            snapshotDate = args[++i];
        } else if (args[i] === "--include-archive") {
            includeArchive = true;
        }
    }

    return { rawDir, overridesPath, outPath, snapshotDate, includeArchive };
};

const mergeArchived = (rawDir: string, prefix: string, hot: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
    const archiveDir = path.join(rawDir, "archive");
    if (!fs.existsSync(archiveDir)) return hot;
    const deduped = new Map<string, Record<string, unknown>>();
    for (const file of fs.readdirSync(archiveDir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".json")).sort()) {
        const rows = JSON.parse(fs.readFileSync(path.join(archiveDir, file), "utf8")) as Array<Record<string, unknown>>;
        for (const row of rows) deduped.set(getRowDedupeKey(row), row);
    }
    for (const row of hot) deduped.set(getRowDedupeKey(row), row);
    return [...deduped.values()];
};

const main = async () => {
    const { rawDir, overridesPath, outPath, snapshotDate, includeArchive } = parseArgs();

    const matchesFile = path.join(rawDir, "matches.json");
    const tournamentsFile = path.join(rawDir, "tournaments.json");
    const placementsFile = path.join(rawDir, "placements.json");
    const playersFile = path.join(rawDir, "players.json");

    if (!fs.existsSync(matchesFile)) {
        throw new Error(`Raw matches file not found: ${matchesFile}. Run npm run fetch-liquipedia first.`);
    }

    console.log(`Loading raw data from ${rawDir}...`);
    const hotMatches = JSON.parse(fs.readFileSync(matchesFile, "utf8"));
    const hotTournaments = fs.existsSync(tournamentsFile)
        ? JSON.parse(fs.readFileSync(tournamentsFile, "utf8"))
        : [];
    const rawMatches = includeArchive ? mergeArchived(rawDir, "matches", hotMatches) : hotMatches;
    const rawTournaments = includeArchive ? mergeArchived(rawDir, "tournaments", hotTournaments) : hotTournaments;
    const hotPlacements = fs.existsSync(placementsFile)
        ? JSON.parse(fs.readFileSync(placementsFile, "utf8"))
        : [];
    const rawPlacements = includeArchive ? mergeArchived(rawDir, "placements", hotPlacements) : hotPlacements;
    const rawPlayers = fs.existsSync(playersFile)
        ? JSON.parse(fs.readFileSync(playersFile, "utf8"))
        : [];

    let overrides: Overrides = {};
    if (fs.existsSync(overridesPath)) {
        console.log(`Loading overrides from ${overridesPath}...`);
        overrides = JSON.parse(fs.readFileSync(overridesPath, "utf8"));
    } else {
        console.log("No overrides file found; proceeding with empty overrides.");
    }

    console.log("Building matchdata...");
    const { matchdata, validation } = buildAndValidateMatchdata(
        rawMatches,
        rawTournaments,
        rawPlacements,
        rawPlayers,
        overrides,
        { snapshotDate }
    );

    if (validation.errors.length > 0) {
        console.error(`Validation failed with ${validation.errors.length} errors:`);
        for (const err of validation.errors.slice(0, 20)) {
            console.error(`  - ${err}`);
        }
        if (validation.errors.length > 20) {
            console.error(`  ... and ${validation.errors.length - 20} more errors`);
        }
        process.exit(1);
    }

    if (validation.warnings.length > 0) {
        console.warn(`Validation produced ${validation.warnings.length} warnings.`);
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(matchdata, null, 2), "utf8");
    console.log(
        `Successfully wrote matchdata with ${matchdata.matches.length} matches and ${matchdata.events.length} events to ${outPath}`
    );
};

main().catch((err) => {
    console.error("build-matchdata failed:", err);
    process.exit(1);
});
