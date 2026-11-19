import type { PlanIndex } from "../../../../src/sim/types.ts";
import type { Region } from "../../../../src/vrs/types.ts";

export interface BatchCandidate {
    team: string;
    teamName: string;
    region: Region;
    /** Season-rules Major invite share from the nightly team file. */
    invite: number;
}

/** Teams whose invite is most in doubt: within [min, max], closest to even odds first, taken round-robin across regions. */
export const selectTeams = (candidates: BatchCandidate[], { max, min, maxInvite }: { max: number; min: number; maxInvite: number }): BatchCandidate[] => {
    const byRegion = new Map<Region, BatchCandidate[]>();
    const doubt = (c: BatchCandidate) => Math.abs(c.invite - 0.5);
    const inRange = candidates
        .filter((c) => c.invite >= min && c.invite <= maxInvite)
        .sort((a, b) => doubt(a) - doubt(b) || a.team.localeCompare(b.team));
    for (const c of inRange) byRegion.set(c.region, [...(byRegion.get(c.region) ?? []), c]);
    const queues = [...byRegion.values()].sort((a, b) => doubt(a[0]) - doubt(b[0]) || a[0].team.localeCompare(b[0].team));
    const picked: BatchCandidate[] = [];
    for (let round = 0; picked.length < max && queues.some((q) => q.length > round); round++) {
        for (const q of queues) if (q[round] && picked.length < max) picked.push(q[round]);
    }
    return picked;
};

/** Splits the index into entries generated within `keepDays` of `now` and the files of those older. */
export const prune = (index: PlanIndex, now: Date, keepDays: number): { index: PlanIndex; removed: string[] } => {
    const cutoff = now.getTime() - keepDays * 86_400_000;
    const old = (t: PlanIndex["teams"][number]) => Date.parse(t.generatedAt) < cutoff;
    return { index: { ...index, teams: index.teams.filter((t) => !old(t)) }, removed: index.teams.filter(old).map((t) => t.file) };
};
