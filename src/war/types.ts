export type CreditVersion = "wpa_opp" | "wpa" | "nwpa_mancount" | "nwpa_event";

/** Round-wins per 100 rounds with a 90% round-bootstrap interval. */
export interface WarRate {
    per100: number;
    per100P5: number;
    per100P95: number;
}

export interface HltvGap {
    z: number;
    zP5: number;
    zP95: number;
}

export interface WarEstimate extends WarRate {
    waa: number;
    waaP5: number;
    waaP95: number;
    /** context + usage.per100 + conversion.per100 = per100. Absent before `cs2wp usage` has run. */
    context?: number;
    usage?: WarRate;
    conversion?: WarRate;
    /** Standardized WAA per 100 minus HLTV Rating 3.0 over qualified players with a rating. */
    hltvGap?: HltvGap | null;
}

/** Shares are 0–1; null when the denominator is empty (e.g. no eco rounds). */
export interface WarResources {
    equipShare: { eco: number | null; force: number | null; full: number | null };
    awpRate: number | null;
    dropsReceivedPer100: number | null;
    dropsGivenPer100: number | null;
    flashSupportShare: number | null;
    selfFlashShare: number | null;
    smokeSupportShare: number | null;
    tradedDeathRate: number | null;
    /** Duel wins added by teammates' flashes, from the duel model; null until `cs2wp duels` adds it. */
    flashGift: number | null;
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
    resources?: WarResources | null;
}

/** Per 100 duels (or opening duels), and per 100 rounds, with 90% series-bootstrap intervals. */
export interface DuelRate {
    per100: number;
    p5: number;
    p95: number;
    per100_rounds: number;
    per100_rounds_p5: number;
    per100_rounds_p95: number;
}

export type DuelStatKey = "exec" | "quality" | "q_pos" | "q_flash" | "q_hp";

export interface DuelStatMeta {
    label: string;
    weight: "duels" | "opening_duels";
    split_half_r: number;
    split_half_r_ci: [number, number];
    k: number;
    /** True unless the stat improves leave-one-event-out Elo log loss on map results. */
    descriptive: boolean;
}

export interface TeamDuelStint extends Partial<Record<DuelStatKey, DuelRate>> {
    stint_id: string;
    label: string;
    lp_team: string;
    igl_player: string | null;
    maps: number;
    rounds: number;
    duels?: number;
    opening_duels?: number;
}

/** `cs2wp duel-stats --publish`; only stats that passed their split-half gate appear in `stats`. */
export interface TeamDuelsData {
    generated_at: string;
    min_rounds: number;
    quality_definition: string | null;
    quality_parts: string[];
    stats: Partial<Record<DuelStatKey, DuelStatMeta>>;
    source: { demos: string; attribution: string; liquipedia: string };
    teams: TeamDuelStint[];
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
        withRating3?: Record<string, ValidationScore>;
    };
    source: { demos: string; attribution: string; liquipedia: string };
    players: WarPlayer[];
}
