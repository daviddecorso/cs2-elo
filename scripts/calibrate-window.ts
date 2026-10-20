import fs from "node:fs";
import path from "node:path";
import { readDetailsSnapshot } from "./lib/vrs/valveDetails.ts";
import { type WindowInterval, bestCoverage } from "./lib/vrs/windowCalibration.ts";

// Valve's age weight is 1 within 30 days of the window end, then falls linearly to 0 at 180 days,
// so a match at t with weight w implies windowEnd = t + 180d − 150d·w.
const DAY = 86400;
// Details files print age weights to 3 decimals.
const WEIGHT_HALF_STEP = 0.0005;

interface Player {
    nick: string;
}

interface Match {
    matchStartTime: number;
    team1Name: string;
    team2Name: string;
    team1Players: Player[];
    team2Players: Player[];
}

const laDate = (unixSeconds: number): string =>
    new Date(unixSeconds * 1000).toLocaleDateString("fr-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });

const args = process.argv.slice(2);
const option = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const date = option("date");
const matchdataPath = path.resolve(process.cwd(), option("matchdata") ?? "data/matchdata.json");
const valveRoot = path.resolve(process.cwd(), option("valve-root") ?? "vendor/counter-strike_regional_standings");
const write = args.includes("--write");

if (!date) {
    console.error(
        "Usage: vite-node scripts/calibrate-window.ts --date <YYYY-MM-DD> [--matchdata <path>] [--valve-root <dir>] [--write]"
    );
    process.exit(1);
}

const { matches } = JSON.parse(fs.readFileSync(matchdataPath, "utf8")) as { matches: Match[] };
const matchesByLaDate = new Map<string, Match[]>();
for (const m of matches) {
    const key = laDate(m.matchStartTime);
    matchesByLaDate.set(key, [...(matchesByLaDate.get(key) ?? []), m]);
}

const overlap = (players: Player[], roster: Set<string>) =>
    players.filter((p) => roster.has(p.nick.toLowerCase())).length;

const intervals: WindowInterval[] = [];
let decaying = 0;
let unmatched = 0;
for (const details of readDetailsSnapshot(valveRoot, date).values()) {
    for (const row of details.matches) {
        if (row.ageWeight <= 0 || row.ageWeight >= 1) continue;
        decaying += 1;
        const roster = new Set(row.roster.map((n) => n.toLowerCase()));
        let candidates = (matchesByLaDate.get(row.date) ?? []).filter(
            (m) => overlap(m.team1Players, roster) >= 3 || overlap(m.team2Players, roster) >= 3
        );
        if (candidates.length > 1) {
            const opponent = row.opponent.toLowerCase();
            candidates = candidates.filter(
                (m) => m.team1Name.toLowerCase() === opponent || m.team2Name.toLowerCase() === opponent
            );
        }
        if (candidates.length !== 1) {
            unmatched += 1;
            continue;
        }
        const t = candidates[0].matchStartTime;
        intervals.push({
            lo: t + 180 * DAY - 150 * DAY * (row.ageWeight + WEIGHT_HALF_STEP),
            hi: t + 180 * DAY - 150 * DAY * (row.ageWeight - WEIGHT_HALF_STEP),
        });
    }
}

if (intervals.length === 0) {
    console.error(`No details rows for ${date} could be matched to ${matchdataPath}.`);
    process.exit(1);
}

const best = bestCoverage(intervals);
// The window ends at the latest match in Valve's pull, so prefer a real match time in the range.
const matchTimes = matches
    .map((m) => m.matchStartTime)
    .filter((t) => t >= best.lo && t <= best.hi)
    .sort((a, b) => b - a);
const windowEnd = matchTimes[0] ?? Math.round((best.lo + best.hi) / 2);

const iso = (t: number) => new Date(t * 1000).toISOString();
console.log(`Snapshot ${date}: ${decaying} decaying rows, ${intervals.length} matched, ${unmatched} unmatched.`);
console.log(`Best range ${iso(best.lo)} – ${iso(best.hi)}, agreed by ${best.count}/${intervals.length} rows.`);
console.log(
    `Window end ${windowEnd} (${iso(windowEnd)})${matchTimes.length > 0 ? ", the latest match in range" : ", range midpoint"}.`
);

if (write) {
    const endsPath = path.resolve(process.cwd(), "scripts/lib/vrs/snapshotWindowEnds.json");
    const file = JSON.parse(fs.readFileSync(endsPath, "utf8"));
    file.windowEnds = Object.fromEntries(
        Object.entries({ ...file.windowEnds, [date]: windowEnd }).sort(([a], [b]) => a.localeCompare(b))
    );
    fs.writeFileSync(endsPath, `${JSON.stringify(file, null, 4)}\n`);
    console.log(`Wrote ${endsPath}.`);
}
