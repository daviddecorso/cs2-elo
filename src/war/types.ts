export type CreditVersion = "wpa_opp" | "wpa" | "nwpa_mancount" | "nwpa_event";

export interface WarEstimate {
    waa: number;
    waaP5: number;
    waaP95: number;
    per100: number;
    per100P5: number;
    per100P95: number;
}

export interface WarCtMapRole {
    map: string;
    role: string;
    maps: number;
}

export interface WarPlayer {
    steamid: string;
    lpPlayer: string | null;
    name: string;
    lpTeam: string | null;
    maps: number;
    rounds: number;
    isIgl: boolean;
    iglShare: number;
    tRole: "AWPer" | "Entry" | "Rifler";
    ctRole: string;
    awpShare: number;
    entryShare: number;
    ctByMap: WarCtMapRole[];
    duels: number;
    killsAbove: number;
    killsAbovePer100: number;
    kd: number | null;
    adr: number | null;
    rating2Approx: number | null;
    rating3: number | null;
    swing: number | null;
    metrics: Record<CreditVersion, WarEstimate>;
}

export interface ValidationScore {
    r: number | null;
    pairs?: number;
    players?: number;
    spearman_brown?: number | null;
}

export interface PlayerWarData {
    generatedAt: string;
    model: string | null;
    provisional: boolean;
    gate: { passed?: boolean; log_loss?: number; max_bin_gap?: number; slope?: number } | null;
    metric: "WAA" | "WAR";
    replacementRate: number;
    minRounds: number;
    roundsPerWin: number;
    iglAdjustmentPer100: Record<CreditVersion, { ct: number; t: number; nonIglCt: number; nonIglT: number }>;
    window: { from: string; to: string; maps: number; events: number };
    validation: {
        monthToMonth100: Record<string, ValidationScore>;
        monthToMonth200: Record<string, ValidationScore>;
        monthToMonth300: Record<string, ValidationScore>;
        splitHalf: Record<string, ValidationScore>;
        withKd: Record<string, ValidationScore>;
    };
    source: { demos: string; attribution: string; liquipedia: string };
    players: WarPlayer[];
}
