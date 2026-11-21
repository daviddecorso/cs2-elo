import fs from "node:fs";
import path from "node:path";
import type { EloGame, EloGameLog, EloRankings, EloRoster } from "../src/elo/types.ts";
import { teamSlug } from "../src/utils/teams.ts";
import type { Region } from "../src/vrs/types.ts";
import { EloEngine } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";
import { findVrsRoster, makeNickLookup, readGlobalSnapshots, type VrsRoster } from "./lib/elo/vrsBaseline.ts";
import type { Overrides } from "./lib/vrs/buildMatchdata.ts";
import { saveJson, writeJsonIfChanged } from "./lib/writeJson.ts";

const ACTIVE_DAYS = 90;
const GAME_LOG_DAYS = 180;
const MIN_MAPS = 15;
const REGIONS: Region[] = ["Europe", "Americas", "Asia"];
const TEAM_MAP_PATH = path.resolve("data/elo/vrsTeamMap.json");

type TeamMap = Record<string, { vrsTeam: string; reason: string }>;

const updateTeamMap = process.argv.includes("--update-team-map");

const feed = loadFeed();
const engine = new EloEngine(DEFAULT_PARAMS, feed.players);
const predictions = engine.run(feed.matches);
const matchById = new Map(feed.matches.map((m) => [m.id, m]));

const lastT = feed.matches.at(-1)!.t;
const asOf = new Date(lastT * 1000).toISOString().slice(0, 10);
// Oceania's prior is in the update, so its raw ratings sit on their own scale; publish rating + prior.
const publishedRating = (l: (typeof engine.lineages)[number]) => l.rating + engine.regionPrior(l);
const active = engine.lineages
    .filter((l) => l.lastT >= lastT - ACTIVE_DAYS * 86400 && l.maps >= MIN_MAPS)
    .sort((a, b) => publishedRating(b) - publishedRating(a));

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
        rating: Math.round(publishedRating(l) * 10) / 10,
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

const round1 = (n: number) => Math.round(n * 10) / 10;
const gamesFrom = lastT - GAME_LOG_DAYS * 86400;
const ranked = new Set(rosters.map((r) => r.team));
const gamesByTeam = new Map<string, EloGame[]>();
for (let i = predictions.length - 1; i >= 0 && predictions[i].t >= gamesFrom; i--) {
    const s = predictions[i];
    s.teams.forEach((team, side) => {
        if (!ranked.has(team)) return;
        const match = matchById.get(s.id)!;
        const opp = 1 - side;
        const won = (s.y === 1) === (side === 0);
        const mapsWon = s.maps.filter((m) => (m.y === 1) === (side === 0)).length;
        const game: EloGame = {
            date: new Date(s.t * 1000).toISOString().slice(0, 10),
            event: match.event,
            tier: s.tier,
            lan: s.lan,
            bestOf: s.bestOf,
            opponent: s.teams[opp],
            won,
            score: [mapsWon, s.maps.length - mapsWon],
            maps: s.maps.map((m, j) => {
                const rounds = match.maps[j].rounds;
                return { map: m.map, rounds: side === 0 ? rounds : [rounds[1], rounds[0]] };
            }),
            elo: round1(s.ratings[side] + s.regionPriors[side]),
            oppElo: round1(s.ratings[opp] + s.regionPriors[opp]),
            p: Math.round((side === 0 ? s.p : 1 - s.p) * 1000) / 1000,
            delta: round1(s.after[side] - s.ratings[side]),
        };
        if (!gamesByTeam.has(team)) gamesByTeam.set(team, []);
        gamesByTeam.get(team)!.push(game);
    });
}

const gamesDir = path.resolve("public/data/elo/games");
const slugs = new Set<string>();
let written = 0;
for (const [team, games] of gamesByTeam) {
    const slug = teamSlug(team);
    slugs.add(slug);
    const log: EloGameLog = { generatedAt: new Date().toISOString(), team, from: new Date(gamesFrom * 1000).toISOString().slice(0, 10), games };
    if (writeJsonIfChanged(path.join(gamesDir, `${slug}.json`), JSON.stringify(log))) written++;
}
let removed = 0;
for (const file of fs.existsSync(gamesDir) ? fs.readdirSync(gamesDir) : []) {
    if (!slugs.has(file.replace(/\.json$/, ""))) {
        fs.rmSync(path.join(gamesDir, file));
        removed++;
    }
}
console.log(`Game logs: ${gamesByTeam.size} teams, ${written} written, ${removed} removed`);
