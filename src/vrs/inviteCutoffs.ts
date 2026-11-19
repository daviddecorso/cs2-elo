import type { Region } from "./types.ts";

/** Per-region Major invite totals for the post-Cologne 2026 cycle (Stage 1: 6/6/4 + Stage 2 & 3 from previous Major). */
export const INVITE_CUTOFFS: Record<Region, number> = {
    Europe: 18,
    Americas: 9,
    Asia: 5,
};

const PRE_COLOGNE_CUTOFFS: Record<Region, number> = {
    Europe: 16,
    Americas: 10,
    Asia: 6,
};

export const cutoffsForSnapshot = (snapshotDate: string): Record<Region, number> =>
    snapshotDate < "2026-07-06" ? PRE_COLOGNE_CUTOFFS : INVITE_CUTOFFS;
