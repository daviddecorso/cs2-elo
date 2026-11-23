import type { CreditVersion, PlayerWarData, WarPlayer } from "./types.ts";

/** The credit behind WAA. `players.json` carries the other versions as diagnostics only. */
export const WAA_CREDIT: CreditVersion = "wpa_opp";
/** Rounds at which WAA is half signal: split-half k from `cs2wp validate-war` (docs/war.md, Shrinkage). */
export const SHRINK_ROUNDS = 984;

export const USAGE_LABEL = "Usage: round-wins per 100 rounds expected from the player's own resources, beyond the team's economy";
export const CONVERSION_LABEL = "Conversion: round-wins per 100 rounds above what the same resources earn on average";
export const HLTV_GAP_LABEL = "z(unshrunk WAA / 100 rds) − z(HLTV 3.0) in SD units across qualified players (HLTV fixed in CI)";

export const signed = (n: number, digits = 2) => (n > 0 ? `+${n.toFixed(digits)}` : n.toFixed(digits));

/** Shrunk toward the league mean, which is zero until a replacement rate shifts it. */
export const waaRate = ({ rounds, metrics }: WarPlayer, replacementRate: number) => {
    const mean = 100 * replacementRate;
    return mean + ((metrics[WAA_CREDIT].per100 - mean) * rounds) / (rounds + SHRINK_ROUNDS);
};

export type RankedPlayer = { player: WarPlayer; rate: number; rank: number };

/** Ranks by shrunk rate, separately for IGLs and everyone else. */
export const rankPlayers = ({ players, replacementRate }: Pick<PlayerWarData, "players" | "replacementRate">) => {
    const sorted = players.map((player) => ({ player, rate: waaRate(player, replacementRate) })).sort((a, b) => b.rate - a.rate);
    const ranked = (isIgl: boolean) =>
        sorted.filter(({ player }) => player.isIgl === isIgl).map((row, idx): RankedPlayer => ({ ...row, rank: idx + 1 }));
    return {
        nonIgls: ranked(false),
        igls: ranked(true),
    };
};
