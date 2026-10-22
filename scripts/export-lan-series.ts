import fs from "node:fs";
import path from "node:path";
import { addDays, type Row } from "./lib/liquipedia/rawStore.ts";

// demos/ runs on a local machine without data/raw/; the nightly job hands it recent tier-1 LAN rows as an artifact.
const DAYS = 30;

const main = () => {
    const rows = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data/raw/matches.json"), "utf8")) as Row[];
    const since = addDays(new Date().toISOString().slice(0, 10), -DAYS);
    const out = rows.filter(
        (r) =>
            r.game === "cs2" &&
            r.finished &&
            String(r.liquipediatier) === "1" &&
            r.type === "Offline" &&
            String(r.date ?? "") >= since
    );
    fs.writeFileSync(path.resolve(process.cwd(), "data/lan-series.json"), JSON.stringify(out));
    console.log(`Exported ${out.length} tier-1 LAN matches since ${since}.`);
};

main();
