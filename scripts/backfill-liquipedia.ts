import fs from "node:fs";
import path from "node:path";
import { fetchLiquipediaAll, getNetworkRequestCount } from "./lib/liquipedia/client.ts";
import { addDays } from "./lib/liquipedia/rawStore.ts";
import { addMonths, monthEnd } from "./lib/elo/history.ts";

// Everything buildMatchdata and the Elo normalizer read; dropping streams, icons and links roughly halves the payload.
const MATCH_FIELDS = [
    "pagename",
    "objectname",
    "match2id",
    "match2bracketid",
    "match2bracketdata",
    "winner",
    "walkover",
    "resulttype",
    "finished",
    "bestof",
    "date",
    "type",
    "game",
    "tournament",
    "parent",
    "liquipediatier",
    "publishertier",
    "extradata",
    "match2games",
    "match2opponents",
].join(",");

// A month is a few pages; starting one with less budget left than this risks overrunning the cap mid-month.
const MONTH_RESERVE = 8;

interface ArchiveMeta {
    done: string[];
    placementsDone?: string[];
}

const parseArgs = () => {
    const args = process.argv.slice(2);
    const option = (name: string) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const game = option("game") ?? "cs2";
    if (game !== "cs2" && game !== "csgo") throw new Error(`--game must be cs2 or csgo, not ${game}`);
    return {
        game,
        fromMonth: option("from") ?? (game === "csgo" ? "2022-01" : "2023-10"),
        toMonth: option("to") ?? (game === "csgo" ? "2023-09" : undefined),
        maxRequests: Number(option("max-requests") ?? 30),
    };
};

const main = async () => {
    const { game, fromMonth, toMonth: toArg, maxRequests } = parseArgs();
    const rawDir = path.resolve(process.cwd(), "data/raw");
    // CS:GO rows live apart so the VRS projection, buildMatchdata and the hot store never see them; only the Elo warmup reads them.
    const archiveDir = path.join(rawDir, game === "csgo" ? "archive-csgo" : "archive");
    fs.mkdirSync(archiveDir, { recursive: true });

    // The hot store covers its window; the archive runs up to the end of the month it starts in.
    const hotMeta = JSON.parse(fs.readFileSync(path.join(rawDir, "meta.json"), "utf8")) as { from: string };
    const toMonth = toArg ?? hotMeta.from.slice(0, 7);
    const wantPlacements = game === "cs2";

    const metaPath = path.join(archiveDir, "meta.json");
    const meta: ArchiveMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : { done: [] };
    const done = new Set(meta.done);
    const placementsDone = new Set(meta.placementsDone ?? []);

    const pendingMatches: string[] = [];
    const pendingPlacements: string[] = [];
    for (let month = fromMonth; month <= toMonth; month = addMonths(month, 1)) {
        if (!done.has(month)) pendingMatches.push(month);
        if (wantPlacements && !placementsDone.has(month) && !fs.existsSync(path.join(archiveDir, `placements-${month}.json`))) {
            pendingPlacements.push(month);
        }
    }
    const pending = [...new Set([...pendingMatches, ...pendingPlacements])].sort();
    console.log(
        `Archive ${fromMonth} to ${toMonth}: ${done.size} match months done, ${pendingMatches.length} match pending, ${pendingPlacements.length} placement pending.`
    );

    const saveMeta = () =>
        fs.writeFileSync(
            metaPath,
            JSON.stringify({ done: [...done].sort(), placementsDone: [...placementsDone].sort() }, null, 2)
        );

    for (const month of pending) {
        const used = getNetworkRequestCount();
        if (maxRequests - used < MONTH_RESERVE) {
            console.log(`Stopping with ${used} requests used; run again after the hourly limit resets.`);
            break;
        }

        const from = `${month}-01`;
        const to = monthEnd(month);
        const needMatches = !done.has(month);
        const needPlacements = pendingPlacements.includes(month);
        console.log(`Fetching ${month} (${[needMatches && "matches+tournaments", needPlacements && "placements"].filter(Boolean).join(", ")})...`);
        try {
            if (needMatches) {
                const matches = await fetchLiquipediaAll("match", {
                    conditions: `[[game::${game}]] AND [[finished::1]] AND [[date::>${addDays(from, -1)} 23:59:59]] AND [[date::<${addDays(to, 1)} 00:00:00]]`,
                    query: MATCH_FIELDS,
                    order: "objectname ASC",
                    limit: 500,
                });
                const tournaments = await fetchLiquipediaAll("tournament", {
                    conditions: `[[game::${game}]] AND [[startdate::>${addDays(from, -1)}]] AND [[startdate::<${addDays(to, 1)}]]`,
                    order: "objectname ASC",
                    limit: 500,
                });
                fs.writeFileSync(path.join(archiveDir, `matches-${month}.json`), JSON.stringify(matches));
                fs.writeFileSync(path.join(archiveDir, `tournaments-${month}.json`), JSON.stringify(tournaments));
                done.add(month);
                console.log(`  ${matches.length} matches, ${tournaments.length} tournaments.`);
            }
            if (needPlacements) {
                const placements = await fetchLiquipediaAll("placement", {
                    conditions: `[[game::cs2]] AND [[date::>${addDays(from, -1)} 23:59:59]] AND [[date::<${addDays(to, 1)} 00:00:00]]`,
                    order: "objectname ASC",
                    limit: 500,
                });
                fs.writeFileSync(path.join(archiveDir, `placements-${month}.json`), JSON.stringify(placements));
                placementsDone.add(month);
                console.log(`  ${placements.length} placements.`);
            }
            saveMeta();
        } catch (err) {
            console.error(`Stopped at ${month}: ${(err as Error).message}`);
            process.exitCode = 1;
            break;
        }
    }

    console.log(`Used ${getNetworkRequestCount()} API requests.`);
};

main().catch((err) => {
    console.error("backfill-liquipedia failed:", err);
    process.exit(1);
});
