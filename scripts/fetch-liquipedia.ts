import fs from "node:fs";
import path from "node:path";
import { fetchLiquipediaAll } from "./lib/liquipedia/client.ts";
import { normalizeCountryIso } from "./lib/vrs/buildMatchdata.ts";

const parseArgs = () => {
    const args = process.argv.slice(2);
    const now = new Date();
    const defaultToDate = now.toISOString().slice(0, 10);
    const defaultFromDate = new Date(now.getTime() - 190 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

    let fromDate = defaultFromDate;
    let toDate = defaultToDate;
    let outDir = path.resolve(process.cwd(), "data/raw");

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--from" && args[i + 1]) {
            fromDate = args[++i];
        } else if (args[i] === "--to" && args[i + 1]) {
            toDate = args[++i];
        } else if (args[i] === "--out-dir" && args[i + 1]) {
            outDir = path.resolve(process.cwd(), args[++i]);
        }
    }

    return { fromDate, toDate, outDir };
};

const getDayBefore = (dateStr: string): string => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
};

const getDayAfter = (dateStr: string): string => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
};

const main = async () => {
    const { fromDate, toDate, outDir } = parseArgs();
    fs.mkdirSync(outDir, { recursive: true });

    const prevDate = getDayBefore(fromDate);
    const nextDate = getDayAfter(toDate);

    console.log(`Fetching Liquipedia CS2 data for window ${fromDate} to ${toDate}...`);

    // 1. Fetch matches
    console.log("Fetching /match...");
    const matchConditions = `[[game::cs2]] AND [[finished::1]] AND [[date::>${prevDate} 23:59:59]] AND [[date::<${nextDate} 00:00:00]]`;
    const matches = await fetchLiquipediaAll("match", {
        conditions: matchConditions,
        limit: 500,
    });
    console.log(`Fetched ${matches.length} matches.`);
    fs.writeFileSync(path.join(outDir, "matches.json"), JSON.stringify(matches, null, 2), "utf8");

    // 2. Fetch tournaments
    console.log("Fetching /tournament...");
    const tourneyConditions = `[[game::cs2]] AND [[startdate::>${prevDate}]] AND [[startdate::<${nextDate}]]`;
    const tournaments = await fetchLiquipediaAll("tournament", {
        conditions: tourneyConditions,
        limit: 500,
    });
    console.log(`Fetched ${tournaments.length} tournaments.`);
    fs.writeFileSync(path.join(outDir, "tournaments.json"), JSON.stringify(tournaments, null, 2), "utf8");

    // 3. Fetch placements
    console.log("Fetching /placement...");
    const placementConditions = `[[game::cs2]] AND [[date::>${prevDate} 23:59:59]] AND [[date::<${nextDate} 00:00:00]]`;
    const placements = await fetchLiquipediaAll("placement", {
        conditions: placementConditions,
        limit: 500,
    });
    console.log(`Fetched ${placements.length} placements.`);
    fs.writeFileSync(path.join(outDir, "placements.json"), JSON.stringify(placements, null, 2), "utf8");

    // 4. build-matchdata only falls back to /player nationality when the match flag doesn't map to a country
    const playerNames = new Set<string>();
    for (const match of matches as Array<Record<string, unknown>>) {
        const opponents = Array.isArray(match.match2opponents) ? match.match2opponents : [];
        for (const opp of opponents) {
            const players = Array.isArray(opp.match2players) ? opp.match2players : [];
            for (const p of players) {
                if (p.name && typeof p.name === "string" && !normalizeCountryIso(String(p.flag ?? ""))) {
                    playerNames.add(p.name);
                }
            }
        }
    }

    const playersFilePath = path.join(outDir, "players.json");
    const playersByPage = new Map<string, Record<string, unknown>>();
    if (fs.existsSync(playersFilePath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(playersFilePath, "utf8"));
            if (Array.isArray(existing)) {
                for (const row of existing) playersByPage.set(String(row.pagename), row);
            }
        } catch {
            // Ignore corrupted file
        }
    }

    // Player rows rarely change, and refetching all of them exceeds Liquipedia's hourly limit.
    const nameList = Array.from(playerNames).filter((name) => !playersByPage.has(name.replace(/ /g, "_")));
    console.log(
        `Found ${playerNames.size} distinct players, ${playersByPage.size} already saved. Fetching ${nameList.length} from /player...`
    );
    const batchSize = 50;

    try {
        for (let i = 0; i < nameList.length; i += batchSize) {
            const batch = nameList.slice(i, i + batchSize);
            const condition = batch.map((name) => `[[pagename::${name.replace(/ /g, "_")}]]`).join(" OR ");
            const rows = await fetchLiquipediaAll("player", {
                conditions: condition,
                limit: 500,
            });
            for (const row of rows) playersByPage.set(String(row.pagename), row);
        }
    } catch (err) {
        console.warn(`Warning: /player fetch stopped early: ${(err as Error).message}`);
    }

    console.log(`Saved ${playersByPage.size} player records.`);
    fs.writeFileSync(playersFilePath, JSON.stringify([...playersByPage.values()], null, 2), "utf8");

    console.log(`All raw data written to ${outDir}`);
};

main().catch((err) => {
    console.error("fetch-liquipedia failed:", err);
    process.exit(1);
});
