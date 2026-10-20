import type { StageConfig } from "./config.ts";
import type { Rng } from "./rng.ts";

/** Liquipedia team page, as the Elo feed keys teams. */
export type TeamId = string;

export type Lane = "upper" | "lower";

/** A bracket position, the same across simulations. */
export interface SlotPlace {
    /** Unique within the stage, except in Swiss, where a round's W-L pool shares one. */
    slot: string;
    lane: Lane;
}

export interface SimMatch extends SlotPlace {
    stage: string;
    round: number;
    teams: [TeamId, TeamId];
    bestOf: number;
    winner: 0 | 1;
    /** Played on Liquipedia, so the result is fixed in every simulation. */
    locked: boolean;
    /** Unix seconds; only known for locked matches. */
    t: number | null;
}

export interface StageResult {
    /** In seed order for the next stage. */
    advancing: TeamId[];
    /** Eliminated (or winning) team → format exit key. */
    exits: Map<TeamId, string>;
    matches: SimMatch[];
}

export interface StageContext {
    config: StageConfig;
    rng: Rng;
    play(a: TeamId, b: TeamId, bestOf: number, round: number, place: SlotPlace): SimMatch;
    /** Liquipedia's pairings for a round, once both opponents are known, in match order. */
    knownPairings(round: number): Array<[TeamId, TeamId]>;
}

export type StageRunner = (teams: TeamId[], ctx: StageContext) => StageResult;

export const winnerOf = (m: SimMatch): TeamId => m.teams[m.winner];
export const loserOf = (m: SimMatch): TeamId => m.teams[1 - m.winner];
