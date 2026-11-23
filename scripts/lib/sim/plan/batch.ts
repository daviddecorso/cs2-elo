import type { PlanEvents, PlanIndex, PlanTeamFile, SeasonRoster } from "../../../../src/sim/types.ts";
import type { Region } from "../../../../src/vrs/types.ts";

export interface BatchCandidate {
    team: string;
    teamName: string;
    region: Region;
    /** Season-rules Major invite share from the nightly team file; null for a roster with no team file, ranked by its regional rank range instead. */
    invite: number | null;
}

/** Teams whose invite is most in doubt: within [min, max], closest to even odds first, taken round-robin across regions; teams without odds come last. */
export const selectTeams = (candidates: BatchCandidate[], { max, min, maxInvite }: { max: number; min: number; maxInvite: number }): BatchCandidate[] => {
    const byRegion = new Map<Region, BatchCandidate[]>();
    const doubt = (c: BatchCandidate) => (c.invite === null ? 1 : Math.abs(c.invite - 0.5));
    const inRange = candidates
        .filter((c) => c.invite === null || (c.invite >= min && c.invite <= maxInvite))
        .sort((a, b) => doubt(a) - doubt(b) || a.team.localeCompare(b.team));
    for (const c of inRange) byRegion.set(c.region, [...(byRegion.get(c.region) ?? []), c]);
    const queues = [...byRegion.values()].sort((a, b) => doubt(a[0]) - doubt(b[0]) || a[0].team.localeCompare(b[0].team));
    const picked: BatchCandidate[] = [];
    for (let round = 0; picked.length < max && queues.some((q) => q.length > round); round++) {
        for (const q of queues) if (q[round] && picked.length < max) picked.push(q[round]);
    }
    return picked;
};

/** Rosters with no team file whose target regional rank range straddles the invite line: the worst p50 among the region's teams at even odds or better. */
export const bubbleRosters = (rosters: SeasonRoster[], known: BatchCandidate[], hasFile: (teamName: string) => boolean): BatchCandidate[] => {
    const line = new Map<Region, number>();
    const rankOf = new Map(rosters.map((r) => [r.teamName, r.checkpoints.at(-1)?.regionalRank.p50 ?? null]));
    for (const c of known) {
        const rank = rankOf.get(c.teamName);
        if (c.invite !== null && c.invite >= 0.5 && rank != null) line.set(c.region, Math.max(line.get(c.region) ?? 0, rank));
    }
    return rosters.flatMap((r) => {
        const at = r.checkpoints.at(-1)?.regionalRank;
        const cut = line.get(r.region);
        if (!at || cut === undefined || hasFile(r.teamName) || at.p10 === null) return [];
        const worst = at.p90 ?? Infinity;
        return at.p10 <= cut && worst > cut ? [{ team: r.teamName, teamName: r.teamName, region: r.region, invite: null }] : [];
    });
};

/** Splits `items` into consecutive groups of at most `size`. */
export const groupsOf = <T>(items: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
    return out;
};

/** Splits the index into entries generated within `keepDays` of `now` and the files of those older. */
export const prune = (index: PlanIndex, now: Date, keepDays: number): { index: PlanIndex; removed: string[] } => {
    const cutoff = now.getTime() - keepDays * 86_400_000;
    const old = (t: PlanIndex["teams"][number]) => Date.parse(t.generatedAt) < cutoff;
    return { index: { ...index, teams: index.teams.filter((t) => !old(t)) }, removed: index.teams.filter(old).map((t) => t.file) };
};

/** For each event, the planned teams whose default schedule (best for average volume, else the first) goes there, and how. */
export const planEvents = (files: PlanTeamFile[], generatedAt: string): PlanEvents => {
    const events: PlanEvents["events"] = {};
    for (const file of files) {
        const at = file.schedules.findIndex((s) => s.bestFor.includes("average"));
        const schedule = file.schedules[at >= 0 ? at : 0];
        if (!schedule) continue;
        const options = new Map(file.options.map((o) => [o.id, o]));
        for (const id of schedule.options) {
            const option = options.get(id);
            if (!option) continue;
            const worth = schedule.marginal.find((m) => m.option === id)?.invite ?? null;
            (events[option.event.slug] ??= []).push({ team: file.team, teamName: file.teamName, region: file.region, route: option.kind, worth });
        }
    }
    for (const list of Object.values(events)) list.sort((a, b) => (b.worth ?? 0) - (a.worth ?? 0) || a.team.localeCompare(b.team));
    return { generatedAt, events };
};
