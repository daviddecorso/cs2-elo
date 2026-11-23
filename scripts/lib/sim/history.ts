import fs from "node:fs";
import path from "node:path";
import type { Region, Roster } from "../../../src/vrs/types.ts";
import type { RawRow } from "../elo/normalize.ts";
import { readUpcoming } from "../liquipedia/upcoming.ts";
import type { Overrides } from "../vrs/buildMatchdata.ts";
import { publishedSnapshotDates, readPublishedSnapshot } from "../vrs/publishedStandings.ts";
import { loadValveCjs } from "../vrs/valveModel.ts";
import { rankedRules } from "./catalog.ts";
import { readJson } from "./inputs.ts";
import { seriesKey } from "./series.ts";
import type { Matchdata, ValvePlayer } from "../vrs/buildMatchdata.ts";
import { isRanked, kindOf, locationOf, organizerOf, parseVrsLabel, roleOf, type CountryRegion, type RankedRules } from "./catalog.ts";
import type { VrsList } from "./config.ts";
import type { EventRole } from "./formats/genericFormat.ts";
import type { EventKind } from "./schedule.ts";

/** Kinds of event a team's habits are counted in. */
export type ActivityCategory = "lan1" | "lan2" | "lan34" | "online" | "qualifier";
export const CATEGORIES: ActivityCategory[] = ["lan1", "lan2", "lan34", "online", "qualifier"];

export const categoryOf = (kind: EventKind, role: EventRole, tier: number | null): ActivityCategory =>
    role === "qualifier" ? "qualifier" : kind === "online" ? "online" : tier === 1 ? "lan1" : tier === 2 ? "lan2" : "lan34";

/** How an attendee got its place, from Liquipedia's participant label. */
export type SlotLabel = "vrs" | "qualifier" | "direct";

export interface PastAttendee {
    teamId: string;
    globalRank: number | null;
    regionalRank: number | null;
    region: Region | null;
    label?: SlotLabel;
    vrs?: { list: VrsList | null; month: string | null };
    /** Lowercase nick and ISO country of each player it fielded. */
    players?: Array<{ nick: string; country: string }>;
}

export interface PastEdition {
    page: string;
    name: string;
    series: string;
    kind: EventKind;
    role: EventRole;
    tier: number | null;
    publisherTier: string;
    category: ActivityCategory;
    region: Region | null;
    /** Liquipedia's first organizer, "" when unset. */
    organizer?: string;
    /** ISO country of the venue, "" when online or unknown. */
    country?: string;
    prizePool: number;
    teams: number;
    startDate: string;
    endDate: string;
    /** Date of the published VRS list attendee ranks come from. */
    listDate: string | null;
    attendees: PastAttendee[];
    /** Liquipedia labels at least half the attendees with how they got in. */
    labeled: boolean;
}


/** Per event id, each team with an unforfeited match there and the first lineup it fielded. */
export type Attendance = Map<string, Map<string, ValvePlayer[]>>;

export const attendanceOf = (matchdata: Matchdata, into: Attendance = new Map()): Attendance => {
    for (const m of matchdata.matches) {
        if (m.forfeited) continue;
        const id = String(m.eventId);
        let teams = into.get(id);
        if (!teams) into.set(id, (teams = new Map()));
        if (!teams.has(String(m.team1Id))) teams.set(String(m.team1Id), m.team1Players);
        if (!teams.has(String(m.team2Id))) teams.set(String(m.team2Id), m.team2Players);
    }
    return into;
};

export interface HistoryInput {
    tournamentRows: RawRow[];
    placementRows: RawRow[];
    attendance: Attendance;
    /** Editions must have ended by this day. */
    finishedBy: string;
    /** Published VRS lists, any order. */
    lists: Array<{ date: string; rosters: Roster[] }>;
    rules: RankedRules;
    countryRegion: CountryRegion;
    /** Liquipedia team page → matchdata team id. */
    teamIdOf: (page: string) => string;
    /** Liquipedia page → matchdata event id. */
    eventIdOf: (page: string) => string;
    /** Editions starting in [from, to). */
    from: string;
    to: string;
}

/** Settled months of what `pastEditions` reads, committed because CI has no `data/raw/archive` (`npm run freeze-sim-history`). */
export const SIM_HISTORY_DIR = "data/history/sim";

export interface FrozenSimMonth {
    month: string;
    tournaments: RawRow[];
    /** Participant and placement rows on parent pages. */
    placements: RawRow[];
    attendance: Array<{ eventId: string; teams: Array<{ teamId: string; players: ValvePlayer[] }> }>;
}

const frozenCache = new Map<string, FrozenSimMonth[]>();
export const readFrozenSimMonths = (dir = SIM_HISTORY_DIR): FrozenSimMonth[] => {
    let months = frozenCache.get(dir);
    if (!months) {
        months = fs.existsSync(dir)
            ? fs
                  .readdirSync(dir)
                  .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
                  .sort()
                  .map((f) => readJson<FrozenSimMonth>(path.join(dir, f), { month: f.slice(0, 7), tournaments: [], placements: [], attendance: [] }))
            : [];
        frozenCache.set(dir, months);
    }
    return months;
};

/** Tournament and placement rows from frozen months, the archive, the hot store, then the upcoming store, so later rows win per page. */
export const readHistoryRows = (rawDir = "data/raw", frozenDir = SIM_HISTORY_DIR): { tournamentRows: RawRow[]; placementRows: RawRow[] } => {
    const archive = path.join(rawDir, "archive");
    const monthly = (prefix: string) =>
        fs.existsSync(archive)
            ? fs
                  .readdirSync(archive)
                  .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
                  .sort()
                  .flatMap((f) => readJson<RawRow[]>(path.join(archive, f), []))
            : [];
    const upcoming = readUpcoming();
    const tournamentRows = [...monthly("tournaments-"), ...readJson<RawRow[]>(path.join(rawDir, "tournaments.json"), []), ...(upcoming?.tournaments ?? [])];
    const placementRows = [...monthly("placements-"), ...readJson<RawRow[]>(path.join(rawDir, "placements.json"), []), ...(upcoming?.placements ?? [])];
    // Frozen rows only fill pages the stores lack: repeated participant rows would count a page's slots twice.
    const pages = new Set(tournamentRows.map((r) => String(r.pagename)));
    const parents = new Set(placementRows.map((r) => String(r.parent)));
    const frozen = readFrozenSimMonths(frozenDir);
    return {
        tournamentRows: [...frozen.flatMap((m) => m.tournaments.filter((r) => !pages.has(String(r.pagename)))), ...tournamentRows],
        placementRows: [...frozen.flatMap((m) => m.placements.filter((r) => !parents.has(String(r.parent)))), ...placementRows],
    };
};

/** Frozen months' attendance merged per team with `matchdata`'s, whose lineups win; an event straddling the hot store's start is only partly in it. */
export const readAttendance = (matchdata: Matchdata, frozenDir = SIM_HISTORY_DIR): Attendance => {
    const out: Attendance = new Map();
    for (const m of readFrozenSimMonths(frozenDir)) for (const e of m.attendance) out.set(e.eventId, new Map(e.teams.map((t) => [t.teamId, t.players])));
    for (const [id, teams] of attendanceOf(matchdata)) out.set(id, new Map([...(out.get(id) ?? []), ...teams]));
    return out;
};

/** Valve's published lists, and so attendee ranks, start in August 2024. */
export const HISTORY_FROM = "2024-08-01";

/** Built by `npm run build-matchdata-full` from the local archive; `data/matchdata.json` only holds the hot store's ~190 days. */
export const FULL_MATCHDATA = "data/matchdata-full.json";

/** `current` (default `data/matchdata.json`) with every older match spliced in from `FULL_MATCHDATA`, when that file exists. */
export const readMatchHistory = (current?: Matchdata): Matchdata => {
    const now = current ?? readJson<Matchdata | null>("data/matchdata.json", null);
    if (!now) throw new Error("data/matchdata.json is missing; run npm run build-matchdata first");
    const full = readJson<Matchdata | null>(FULL_MATCHDATA, null);
    if (!full) return now;
    const from = now.matches.reduce((t, m) => Math.min(t, m.matchStartTime), Infinity);
    const older = full.matches.filter((m) => m.matchStartTime < from);
    const olderEvents = new Set(older.map((m) => String(m.eventId)));
    const nowEvents = new Set(now.events.map((e) => String(e.eventId)));
    return {
        ...now,
        matches: [...older, ...now.matches],
        events: [...full.events.filter((e) => olderEvents.has(String(e.eventId)) && !nowEvents.has(String(e.eventId))), ...now.events],
    };
};

/** Every past edition and published list from local files, with team ids as the model input spells them; for scripts that don't load a season. */
export const loadHistory = (valveRoot: string) => {
    const overrides = readJson<Overrides>("data/overrides.json", {});
    const matchdata = readMatchHistory();
    const lists = publishedSnapshotDates(valveRoot, ["invitation"]).map((date) => ({ date, rosters: readPublishedSnapshot(valveRoot, date).rosters }));
    const countryRegion = (loadValveCjs(path.join(valveRoot, "model/util/region.js")) as { getCountryRegion: CountryRegion }).getCountryRegion;
    const lastDay = new Date(matchdata.matches.reduce((t, m) => Math.max(t, m.matchStartTime), 0) * 1000).toISOString().slice(0, 10);
    const editions = pastEditions({
        ...readHistoryRows(),
        attendance: readAttendance(matchdata),
        finishedBy: lastDay,
        lists,
        rules: rankedRules(overrides),
        countryRegion,
        teamIdOf: (page) => overrides.teamAliases?.[page]?.targetTeamId ?? page,
        eventIdOf: (page) => overrides.eventRollups?.[page]?.parentEventId ?? page,
        from: HISTORY_FROM,
        to: lastDay,
    });
    return { editions, lists, countryRegion, lastDay };
};

const MIN_SHARED_PLAYERS = 3;
const VALVE_REGIONS: Region[] = ["Europe", "Americas", "Asia"];
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Valve region of a majority of a lineup's players, else null. */
export const lineupRegion = (players: ValvePlayer[], countryRegion: CountryRegion): Region | null => {
    const counts = new Map<Region, number>();
    for (const p of players) {
        try {
            const r = VALVE_REGIONS[countryRegion(String(p.countryIso ?? "").toLowerCase())];
            if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
        } catch {
            // Valve's table throws on unknown codes; that player just doesn't vote.
        }
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] * 2 > players.length ? best[0] : null;
};

/** Every ranked event in range that has finished, with who played it, their rank on the list then and how they got in. */
export const pastEditions = (input: HistoryInput): PastEdition[] => {
    const rowByPage = new Map<string, RawRow>();
    for (const r of input.tournamentRows) rowByPage.set(str(r.pagename), r);
    const { finishedBy } = input;

    const rows = [...rowByPage.values()].filter((r) => {
        const start = str(r.startdate);
        return (
            start >= input.from &&
            start < input.to &&
            str(r.enddate) <= finishedBy &&
            !/cancelled|postponed/i.test(str(r.status)) &&
            str(r.liquipediatiertype) !== "Showmatch" &&
            isRanked(r, input.rules)
        );
    });
    const rowByEventId = new Map<string, RawRow>();
    for (const r of rows) {
        const id = input.eventIdOf(str(r.pagename));
        if (!rowByEventId.has(id) || str(r.pagename) === id) rowByEventId.set(id, r);
    }

    const lineupsByEvent = input.attendance;

    const labelsByPage = new Map<string, Map<string, Pick<PastAttendee, "label" | "vrs">>>();
    for (const r of input.placementRows) {
        if (r.pagename !== r.parent || r.opponenttype !== "team" || !r.opponentname || str(r.opponentname).toUpperCase() === "TBD") continue;
        const page = str(r.pagename);
        let labels = labelsByPage.get(page);
        if (!labels) labelsByPage.set(page, (labels = new Map()));
        const q = str(r.qualifier).replace(/\[\[Category:[^\]]*\]\]/g, "").trim();
        const vrs = parseVrsLabel(q);
        labels.set(input.teamIdOf(str(r.opponentname)), vrs ? { label: "vrs", vrs } : { label: q ? "qualifier" : "direct" });
    }

    const lists = [...input.lists].sort((a, b) => a.date.localeCompare(b.date));
    const nickIndex = new Map<string, Map<string, Roster[]>>();
    const indexOf = (list: { date: string; rosters: Roster[] }) => {
        let index = nickIndex.get(list.date);
        if (!index) {
            index = new Map();
            for (const r of list.rosters) for (const nick of r.players) index.set(nick.toLowerCase(), [...(index.get(nick.toLowerCase()) ?? []), r]);
            nickIndex.set(list.date, index);
        }
        return index;
    };
    const rosterOf = (players: ValvePlayer[], index: Map<string, Roster[]>): Roster | null => {
        const shared = new Map<Roster, number>();
        for (const p of players) for (const r of index.get(p.nick.toLowerCase()) ?? []) shared.set(r, (shared.get(r) ?? 0) + 1);
        return [...shared].filter(([, k]) => k >= MIN_SHARED_PLAYERS).sort((a, b) => b[1] - a[1] || b[0].points - a[0].points)[0]?.[0] ?? null;
    };

    const out: PastEdition[] = [];
    for (const [id, row] of rowByEventId) {
        const lineups = lineupsByEvent.get(id);
        if (!lineups || lineups.size < 2) continue;
        const page = str(row.pagename);
        const startDate = str(row.startdate);
        const list = lists.filter((l) => l.date <= startDate).at(-1) ?? null;
        const index = list ? indexOf(list) : null;
        const labels = labelsByPage.get(page);
        const attendees = [...lineups].map(([teamId, players]): PastAttendee => {
            const roster = index ? rosterOf(players, index) : null;
            return {
                teamId,
                globalRank: roster?.globalRank ?? null,
                regionalRank: roster?.regionalRank ?? null,
                region: roster?.region ?? lineupRegion(players, input.countryRegion),
                ...(labels?.get(teamId) ?? {}),
                players: players.map((p) => ({ nick: p.nick.toLowerCase(), country: str(p.countryIso).toLowerCase() })),
            };
        });
        const kind = kindOf(row);
        const role = roleOf(row);
        const tier = Number(row.liquipediatier) > 0 ? Number(row.liquipediatier) : null;
        out.push({
            page,
            name: str(row.name) || page,
            series: seriesKey(page),
            kind,
            role,
            tier,
            publisherTier: str(row.publishertier),
            category: categoryOf(kind, role, tier),
            region: locationOf(row, input.countryRegion)?.region ?? null,
            organizer: organizerOf(row),
            country: kind === "lan" ? (locationOf(row, input.countryRegion)?.country ?? "") : "",
            prizePool: Number(row.prizepool) || 0,
            teams: lineups.size,
            startDate,
            endDate: str(row.enddate),
            listDate: list?.date ?? null,
            attendees,
            labeled: attendees.filter((a) => a.label).length * 2 >= attendees.length,
        });
    }
    return out.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.page.localeCompare(b.page));
};
