import type { Roster } from "./types.ts";

export const getPlayerOverlap = (p1: readonly string[], p2: readonly string[]): number => {
    const s1 = new Set(p1.map((p) => p.trim().toLowerCase()));
    return p2.filter((p) => s1.has(p.trim().toLowerCase())).length;
};

interface Candidate {
    liveRoster: Roster;
    prevRoster: Roster;
    overlap: number;
    sameName: boolean;
}

export const matchPreviousRanks = (
    liveRosters: readonly Roster[],
    prevRosters: readonly Roster[]
): Map<string, number | null> => {
    const ranks = new Map<string, number | null>();
    const matchedPrev = new Set<string>();
    const matchedLive = new Set<string>();

    const prevByKey = new Map<string, Roster>();
    for (const p of prevRosters) {
        if (p.rosterKey) prevByKey.set(p.rosterKey, p);
    }

    for (const liveR of liveRosters) {
        if (!liveR.rosterKey || liveR.players.length < 3) continue;
        const exact = prevByKey.get(liveR.rosterKey);
        if (exact && exact.players.length >= 3) {
            ranks.set(liveR.rosterKey, exact.globalRank ?? null);
            matchedPrev.add(exact.rosterKey);
            matchedLive.add(liveR.rosterKey);
        }
    }

    const candidates: Candidate[] = [];

    for (const liveR of liveRosters) {
        if (matchedLive.has(liveR.rosterKey) || liveR.players.length < 3) continue;

        for (const prevR of prevRosters) {
            if (matchedPrev.has(prevR.rosterKey) || prevR.players.length < 3) continue;
            const overlap = getPlayerOverlap(liveR.players, prevR.players);
            if (overlap >= 3) {
                candidates.push({
                    liveRoster: liveR,
                    prevRoster: prevR,
                    overlap,
                    sameName: liveR.teamName.trim().toLowerCase() === prevR.teamName.trim().toLowerCase(),
                });
            }
        }
    }

    candidates.sort((a, b) => {
        if (a.overlap !== b.overlap) return b.overlap - a.overlap;
        if (a.sameName !== b.sameName) return a.sameName ? -1 : 1;
        if (a.liveRoster.points !== b.liveRoster.points) return b.liveRoster.points - a.liveRoster.points;
        return b.prevRoster.points - a.prevRoster.points;
    });

    for (const c of candidates) {
        if (matchedLive.has(c.liveRoster.rosterKey) || matchedPrev.has(c.prevRoster.rosterKey)) {
            continue;
        }
        ranks.set(c.liveRoster.rosterKey, c.prevRoster.globalRank ?? null);
        matchedLive.add(c.liveRoster.rosterKey);
        matchedPrev.add(c.prevRoster.rosterKey);
    }

    for (const liveR of liveRosters) {
        if (!ranks.has(liveR.rosterKey)) {
            ranks.set(liveR.rosterKey, null);
        }
    }

    return ranks;
};
