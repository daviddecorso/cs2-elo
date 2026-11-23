export type HeatmapSide = "t" | "ct";
export type HeatmapPhase = "setup" | "mid" | "late" | "post";
export type HeatmapLevel = "upper" | "lower";
export type GrenadeType = "smoke" | "flash" | "he" | "molotov";

export type EventLayerKey =
    | "kills"
    | "deaths"
    | "open_kill"
    | "open_death"
    | "plant"
    | `util_land:${GrenadeType}`;

export type HeatmapLayer = "positions" | "kills" | "deaths" | "openings" | "utility" | "plants";

export interface SparseGrid {
    max: number;
    n: number;
    /** Flattened 64x64 cell index delta-coded pairs: [dIdx, value, dIdx, value, ...]. */
    cells: number[];
}

export interface HeatmapUtilZone {
    land: [number, number];
    r: number;
    n: number;
    share: number;
    tMed: number;
    level?: HeatmapLevel;
    /** Throw origin clusters within this landing zone: [px, py, count], dominant first. */
    from: [number, number, number][];
}

export interface HeatmapCallout {
    callout: string;
    share: number;
    n?: number;
}

export interface HeatmapScope {
    type: "team" | "all";
    team: string | null;
}

export interface HeatmapWindow {
    from: string;
    to: string;
    months: number | null;
}

export interface HeatmapSource {
    demos: string;
    attribution: string;
    liquipedia: string;
}

export interface HeatmapIndexSide {
    presence: Partial<Record<HeatmapPhase, HeatmapCallout[]>>;
    kills: HeatmapCallout[];
    deaths: HeatmapCallout[];
    openings: { wins: number; losses: number };
    tradedDeathShare: number | null;
}

export interface HeatmapIndexMap {
    map: string;
    maps: number;
    rounds: Record<HeatmapSide, number>;
    scope: HeatmapScope;
    lowSample: boolean;
    levels: HeatmapLevel[];
    sides: Record<HeatmapSide, HeatmapIndexSide>;
}

export interface HeatmapIndex {
    version: number;
    steamid: string;
    generatedAt: string;
    window: HeatmapWindow;
    source: HeatmapSource;
    maps: HeatmapIndexMap[];
}

export type LevelGrids = {
    presence?: Partial<Record<HeatmapPhase, SparseGrid>>;
} & Partial<Record<EventLayerKey, SparseGrid>>;

export interface HeatmapMapSide {
    grids: Partial<Record<HeatmapLevel, LevelGrids>>;
    lineups: Partial<Record<GrenadeType, HeatmapUtilZone[]>>;
}

export interface HeatmapMapData {
    version: number;
    steamid: string;
    map: string;
    maps: number;
    rounds: Record<HeatmapSide, number>;
    scope: HeatmapScope;
    lowSample: boolean;
    levels: HeatmapLevel[];
    gridSize: number;
    generatedAt: string;
    window: HeatmapWindow;
    source: HeatmapSource;
    sides: Record<HeatmapSide, HeatmapMapSide>;
}

export interface HeatmapAverageData {
    version: number;
    map: string;
    players: number;
    scale: number;
    levels: HeatmapLevel[];
    gridSize: number;
    generatedAt: string;
    window: HeatmapWindow;
    source: HeatmapSource;
    sides: Record<HeatmapSide, { grids: Partial<Record<HeatmapLevel, LevelGrids>> }>;
}
