export type Region = "Europe" | "Americas" | "Asia";

export interface RosterFactors {
    bountyOffered: number;
    bountyCollected: number;
    opponentNetwork: number;
    lanFactor: number;
}

export interface Roster {
    rosterKey: string;
    teamName: string;
    region: Region;
    regionalRank: number | null;
    globalRank: number | null;
    points: number;
    factors: RosterFactors;
    startingValue: number;
    h2hAdjustment: number;
    players: string[];
}

export interface Standings {
    snapshotDate: string;
    valveCommit: string;
    modelCommit: string;
    source: "valve-published" | "model";
    generatedAt: string;
    rosters: Roster[];
}

export const getRosterKey = (players: readonly string[]): string =>
    players
        .map((p) => p.trim().toLowerCase())
        .sort()
        .join(",");
