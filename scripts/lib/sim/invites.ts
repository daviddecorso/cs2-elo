import fs from "node:fs";
import path from "node:path";
import type { Region } from "../../../src/vrs/types.ts";
import type { ProjectedRoster } from "./vrsProjection.ts";

export const REGIONS: Region[] = ["Europe", "Americas", "Asia"];

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
