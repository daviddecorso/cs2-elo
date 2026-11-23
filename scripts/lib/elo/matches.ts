import type { EloMatchesData, EloRoster, MatchMapBreakdown, MatchSide, ScheduledMatch } from "../../../src/elo/types.ts";
import type { UpcomingStore } from "../liquipedia/upcoming.ts";
import { slugOf } from "../sim/catalog.ts";
import { templatePages } from "../sim/participants.ts";
import type { VetoForecaster } from "../sim/vetoForecast.ts";
import type { EloEngine, Lineage, SeriesPrediction } from "./engine.ts";
import { parseTime, teamPage, type RawRow } from "./normalize.ts";
import { publishRating } from "./publish.ts";
import type { EloMatch, EloPlayers } from "./types.ts";

const DEFAULT_RECENT_DAYS = 14;
/** Drop unfinished rows whose scheduled time is far behind the feed's latest completed match. */
const STALE_UPCOMING_SECONDS = 3 * 86400;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const asArray = (v: unknown): RawRow[] => (Array.isArray(v) ? (v as RawRow[]) : []);

const parseTier = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : null;
};

const humanEventName = (page: string) => page.replace(/_/g, " ").split("/").join(" ");

/** Collects earlier team pages from `opponentaliases` across all placement rows so renamed teams keep their rating. */
const allPreviousNames = (placementRows: RawRow[], pages: Map<string, string>): Map<string, string[]> => {
    const out = new Map<string, Set<string>>();
    for (const row of placementRows) {
        if (row.opponenttype !== "team" || !row.opponenttemplate) continue;
        const current = pages.get(String(row.opponenttemplate).toLowerCase()) ?? String(row.opponentname ?? "");
        if (!current || current === "TBD") continue;
        const aliases = Object.values(((row.extradata ?? {}) as RawRow).opponentaliases ?? {}).map((t) => String(t).toLowerCase());
        const earlier = [String(row.opponentname ?? ""), ...aliases.map((t) => pages.get(t)).filter((p): p is string => !!p)];
        for (const name of earlier) {
            if (!name || name === current || name === "TBD") continue;
            if (!out.has(current)) out.set(current, new Set());
            out.get(current)!.add(name);
        }
    }
    return new Map([...out].map(([k, set]) => [k, [...set]]));
};

const extractPlayers = (opp: RawRow, knownPlayers: EloPlayers): Array<{ page: string; nick: string }> =>
    asArray(opp.match2players)
        .map((p) => {
            const page = String(p.name ?? "");
            if (!page) return null;
            return { page, nick: String(p.displayname || knownPlayers[page]?.nick || page) };
        })
        .filter((p): p is { page: string; nick: string } => p !== null);

const lineupPlayers = (pages: string[], knownPlayers: EloPlayers): Array<{ page: string; nick: string }> =>
    pages.map((page) => ({ page, nick: knownPlayers[page]?.nick ?? page }));

const combineSection = (parentName: string, rowTournament: string, section: string): string | undefined => {
    const parts: string[] = [];
    if (rowTournament && rowTournament !== parentName) {
        const prefix = `${parentName}:`;
        const suffix = rowTournament.startsWith(prefix) ? rowTournament.slice(prefix.length).trim() : "";
        if (suffix) parts.push(suffix);
    }
    if (section && !parts.some((p) => p.toLowerCase() === section.toLowerCase())) {
        parts.push(section);
    }
    return parts.length > 0 ? parts.join(" · ") : undefined;
};

export interface BuildMatchesArgs {
    engine: EloEngine;
    predictions: SeriesPrediction[];
    matchById: Map<string, EloMatch>;
    players: EloPlayers;
    rosters: EloRoster[];
    lastT: number;
    asOf: string;
    upcoming: UpcomingStore | null;
    tournamentRows: RawRow[];
    placementRows: RawRow[];
    finishedRawRows: RawRow[];
    configuredEvents: Array<{ slug: string; name: string; liquipedia: string; vetoOrder?: Record<number, string> }>;
    forecastVeto?: VetoForecaster;
    recentDays?: number;
}

export const buildMatches = ({
    engine,
    predictions,
    matchById,
    players,
    rosters,
    lastT,
    asOf,
    upcoming,
    tournamentRows,
    placementRows,
    finishedRawRows,
    configuredEvents,
    forecastVeto,
    recentDays = DEFAULT_RECENT_DAYS,
}: BuildMatchesArgs): EloMatchesData => {
    const rosterByTeam = new Map(rosters.map((r) => [r.team, r]));
    const configuredByPage = new Map(configuredEvents.map((c) => [c.liquipedia, c]));
    const tournamentByPage = new Map<string, RawRow>();
    for (const row of tournamentRows) {
        if (typeof row.pagename === "string") tournamentByPage.set(row.pagename, row);
    }

    const pages = templatePages([...finishedRawRows, ...(upcoming?.matches ?? [])]);
    const prevNames = allPreviousNames(placementRows, pages);

    const resolveEventInfo = (parent: string, page: string) => {
        const cfg = configuredByPage.get(parent);
        const tRow = tournamentByPage.get(parent) ?? tournamentByPage.get(page);
        const eventName = cfg?.name || String(tRow?.name || "") || humanEventName(parent);
        const eventSlug = cfg?.slug ?? slugOf(parent);
        return { eventName, eventSlug, tRow };
    };

    const rosterFor = (team: string, lineage: Lineage | null): EloRoster | undefined =>
        rosterByTeam.get(team) ?? (lineage ? rosterByTeam.get(lineage.team) : undefined);

    const seenUpcoming = new Set<string>();
    const upcomingMatches: ScheduledMatch[] = [];

    for (const m of upcoming?.matches ?? []) {
        if (m.game !== undefined && m.game !== "cs2") continue;
        if (Number(m.finished) === 1 || m.walkover === "ff" || m.resulttype === "default") continue;

        const page = String(m.pagename ?? "");
        const id = `${page}:${String(m.match2id ?? m.objectname ?? "")}`;
        if (!page || seenUpcoming.has(id) || matchById.has(id)) continue;

        const opponents = asArray(m.match2opponents);
        if (opponents.length !== 2) continue;
        if (opponents.some((o) => o.type !== undefined && o.type !== "team")) continue;
        if (opponents.some((o) => String(o.template ?? "").toLowerCase() === "tbd")) continue;

        const teams = opponents.map(teamPage) as [string, string];
        if (teams.some((t) => !t || t === "TBD") || teams[0] === teams[1]) continue;

        const rawT = parseTime(m);
        const t = rawT > 0 ? rawT : null;
        if (t !== null && t < lastT - STALE_UPCOMING_SECONDS) continue;

        seenUpcoming.add(id);

        const parent = String(m.parent || page);
        const { eventName, eventSlug, tRow } = resolveEventInfo(parent, page);
        const type = String(m.type ?? "");
        const lan = type === "Offline" || (type !== "Online" && String(tRow?.type ?? "").toLowerCase() === "offline");
        const tier = parseTier(m.liquipediatier) ?? parseTier(tRow?.liquipediatier);
        const bestOf = Number(m.bestof) || 0;
        const rowPlayers = [extractPlayers(opponents[0], players), extractPlayers(opponents[1], players)] as const;

        const pred = engine.predictMatchup(teams, {
            t: lastT,
            bestOf,
            lan,
            tier,
            lineups: [rowPlayers[0].map((p) => p.page), rowPlayers[1].map((p) => p.page)],
            previousNames: [prevNames.get(teams[0]) ?? [], prevNames.get(teams[1]) ?? []],
        });

        const sides = ([0, 1] as const).map((i): MatchSide => {
            const team = teams[i];
            const lineage = pred.lineages[i];
            const roster = rosterFor(team, lineage);
            const rating = pred.ratings[i];
            const listed = rowPlayers[i].length > 0 ? rowPlayers[i] : roster ? roster.players : lineage ? lineupPlayers(lineage.core, players) : undefined;
            const profileTeam = roster && roster.team !== team ? roster.team : undefined;
            return {
                team,
                ...(profileTeam ? { profileTeam } : {}),
                rank: roster?.rank ?? null,
                vrsRank: roster?.vrs?.rank ?? null,
                rating: rating !== null ? publishRating(rating) : null,
                rated: lineage !== null,
                ...(listed && listed.length > 0 ? { players: listed } : {}),
            };
        }) as [MatchSide, MatchSide];

        const [la, lb] = pred.lineages;
        const [ra, rb] = pred.ratings;
        const veto =
            la && lb && ra !== null && rb !== null
                ? forecastVeto?.({
                      lineages: [la.id, lb.id],
                      ratings: [ra, rb],
                      bestOf,
                      order: configuredByPage.get(parent)?.vetoOrder?.[bestOf],
                  })
                : undefined;

        const section = combineSection(eventName, String(m.tournament ?? ""), String(m.section ?? ""));

        upcomingMatches.push({
            id,
            t,
            dateExact: Number(m.dateexact) === 1 && t !== null,
            status: "upcoming",
            event: parent,
            eventName,
            eventSlug,
            page,
            ...(section ? { section } : {}),
            tier,
            lan,
            bestOf,
            sides,
            p: round4(pred.p),
            seriesOdds: {
                bo1: round4(pred.seriesOdds.bo1),
                bo3: round4(pred.seriesOdds.bo3),
                bo5: round4(pred.seriesOdds.bo5),
            },
            maps: pred.maps.map((mp) => ({
                map: mp.map,
                p: round4(mp.p),
                offsets: [round1(mp.offsets[0]), round1(mp.offsets[1])],
            })),
            ...(veto ? { veto } : {}),
        });
    }

    upcomingMatches.sort((a, b) => {
        if (a.t === null && b.t !== null) return 1;
        if (a.t !== null && b.t === null) return -1;
        if (a.t !== null && b.t !== null && a.t !== b.t) return a.t - b.t;
        return a.id.localeCompare(b.id);
    });

    const recentFrom = lastT - recentDays * 86400;
    const recentMatches: ScheduledMatch[] = [];
    for (let i = predictions.length - 1; i >= 0 && predictions[i].t >= recentFrom; i--) {
        const s = predictions[i];
        const match = matchById.get(s.id);
        if (!match) continue;
        const page = s.id.split(":")[0] || match.event;
        const { eventName, eventSlug } = resolveEventInfo(match.event, page);

        const mapsWon = [0, 0];
        const maps: MatchMapBreakdown[] = s.maps.map((m, idx) => {
            const rounds = match.maps[idx]?.rounds ?? [0, 0];
            const winner: 0 | 1 = m.y === 1 ? 0 : 1;
            mapsWon[winner]++;
            return {
                map: m.map,
                p: round4(m.p),
                rounds,
                winner,
            };
        });

        const sides = ([0, 1] as const).map((side): MatchSide => {
            const team = s.teams[side];
            const roster = rosterByTeam.get(team);
            const listed = s.lineups[side].length > 0 ? lineupPlayers(s.lineups[side], players) : roster?.players;
            return {
                team,
                rank: roster?.rank ?? null,
                vrsRank: roster?.vrs?.rank ?? null,
                rating: publishRating(s.ratings[side] + s.regionPriors[side]),
                rated: true,
                score: mapsWon[side],
                delta: round1(s.after[side] - s.ratings[side]),
                ...(listed && listed.length > 0 ? { players: listed } : {}),
            };
        }) as [MatchSide, MatchSide];

        recentMatches.push({
            id: s.id,
            t: s.t,
            dateExact: true,
            status: "completed",
            event: match.event,
            eventName,
            eventSlug,
            page,
            tier: s.tier,
            lan: s.lan,
            bestOf: s.bestOf,
            sides,
            p: round4(s.p),
            winner: s.y === 1 ? 0 : 1,
            maps,
        });
    }

    return {
        generatedAt: new Date().toISOString(),
        asOf,
        upcomingFetched: upcoming?.fetched ?? null,
        topRating: rosters[0]?.rating ?? 0,
        pool: engine.activePool(lastT),
        upcoming: upcomingMatches,
        recent: recentMatches,
    };
};
