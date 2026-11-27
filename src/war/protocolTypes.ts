import type { GrenadeType, HeatmapLevel, HeatmapSide, HeatmapSource, HeatmapWindow } from "./heatmapTypes.ts";

/** `gun`: full buy, not a pistol round. `light`: eco or force buy. */
export type ProtocolClass = "gun" | "pistol" | "light";

export interface ProtocolLeagueClass {
    rate: number;
    tMed: number | null;
    /** Rounds whose first throw into the zone fell in each `timeEdges` bin. */
    bins: number[];
    hits: number;
}

export interface ProtocolLeagueZone {
    /** Unique on its map; ordered by side, then the league's median first-throw time on gun rounds. */
    id: number;
    side: HeatmapSide;
    type: GrenadeType;
    level: HeatmapLevel;
    /** Radar px (1024 px radar). */
    land: [number, number];
    r: number;
    place: string | null;
    name?: string;
    description?: string;
    reviewed?: boolean;
    /** Throw spots, dominant first: [px, py, count]. */
    from: [number, number, number][];
    league: Partial<Record<ProtocolClass, ProtocolLeagueClass>>;
    reliability: Record<ProtocolClass, number | null>;
}

export interface ProtocolLeagueMap {
    version: number;
    map: string;
    levels: HeatmapLevel[];
    generatedAt: string;
    window: HeatmapWindow;
    source: HeatmapSource;
    rounds: Record<HeatmapSide, Record<ProtocolClass, number>>;
    /** Share of the league's gun T rounds with a group site entry in the first 30 s. */
    fastShare: number | null;
    /** Seconds from freeze end; bins are [0, e0), [e0, e1), …, [eLast, ∞). */
    timeEdges: number[];
    zones: ProtocolLeagueZone[];
}

/** [steamid, share of the team's rounds in the zone, the player's own per-round rate]. */
export type ProtocolThrower = [string, number, number];

export interface ProtocolTeamZone {
    id: number;
    hits: number;
    rate: number;
    /** Team rate minus league rate, with its 90% series-bootstrap interval. */
    diff: number | null;
    lo: number | null;
    hi: number | null;
    tMed?: number | null;
    bins?: number[];
    throwers?: ProtocolThrower[];
}

export interface ProtocolTeamSide {
    rounds: Record<ProtocolClass, number>;
    allRounds: number;
    fastShare: number | null;
    classes: Partial<Record<ProtocolClass, { rounds: number; zones: ProtocolTeamZone[] }>>;
}

export interface ProtocolTeamMap {
    map: string;
    maps: number;
    lowSample: boolean;
    sides: Partial<Record<HeatmapSide, ProtocolTeamSide>>;
}

export interface ProtocolTeam {
    version: number;
    team: string;
    generatedAt: string;
    window: HeatmapWindow;
    source: HeatmapSource;
    /** Start of this team's window: the 6-month start, or its current IGL stint if that began later. */
    from: string;
    stint: { label: string; from: string } | null;
    players: Record<string, string>;
    maps: ProtocolTeamMap[];
}
