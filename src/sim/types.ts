import type { Region } from "../vrs/types.ts";

export interface EventOddsTeam {
    team: string;
    /** Elo rating as of `asOf`; null for teams with no rated history. */
    rating: number | null;
    /** Stage id → probability of playing in it. */
    reach: Record<string, number>;
    /** Placement label → probability. */
    placements: Record<string, number>;
}

export type StageFormat = "swiss" | "single_elim" | "double_elim" | "gsl" | "round_robin" | "bracket";

export interface BracketSlot {
    /** Config match id for `bracket` stages; `r<round>:<w>-<l>` for a Swiss pool. */
    id: string;
    /** Column order within the lane; not consecutive (double elimination's lower rounds start at 101). */
    round: number;
    lane: "upper" | "lower";
    bestOf: number;
    /** Share of simulations that played this slot. */
    reach: number;
    /** Most likely teams here; both shares are of all simulations. */
    teams: Array<{ team: string; here: number; win: number }>;
    /** Most likely pairings, as a share of all simulations. */
    matchups: Array<{ teams: [string, string]; p: number }>;
    /** Set once every match here is played; a Swiss pool has several. */
    results?: Array<{ teams: [string, string]; winner: 0 | 1 }>;
}

export interface StageBracket {
    id: string;
    name: string;
    format: StageFormat;
    /** In play order. */
    slots: BracketSlot[];
}

export interface EventOdds {
    slug: string;
    name: string;
    liquipedia: string;
    startDate: string;
    endDate: string;
    generatedAt: string;
    /** Date of the latest match in the ratings. */
    asOf: string;
    n: number;
    /** Stages teams advance into, so reaching one means something. */
    stages: Array<{ id: string; name: string }>;
    /** Best first. */
    placements: string[];
    /** Placement label → USD, when Liquipedia has the prize table. */
    prizes: Record<string, number> | null;
    playedMatches: number;
    teams: EventOddsTeam[];
    /** Missing from files written before the bracket view. */
    bracket?: StageBracket[];
}

export type EventIndexEntry = Pick<EventOdds, "slug" | "name" | "startDate" | "endDate">;

export interface InviteOddsRoster {
    rosterKey: string;
    teamName: string;
    region: Region;
    players: string[];
    stage3: number;
    stage2: number;
    stage1: number;
    miss: number;
    /** Projected regional rank percentiles across simulations. */
    rank: { p10: number; p50: number; p90: number };
    /** Whether a current squad still holds the roster; null without squad data. */
    intact: boolean | null;
}

export interface InviteOdds {
    slug: string;
    name: string;
    liquipedia: string;
    snapshotDate: string;
    snapshotEstimated: boolean;
    generatedAt: string;
    asOf: string;
    n: number;
    events: Array<{ slug: string; name: string; liquipedia: string; included: boolean; reason?: string }>;
    /** Stage 3 and 2 are mean slots per region over simulations of the previous Major; Stage 1 is fixed. */
    slots: {
        stage3: Record<Region, number>;
        stage2: Record<Region, number>;
        stage1: Record<Region, number>;
        source: string;
        verified: boolean;
    };
    rosters: InviteOddsRoster[];
}

export type InviteIndexEntry = Pick<InviteOdds, "slug" | "name" | "snapshotDate">;
