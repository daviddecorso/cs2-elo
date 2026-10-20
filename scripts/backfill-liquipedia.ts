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
}

const parseArgs = () => {
    const args = process.argv.slice(2);
    const option = (name: string) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    return {
        fromMonth: option("from") ?? "2023-10",
        toMonth: option("to"),
        maxRequests: Number(option("max-requests") ?? 30),
    };
};

const main = async () => {
    const { fromMonth, toMonth: toArg, maxRequests } = parseArgs();
    const rawDir = path.resolve(process.cwd(), "data/raw");
    const archiveDir = path.join(rawDir, "archive");
    fs.mkdirSync(archiveDir, { recursive: true });

    // The hot store covers its window; the archive runs up to the end of the month it starts in.
    const hotMeta = JSON.parse(fs.readFileSync(path.join(rawDir, "meta.json"), "utf8")) as { from: string };
    const toMonth = toArg ?? hotMeta.from.slice(0, 7);

    const metaPath = path.join(archiveDir, "meta.json");
    const meta: ArchiveMeta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : { done: [] };
    const done = new Set(meta.done);

    const pending: string[] = [];
    for (let month = fromMonth; month <= toMonth; month = addMonths(month, 1)) {
        if (!done.has(month)) pending.push(month);
    }
    console.log(`Archive ${fromMonth} to ${toMonth}: ${done.size} months done, ${pending.length} pending.`);

    for (const month of pending) {
        const used = getNetworkRequestCount();
        if (maxRequests - used < MONTH_RESERVE) {
            console.log(`Stopping with ${used} requests used; run again after the hourly limit resets.`);
            break;
        }

        const from = `${month}-01`;
        const to = monthEnd(month);
        console.log(`Fetching ${month}...`);
        try {
            const matches = await fetchLiquipediaAll("match", {
                conditions: `[[game::cs2]] AND [[finished::1]] AND [[date::>${addDays(from, -1)} 23:59:59]] AND [[date::<${addDays(to, 1)} 00:00:00]]`,
                query: MATCH_FIELDS,
                order: "objectname ASC",
                limit: 500,
            });
            const tournaments = await fetchLiquipediaAll("tournament", {
                conditions: `[[game::cs2]] AND [[startdate::>${addDays(from, -1)}]] AND [[startdate::<${addDays(to, 1)}]]`,
                order: "objectname ASC",
                limit: 500,
            });
            fs.writeFileSync(path.join(archiveDir, `matches-${month}.json`), JSON.stringify(matches));
            fs.writeFileSync(path.join(archiveDir, `tournaments-${month}.json`), JSON.stringify(tournaments));
            done.add(month);
            fs.writeFileSync(metaPath, JSON.stringify({ done: [...done].sort() }, null, 2));
            console.log(`  ${matches.length} matches, ${tournaments.length} tournaments.`);
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
