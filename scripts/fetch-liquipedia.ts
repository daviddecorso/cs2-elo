import fs from "node:fs";
import path from "node:path";
import { fetchLiquipediaAll } from "./lib/liquipedia/client.ts";
import {
    addDays,
    mergeRows,
    planFetchRanges,
    type DateRange,
    type Row,
    type StoreMeta,
} from "./lib/liquipedia/rawStore.ts";
import { fetchUpcoming } from "./lib/liquipedia/upcoming.ts";
import { loadEventConfigs } from "./lib/sim/config.ts";
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
    let forceFull = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--from" && args[i + 1]) {
            fromDate = args[++i];
        } else if (args[i] === "--to" && args[i + 1]) {
            toDate = args[++i];
        } else if (args[i] === "--out-dir" && args[i + 1]) {
            outDir = path.resolve(process.cwd(), args[++i]);
        } else if (args[i] === "--full") {
            forceFull = true;
        }
    }

    return { fromDate, toDate, outDir, forceFull };
};

const readRows = (filePath: string): Row[] => {
    if (!fs.existsSync(filePath)) return [];
    try {
        const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return Array.isArray(rows) ? rows : [];
    } catch {
        return [];
    }
};

const dateConditions = (range: DateRange) =>
    `[[date::>${addDays(range.from, -1)} 23:59:59]] AND [[date::<${addDays(range.to, 1)} 00:00:00]]`;

const fetchDatedTable = async (
    endpoint: string,
    baseConditions: string,
    ranges: DateRange[]
): Promise<Array<{ range: DateRange; rows: Row[] }>> => {
    const fetched = [];
    for (const range of ranges) {
        console.log(`Fetching /${endpoint} ${range.from} to ${range.to}...`);
        const rows = await fetchLiquipediaAll(endpoint, {
            conditions: `${baseConditions} AND ${dateConditions(range)}`,
            order: "objectname ASC",
            limit: 500,
        });
        fetched.push({ range, rows });
    }
    return fetched;
};

const SQUAD_REFRESH_DAYS = 7;
const SQUAD_ACTIVE_DAYS = 90;
const SQUAD_MAX_TIER = 3;

/** Active player squads for teams with a tier 1–3 series in the last 90 days, refetched weekly (about 10 requests). */
const fetchSquads = async (outDir: string, matches: Array<Record<string, unknown>>, today: string) => {
    const squadsPath = path.join(outDir, "squads.json");
    const stored = fs.existsSync(squadsPath)
        ? (JSON.parse(fs.readFileSync(squadsPath, "utf8")) as { fetched: string; rows: Row[] })
        : null;
    // Stores written before `objectname` was queried hold one player per team, because rows were deduped by page name.
    const complete = stored?.rows.every((r) => r.objectname);
    if (stored && complete && addDays(stored.fetched, SQUAD_REFRESH_DAYS) > today) {
        console.log(`Squads fetched ${stored.fetched}; next refresh after ${SQUAD_REFRESH_DAYS} days.`);
        return;
    }

    const since = addDays(today, -SQUAD_ACTIVE_DAYS);
    const teams = new Set<string>();
    for (const m of matches) {
        if (String(m.date ?? "") < since || Number(m.liquipediatier) > SQUAD_MAX_TIER) continue;
        for (const opp of Array.isArray(m.match2opponents) ? m.match2opponents : []) {
            const page = opp?.teamtemplate?.page;
            if (typeof page === "string" && page) teams.add(page.replace(/ /g, "_"));
        }
    }

    const teamList = [...teams].sort();
    console.log(`Fetching active squads for ${teamList.length} teams from /squadplayer...`);
    const rows: Row[] = [];
    try {
        for (let i = 0; i < teamList.length; i += 50) {
            const pages = teamList.slice(i, i + 50).map((t) => `[[pagename::${t}]]`).join(" OR ");
            rows.push(
                ...(await fetchLiquipediaAll("squadplayer", {
                    conditions: `(${pages}) AND [[status::active]] AND [[type::player]]`,
                    query: "pagename,objectname,link,id,role,status,joindate",
                    order: "objectname ASC",
                    limit: 500,
                }))
            );
        }
    } catch (err) {
        console.warn(`Warning: /squadplayer fetch stopped early, keeping the stored squads: ${(err as Error).message}`);
        return;
    }
    fs.writeFileSync(squadsPath, JSON.stringify({ fetched: today, rows }), "utf8");
    console.log(`Stored ${rows.length} active squad players.`);
};

const main = async () => {
    const { fromDate, toDate, outDir, forceFull } = parseArgs();
    fs.mkdirSync(outDir, { recursive: true });

    const window = { from: fromDate, to: toDate };
    const metaPath = path.join(outDir, "meta.json");
    const meta = fs.existsSync(metaPath) ? (JSON.parse(fs.readFileSync(metaPath, "utf8")) as StoreMeta) : null;
    const today = new Date().toISOString().slice(0, 10);
    const { ranges, full } = planFetchRanges(window, meta, today, forceFull);

    console.log(`Liquipedia CS2 window ${fromDate} to ${toDate} (${full ? "full refresh" : "incremental"})`);

    const matchesPath = path.join(outDir, "matches.json");
    const matches = mergeRows(
        full ? [] : readRows(matchesPath),
        await fetchDatedTable("match", "[[game::cs2]] AND [[finished::1]]", ranges),
        window
    );
    console.log(`Stored ${matches.length} matches.`);
    fs.writeFileSync(matchesPath, JSON.stringify(matches, null, 2), "utf8");

    // Tournaments span their own date range rather than one date, so the whole window is refetched (2 pages).
    console.log("Fetching /tournament...");
    const tournaments = await fetchLiquipediaAll("tournament", {
        conditions: `[[game::cs2]] AND [[startdate::>${addDays(fromDate, -1)}]] AND [[startdate::<${addDays(toDate, 1)}]]`,
        order: "objectname ASC",
        limit: 500,
    });
    console.log(`Stored ${tournaments.length} tournaments.`);
    fs.writeFileSync(path.join(outDir, "tournaments.json"), JSON.stringify(tournaments, null, 2), "utf8");

    const placementsPath = path.join(outDir, "placements.json");
    const placements = mergeRows(
        full ? [] : readRows(placementsPath),
        await fetchDatedTable("placement", "[[game::cs2]]", ranges),
        window
    );
    console.log(`Stored ${placements.length} placements.`);
    fs.writeFileSync(placementsPath, JSON.stringify(placements, null, 2), "utf8");

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

    await fetchSquads(outDir, matches as Array<Record<string, unknown>>, today);

    try {
        await fetchUpcoming(outDir, today, loadEventConfigs().map((c) => c.liquipedia));
    } catch (err) {
        console.warn(`Warning: upcoming fetch failed, keeping the stored upcoming.json: ${(err as Error).message}`);
    }

    const nextMeta: StoreMeta = {
        from: fromDate,
        to: toDate,
        lastFullRefresh: full || !meta ? today : meta.lastFullRefresh,
    };
    fs.writeFileSync(metaPath, JSON.stringify(nextMeta, null, 2), "utf8");

    console.log(`All raw data written to ${outDir}`);
};

main().catch((err) => {
    console.error("fetch-liquipedia failed:", err);
    process.exit(1);
});
