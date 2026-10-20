import fs from "node:fs";
import path from "node:path";
import { validateMatchdata } from "./lib/vrs/matchdataSchema.ts";
import { readDetailsSnapshot, type ParsedMatchRow } from "./lib/vrs/valveDetails.ts";
import { computeStandingsWithDetails } from "./lib/vrs/valveModel.ts";

interface Divergence {
    date: string;
    rosterKey: string;
    teamName: string;
    type: "missing_match" | "extra_match" | "lineup_mismatch" | "prize_mismatch" | "lan_weight_mismatch" | "missing_roster" | "extra_roster";
    description: string;
}

const parseArgs = () => {
    const args = process.argv.slice(2);
    let date = "";
    let matchdataPath = "";
    let valveRoot = path.resolve(process.cwd(), "vendor/counter-strike_regional_standings");
    let teamFilter = "";

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--date" && args[i + 1]) {
            date = args[++i];
        } else if (args[i] === "--matchdata" && args[i + 1]) {
            matchdataPath = args[++i];
        } else if (args[i] === "--valve-root" && args[i + 1]) {
            valveRoot = path.resolve(process.cwd(), args[++i]);
        } else if (args[i] === "--team" && args[i + 1]) {
            teamFilter = args[++i];
        }
    }

    if (!date || !matchdataPath) {
        console.error("Usage: vite-node scripts/diff-details.ts --date <YYYY-MM-DD> --matchdata <path> [--team <team>] [--valve-root <dir>]");
        process.exit(1);
    }

    return { date, matchdataPath, valveRoot, teamFilter };
};

const getMatchKey = (m: ParsedMatchRow): string => {
    return `${m.date}:${m.opponent.toLowerCase()}:${m.result}`;
};

const compareRosters = (a: string[], b: string[]): boolean => {
    if (a.length !== b.length) return false;
    const sortedA = [...a].map((p) => p.toLowerCase()).sort();
    const sortedB = [...b].map((p) => p.toLowerCase()).sort();
    return sortedA.every((val, idx) => val === sortedB[idx]);
};

const main = async () => {
    const { date, matchdataPath, valveRoot, teamFilter } = parseArgs();

    const resolvedMatchdata = path.resolve(process.cwd(), matchdataPath);
    if (!fs.existsSync(resolvedMatchdata)) {
        console.error(`Matchdata file not found: ${resolvedMatchdata}`);
        process.exit(1);
    }

    const raw = fs.readFileSync(resolvedMatchdata, "utf8");
    const matchJson = JSON.parse(raw);

    const validation = validateMatchdata(matchJson);
    if (validation.errors.length > 0) {
        console.error(`Matchdata validation failed with ${validation.errors.length} errors:`);
        for (const err of validation.errors.slice(0, 10)) {
            console.error(`  - ${err}`);
        }
        process.exit(1);
    }

    console.log(`Reading Valve published details for ${date}...`);
    const valveSnapshot = readDetailsSnapshot(valveRoot, date);
    console.log(`Loaded ${valveSnapshot.size} rosters from Valve details.`);

    console.log(`Running model and generating in-memory details for ${date}...`);
    const { detailsFiles: modelSnapshot } = computeStandingsWithDetails(
        matchJson.matches,
        matchJson.events,
        date
    );
    console.log(`Model generated details for ${modelSnapshot.size} rosters.`);

    const divergences: Divergence[] = [];

    // 1. Check all published rosters against model rosters
    for (const [rosterKey, valveDetails] of valveSnapshot.entries()) {
        if (teamFilter && !valveDetails.teamName.toLowerCase().includes(teamFilter.toLowerCase())) {
            continue;
        }
        const modelDetails = modelSnapshot.get(rosterKey);
        if (!modelDetails) {
            divergences.push({
                date: "0000-00-00",
                rosterKey,
                teamName: valveDetails.teamName,
                type: "missing_roster",
                description: `Roster [${valveDetails.roster.join(", ")}] present in Valve details (#${valveDetails.globalRank ?? "unranked"}) but missing in model output`,
            });
            continue;
        }

        // Compare Prize / Bounty Offered Winnings
        if (Math.abs(valveDetails.top10ScaledWinnings - modelDetails.top10ScaledWinnings) > 1.0) {
            divergences.push({
                date: valveDetails.bountyOfferedRows[0]?.eventDate ?? date,
                rosterKey,
                teamName: valveDetails.teamName,
                type: "prize_mismatch",
                description: `Top 10 scaled winnings mismatch: Valve=$${valveDetails.top10ScaledWinnings.toFixed(2)}, Model=$${modelDetails.top10ScaledWinnings.toFixed(2)}`,
            });
        }

        // Compare matches
        const valveMatchMap = new Map<string, ParsedMatchRow[]>();
        for (const m of valveDetails.matches) {
            const key = getMatchKey(m);
            if (!valveMatchMap.has(key)) valveMatchMap.set(key, []);
            valveMatchMap.get(key)!.push(m);
        }

        const modelMatchMap = new Map<string, ParsedMatchRow[]>();
        for (const m of modelDetails.matches) {
            const key = getMatchKey(m);
            if (!modelMatchMap.has(key)) modelMatchMap.set(key, []);
            modelMatchMap.get(key)!.push(m);
        }

        // Missing matches in model
        for (const [key, vMatches] of valveMatchMap.entries()) {
            const mMatches = modelMatchMap.get(key) ?? [];
            if (mMatches.length < vMatches.length) {
                const sample = vMatches[0];
                divergences.push({
                    date: sample.date,
                    rosterKey,
                    teamName: valveDetails.teamName,
                    type: "missing_match",
                    description: `Missing match against ${sample.opponent} (${sample.result}) on ${sample.date} (Valve umid ${sample.matchId})`,
                });
            }
        }

        // Extra matches in model
        for (const [key, mMatches] of modelMatchMap.entries()) {
            const vMatches = valveMatchMap.get(key) ?? [];
            if (mMatches.length > vMatches.length) {
                const sample = mMatches[0];
                divergences.push({
                    date: sample.date,
                    rosterKey,
                    teamName: valveDetails.teamName,
                    type: "extra_match",
                    description: `Extra match against ${sample.opponent} (${sample.result}) on ${sample.date} in model (umid ${sample.matchId})`,
                });
            }
        }

        // Match attributes: lineup, LAN, event weight
        for (const [key, vMatches] of valveMatchMap.entries()) {
            const mMatches = modelMatchMap.get(key) ?? [];
            const count = Math.min(vMatches.length, mMatches.length);
            for (let i = 0; i < count; i++) {
                const vm = vMatches[i];
                const mm = mMatches[i];

                if (!compareRosters(vm.roster, mm.roster)) {
                    divergences.push({
                        date: vm.date,
                        rosterKey,
                        teamName: valveDetails.teamName,
                        type: "lineup_mismatch",
                        description: `Lineup mismatch vs ${vm.opponent} on ${vm.date}: Valve=[${vm.roster.join(", ")}], Model=[${mm.roster.join(", ")}]`,
                    });
                }

                if (vm.eventWeight !== null && mm.eventWeight !== null) {
                    if (Math.abs(vm.eventWeight - mm.eventWeight) > 0.05) {
                        divergences.push({
                            date: vm.date,
                            rosterKey,
                            teamName: valveDetails.teamName,
                            type: "lan_weight_mismatch",
                            description: `Event weight mismatch vs ${vm.opponent} on ${vm.date}: Valve=${vm.eventWeight}, Model=${mm.eventWeight}`,
                        });
                    }
                }
            }
        }
    }

    // 2. Check for extra rosters in model not in published
    for (const [rosterKey, modelDetails] of modelSnapshot.entries()) {
        if (teamFilter && !modelDetails.teamName.toLowerCase().includes(teamFilter.toLowerCase())) {
            continue;
        }
        if (!valveSnapshot.has(rosterKey) && modelDetails.globalRank && modelDetails.globalRank > 0) {
            divergences.push({
                date: "9999-99-99",
                rosterKey,
                teamName: modelDetails.teamName,
                type: "extra_roster",
                description: `Extra roster [${modelDetails.roster.join(", ")}] in model (#${modelDetails.globalRank}) not in Valve details`,
            });
        }
    }

    // 3. Sort divergences by earliest divergence date
    divergences.sort((a, b) => a.date.localeCompare(b.date));

    console.log("==================================================");
    console.log(`VRS Details Diff Report — Snapshot: ${date}`);
    console.log("==================================================");
    console.log(`Total divergences: ${divergences.length}`);

    if (divergences.length === 0) {
        console.log("DIFF STATUS: CLEAN (0 divergences between model and Valve details)");
        console.log("==================================================");
        process.exit(0);
    } else {
        console.log("\nDivergences ordered by earliest date (first 25 shown):");
        for (const d of divergences.slice(0, 25)) {
            console.log(`  [${d.date}] [${d.type}] ${d.teamName}: ${d.description}`);
        }
        if (divergences.length > 25) {
            console.log(`  ... and ${divergences.length - 25} more divergences`);
        }
        console.log("==================================================");
        process.exit(1);
    }
};

main().catch((err) => {
    console.error("diff-details failed:", err);
    process.exit(1);
});
