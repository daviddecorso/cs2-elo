import type { Region } from "./types.ts";

/**
 * Major invite cutoff ranks per region.
 * UNCONFIRMED: David to check and verify against the Valve Major supplemental rulebook.
 */
export const INVITE_CUTOFFS: Record<Region, number> = {
    Europe: 16,
    Americas: 8,
    Asia: 8,
};
