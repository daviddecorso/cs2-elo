import fs from "node:fs";
import path from "node:path";
import { fetchLiquipediaAll } from "./client.ts";
import { catalogParents, rankedRules } from "../sim/catalog.ts";
import { addDays, type Row } from "./rawStore.ts";

export const UPCOMING_DAYS = 200;

export interface UpcomingStore {
    fetched: string;
    /** Tournaments starting after today, for finding pages to configure. */
    tournaments: Row[];
    /** Unfinished matches on configured events and their stage pages; their finished matches come from `matches.json`. */
    matches: Row[];
    placements: Row[];
}

/** `parent` is the event's main page on every stage subpage's rows, and on the main page's own rows. */
const parentConditions = (parents: string[]) => parents.map((p) => `[[parent::${p.replace(/ /g, "_")}]]`).join(" OR ");

const MAX_PARENTS = 100;

/** Replaces `upcoming.json` whole, since unfinished rows change until they're played; one request per table per 50 parent pages. */
export const fetchUpcoming = async (outDir: string, today: string, configured: string[]): Promise<UpcomingStore> => {
    const until = addDays(today, UPCOMING_DAYS);
    console.log(`Fetching /tournament starting ${today} to ${until}...`);
    const tournaments = await fetchLiquipediaAll("tournament", {
        conditions: `[[game::cs2]] AND [[startdate::>${today}]] AND [[startdate::<${until}]]`,
        order: "objectname ASC",
        limit: 500,
    });

    const storedFile = path.join(outDir, "tournaments.json");
    const stored = fs.existsSync(storedFile) ? (JSON.parse(fs.readFileSync(storedFile, "utf8")) as Row[]) : [];
    const overridesFile = path.resolve("data/overrides.json");
    const overrides = fs.existsSync(overridesFile) ? JSON.parse(fs.readFileSync(overridesFile, "utf8")) : {};
    const { parents, dropped } = catalogParents(configured, [...stored, ...tournaments], today, until, MAX_PARENTS, rankedRules(overrides), "all");
    if (dropped) console.warn(`Warning: ${dropped} catalog pages over the ${MAX_PARENTS}-page cap were not fetched.`);

    const matches: Row[] = [];
    const placements: Row[] = [];
    for (let i = 0; i < parents.length; i += 50) {
        const batch = parentConditions(parents.slice(i, i + 50));
        console.log(`Fetching unfinished /match and /placement for ${Math.min(50, parents.length - i)} events...`);
        matches.push(
            ...(await fetchLiquipediaAll("match", {
                conditions: `(${batch}) AND [[finished::0]]`,
                order: "objectname ASC",
                limit: 500,
            }))
        );
        placements.push(
            ...(await fetchLiquipediaAll("placement", { conditions: `(${batch})`, order: "objectname ASC", limit: 500 }))
        );
    }

    const store: UpcomingStore = { fetched: today, tournaments, matches, placements };
    fs.writeFileSync(path.join(outDir, "upcoming.json"), JSON.stringify(store), "utf8");
    console.log(
        `Stored ${tournaments.length} upcoming tournaments, ${matches.length} unfinished matches, ${placements.length} placements.`
    );
    return store;
};

export const readUpcoming = (outDir = path.resolve("data/raw")): UpcomingStore | null => {
    const file = path.join(outDir, "upcoming.json");
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as UpcomingStore) : null;
};
