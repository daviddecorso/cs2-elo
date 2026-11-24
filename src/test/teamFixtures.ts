import type { EloRankings as EloRankingsData } from "../elo/types.ts";
import type { PlayerWarData, TacticsData, TeamDuelsData, TeamStatsData } from "../war/types.ts";

export const eloData: EloRankingsData = {
    generatedAt: "2026-10-20T12:00:00Z",
    asOf: "2026-10-20",
    vrsSnapshot: "2026-10-19",
    pool: ["Team Vitality", "Team Spirit"],
    rosters: [
        {
            rank: 1,
            team: "Team Vitality",
            region: "Europe",
            rating: 1950,
            maps: 45,
            lastMatch: "2026-10-18",
            players: [
                { nick: "ZywOo", page: "ZywOo" },
                { nick: "apEX", page: "apEX" },
            ],
            departed: [],
            mapOffsets: { mirage: 12, nuke: -8 },
            vrs: { rank: 1, teamName: "Team Vitality", points: 2000 },
        },
        {
            rank: 2,
            team: "Team Spirit",
            region: "Europe",
            rating: 1920,
            maps: 40,
            lastMatch: "2026-10-19",
            players: [
                { nick: "donk", page: "donk" },
                { nick: "sh1ro", page: "sh1ro" },
            ],
            departed: [],
            mapOffsets: {},
            vrs: { rank: 2, teamName: "Team Spirit", points: 1980 },
        },
    ],
};

const source = {
    demos: "HLTV.org match demos, parsed with awpy",
    attribution: "Events, rosters and player pages from Liquipedia (CC-BY-SA 3.0)",
    liquipedia: "https://liquipedia.net/counterstrike/",
};

const duelRate = (per100: number) => ({
    per100,
    p5: per100 - 0.3,
    p95: per100 + 0.3,
    per100_rounds: per100 * 6,
    per100_rounds_p5: 0,
    per100_rounds_p95: 0,
});
const duelMeta = (label: string) => ({
    label,
    weight: "duels" as const,
    split_half_r: 0.5,
    split_half_r_ci: [0.3, 0.6] as [number, number],
    k: 4000,
    descriptive: true,
});
export const teamDuels: TeamDuelsData = {
    generated_at: "2026-11-13T00:00:00Z",
    min_rounds: 300,
    quality_definition: "all duels",
    quality_parts: ["q_pos"],
    stats: { exec: duelMeta("Execution"), quality: duelMeta("Quality"), q_pos: duelMeta("Quality: positioning") },
    source,
    teams: [
        { stint_id: "a", label: "FURIA (FalleN)", lp_team: "FURIA", igl_player: "FalleN", maps: 363, rounds: 7857, duels: 50111, exec: duelRate(1.4), quality: duelRate(0.36), q_pos: duelRate(0.12) },
        { stint_id: "b", label: "Team Spirit (Chopper)", lp_team: "Team Spirit", igl_player: "Chopper", maps: 140, rounds: 3000, duels: 20430, exec: duelRate(2.32), quality: duelRate(0.1), q_pos: duelRate(0.05) },
    ],
};

const rate = (per100: number) => ({ per100, p5: per100 - 0.5, p95: per100 + 0.5 });
const meta = (label: string, extra = {}) => ({
    label,
    split_half_r: 0.6,
    split_half_r_ci: [0.5, 0.7] as [number, number],
    descriptive: true,
    ...extra,
});
export const teamStats: TeamStatsData = {
    generated_at: "2026-11-13T00:00:00Z",
    min_rounds: 300,
    stats: {
        rwoe_econ: meta("Round wins over expected (economy)"),
        ct_def: meta("Adjusted CT (defense)", { gain_vs_raw: 0.0002, gain_vs_raw_ci: [0.0001, 0.0004] }),
    },
    source,
    teams: [
        { stint_id: "a", label: "FURIA (FalleN)", lp_team: "FURIA", igl_player: "FalleN", maps: 363, rounds: 7857, rwoe_econ: rate(3.51), ct_def: rate(1.2) },
        { stint_id: "b", label: "Team Vitality (apEX)", lp_team: "Team Vitality", igl_player: "apEX", maps: 341, rounds: 7272, rwoe_econ: rate(7.19), ct_def: rate(8.24) },
    ],
};

export const tactics: TacticsData = {
    generated_at: "2026-11-14T00:00:00Z",
    min_rounds: 300,
    stats: {
        post: meta("Post-plant conversion", { season_r: 0.37, season_r_ci: [0.22, 0.5] }),
        contact: meta("Numbers at contact"),
    },
    source,
    teams: [
        { stint_id: "a", label: "FURIA (FalleN)", lp_team: "FURIA", igl_player: "FalleN", maps: 363, contact: rate(1.1), post_t_off: rate(2.2), post_ct_def: rate(-0.4) },
        { stint_id: "b", label: "Team Vitality (apEX)", lp_team: "Team Vitality", igl_player: "apEX", maps: 341, contact: rate(4.4), post_t_off: rate(6.6), post_ct_def: rate(3.3) },
    ],
};

const metrics = (per100: number) => {
    const est = {
        waa: per100 * 5,
        waaP5: 0,
        waaP95: per100 * 10,
        per100,
        per100Shrunk: (per100 * 2000) / (2000 + 984),
        per100P5: per100 - 0.5,
        per100P95: per100 + 0.5,
    };
    return { wpa_opp: est, wpa: est, nwpa_mancount: est, nwpa_event: est };
};
const player = (steamid: string, name: string, lpTeam: string, per100: number, isIgl = false) => ({
    steamid,
    lpPlayer: name,
    name,
    lpTeam,
    maps: 100,
    rounds: 2000,
    isIgl,
    iglShare: isIgl ? 1 : 0,
    tRole: "Rifler" as const,
    ctRole: "Anchor",
    awpShare: 0,
    entryShare: 0.2,
    ctByMap: [],
    duels: 1000,
    killsAbove: 0,
    killsAbovePer100: 0,
    kd: 1,
    adr: 80,
    rating2Approx: 1,
    rating3: 1,
    swing: 0,
    metrics: metrics(per100),
});
export const warPlayers: PlayerWarData = {
    generatedAt: "2026-11-05T23:00:00Z",
    model: null,
    provisional: false,
    gate: null,
    metric: "WAA",
    replacementRate: 0,
    minRounds: 300,
    roundsPerWin: 5.38,
    shrinkRounds: { wpa_opp: 984, wpa: 1854, nwpa_mancount: 1476, nwpa_event: 1237 },
    leagueMeanPer100: { wpa_opp: 0, wpa: 0, nwpa_mancount: 0, nwpa_event: 0 },
    iglAdjustmentPer100: {
        wpa_opp: { ct: 0, t: 0, nonIglCt: 0, nonIglT: 0 },
        wpa: { ct: 0, t: 0, nonIglCt: 0, nonIglT: 0 },
        nwpa_mancount: { ct: 0, t: 0, nonIglCt: 0, nonIglT: 0 },
        nwpa_event: { ct: 0, t: 0, nonIglCt: 0, nonIglT: 0 },
    },
    window: { from: "2025-11-24", to: "2026-10-18", maps: 1312, events: 23 },
    validation: { monthToMonth100: {}, monthToMonth200: {}, monthToMonth300: {}, splitHalf: {}, withKd: {} },
    source,
    players: [
        player("1", "ZywOo", "Team Vitality", 3.21),
        player("2", "apEX", "Team Vitality", 0.51, true),
        player("3", "donk", "Team Spirit", 2.19),
    ],
};
