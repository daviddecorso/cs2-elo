import { normalizeCountryIso } from "../vrs/buildMatchdata.ts";
import type { EloMap, EloMatch, EloPlayers } from "./types.ts";

export type RawRow = Record<string, unknown>;

const asArray = (v: unknown): RawRow[] => (Array.isArray(v) ? (v as RawRow[]) : []);

export const parseTime = (m: RawRow): number => {
    const ts = Number((m.extradata as RawRow | undefined)?.timestamp);
    if (ts) return ts;
    const parsed = Date.parse(`${String(m.date ?? "").replace(" ", "T")}Z`);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
};

export const teamPage = (opp: RawRow): string => {
    const template = opp.teamtemplate as RawRow | undefined;
    return String((template?.page as string) || opp.name || opp.template || "");
};

/** Scored maps only: CS2 regulation ends at 13, so a map whose winner has fewer rounds was abandoned or defaulted. */
const parseMaps = (games: RawRow[]): EloMap[] => {
    const maps: EloMap[] = [];
    for (const g of games) {
        if (g.resulttype === "np" || g.resulttype === "default" || g.walkover) continue;
        const scores = Array.isArray(g.scores) ? g.scores.map(Number) : [];
        if (scores.length !== 2 || scores.some((s) => !Number.isFinite(s))) continue;
        if (Math.max(scores[0], scores[1]) < 13 || scores[0] === scores[1]) continue;
        maps.push({ map: String(g.map ?? "Unknown"), rounds: [scores[0], scores[1]] });
    }
    return maps;
};

const parseTier = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : null;
};

/** Liquipedia rows → the clean series feed Elo reads; no VRS coverage rules, aliases or overrides. */
export const normalizeMatches = (
    rawMatches: RawRow[],
    rawTournaments: RawRow[]
): { matches: EloMatch[]; players: EloPlayers } => {
    const tournaments = new Map<string, RawRow>();
    for (const t of rawTournaments) if (typeof t.pagename === "string") tournaments.set(t.pagename, t);

    const players: EloPlayers = {};
    const seen = new Set<string>();
    const matches: EloMatch[] = [];

    for (const m of rawMatches) {
        if (m.game !== undefined && m.game !== "cs2") continue;
        const id = `${String(m.pagename)}:${String(m.match2id ?? m.objectname ?? "")}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const opponents = asArray(m.match2opponents);
        if (opponents.length !== 2 || opponents.some((o) => o.type !== undefined && o.type !== "team")) continue;
        if (m.winner !== "1" && m.winner !== "2") continue;

        const teams = opponents.map(teamPage) as [string, string];
        if (!teams[0] || !teams[1] || teams[0] === teams[1]) continue;

        const lineups = opponents.map((o) =>
            asArray(o.match2players)
                .map((p) => {
                    const name = String(p.name ?? "");
                    if (!name) return "";
                    players[name] = {
                        nick: String(p.displayname || name),
                        country: normalizeCountryIso(String(p.flag ?? "")),
                    };
                    return name;
                })
                .filter(Boolean)
        ) as [string[], string[]];

        const tournament = tournaments.get(String(m.pagename)) ?? tournaments.get(String(m.parent ?? ""));
        const type = String(m.type ?? "");
        const lan = type === "Offline" || (type !== "Online" && String(tournament?.type ?? "").toLowerCase() === "offline");
        const prize = Number(tournament?.prizepool);

        matches.push({
            id,
            t: parseTime(m),
            event: String(m.parent || m.pagename),
            tier: parseTier(m.liquipediatier),
            lan,
            prizePool: Number.isFinite(prize) && prize > 0 ? prize : null,
            bestOf: Number(m.bestof) || 0,
            teams,
            lineups,
            winner: m.winner === "1" ? 0 : 1,
            forfeit: m.walkover === "ff" || m.resulttype === "default",
            maps: parseMaps(asArray(m.match2games)),
        });
    }

    matches.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
    return { matches, players };
};
