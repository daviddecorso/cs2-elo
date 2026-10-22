import fs from "node:fs";
import path from "node:path";
import type { EloRankings, EloRoster } from "../src/elo/types.ts";
import type { Region } from "../src/vrs/types.ts";
import { EloEngine } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";
import { findVrsRoster, makeNickLookup, readGlobalSnapshots, type VrsRoster } from "./lib/elo/vrsBaseline.ts";
import type { Overrides } from "./lib/vrs/buildMatchdata.ts";
import { saveJson } from "./lib/writeJson.ts";

const ACTIVE_DAYS = 90;
const MIN_MAPS = 15;
const REGIONS: Region[] = ["Europe", "Americas", "Asia"];
const TEAM_MAP_PATH = path.resolve("data/elo/vrsTeamMap.json");

type TeamMap = Record<string, { vrsTeam: string; reason: string }>;

const updateTeamMap = process.argv.includes("--update-team-map");

const feed = loadFeed();
const engine = new EloEngine(DEFAULT_PARAMS, feed.players);
engine.run(feed.matches);

const lastT = feed.matches.at(-1)!.t;
const asOf = new Date(lastT * 1000).toISOString().slice(0, 10);
const active = engine.lineages
    .filter((l) => l.lastT >= lastT - ACTIVE_DAYS * 86400 && l.maps >= MIN_MAPS)
    .sort((a, b) => b.rating - a.rating);

const overrides = JSON.parse(fs.readFileSync(path.resolve("data/overrides.json"), "utf8")) as Overrides;
const nicksOf = makeNickLookup(feed.players, overrides.playerAliases);
const snapshot = readGlobalSnapshots().at(-1)!;
const teamMap: TeamMap = fs.existsSync(TEAM_MAP_PATH) ? JSON.parse(fs.readFileSync(TEAM_MAP_PATH, "utf8")) : {};

// Player overlap first, as Valve does; the committed team map covers rosters that changed since the snapshot.
const vrsFor = (team: string, core: string[]): VrsRoster | null => {
    const byPlayers = findVrsRoster(snapshot, core, nicksOf);
    if (byPlayers) {
        if (updateTeamMap && !teamMap[team]) {
            teamMap[team] = { vrsTeam: byPlayers.teamName, reason: `3+ of 5 players on ${byPlayers.teamName}, ${snapshot.date}` };
        }
        return byPlayers;
    }
    const mapped = teamMap[team]?.vrsTeam;
    return mapped ? (snapshot.rosters.find((r) => r.teamName === mapped) ?? null) : null;
};

const squadsPath = path.resolve("data/raw/squads.json");
const squads = new Map<string, Set<string>>();
if (fs.existsSync(squadsPath)) {
    const { rows } = JSON.parse(fs.readFileSync(squadsPath, "utf8")) as { rows: Array<{ pagename: string; link: string }> };
    for (const { pagename, link } of rows) {
        const team = pagename.replace(/_/g, " ");
        if (!squads.has(team)) squads.set(team, new Set());
        squads.get(team)!.add(link.toLowerCase());
    }
}
const departedFrom = (team: string, core: string[]): string[] => {
    const squad = squads.get(team);
    return squad ? core.filter((p) => !squad.has(p.toLowerCase().replace(/_/g, " "))).map((p) => feed.players[p]?.nick ?? p) : [];
};

const pool = engine.activePool(lastT);
const rosters: EloRoster[] = active.map((l, i) => {
    const vrs = vrsFor(l.team, l.core);
    return {
        rank: i + 1,
        team: l.team,
        players: l.core.map((page) => ({ page, nick: feed.players[page]?.nick ?? page })),
        rating: Math.round(l.rating * 10) / 10,
        mapOffsets: Object.fromEntries(pool.map((m) => [m, Math.round((l.mapOffsets.get(m) ?? 0) * 10) / 10])),
        maps: l.maps,
        lastMatch: new Date(l.lastT * 1000).toISOString().slice(0, 10),
        region: l.region === null ? null : REGIONS[l.region],
        vrs: vrs ? { rank: vrs.rank, points: vrs.points, teamName: vrs.teamName } : null,
        departed: departedFrom(l.team, l.core),
    };
});

if (updateTeamMap) {
    const sorted = Object.fromEntries(Object.entries(teamMap).sort(([a], [b]) => a.localeCompare(b)));
    fs.mkdirSync(path.dirname(TEAM_MAP_PATH), { recursive: true });
    fs.writeFileSync(TEAM_MAP_PATH, `${JSON.stringify(sorted, null, 4)}\n`);
    console.log(`Wrote ${Object.keys(sorted).length} entries to ${path.relative(process.cwd(), TEAM_MAP_PATH)}`);
}

const out: EloRankings = { generatedAt: new Date().toISOString(), asOf, vrsSnapshot: snapshot.date, pool, rosters };
saveJson(
    path.resolve("public/data/elo/latest.json"),
    JSON.stringify(out),
    `${rosters.length} rosters, ${rosters.filter((r) => r.vrs).length} with VRS`
);
