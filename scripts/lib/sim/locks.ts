import { parseTime, teamPage, type RawRow } from "../elo/normalize.ts";
import type { TeamId } from "./types.ts";

export interface KnownMatch {
    id: string;
    teams: [TeamId, TeamId];
    /** null until played. */
    winner: 0 | 1 | null;
    /** Swiss round from the match section, else the bracket column from `match2id`. */
    round: number | null;
    t: number;
}

const roundOf = (m: RawRow): number | null => {
    const section = String((m.extradata as RawRow | undefined)?.matchsection ?? "");
    const fromSection = /Round (\d+)/i.exec(section);
    if (fromSection) return Number(fromSection[1]);
    const fromId = /_R(\d+)-M\d+$/.exec(String(m.match2id ?? ""));
    return fromId ? Number(fromId[1]) : null;
};

/** Matches on one stage page (and `sections`, if given) with both opponents known, finished or not, in match order. */
export const knownMatches = (rows: RawRow[], page: string, sections?: string[]): KnownMatch[] => {
    const seen = new Set<string>();
    const out: KnownMatch[] = [];
    for (const m of rows) {
        if (m.pagename !== page) continue;
        if (sections && !sections.includes(String(m.section ?? ""))) continue;
        const id = String(m.match2id ?? "");
        if (seen.has(id)) continue;
        const opponents = Array.isArray(m.match2opponents) ? (m.match2opponents as RawRow[]) : [];
        // Placeholders like "Group A 1st Place" carry the `tbd` template under their own name.
        if (opponents.length !== 2 || opponents.some((o) => String(o.template ?? "").toLowerCase() === "tbd")) continue;
        const teams = opponents.map(teamPage) as [TeamId, TeamId];
        if (teams.some((t) => !t || t === "TBD") || teams[0] === teams[1]) continue;
        seen.add(id);
        const finished = Number(m.finished) === 1 && (m.winner === "1" || m.winner === "2");
        out.push({ id, teams, winner: finished ? (m.winner === "1" ? 0 : 1) : null, round: roundOf(m), t: parseTime(m) });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
};

/** One simulation's view of a stage's known matches; each played result is used once, earliest first. */
export class StageLocks {
    private used = new Set<KnownMatch>();
    private played: KnownMatch[];
    private known: KnownMatch[];

    constructor(known: KnownMatch[]) {
        this.known = known;
        this.played = known.filter((k) => k.winner !== null).sort((a, b) => a.t - b.t);
    }

    take(a: TeamId, b: TeamId): KnownMatch | undefined {
        const hit = this.played.find(
            (k) => !this.used.has(k) && ((k.teams[0] === a && k.teams[1] === b) || (k.teams[0] === b && k.teams[1] === a))
        );
        if (hit) this.used.add(hit);
        return hit;
    }

    pairings(round: number): Array<[TeamId, TeamId]> {
        return this.known.filter((k) => k.round === round).map((k) => k.teams);
    }

    /** Played matches this simulation never reached, meaning its pairings diverged from what happened. */
    unused(): KnownMatch[] {
        return this.played.filter((k) => !this.used.has(k));
    }
}
