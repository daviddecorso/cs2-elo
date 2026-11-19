import type { EloRankings } from "../elo/types.ts";
import { fetchSimJson } from "../sim/fetch.ts";
import type { PlanIndex, PlanTeamFile } from "../sim/types.ts";
import type { ClutchData, PlayerWarData, TacticsData, TeamDuelsData, TeamStatsData } from "../war/types.ts";

const fetchJson = async <T>(file: string, what: string): Promise<T> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${file}`);
    if (!res.ok) throw new Error(`Failed to load ${what}: HTTP ${res.status}`);
    return res.json();
};

/** Null on a 404: the file is only written once its `cs2wp ... --publish` step has run. */
const fetchOptionalJson = async <T>(file: string, what: string): Promise<T | null> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${file}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load ${what}: HTTP ${res.status}`);
    return res.json();
};

export const eloRankingsQuery = {
    queryKey: ["elo", "latest"],
    queryFn: () => fetchJson<EloRankings>("elo/latest.json", "Elo rankings"),
};

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

export const clutchQuery = {
    queryKey: ["war", "clutch"],
    queryFn: () => fetchOptionalJson<ClutchData>("war/clutch.json", "clutch conversion"),
};
