import fs from "node:fs";
import path from "node:path";
import { addDays, type Row } from "./lib/liquipedia/rawStore.ts";

// demos/ runs on a local machine without data/raw/; the nightly job hands it recent tier-1 and tier-2 rows as an artifact.
// The name predates `cs2demos auto --wide`, which is what reads the online and tier-2 rows.
const DAYS = 30;

const main = () => {
    const rows = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data/raw/matches.json"), "utf8")) as Row[];
    const since = addDays(new Date().toISOString().slice(0, 10), -DAYS);
    const out = rows.filter(
        (r) => r.game === "cs2" && r.finished && ["1", "2"].includes(String(r.liquipediatier)) && String(r.date ?? "") >= since
    );
    fs.writeFileSync(path.resolve(process.cwd(), "data/lan-series.json"), JSON.stringify(out));
    console.log(`Exported ${out.length} tier-1 and tier-2 matches since ${since}.`);
};

main();
