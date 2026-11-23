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

export interface MatchSide {
    /** Liquipedia team page name for this match. */
    team: string;
    /** Rated lineage team name when the team renamed since its last played series; used for `/teams/` links. */
    profileTeam?: string;
    /** Active Elo rank, or null when unranked/provisional. */
    rank: number | null;
    vrsRank: number | null;
    /** Pre-series Elo rating (including region prior), or null when unrated. */
    rating: number | null;
    rated: boolean;
    /** Maps won (completed matches only). */
    score?: number;
    /** Post-series rating change (completed matches only). */
    delta?: number;
    players?: Array<{ page: string; nick: string }>;
}

export interface MatchMapBreakdown {
    map: string;
    /** Pre-map Elo win probability for sides[0]. */
    p: number;
    /** Active-pool map offsets [sides[0], sides[1]] for upcoming matches. */
    offsets?: [number, number];
    /** Round score [sides[0], sides[1]] for completed matches. */
    rounds?: [number, number];
    winner?: 0 | 1;
}

export type VetoChance = "likely" | "possible" | "unlikely";

/** Bo1 gets only its likeliest maps in order; longer series get every pool map, likeliest first. */
export type MatchVeto =
    | { kind: "shortlist"; maps: string[] }
    | {
          kind: "chances";
          /** `pickedBy` lists the sides whose likeliest pick this map is (Bo3 only). */
          maps: Array<{ map: string; chance: VetoChance; pickedBy?: Array<0 | 1> }>;
      };

export interface ScheduledMatch {
    id: string;
    /** Unix seconds UTC; null when Liquipedia has no date yet. */
    t: number | null;
    dateExact: boolean;
    status: "upcoming" | "completed";
    /** Parent Liquipedia tournament page. */
    event: string;
    eventName: string;
    eventSlug: string;
    /** Liquipedia page holding the match row (may be a stage subpage). */
    page: string;
    section?: string;
    tier: number | null;
    lan: boolean;
    /** Scheduled best-of (0 when unspecified on Liquipedia). */
    bestOf: number;
    sides: [MatchSide, MatchSide];
    /** Pre-series Elo win probability for sides[0]. */
    p: number;
    seriesOdds?: { bo1: number; bo3: number; bo5: number };
    winner?: 0 | 1;
    maps: MatchMapBreakdown[];
    /** Upcoming Bo1, Bo3 and Bo5 between rated sides only; the odds don't use it. */
    veto?: MatchVeto;
}

export interface EloMatchesData {
    generatedAt: string;
    /** `YYYY-MM-DD` of the latest completed series in the Elo feed. */
    asOf: string;
    /** `YYYY-MM-DD` of the latest `upcoming.json` fetch, or null. */
    upcomingFetched: string | null;
    /** Highest active Elo rating, used to anchor excitement quality on the current rating scale. */
    topRating: number;
    pool: string[];
    upcoming: ScheduledMatch[];
    recent: ScheduledMatch[];
}
