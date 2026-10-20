/** One played map; `rounds` is [team1, team2] rounds won. */
export interface EloMap {
    map: string;
    rounds: [number, number];
}

/** A finished series from the normalized feed, keyed on Liquipedia page names. */
export interface EloMatch {
    /** `<tournament page>:<match2id>` */
    id: string;
    /** Unix seconds, UTC. */
    t: number;
    event: string;
    /** Liquipedia tier 1 (top) to 5; null when the wiki has none. */
    tier: number | null;
    lan: boolean;
    /** USD; null when the tournament row is missing. */
    prizePool: number | null;
    bestOf: number;
    teams: [string, string];
    /** Every player Liquipedia lists for the series, which can be more or fewer than 5. */
    lineups: [string[], string[]];
    /** 0 for teams[0], 1 for teams[1]. */
    winner: 0 | 1;
    forfeit: boolean;
    maps: EloMap[];
}

/** Player page name → display nick and ISO2 country ("" if unknown). */
export type EloPlayers = Record<string, { nick: string; country: string }>;

export interface HistoryMonth {
    month: string;
    matches: EloMatch[];
    players: EloPlayers;
}
