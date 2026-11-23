import type { EloGameLog, EloMatchesData, EloRankings } from "../elo/types.ts";
import { teamSlug } from "../utils/teams.ts";
import { fetchSimJson } from "../sim/fetch.ts";
import type { EventIndexEntry, PlanEvents, PlanIndex, PlanTeamFile, SeasonEventFile, SeasonIndex } from "../sim/types.ts";
import type { HeatmapAverageData, HeatmapIndex, HeatmapMapData } from "../war/heatmapTypes.ts";
import type { ClutchData, PlayerWarData, StyleData, TacticsData, TeamDuelsData, TeamStatsData } from "../war/types.ts";

const fetchJson = async <T>(file: string, what: string): Promise<T> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${file}`);
    if (!res.ok) throw new Error(`Failed to load ${what}: HTTP ${res.status}`);
    return res.json();
};

/** Null on a 404: the file is only written once its `cs2wp ... --publish` step has run. */
const fetchOptionalJson = async <T>(
    file: string,
    what: string,
    base = `${import.meta.env.BASE_URL}data/`
): Promise<T | null> => {
    const prefix = base.endsWith("/") ? base : `${base}/`;
    const res = await fetch(`${prefix}${file}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load ${what}: HTTP ${res.status}`);
    return res.json();
};

const HEATMAPS_BASE = (
    import.meta.env.VITE_HEATMAPS_URL || `${import.meta.env.BASE_URL}data/war/heatmaps/`
).replace(/\/?$/, "/");

export const eloRankingsQuery = {
    queryKey: ["elo", "latest"],
    queryFn: () => fetchJson<EloRankings>("elo/latest.json", "Elo rankings"),
};

export const eloMatchesQuery = {
    queryKey: ["elo", "matches"],
    queryFn: () => fetchJson<EloMatchesData>("elo/matches.json", "matches"),
};

/** Null for teams with no rated series in the log window. */
export const eloGamesQuery = (team: string) => ({
    queryKey: ["elo", "games", team],
    queryFn: () => fetchOptionalJson<EloGameLog>(`elo/games/${teamSlug(team)}.json`, "game log"),
});

export const playerWarQuery = {
    queryKey: ["war", "players"],
    queryFn: () => fetchJson<PlayerWarData>("war/players.json", "player WAR"),
};

export const teamDuelsQuery = {
    queryKey: ["war", "team-duels"],
    queryFn: () => fetchOptionalJson<TeamDuelsData>("war/team-duels.json", "team duels"),
};

export const teamStatsQuery = {
    queryKey: ["war", "team-stats"],
    queryFn: () => fetchOptionalJson<TeamStatsData>("war/team-stats.json", "team round stats"),
};

export const tacticsQuery = {
    queryKey: ["war", "tactics"],
    queryFn: () => fetchOptionalJson<TacticsData>("war/tactics.json", "tactics stats"),
};

export const planIndexQuery = {
    queryKey: ["sim", "plan", "index"],
    queryFn: () => fetchSimJson<PlanIndex>("plan/index.json"),
};

export const planTeamQuery = (file: string) => ({
    queryKey: ["sim", "plan", "team", file],
    queryFn: () => fetchSimJson<PlanTeamFile>(`plan/${encodeURIComponent(file)}`),
});

export const planEventsQuery = {
    queryKey: ["sim", "plan", "events"],
    queryFn: () => fetchSimJson<PlanEvents>("plan/events.json"),
};

export const eventIndexQuery = {
    queryKey: ["sim", "events"],
    queryFn: () => fetchSimJson<EventIndexEntry[]>("events/index.json"),
};

export const seasonIndexQuery = {
    queryKey: ["sim", "season", "index"],
    queryFn: () => fetchSimJson<SeasonIndex>("season/index.json"),
};

export const seasonEventQuery = (slug: string) => ({
    queryKey: ["sim", "season", "field", slug],
    queryFn: () => fetchSimJson<SeasonEventFile>(`season/fields/${encodeURIComponent(slug)}.json`),
});

export const clutchQuery = {
    queryKey: ["war", "clutch"],
    queryFn: () => fetchOptionalJson<ClutchData>("war/clutch.json", "clutch conversion"),
};

export const styleQuery = {
    queryKey: ["war", "style"],
    queryFn: () => fetchOptionalJson<StyleData>("war/style.json", "player style"),
};

export const heatmapIndexQuery = (steamid: string) => ({
    queryKey: ["war", "heatmaps", "index", steamid],
    queryFn: () => fetchOptionalJson<HeatmapIndex>(`v2/${steamid}/index.json`, "player map tendencies", HEATMAPS_BASE),
});

export const heatmapMapQuery = (steamid: string, map: string) => ({
    queryKey: ["war", "heatmaps", "map", steamid, map],
    queryFn: () => fetchOptionalJson<HeatmapMapData>(`v2/${steamid}/${map}.json`, `${map} heatmap`, HEATMAPS_BASE),
});

export const heatmapAverageQuery = (map: string) => ({
    queryKey: ["war", "heatmaps", "avg", map],
    queryFn: () => fetchOptionalJson<HeatmapAverageData>(`v2/_avg/${map}.json`, `${map} average heatmap`, HEATMAPS_BASE),
});
