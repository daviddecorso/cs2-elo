import fs from "node:fs";
import path from "node:path";
import { addMonths, FREEZE_AFTER_DAYS, monthEnd } from "./lib/elo/history.ts";
import type { RawRow } from "./lib/elo/normalize.ts";
import { attendanceOf, HISTORY_FROM, readHistoryRows, readMatchHistory, SIM_HISTORY_DIR, type FrozenSimMonth } from "./lib/sim/history.ts";

/** Writes each settled month the sim's history models read into `data/history/sim/`, from whatever local store covers it; existing months are kept unless `--force`. */

const TOURNAMENT_FIELDS = [
    "pagename",
    "name",
    "seriespage",
    "previous",
    "previous2",
    "next",
    "next2",
    "type",
    "organizers",
    "startdate",
    "enddate",
    "locations",
    "prizepool",
    "participantsnumber",
    "liquipediatier",
    "liquipediatiertype",
    "publishertier",
    "status",
];
const PLACEMENT_FIELDS = [
    "pagename",
    "parent",
    "tournament",
    "date",
    "startdate",
    "placement",
    "prizemoney",
    "opponentname",
    "opponenttemplate",
    "opponenttype",
    "qualifier",
    "qualifierpage",
    "type",
    "liquipediatier",
    "liquipediatiertype",
    "publishertier",
];
const pick = (row: RawRow, fields: string[]): RawRow => Object.fromEntries(fields.filter((f) => row[f] !== undefined && row[f] !== "").map((f) => [f, row[f]]));
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

const force = process.argv.includes("--force");
const today = new Date().toISOString().slice(0, 10);
const settledBy = new Date(Date.parse(`${today}T00:00:00Z`) - FREEZE_AFTER_DAYS * 86400000).toISOString().slice(0, 10);
const { tournamentRows, placementRows } = readHistoryRows("data/raw", "/nonexistent");
const matchdata = readMatchHistory();

const rowByPage = new Map<string, RawRow>();
for (const r of tournamentRows) rowByPage.set(str(r.pagename), r);
// A month is only frozen when a store holds all of it, so CI's rolling hot store never writes a partial first month.
const rowsFrom = [...rowByPage.values()].map((r) => str(r.startdate)).filter(Boolean).sort()[0] ?? "9999";
const matchesFrom = new Date(matchdata.matches.reduce((t, m) => Math.min(t, m.matchStartTime), Infinity) * 1000).toISOString().slice(0, 10);
const coveredFrom = rowsFrom > matchesFrom ? rowsFrom : matchesFrom;

const firstMatch = new Map<string, number>();
for (const m of matchdata.matches) firstMatch.set(String(m.eventId), Math.min(firstMatch.get(String(m.eventId)) ?? Infinity, m.matchStartTime));
const attendance = attendanceOf(matchdata);
const monthOfTime = (t: number) => new Date(t * 1000).toISOString().slice(0, 7);

fs.mkdirSync(SIM_HISTORY_DIR, { recursive: true });
const written: string[] = [];
for (let month = HISTORY_FROM.slice(0, 7); monthEnd(month) <= settledBy; month = addMonths(month, 1)) {
    const file = path.join(SIM_HISTORY_DIR, `${month}.json`);
    if (fs.existsSync(file) && !force) continue;
    if (`${month}-01` < coveredFrom) continue;
    const tournaments = [...rowByPage.values()].filter((r) => str(r.startdate).slice(0, 7) === month);
    const pages = new Set(tournaments.map((r) => str(r.pagename)));
    const placements = placementRows.filter((r) => r.pagename === r.parent && r.opponenttype === "team" && pages.has(str(r.parent)));
    const out: FrozenSimMonth = {
        month,
        tournaments: tournaments.map((r) => pick(r, TOURNAMENT_FIELDS)),
        placements: [...new Map(placements.map((r) => [`${str(r.parent)}|${str(r.opponentname)}|${str(r.placement)}`, pick(r, PLACEMENT_FIELDS)])).values()],
        attendance: [...attendance]
            .filter(([id]) => monthOfTime(firstMatch.get(id) ?? 0) === month)
            .map(([eventId, teams]) => ({ eventId, teams: [...teams].map(([teamId, players]) => ({ teamId, players })) })),
    };
    fs.writeFileSync(file, JSON.stringify(out));
    written.push(`${month} (${out.tournaments.length} tournaments, ${out.placements.length} placement rows, ${out.attendance.length} events)`);
}
console.log(written.length ? `Froze ${written.length} months into ${SIM_HISTORY_DIR}/:\n  ${written.join("\n  ")}` : "No new months to freeze.");
