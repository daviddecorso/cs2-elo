import fs from "node:fs";
import path from "node:path";
import type { Region } from "../../../src/vrs/types.ts";
import type { ProjectedRoster } from "./vrsProjection.ts";

export const REGIONS: Region[] = ["Europe", "Americas", "Asia"];

export interface RegionException {
    players: string[];
    region: Region;
    reason: string;
}

export interface InviteConfig {
    slug: string;
    name: string;
    liquipedia: string;
    snapshotDate: string;
    /** True until Valve announces the invite snapshot. */
    snapshotEstimated: boolean;
    /** Per region: a Stage 3 slot per team reaching `stage3From` in the previous Major and a Stage 2 slot per team stopping in `stage2From`, or fixed `slots` once it's played. */
    previousMajor:
        | { event: string; stage3From: string; stage2From: string }
        | { event: string; slots: { stage3: Record<Region, number>; stage2: Record<Region, number> } };
    stage1: Record<Region, number>;
    /** Players of the ranked roster an organisation must still field to keep its invite. */
    minRetained: number;
    /** Official Valve exceptions overriding the 3-month regional assignment lock. */
    regionExceptions?: RegionException[];
    /** Where the slot split comes from, and whether it's been checked against the rulebook. */
    source: string;
    verified: boolean;
}

export const loadInviteConfig = (file: string): InviteConfig =>
    JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as InviteConfig;

export const loadInviteConfigs = (dir: string): InviteConfig[] =>
    fs.existsSync(dir)
        ? fs
              .readdirSync(dir)
              .filter((f) => f.startsWith("invites-") && f.endsWith(".json"))
              .map((f) => loadInviteConfig(path.join(dir, f)))
              .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate))
        : [];

export type InviteStage = 1 | 2 | 3;

export type StageSlots = Record<InviteStage, Record<Region, number>>;

const noSlots = (): Record<Region, number> => ({ Europe: 0, Americas: 0, Asia: 0 });

/** Stage 3 and Stage 2 slots per region: fixed once the previous Major is played, else from the teams that reached each stage. */
export const previousMajorSlots = (
    previous: InviteConfig["previousMajor"],
    reached: Map<string, string[]> | null,
    regionOf: (team: string) => Region
): Pick<StageSlots, 2 | 3> => {
    if ("slots" in previous) return { 3: previous.slots.stage3, 2: previous.slots.stage2 };
    const slots = { 3: noSlots(), 2: noSlots() };
    for (const [team, stages] of reached ?? []) {
        const stage = stages.includes(previous.stage3From) ? 3 : stages.includes(previous.stage2From) ? 2 : null;
        if (stage) slots[stage][regionOf(team)]++;
    }
    return slots;
};

export const totalSlots = (slots: StageSlots, region: Region) => slots[1][region] + slots[2][region] + slots[3][region];

/** How many of `descending` are strictly above `points`. */
export const countAbove = (descending: ArrayLike<number>, points: number): number => {
    let lo = 0;
    let hi = descending.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (descending[mid] > points) lo = mid + 1;
        else hi = mid;
    }
    return lo;
};

/** Walks each regional list in rank order, filling Stage 3, then 2, then 1; a roster that isn't intact passes its slot down. */
export const allocateInvites = (
    rosters: ProjectedRoster[],
    slots: Record<InviteStage, Record<Region, number>>,
    isIntact: (r: ProjectedRoster) => boolean
): Map<string, InviteStage> => {
    const invites = new Map<string, InviteStage>();
    for (const region of REGIONS) {
        const regionSlots: InviteStage[] = [
            ...Array<InviteStage>(slots[3][region]).fill(3),
            ...Array<InviteStage>(slots[2][region]).fill(2),
            ...Array<InviteStage>(slots[1][region]).fill(1),
        ];
        const list = rosters
            .filter((r) => r.region === region && r.regionalRank !== null)
            .sort((a, b) => a.regionalRank! - b.regionalRank!);
        let next = 0;
        for (const r of list) {
            if (next >= regionSlots.length) break;
            if (!isIntact(r)) continue;
            invites.set(r.rosterKey, regionSlots[next++]);
        }
    }
    return invites;
};

/** Squad lookup for the intact rule: a roster is intact if some current squad still has `minRetained` of its players. */
export const makeIntactCheck = (
    squads: Map<string, Set<string>>,
    minRetained: number
): ((r: ProjectedRoster) => boolean | null) => {
    const teamsOf = new Map<string, string[]>();
    for (const [team, players] of squads) {
        for (const p of players) teamsOf.set(p, [...(teamsOf.get(p) ?? []), team]);
    }
    return (r) => {
        const counts = new Map<string, number>();
        let known = 0;
        for (const nick of r.players) {
            const teams = teamsOf.get(nick.toLowerCase());
            if (!teams) continue;
            known++;
            for (const t of teams) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        // No squad data for the roster: unknown, which the caller treats as intact.
        if (known === 0) return null;
        return Math.max(0, ...counts.values()) >= minRetained;
    };
};

/**
 * Major Supplemental Rulebook § Regional Assignment: a roster is ineligible for a regional invite
 * if a core of `minShared`+ of its players appeared in another region's VRS list in the preceding 3 calendar months.
 */
export const makeRegionEligibleCheck = (
    priorRosters: Array<{ region: Region; players: string[] }>,
    exceptions: RegionException[] = [],
    minShared = 3
): ((r: Pick<ProjectedRoster, "region" | "players">) => boolean) => {
    const byPlayer = new Map<string, number[]>();
    priorRosters.forEach((entry, idx) => {
        for (const p of entry.players) {
            const key = p.toLowerCase();
            const list = byPlayer.get(key);
            if (list) list.push(idx);
            else byPlayer.set(key, [idx]);
        }
    });
    const normalizedExceptions = exceptions.map((e) => ({
        region: e.region,
        players: new Set(e.players.map((p) => p.toLowerCase())),
    }));

    return (r) => {
        const lower = r.players.map((p) => p.toLowerCase());
        if (normalizedExceptions.some((e) => e.region === r.region && lower.filter((p) => e.players.has(p)).length >= minShared)) {
            return true;
        }
        const counts = new Map<number, number>();
        for (const p of lower) {
            for (const idx of byPlayer.get(p) ?? []) {
                if (priorRosters[idx].region === r.region) continue;
                const next = (counts.get(idx) ?? 0) + 1;
                if (next >= minShared) return false;
                counts.set(idx, next);
            }
        }
        return true;
    };
};
