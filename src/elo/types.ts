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

export interface EloCalibration {
    generatedAt: string;
    testFrom: string;
    vrsScale: number;
    gate: { n: number; elo: EloScore; vrs: EloScore; passed: boolean };
    all: EloScore;
    maps: EloScore;
    crossRegion: { n: number; elo: EloScore; vrs: EloScore };
    bins: { elo: EloCalibrationBin[]; vrs: EloCalibrationBin[] };
}
