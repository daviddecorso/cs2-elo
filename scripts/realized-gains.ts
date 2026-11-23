import fs from "node:fs";
import path from "node:path";
import { EloEngine } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";
import { readMatchHistory } from "./lib/sim/history.ts";
import { readJson } from "./lib/sim/inputs.ts";
import { canonicalEventId } from "./lib/sim/vrsProjection.ts";
import type { Overrides } from "./lib/vrs/buildMatchdata.ts";
import { freeze, scoreTeam, withoutEvents } from "./lib/vrs/oneTeam.ts";
import { publishedSnapshotDates } from "./lib/vrs/publishedStandings.ts";
import { loadWorld, rerun } from "./lib/vrs/valveWorld.ts";

/** What each event a ranked roster finished added to its VRS points at the next published list, with its strength against the field going in; see `docs/vrs-simulator.md`, "Realized gains". */

const VALVE_ROOT = path.resolve("vendor/counter-strike_regional_standings");
const OUT = path.resolve(".cache/realized-gains.json");
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const FROM = option("from", "2026-02-02");
const RANKS: [number, number] = [1, 150];
const MIN_SHARED_PLAYERS = 3;

export interface RealizedGain {
    date: string;
    eventId: string;
    rosterKey: string;
    teamName: string;
    /** Lowercase nicks, to match the roster across lists. */
    players: string[];
    globalRank: number;
    points: number;
    gain: number;
    seedGain: number;
    lan: boolean;
    prizePool: number;
    prize: number;
    matches: number;
    wins: number;
    tier: number | null;
    /** Pre-event Elo of the roster and the mean of the other teams' at the event; null when the Elo feed doesn't cover it. */
    elo: number | null;
    fieldElo: number | null;
    fieldTop: number | null;
    teams: number;
}

const overrides = readJson<Overrides>("data/overrides.json", {});
const started = Date.now();

// --- Pre-event Elo per event and lineup, from each team's first series there.
const feed = loadFeed();
const predictions = new EloEngine(DEFAULT_PARAMS, feed.players).run(feed.matches);
interface Entrant {
    players: Set<string>;
    rating: number;
}
const entrantsByEvent = new Map<string, { tier: number | null; entrants: Map<string, Entrant> }>();
for (const p of predictions) {
    const page = p.id.slice(0, p.id.lastIndexOf(":"));
    const eventId = canonicalEventId(overrides, page);
    let e = entrantsByEvent.get(eventId);
    if (!e) entrantsByEvent.set(eventId, (e = { tier: p.tier, entrants: new Map() }));
    p.teams.forEach((team, side) => {
        if (!e!.entrants.has(team)) e!.entrants.set(team, { players: new Set(p.lineups[side].map((x) => x.toLowerCase())), rating: p.ratings[side] });
    });
}
console.log(`Elo: ${predictions.length} series over ${entrantsByEvent.size} events.`);

const history = readMatchHistory();
const dates = publishedSnapshotDates(VALVE_ROOT, ["invitation"])
    .sort()
    .filter((d) => d >= FROM);
const rows: RealizedGain[] = [];
let previous = publishedSnapshotDates(VALVE_ROOT, ["invitation"])
    .sort()
    .filter((d) => d < FROM)
    .at(-1)!;
for (const date of dates) {
    const world = loadWorld(history.matches, history.events, date, { windowEndsAtPull: true });
    const base = rerun(world);
    const frozen = freeze(base.state);
    const rankOf = new Map(base.standings.rosters.map((r) => [r.rosterKey, r]));
    const since = Date.parse(`${previous}T00:00:00Z`) / 1000;
    const until = Date.parse(`${date}T00:00:00Z`) / 1000;
    let count = 0;
    frozen.rosters.forEach((roster, i) => {
        const listed = rankOf.get(roster.rosterKey);
        if (!listed || listed.globalRank === null || listed.globalRank < RANKS[0] || listed.globalRank > RANKS[1]) return;
        const ledger = frozen.ledgers[i];
        const players = new Set(roster.playerIds.map((p) => String(p).toLowerCase()));
        for (const ev of ledger.events) {
            if (ev.lastMatchTime <= since || ev.lastMatchTime > until) continue;
            const without = scoreTeam(frozen, withoutEvents(ledger, new Set([ev.eventId])), { rank: false });
            const own = ledger.matches.filter((m) => m.eventId === ev.eventId);
            if (own.length === 0) continue;
            const elo = entrantsByEvent.get(ev.eventId);
            const entrants = elo ? [...elo.entrants.values()] : [];
            const self = entrants.find((x) => [...players].filter((p) => x.players.has(p)).length >= MIN_SHARED_PLAYERS);
            const others = entrants.filter((x) => x !== self).map((x) => x.rating).sort((a, b) => b - a);
            rows.push({
                date,
                eventId: ev.eventId,
                rosterKey: roster.rosterKey,
                teamName: roster.name,
                players: listed.players.map((p) => p.toLowerCase()),
                globalRank: listed.globalRank,
                points: roster.points,
                gain: roster.points - without.points,
                seedGain: roster.seedRating - without.seedRating,
                lan: own[0].lan,
                prizePool: own[0].prizePool,
                prize: ev.prize,
                matches: own.length,
                wins: own.filter((m) => m.won).length,
                tier: elo?.tier ?? null,
                elo: self?.rating ?? null,
                fieldElo: self && others.length ? others.reduce((s, x) => s + x, 0) / others.length : null,
                fieldTop: self && others.length ? others.slice(0, 4).reduce((s, x) => s + x, 0) / Math.min(4, others.length) : null,
                teams: entrants.length,
            });
            count++;
        }
    });
    console.log(`  ${date}: ${count} roster-events finished since ${previous}.`);
    previous = date;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows));

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const withElo = rows.filter((r) => r.elo !== null && r.fieldElo !== null);
console.log(`\n${rows.length} roster-events, ${withElo.length} with Elo for the team and its field. Mean gain by kind and rank:`);
for (const [label, keep] of [
    ["LAN", (r: RealizedGain) => r.lan],
    ["online", (r: RealizedGain) => !r.lan],
] as const) {
    for (const [lo, hi] of [
        [1, 14],
        [15, 80],
        [81, 150],
    ]) {
        const g = rows.filter((r) => keep(r) && r.globalRank >= lo && r.globalRank <= hi);
        console.log(`  ${label.padEnd(6)} ranks ${lo}-${hi}: n ${String(g.length).padStart(4)}, mean gain ${mean(g.map((r) => r.gain)).toFixed(1)}, mean seed part ${mean(g.map((r) => r.seedGain)).toFixed(1)}`);
    }
}
console.log(`Wrote ${OUT} in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
