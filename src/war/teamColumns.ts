import { textMatches } from "../utils/search.ts";
import type {
    ClutchData,
    ClutchKey,
    ClutchMeta,
    ClutchStint,
    DuelStatKey,
    Rate,
    TacticsData,
    TacticsKey,
    TacticsMeta,
    TacticsStint,
    TeamDuelStint,
    TeamDuelsData,
    TeamStatKey,
    TeamStatStint,
    TeamStatsData,
} from "./types.ts";

export interface StintBase {
    stint_id: string;
    label: string;
    lp_team: string;
    igl_player: string | null;
    maps: number;
}

export interface StintColumn<T> {
    key: string;
    header: string;
    tooltip: string;
    /** Names the stat in the cell tooltip: "<rateLabel> per 100 <unit>". */
    rateLabel: string;
    unit: string;
    rate: (t: T) => (Rate & { per100_rounds?: number }) | undefined;
    /** Shown below the `lg` breakpoint too. */
    primary: boolean;
}

export interface StintCount<T> {
    header: string;
    value: (t: T) => number | null;
}

export const stintMatches = (t: StintBase, q: string) => {
    const trimmed = q.trim();
    return !trimmed || textMatches(t.lp_team, trimmed) || (t.igl_player !== null && textMatches(t.igl_player, trimmed));
};

const ci = (c?: [number | null, number | null]) =>
    c && c[0] !== null && c[1] !== null ? ` (90% CI ${c[0].toFixed(2)}, ${c[1].toFixed(2)})` : "";

const statTooltip = (description: string, m: TacticsMeta) =>
    [
        description,
        `Split-half r ${m.split_half_r.toFixed(2)}${ci(m.split_half_r_ci)}`,
        m.persistence_r != null ? `Quarter-to-quarter r ${m.persistence_r.toFixed(2)}${ci(m.persistence_r_ci)}` : null,
        m.season_r != null ? `Season-to-season r (T side) ${m.season_r.toFixed(2)}${ci(m.season_r_ci)}` : null,
        m.gain_vs_raw != null ? "Predicts rounds better than raw T and CT win rates" : null,
        m.descriptive ? "Descriptive: not shown to add to Elo" : null,
    ]
        .filter(Boolean)
        .join("\n");

const DUEL_ORDER: DuelStatKey[] = ["exec", "quality", "q_pos", "q_flash", "q_hp"];
const DUEL_LABEL: Record<DuelStatKey, string> = {
    exec: "Execution",
    quality: "Quality",
    q_pos: "Positioning",
    q_flash: "Flashes",
    q_hp: "HP",
};
const DUEL_DESCRIPTION: Record<DuelStatKey, string> = {
    exec: "Duels won above the duel model's expectation",
    quality: "Win probability of the duels the team takes, above a weapons-armor-side baseline",
    q_pos: "Quality from peeker vs holder and distance",
    q_flash: "Quality from flashes",
    q_hp: "Quality from HP going into the duel",
};

export const duelCount: StintCount<TeamDuelStint> = { header: "Duels", value: (t) => t.duels ?? t.opening_duels ?? null };

/** Published stats only. */
export const duelColumns = (data: TeamDuelsData): StintColumn<TeamDuelStint>[] =>
    DUEL_ORDER.flatMap((s) => {
        const m = data.stats[s];
        if (!m) return [];
        return [
            {
                key: s,
                header: DUEL_LABEL[s],
                tooltip: `${DUEL_DESCRIPTION[s]}\nSplit-half r ${m.split_half_r.toFixed(2)}${ci(m.split_half_r_ci)}${m.descriptive ? "\nDescriptive: adds nothing to Elo" : ""}`,
                rateLabel: m.label,
                unit: "duels",
                rate: (t: TeamDuelStint) => t[s],
                primary: s === "exec" || s === "quality",
            },
        ];
    });

const ROUND_ORDER: TeamStatKey[] = ["rwoe_econ", "ct_def", "t_off", "tpv", "conv", "rwoe_war"];
const ROUND_LABEL: Record<TeamStatKey, string> = {
    rwoe_econ: "RW over econ",
    ct_def: "Adj. CT",
    t_off: "Adj. T",
    tpv: "Time & position",
    conv: "Conversion",
    rwoe_war: "RW over WAR",
};
const ROUND_DESCRIPTION: Record<TeamStatKey, string> = {
    rwoe_econ: "Rounds won above what the map, side and both teams' buys predict: overall strength, skill plus tactics",
    ct_def: "CT round win rate above expectation, adjusted for map, economy and the opponent's T side",
    t_off: "T round win rate above expectation, adjusted for map, economy and the opponent's CT side",
    tpv: "Win probability gained between kills and plants: positioning and use of time, which WPA credits to no player",
    conv: "Rounds won beyond what the round's gun duels predict: post-plants, saves, utility kills",
    rwoe_war: "Rounds won above what the players' WAR predicts: the team factor",
};
const ROUND_PRIMARY: TeamStatKey[] = ["rwoe_econ", "ct_def", "t_off"];

export const roundCount: StintCount<TeamStatStint> = { header: "Rounds", value: (t) => t.rounds };

/** Published stats only. */
export const roundColumns = (data: TeamStatsData): StintColumn<TeamStatStint>[] =>
    ROUND_ORDER.flatMap((s) => {
        const m = data.stats[s];
        if (!m) return [];
        return [
            {
                key: s,
                header: ROUND_LABEL[s],
                tooltip: statTooltip(ROUND_DESCRIPTION[s], m),
                rateLabel: m.label,
                unit: "rounds",
                rate: (t: TeamStatStint) => t[s],
                primary: ROUND_PRIMARY.includes(s),
            },
        ];
    });

const TACTICS_ORDER: TacticsKey[] = ["post_t_off", "post_ct_def", "contact"];
const TACTICS_LABEL: Record<TacticsKey, string> = {
    post_t_off: "Post-plant T",
    post_ct_def: "Retake CT",
    contact: "Numbers at contact",
};
const TACTICS_DESCRIPTION: Record<TacticsKey, string> = {
    post_t_off:
        "T rounds won after planting, above what the site, men alive, buys and defuse kits predict, adjusted for the defending team",
    post_ct_def:
        "CT rounds won after the bomb is planted, above what the site, men alive, buys and defuse kits predict, adjusted for the planting team",
    contact:
        "Extra defenders on the site the Ts hit at first contact (CT side), minus the defenders opponents had where this team hit (T side), against the map-and-site average",
};

/** Both post-plant columns share the `post` gate in `tactics.json`. */
export const tacticsMetaKey = (s: TacticsKey) => (s === "contact" ? "contact" : "post");

/** Published stats only. */
const CLUTCH_ORDER: ClutchKey[] = ["clutch", "disadv", "adv"];
const CLUTCH_LABEL: Record<ClutchKey, string> = { clutch: "Clutch", disadv: "Behind", adv: "Ahead" };
const CLUTCH_DESCRIPTION: Record<ClutchKey, string> = {
    clutch: "Rounds won from 1vN above the win-probability model's expectation at even Elo",
    disadv: "Rounds won after first falling behind in men alive, above the expectation at even Elo",
    adv: "Rounds won after first going ahead in men alive, above the expectation at even Elo",
};

export const clutchTooltip = (description: string, m: ClutchMeta) =>
    [
        description,
        m.year_r != null ? `2025 → 2026 r ${m.year_r.toFixed(2)}${ci(m.year_r_ci)}` : null,
        m.split_half_r != null ? `Split-half r ${m.split_half_r.toFixed(2)}${ci(m.split_half_r_ci)}` : null,
        m.r_elo != null ? `r with Elo ${m.r_elo.toFixed(2)}` : null,
        "Descriptive: stable year to year, not tested against Elo",
    ]
        .filter(Boolean)
        .join("\n");

/** Published classes only. */
export const clutchColumns = (data: ClutchData): StintColumn<ClutchStint>[] =>
    CLUTCH_ORDER.flatMap((s) => {
        const m = data.team_stats[s];
        if (!m) return [];
        return [
            {
                key: s,
                header: CLUTCH_LABEL[s],
                tooltip: clutchTooltip(CLUTCH_DESCRIPTION[s], m),
                rateLabel: m.label,
                unit: "entries",
                rate: (t: ClutchStint) => t[s],
                primary: true,
            },
        ];
    });

export const tacticsColumns = (data: TacticsData): StintColumn<TacticsStint>[] =>
    TACTICS_ORDER.flatMap((s) => {
        const m = data.stats[tacticsMetaKey(s)];
        if (!m) return [];
        const post = s !== "contact";
        return [
            {
                key: s,
                header: TACTICS_LABEL[s],
                tooltip: statTooltip(TACTICS_DESCRIPTION[s], m),
                rateLabel: post ? `${m.label} (${s === "post_t_off" ? "T" : "CT"})` : m.label,
                unit: post ? "post-plant rounds" : "rounds",
                rate: (t: TacticsStint) => t[s],
                primary: true,
            },
        ];
    });
