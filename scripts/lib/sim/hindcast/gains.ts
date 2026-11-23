import type { Roster, Standings } from "../../../../src/vrs/types.ts";
import { freeze, scoreTeam, withoutEvents, type FreezeInput } from "../../vrs/oneTeam.ts";

const MIN_SHARED_PLAYERS = 3;

/** The best-points ranked roster sharing 3+ of `players` (lowercase nicks), else null. */
export const matchRoster = (players: string[], rosters: Roster[]): Roster | null => {
    const nicks = new Set(players);
    let best: Roster | null = null;
    for (const r of rosters) {
        if (r.globalRank === null) continue;
        if (r.players.filter((p) => nicks.has(p.toLowerCase())).length < MIN_SHARED_PLAYERS) continue;
        if (!best || r.points > best.points) best = r;
    }
    return best;
};

export interface CohortGain {
    /** Index in the cohort. */
    i: number;
    eventId: string;
    gain: number;
}

/** For each cohort roster ranked in `standings`, what each event whose last match falls in (since, until] (unix seconds) added to its points there. */
export const cohortGains = (state: FreezeInput, standings: Standings, cohort: Array<{ players: string[] }>, since: number, until: number): CohortGain[] => {
    const frozen = freeze(state);
    const index = new Map(frozen.rosters.map((r, k) => [r.rosterKey, k]));
    const out: CohortGain[] = [];
    cohort.forEach((c, i) => {
        const roster = matchRoster(c.players, standings.rosters);
        const k = roster ? index.get(roster.rosterKey) : undefined;
        if (k === undefined) return;
        const ledger = frozen.ledgers[k];
        for (const ev of ledger.events) {
            if (ev.lastMatchTime <= since || ev.lastMatchTime > until) continue;
            if (!ledger.matches.some((m) => m.eventId === ev.eventId)) continue;
            out.push({ i, eventId: ev.eventId, gain: frozen.rosters[k].points - scoreTeam(frozen, withoutEvents(ledger, new Set([ev.eventId])), { rank: false }).points });
        }
    });
    return out;
};
