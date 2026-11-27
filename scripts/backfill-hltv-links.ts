import fs from "node:fs";
import path from "node:path";
import { fetchLiquipediaAll, getNetworkRequestCount } from "./lib/liquipedia/client.ts";
import { addDays } from "./lib/liquipedia/rawStore.ts";

// The archive in data/raw/archive/ was fetched without `links`, so demos/ can't find HLTV match IDs before the hot store.
// `--from` / `--to` (YYYY-MM-DD, `--to` exclusive) default to 2025-01-01 and the hot store's start.
const args = process.argv.slice(2);
const option = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const FROM = option("from") ?? "2025-01-01";
// `--wide` matches `cs2demos auto --wide`: tier 1 and 2, LAN and online.
const WIDE = args.includes("--wide");
const SCOPE = WIDE ? "([[liquipediatier::1]] OR [[liquipediatier::2]])" : "[[liquipediatier::1]] AND [[type::Offline]]";

interface LinkRow {
    match2id?: string;
    links?: { hltv?: Record<string, Record<string, unknown>> } | unknown[];
}

type LinkStore = Record<string, { hltv: number; source: string }>;

const hltvMatchId = (row: LinkRow): number | null => {
    const links = row.links;
    if (!links || Array.isArray(links)) return null;
    const url = String(links.hltv?.["1"]?.["1"] ?? "");
    const m = /\/matches\/(\d+)/.exec(url);
    return m ? Number(m[1]) : null;
};

const main = async () => {
    const rawDir = path.resolve(process.cwd(), "data/raw");
    const hotFrom = option("to") ?? (JSON.parse(fs.readFileSync(path.join(rawDir, "meta.json"), "utf8")) as { from: string }).from;
    if (![FROM, hotFrom].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) || FROM >= hotFrom) throw new Error(`Bad range ${FROM} to ${hotFrom}`);
    const outPath = path.resolve(process.cwd(), "data/demos/hltv-links.json");
    const store: LinkStore = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};

    console.log(`Fetching ${WIDE ? "tier-1 and tier-2" : "tier-1 offline"} match links ${FROM} to ${hotFrom}...`);
    const rows = await fetchLiquipediaAll<LinkRow>("match", {
        conditions: `[[game::cs2]] AND [[finished::1]] AND ${SCOPE} AND [[date::>${addDays(FROM, -1)} 23:59:59]] AND [[date::<${hotFrom} 00:00:00]]`,
        query: "pagename,objectname,match2id,links",
        order: "objectname ASC",
        limit: 500,
    });

    let linked = 0;
    for (const row of rows) {
        const id = hltvMatchId(row);
        if (!row.match2id || !id) continue;
        store[row.match2id] = { hltv: id, source: "liquipedia" };
        linked += 1;
    }
    const sorted = Object.fromEntries(Object.entries(store).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(outPath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`${linked}/${rows.length} matches have an HLTV link. Used ${getNetworkRequestCount()} API requests.`);
};

main().catch((err) => {
    console.error("backfill-hltv-links failed:", err);
    process.exit(1);
});
