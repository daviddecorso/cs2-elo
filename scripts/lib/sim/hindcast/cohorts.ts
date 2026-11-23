import type { Region, Roster } from "../../../../src/vrs/types.ts";

const MIN_SHARED_PLAYERS = 3;
export const REGION_INDEX: Region[] = ["Europe", "Americas", "Asia"];

/** A roster scored across dates: the same team is whichever ranked roster shares 3+ of these players, with the most points. */
export interface CohortRoster {
    rosterKey: string;
    teamName: string;
    players: string[];
    region: Region;
    globalRank: number;
    regionalRank: number;
    points: number;
}

/** Points, ranks (0 = unranked) and region index (-1 = none) per cohort roster, in cohort order. */
export interface CohortScores {
    points: number[];
    globalRanks: number[];
    regionalRanks: number[];
    regions: number[];
}

export const cohortOf = (rosters: Roster[], maxRank: number): CohortRoster[] =>
    rosters
        .filter((r) => r.globalRank !== null && r.globalRank <= maxRank && r.regionalRank !== null)
        .sort((a, b) => a.globalRank! - b.globalRank!)
        .map((r) => ({
            rosterKey: r.rosterKey,
            teamName: r.teamName,
            players: r.players.map((p) => p.toLowerCase()),
            region: r.region,
            globalRank: r.globalRank!,
            regionalRank: r.regionalRank!,
            points: r.points,
        }));

/** Each cohort roster's best-points ranked match in `rosters`; unmatched rosters score 0 points and no rank. */
export const scoreCohort = (cohort: Array<{ players: string[] }>, rosters: Roster[]): CohortScores => {
    const byNick = new Map<string, Roster[]>();
    for (const r of rosters) {
        if (r.globalRank === null) continue;
        for (const p of r.players) {
            const nick = p.toLowerCase();
            byNick.set(nick, [...(byNick.get(nick) ?? []), r]);
        }
    }
    const out: CohortScores = { points: [], globalRanks: [], regionalRanks: [], regions: [] };
    for (const c of cohort) {
        const shared = new Map<Roster, number>();
        for (const nick of c.players) for (const r of byNick.get(nick) ?? []) shared.set(r, (shared.get(r) ?? 0) + 1);
        const best = [...shared].filter(([, k]) => k >= MIN_SHARED_PLAYERS).sort((a, b) => b[0].points - a[0].points)[0]?.[0];
        out.points.push(best?.points ?? 0);
        out.globalRanks.push(best?.globalRank ?? 0);
        out.regionalRanks.push(best?.regionalRank ?? 0);
        out.regions.push(best ? REGION_INDEX.indexOf(best.region) : -1);
    }
    return out;
};
