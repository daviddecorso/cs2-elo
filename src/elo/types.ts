import type { Region } from "../vrs/types.ts";

export interface EloRoster {
    rank: number;
    /** Liquipedia team page name. */
    team: string;
    players: Array<{ page: string; nick: string }>;
    rating: number;
    /** Rating points added on each active-pool map, centred on 0. */
    mapOffsets: Record<string, number>;
    maps: number;
    /** `YYYY-MM-DD` of the roster's last series. */
    lastMatch: string;
    region: Region | null;
    vrs: { rank: number; points: number; teamName: string } | null;
    /** Core players no longer on the team's active Liquipedia squad; empty when squads weren't fetched. */
    departed: string[];
}

export interface EloRankings {
    generatedAt: string;
    /** `YYYY-MM-DD` of the latest series in the feed. */
    asOf: string;
    vrsSnapshot: string;
    pool: string[];
    rosters: EloRoster[];
}

export interface EloGame {
    /** `YYYY-MM-DD`, UTC. */
    date: string;
    /** Liquipedia tournament page. */
    event: string;
    tier: number;
    lan: boolean;
    bestOf: number;
    opponent: string;
    won: boolean;
    /** Maps won by the team, then by the opponent. */
    score: [number, number];
    /** Rounds as [team, opponent]. */
    maps: Array<{ map: string; rounds: [number, number] }>;
    /** Both ratings are before the series. */
    elo: number;
    oppElo: number;
    /** Pre-series probability the team wins. */
    p: number;
    delta: number;
}

/** `public/data/elo/games/<teamSlug>.json`, newest first. */
export interface EloGameLog {
    generatedAt: string;
    team: string;
    from: string;
    games: EloGame[];
}

export interface EloScore {
    n: number;
    logLoss: number;
    brier: number;
    accuracy: number;
}

export interface EloCalibrationBin {
    lo: number;
    hi: number;
    n: number;
    predicted: number;
    actual: number;
}

export interface EloHltvPoints {
    link: string;
    beta: number;
    score: EloScore;
    gain: { mean: number; lo: number; hi: number };
    bins: EloCalibrationBin[];
}

export interface EloHltvComparison {
    through: string;
    n: number;
    rankBeta: number;
    vrsRankBeta: number;
    elo: EloScore;
    hltv: EloScore;
    vrs: EloScore;
    vrsRank: EloScore;
    gain: { mean: number; lo: number; hi: number };
    points?: EloHltvPoints;
}

export interface EloCalibration {
    generatedAt: string;
    testFrom: string;
    vrsScale: number;
    gate: { n: number; elo: EloScore; vrs: EloScore; passed: boolean };
    all: EloScore;
    maps: EloScore;
    crossRegion: { n: number; elo: EloScore; vrs: EloScore };
    bins: { elo: EloCalibrationBin[]; vrs: EloCalibrationBin[] };
    hltv?: EloHltvComparison;
}
