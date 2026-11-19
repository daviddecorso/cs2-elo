import type { CreditVersion, WarPlayer } from "./types.ts";

export const DEFAULT_CREDIT: CreditVersion = "wpa_opp";
export const CREDIT_VERSIONS: CreditVersion[] = ["wpa_opp", "wpa", "nwpa_mancount", "nwpa_event"];
export const CREDIT_OPTIONS: Array<{ value: CreditVersion; label: string }> = [
    { value: "wpa_opp", label: "WPA (team-neutral)" },
    { value: "wpa", label: "WPA (raw)" },
    { value: "nwpa_mancount", label: "Neutral (man-count)" },
    { value: "nwpa_event", label: "Neutral (event)" },
];

export const USAGE_LABEL = "Usage: round-wins per 100 rounds expected from the player's own resources, beyond the team's economy";
export const CONVERSION_LABEL = "Conversion: round-wins per 100 rounds above what the same resources earn on average";
export const HLTV_GAP_LABEL = "z(WAA / 100 rds) − z(HLTV 3.0) in SD units across qualified players (HLTV fixed in CI)";

export const signed = (n: number, digits = 2) => (n > 0 ? `+${n.toFixed(digits)}` : n.toFixed(digits));

export type RankedPlayer = { player: WarPlayer; rank: number };

/** Ranks by rate per 100 rounds, separately for IGLs and everyone else. */
export const rankPlayers = (players: WarPlayer[], credit: CreditVersion) => {
    const sorted = [...players].sort((a, b) => b.metrics[credit].per100 - a.metrics[credit].per100);
    return {
        nonIgls: sorted.filter((p) => !p.isIgl).map((player, idx): RankedPlayer => ({ player, rank: idx + 1 })),
        igls: sorted.filter((p) => p.isIgl).map((player, idx): RankedPlayer => ({ player, rank: idx + 1 })),
    };
};
