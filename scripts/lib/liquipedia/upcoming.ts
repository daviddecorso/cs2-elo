import fs from "node:fs";
import path from "node:path";
import { fetchLiquipediaAll } from "./client.ts";
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

/** Replaces `upcoming.json` whole, since unfinished rows change until they're played. One request per table per 50 events. */
export const fetchUpcoming = async (outDir: string, today: string, parents: string[]): Promise<UpcomingStore> => {
    console.log(`Fetching /tournament starting ${today} to ${addDays(today, UPCOMING_DAYS)}...`);
    const tournaments = await fetchLiquipediaAll("tournament", {
        conditions: `[[game::cs2]] AND [[startdate::>${today}]] AND [[startdate::<${addDays(today, UPCOMING_DAYS)}]]`,
        order: "objectname ASC",
        limit: 500,
    });

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
