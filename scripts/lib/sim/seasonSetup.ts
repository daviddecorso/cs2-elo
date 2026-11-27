import path from "node:path";
import type { Region, Roster, Standings } from "../../../src/vrs/types.ts";
import { liveEngine } from "../elo/adjustments.ts";
import { loadFeed } from "../elo/history.ts";
import type { RawRow } from "../elo/normalize.ts";
import { DEFAULT_PARAMS } from "../elo/params.ts";
import { addDays } from "../liquipedia/rawStore.ts";
import { readUpcoming, UPCOMING_DAYS } from "../liquipedia/upcoming.ts";
import type { Matchdata, Overrides, ValvePlayer } from "../vrs/buildMatchdata.ts";
import { isMajorTier } from "../vrs/majorStages.ts";
import { publishedSnapshotDates, readPriorRegionalRosters, readPublishedSnapshot } from "../vrs/publishedStandings.ts";
import { loadValveCjs } from "../vrs/valveModel.ts";
import { lineupKeepsLinks, loadWorld } from "../vrs/valveWorld.ts";
import { capsFor, fitActivity } from "./activity.ts";
import { isLowerTier, LOWER_TIER_TOP_RANK, welcomes, type ListEntry, type Subregion } from "./attendance.ts";
import { BANDS, bandOf, fitFieldModel, type EventFieldModel } from "./fieldModel.ts";
import { categoryOf, HISTORY_FROM, lineupRegion, pastEditions, readAttendance, readHistoryRows, readMatchHistory, type PastEdition } from "./history.ts";
import { buildCatalog, fitPrizeSplits, kindOf, rankedRules, slotKey, type CatalogEvent, type CatalogScope, type CountryRegion, type RankedRules } from "./catalog.ts";
import { backtestProjections, projectEditions, projectionCategory, projectionChances, seriesKey } from "./series.ts";
import { unannouncedEvents } from "./unannounced.ts";
import { qualifierLinks, type LinkEnd } from "./qualifierLinks.ts";
import { AffinityIndex, nickCountries } from "./affinity.ts";
import { acceptanceShift, CHOICE_USE, choiceRow, EloTimeline, fitAcceptance, fitChoice, HABIT_ONLY, valueSamples } from "./value.ts";
import { EVENTS_DIR, loadEventConfigs, type EventConfig } from "./config.ts";
import { readJson, readSquadRows, squadSets, squadsByTeamId, teamIdResolver } from "./inputs.ts";
import { loadInviteConfigs, makeIntactCheck, makeRegionEligibleCheck, REGIONS, type InviteConfig } from "./invites.ts";
import { knownMatches } from "./locks.ts";
import { qualifyPaths, teamUniverse, type OptimizeRunContext, type OptimizerSetup, type OptimizerTeam } from "./optimizer.ts";
import { resolveParticipants, templatePages } from "./participants.ts";
import { DRIFT_PER_DAY, Predictor } from "./predict.ts";
import { volumeBaselines, type Caps, type VolumeBaselines } from "./schedule.ts";
import type { TeamId } from "./types.ts";
import { entryStages, publicationDates, type SeasonEvent, type SeasonFields, type SeasonInput } from "./season.ts";
import { canonicalEventId, canonicalTeamId, latestLineups, preferSquads, simulationDelta, type ProjectedRoster } from "./vrsProjection.ts";

const VALVE_ROOT = path.resolve("vendor/counter-strike_regional_standings");
/** Rosters mapped to team pages and checked for a page; deep enough to fill every slot on the calendar. */
const LIST_DEPTH = 80;
/** Rosters the optimizer plans schedules for, by today's global rank. */
const OPTIMIZER_TOP = 60;
const MIN_SHARED_PLAYERS = 3;
/** An event drawing less than this share of its field from other regions isn't an option for a team from one. */
const MIN_CROSS_REGION = 0.1;
/** An unranked team is drawable into open slots when it played this many matches in the last `ACTIVE_DAYS`. */
const MIN_ACTIVE_MATCHES = 5;
const ACTIVE_DAYS = 120;
const SOUTH_AMERICA = new Set(["ar", "bo", "br", "cl", "co", "ec", "gy", "pe", "py", "sr", "uy", "ve"]);

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Matches in [from, cutoff] (unix seconds), and the events they belong to. */
const truncateMatchdata = (m: Matchdata, cutoff: number, from = -Infinity): Matchdata => {
    const matches = m.matches.filter((x) => x.matchStartTime <= cutoff && x.matchStartTime >= from);
    const ids = new Set(matches.map((x) => String(x.eventId)));
    return { ...m, matches, events: m.events.filter((e) => ids.has(String(e.eventId))) };
};
/** A hindcast's model input covers this many days before as-of, about what the hot store holds in production. */
const HINDCAST_BASE_DAYS = 200;

/** Live series' next editions, each played in the share of runs that past projections of its category came true. */
const projectedEditions = (tournamentRows: RawRow[], countryRegion: CountryRegion, asOf: string, rules: RankedRules) => {
    const chance = projectionChances(backtestProjections(tournamentRows, countryRegion, { asOf, rules }));
    return projectEditions(tournamentRows, countryRegion, { asOf, rules }).map((p) => ({ ...p, chance: chance(projectionCategory(p.row)) }));
};
/** Teams with an unforfeited match at each event, by page. */
const playedTeams = (matchdata: Matchdata, rows: RawRow[], eventIdOf: (page: string) => string): Map<string, number> => {
    const byEvent = new Map<string, Set<string>>();
    for (const m of matchdata.matches) {
        if (m.forfeited) continue;
        const teams = byEvent.get(String(m.eventId)) ?? new Set<string>();
        teams.add(String(m.team1Id)).add(String(m.team2Id));
        byEvent.set(String(m.eventId), teams);
    }
    const out = new Map<string, number>();
    for (const r of rows) {
        const teams = byEvent.get(eventIdOf(str(r.pagename)));
        if (teams) out.set(str(r.pagename), teams.size);
    }
    return out;
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

export interface CalendarEntry {
    catalog: CatalogEvent;
    /** Set when the season simulation plays it. */
    season?: SeasonEvent;
    reason?: string;
}

export interface SeasonSetup {
    input: SeasonInput;
    asOf: string;
    target: InviteConfig;
    calendar: CalendarEntry[];
    today: Standings;
    volume: VolumeBaselines;
    /** Ranked events since `HISTORY_FROM` the field and activity models learned from; empty when not `learned`. */
    editions: PastEdition[];
    /** Events with a config, and so an event page that shows their impact. */
    impactEvents: Set<string>;
    /** Teams off the list that open slots can draw, and teams kept out of draws. */
    unranked: ListEntry[];
    blocked: Set<string>;
    unmatchedRosters: string[];
    optimizer: OptimizeRunContext;
    /** Per optimizer team, whether it could plausibly be invited to an event's open slots. */
    canEnterFor: Map<TeamId, (e: SeasonEvent) => boolean>;
}

export interface SeasonSetupOptions {
    n: number;
    seed: number;
    scope?: CatalogScope;
    /** Fill open slots and pace teams from past editions. */
    learned?: boolean;
    /** Add live series' unlisted editions; needs `learned` and scope "all". */
    projections?: boolean;
    /** Add stand-ins for events Liquipedia will list later (`unannouncedEvents`); needs `projections`. */
    unannounced?: boolean;
    /** Hindcast: ratings, matches, lists and participants as of this day, and only the events Liquipedia would have listed then (`HINDCAST_LISTED_DAYS`). */
    asOf?: string;
    /** Last checkpoint, when before the target snapshot; later events and stand-ins are left out. For hindcasts only: the optimizer still targets the snapshot. */
    until?: string;
    /** Hindcast diagnostics (`docs/vrs-simulator.md`, "Oracle ladder"), each replacing part of the model with what happened. */
    oracle?: Oracle;
    /** Weigh VRS acceptance by strength against each event's field, and draws by whether a lineup has Elo history, next to habit (`docs/vrs-simulator.md`, "Value in attendance"); default on. */
    value?: boolean;
    /** Plan for these teams only (team page or roster name, any case, `_` for spaces) instead of the top 60; the season runs don't depend on them. */
    focal?: string | string[];
}

/** "calendar" lists every real ranked event to the last checkpoint (no projections or stand-ins); "attendance" also announces their real participants; "results" replays the real matches with winners redrawn from the run's ratings instead of simulating events; "matches" replays them as played, which should reproduce Valve's lists. */
export type Oracle = "calendar" | "attendance" | "results" | "matches";

/** In a hindcast, events starting this many days after as-of count as listed; tier 1–2 LANs always do, as they're announced months ahead. */
const HINDCAST_LISTED_DAYS = 30;
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Everything a season run needs, from local files only. */
export const loadSeasonSetup = ({
    n,
    seed,
    scope = "all",
    learned = true,
    projections = true,
    unannounced = true,
    asOf: hindcastAsOf,
    until,
    oracle,
    value = true,
    focal,
}: SeasonSetupOptions): SeasonSetup => {
    const hindcast = hindcastAsOf !== undefined;
    if (oracle && !hindcast) throw new Error("An oracle needs a hindcast as-of date");
    const replays = oracle === "results" || oracle === "matches";
    const cutoff = hindcast ? Date.parse(`${hindcastAsOf}T23:59:59Z`) / 1000 : Infinity;
    const feed = loadFeed();
    const feedMatches = feed.matches.filter((m) => m.t <= cutoff);
    const engine = liveEngine(DEFAULT_PARAMS, feed.players);
    const predictions = engine.run(feedMatches);
    const lastT = feedMatches.at(-1)!.t;
    const asOf = dayOf(lastT);

    const inviteConfigs = loadInviteConfigs(EVENTS_DIR);
    const target = inviteConfigs.find((c) => c.snapshotDate > asOf);
    if (!target) throw new Error(`No invite snapshot after ${asOf} in ${EVENTS_DIR}`);
    const end = until !== undefined && until > asOf && until < target.snapshotDate ? until : target.snapshotDate;

    const history = readHistoryRows();
    const upcoming = hindcast ? null : readUpcoming();
    const rowByPage = new Map(history.tournamentRows.map((r) => [str(r.pagename), r]));
    const startedBy = (r: RawRow) => str(rowByPage.get(str(r.parent) || str(r.pagename))?.startdate) <= asOf;
    const listedThen = (r: RawRow) =>
        oracle
            ? str(r.startdate) <= end
            : str(r.startdate) <= addDays(asOf, HINDCAST_LISTED_DAYS) || (kindOf(r) === "lan" && Number(r.liquipediatier) > 0 && Number(r.liquipediatier) <= 2);
    const finishedPlacements = hindcast
        ? history.placementRows.filter((r) => str(rowByPage.get(str(r.parent))?.enddate) <= asOf)
        : readJson<RawRow[]>("data/raw/placements.json", []);
    const matchRows = hindcast
        ? readJson<RawRow[]>("data/raw/matches.json", []).filter((r) => str(r.date).slice(0, 10) <= asOf)
        : [...readJson<RawRow[]>("data/raw/matches.json", []), ...(upcoming?.matches ?? [])];
    // For later events a hindcast keeps how slots fill (the labels, announced early) but not who filled them or the results.
    const placementRows = hindcast
        ? history.placementRows.flatMap((r) =>
              startedBy(r)
                  ? [r]
                  : r.pagename === r.parent && r.opponenttype === "team"
                    ? [oracle === "attendance" ? { ...r, placement: "", prizemoney: 0 } : { ...r, opponentname: "TBD", opponenttemplate: "", placement: "", prizemoney: 0 }]
                    : []
          )
        : [...finishedPlacements, ...(upcoming?.placements ?? [])];
    const tournamentRows = hindcast
        ? [...rowByPage.values()].filter(listedThen)
        : [...readJson<RawRow[]>("data/raw/tournaments.json", []), ...(upcoming?.tournaments ?? [])];
    const overrides = readJson<Overrides>("data/overrides.json", {});
    const pages = templatePages(matchRows);

    const snapshot = (date: string) => {
        try {
            return readPublishedSnapshot(VALVE_ROOT, date).rosters;
        } catch {
            return null;
        }
    };
    const previousNames = new Map<string, string[]>();
    // Hand-written configs carry fields keyed after the fact, so a hindcast plays every event generically.
    const configs = (hindcast ? [] : loadEventConfigs()).map((c) => {
        const resolved = resolveParticipants(c, { matchRows, placementRows, invites: inviteConfigs, snapshot });
        for (const [team, names] of resolved.previousNames) previousNames.set(team, [...new Set([...(previousNames.get(team) ?? []), ...names])]);
        return resolved.config;
    });

    const valveRegion = loadValveCjs(path.join(VALVE_ROOT, "model/util/region.js")) as { getCountryRegion: CountryRegion };
    const seriesRows = hindcast ? tournamentRows : history.tournamentRows;
    const projected =
        !oracle && projections && learned && scope === "all" ? projectedEditions(seriesRows, valveRegion.getCountryRegion, asOf, rankedRules(overrides)) : [];
    const allMatchdata = readJson<Matchdata | null>("data/matchdata.json", null);
    if (!allMatchdata) throw new Error("data/matchdata.json is missing; run npm run build-matchdata first");
    const fullHistory = readMatchHistory(allMatchdata);
    const matchHistory = hindcast ? truncateMatchdata(fullHistory, cutoff) : fullHistory;
    const base = hindcast ? truncateMatchdata(matchHistory, cutoff, cutoff - HINDCAST_BASE_DAYS * 86400) : allMatchdata;
    const endT = Date.parse(`${end}T00:00:00Z`) / 1000;
    const replayed = replays ? fullHistory.matches.filter((m) => m.matchStartTime > cutoff && m.matchStartTime < endT).sort((a, b) => a.matchStartTime - b.matchStartTime) : [];
    const replayedEvents = new Set(replayed.map((m) => String(m.eventId)));
    const standIns =
        !oracle && projections && unannounced && learned && scope === "all"
            ? unannouncedEvents(seriesRows, valveRegion.getCountryRegion, {
                  asOf,
                  until: end,
                  rules: rankedRules(overrides),
                  projected,
                  played: playedTeams(base, seriesRows, (page) => canonicalEventId(overrides, page)),
              })
            : [];
    const catalog = buildCatalog({
        configs,
        tournamentRows,
        today: asOf,
        until: addDays(asOf, UPCOMING_DAYS),
        ctx: {
            placementRows,
            pages,
            countryRegion: valveRegion.getCountryRegion,
            prizeSplits: fitPrizeSplits(finishedPlacements),
            rankedRules: rankedRules(overrides),
            learnsFields: learned,
        },
        scope,
        projected,
        unannounced: standIns,
    });

    const publishedDates = publishedSnapshotDates(VALVE_ROOT, ["invitation"]).filter((d) => d <= asOf);
    const live = hindcast ? null : readJson<Standings | null>("public/data/vrs/live.json", null);
    const today = live ?? readPublishedSnapshot(VALVE_ROOT, publishedDates.at(-1)!);
    const lineups = latestLineups(base);
    const resolveTeamId = teamIdResolver(canonicalTeamId(overrides), lineups, previousNames);
    const nickOf = (link: string) => feed.players[link]?.nick ?? feed.players[link.replace(/_/g, " ")]?.nick;
    // A swapped lineup is a new Valve roster, and relinking it costs a full reload, so only rosters near the top get their current squad.
    const topNicks = new Set(today.rosters.filter((r) => r.globalRank !== null && r.globalRank <= LIST_DEPTH).flatMap((r) => r.players.map((p) => p.toLowerCase())));
    const squads = squadsByTeamId(readSquadRows(), resolveTeamId);
    for (const teamId of squads.keys()) {
        const shared = lineups.get(teamId)?.players.filter((p) => topNicks.has(p.nick.toLowerCase())).length ?? 0;
        if (shared < MIN_SHARED_PLAYERS) squads.delete(teamId);
    }
    const checkpoints = publicationDates(asOf, end, publishedDates).map((date) => ({
        date,
        world: loadWorld(base.matches, base.events, date, { windowEndsAtPull: true }),
    }));
    // A current squad that relinks Valve rosters makes that checkpoint's rerun inexact in every run.
    const relinking: string[] = [];
    if (!hindcast)
        preferSquads(base, lineups, squads, nickOf, (players, teamId) => {
            const keeps = checkpoints.every((c) => lineupKeepsLinks(c.world, players));
            if (!keeps) relinking.push(lineups.get(teamId)?.name ?? teamId);
            return keeps;
        });
    if (relinking.length) console.warn(`Kept the last-played lineup for ${relinking.join(", ")}: the current squad relinks Valve rosters.`);

    // --- Rosters as team pages

    const aliasPages = new Map<string, string[]>();
    for (const [page, { targetTeamId }] of Object.entries(overrides.teamAliases ?? {})) {
        if (!/^\d+$/.test(page)) aliasPages.set(targetTeamId, [...(aliasPages.get(targetTeamId) ?? []), page]);
    }
    const renamed = new Map<string, string>();
    for (const [page, names] of previousNames) for (const prev of names) renamed.set(resolveTeamId(prev), page);
    const lastPlayed = new Map<string, number>();
    for (const m of feed.matches) for (const team of m.teams) lastPlayed.set(team, m.t);
    const pageCache = new Map<string, string>();
    /** Liquipedia page for a matchdata team id, which `teamAliases` may have renamed ("Team Vitality" → "Vitality"). */
    const pageOf =(teamId: string): string => {
        let page = pageCache.get(teamId);
        if (page === undefined) {
            const candidates = [...(aliasPages.get(teamId) ?? []), teamId];
            const newest = candidates.reduce((a, b) => ((lastPlayed.get(b) ?? -1) > (lastPlayed.get(a) ?? -1) ? b : a));
            page = renamed.get(teamId) ?? newest;
            pageCache.set(teamId, page);
        }
        return page;
    };
    /** One name per team across Liquipedia pages, renames and matchdata ids, so a field never holds a team twice. */
    const canonical = (page: string) => pageOf(resolveTeamId(page));
    const teamsByNick = new Map<string, string[]>();
    for (const [team, { players }] of lineups) {
        for (const p of players) {
            const nick = p.nick.toLowerCase();
            teamsByNick.set(nick, [...(teamsByNick.get(nick) ?? []), team]);
        }
    }
    const rosterTeams = new Map<string, string | null>();
    const teamOfRoster = (r: Roster): string | null => {
        if (rosterTeams.has(r.rosterKey)) return rosterTeams.get(r.rosterKey)!;
        const shared = new Map<string, number>();
        for (const nick of r.players) for (const team of teamsByNick.get(nick.toLowerCase()) ?? []) shared.set(team, (shared.get(team) ?? 0) + 1);
        const best = [...shared]
            .filter(([, k]) => k >= MIN_SHARED_PLAYERS)
            .sort((a, b) => b[1] - a[1] || Number(lineups.get(b[0])!.name === r.teamName) - Number(lineups.get(a[0])!.name === r.teamName))[0];
        const team = best ? pageOf(best[0]) : null;
        rosterTeams.set(r.rosterKey, team);
        return team;
    };
    const subregionOf = (team: string): Subregion | null => {
        const players: ValvePlayer[] = lineups.get(resolveTeamId(team))?.players ?? [];
        if (players.length === 0) return null;
        const south = players.filter((p) => SOUTH_AMERICA.has(String(p.countryIso ?? "").toLowerCase())).length;
        return south * 2 > players.length ? "South America" : "North America";
    };
    const listEntries = (rosters: Roster[]): ListEntry[] => {
        const seen = new Set<string>();
        const out: ListEntry[] = [];
        const ranked = rosters.filter((r) => r.globalRank !== null).sort((a, b) => a.globalRank! - b.globalRank!);
        for (const r of ranked) {
            const team = teamOfRoster(r);
            if (!team || seen.has(team)) continue;
            seen.add(team);
            out.push({ team, globalRank: r.globalRank, regionalRank: r.regionalRank, region: r.region, subregion: r.region === "Americas" ? subregionOf(team) : null });
        }
        return out;
    };

    // --- Past editions: who played what, ranked where

    const allLists = publishedDates.map((date) => ({ date, rosters: readPublishedSnapshot(VALVE_ROOT, date).rosters }));
    const editions = learned
        ? pastEditions({
              ...history,
              attendance: readAttendance(matchHistory),
              finishedBy: asOf,
              lists: allLists,
              rules: rankedRules(overrides),
              countryRegion: valveRegion.getCountryRegion,
              teamIdOf: resolveTeamId,
              eventIdOf: (page) => canonicalEventId(overrides, page),
              from: HISTORY_FROM,
              to: asOf,
          })
        : [];
    const fieldModel = learned ? fitFieldModel(editions, allLists, { asOf }) : null;

    const todayByNick = new Map<string, Roster[]>();
    for (const r of today.rosters) for (const nick of r.players) todayByNick.set(nick.toLowerCase(), [...(todayByNick.get(nick.toLowerCase()) ?? []), r]);
    const todayKeys = new Set(today.rosters.map((r) => r.rosterKey));
    const rosterIds = new Map<string, string>();
    const rosterId = (r: Roster): string => {
        if (todayKeys.has(r.rosterKey)) return r.rosterKey;
        let id = rosterIds.get(r.rosterKey);
        if (id === undefined) {
            const shared = new Map<Roster, number>();
            for (const nick of r.players) for (const t of todayByNick.get(nick.toLowerCase()) ?? []) shared.set(t, (shared.get(t) ?? 0) + 1);
            const best = [...shared].filter(([, k]) => k >= MIN_SHARED_PLAYERS).sort((a, b) => b[1] - a[1] || b[0].points - a[0].points)[0];
            id = best?.[0].rosterKey ?? r.rosterKey;
            rosterIds.set(r.rosterKey, id);
        }
        return id;
    };

    // --- Calendar

    const models = new Map<string, EventFieldModel>();

    const tournamentByPage = new Map(tournamentRows.map((r) => [String(r.pagename), r]));
    const missingLineups = (teams: string[]) => teams.filter((t) => !lineups.has(resolveTeamId(t)));
    const calendar: CalendarEntry[] = catalog.map((entry): CalendarEntry => {
        const config: EventConfig = {
            ...entry.config,
            stages: entry.config.stages.map((s) => (s.invited ? { ...s, invited: s.invited.map(canonical) } : s)),
        };
        if (!entry.simulated) return { catalog: entry, reason: entry.reason };
        if (config.startDate >= end) return { catalog: entry, reason: "starts after the target snapshot" };
        // Its played matches are already in matchdata, and a generic bracket can't pick up the real one's pairings.
        if (entry.generic && config.startDate <= asOf) return { catalog: entry, reason: "under way in a format the simulator doesn't know" };
        const waiting = config.stages.filter((s) => s.vrsStage && s.invited?.length === 0);
        if (waiting.length) return { catalog: entry, reason: "Major stages wait on Valve's invite snapshot" };
        const entries = config.stages.filter((s) => s.invited !== undefined);
        const filled = entries.filter((s) => s.invited!.length > 0);
        const fixed = entries.length > 0 && filled.length === entries.length;
        if (!fixed && filled.length > 0) return { catalog: entry, reason: "some entry stages are drawn and others aren't" };
        const stages = fixed ? [] : entryStages(config, entry.teams);
        if (typeof stages === "string") return { catalog: entry, reason: stages };
        let announced = [...new Set(entry.announced.map(canonical))];
        let announcedVia = Object.fromEntries(Object.entries(entry.announcedVia).map(([team, via]) => [canonical(team), via]));
        const missing = missingLineups(fixed ? entries.flatMap((s) => s.invited!) : announced);
        // The attendance oracle announces every real participant, many with no recent lineup; their places are drawn instead.
        if (missing.length && oracle === "attendance" && !fixed) {
            announced = announced.filter((t) => !missing.includes(t));
            announcedVia = Object.fromEntries(Object.entries(announcedVia).filter(([t]) => !missing.includes(t)));
        } else if (missing.length) return { catalog: entry, reason: `no match history for ${missing.join(", ")}` };
        const category = categoryOf(entry.kind, entry.role, entry.tier);
        const model = fieldModel?.forEvent(
            {
                page: config.liquipedia,
                name: config.name,
                category,
                region: config.location?.region ?? null,
                prizePool: entry.prizePool,
                publisherTier: entry.publisherTier,
                startDate: config.startDate,
            },
            entry.teams
        );
        const unfilled = !fixed && entry.teams > announced.length;
        if (model && unfilled) models.set(config.slug, model);
        const rule = config.invites ?? (unfilled ? model?.learnedRule : undefined) ?? undefined;
        const openMonths = (rule?.slots ?? [])
            .filter((s) => s.count > Object.values(announcedVia).filter((k) => k === slotKey(s)).length)
            .map((s) => s.month)
            .sort();
        const row = tournamentByPage.get(config.liquipedia);
        const season: SeasonEvent = {
            config,
            projection: {
                config,
                eventId: canonicalEventId(overrides, config.liquipedia),
                prizePool: `$${Math.round(entry.prizePool || [...entry.prizes.values()].reduce((a, b) => a + b, 0)).toLocaleString("en-US")}`,
                prizes: entry.prizes,
                major: isMajorTier(row?.publishertier),
                ranked: entry.ranked,
                publisherTier: entry.publisherTier,
                ...(entry.qualifies ? { qualifies: canonicalEventId(overrides, entry.qualifies.page) } : {}),
            },
            known: new Map(
                config.stages.map((s) => [
                    s.id,
                    knownMatches(matchRows, s.page, s.sections).map((k) => ({ ...k, teams: k.teams.map(canonical) as [string, string] })),
                ])
            ),
            horizon: Math.max(0, daysBetween(asOf, config.startDate)),
            stint: { startDate: config.startDate, endDate: config.endDate, region: config.location?.region ?? null, kind: entry.kind },
            field: {
                slug: config.slug,
                region: config.location?.region ?? model?.region ?? null,
                tier: entry.tier,
                publisherTier: entry.publisherTier,
                teams: entry.teams,
                announced,
                announcedVia,
                invites: config.invites,
            },
            listMonth: openMonths.at(-1) ?? null,
            fixed,
            entryStages: stages,
            category,
            ...(entry.projection ? { chance: entry.projection.chance } : {}),
            ...(entry.unannounced ? { chance: entry.unannounced.chance, unannounced: true } : {}),
        };
        return { catalog: entry, season };
    });
    const events = replays ? [] : calendar.flatMap((c) => (c.season ? [c.season] : []));

    // --- Qualifier links: feeders' finishers fill the slots they qualify for

    const linkable = calendar.filter((c): c is CalendarEntry & { season: SeasonEvent } => !!c.season && !c.catalog.unannounced && !c.season.fixed);
    const linkEnds = linkable.map((c): LinkEnd => {
        const rule = c.season.field.invites ?? models.get(c.season.config.slug)?.learnedRule ?? undefined;
        const via = Object.values(c.season.field.announcedVia);
        return {
            page: c.catalog.config.liquipedia,
            region: c.season.field.region,
            startDate: c.season.config.startDate,
            endDate: c.season.config.endDate,
            ...(c.catalog.qualifies ? { qualifies: c.catalog.qualifies } : {}),
            labels: (rule?.qualifiers ?? [])
                .filter((q) => q.label !== "Unspecified")
                .map((q) => ({ label: q.label, count: q.count - via.filter((k) => k === slotKey(q)).length }))
                .filter((q) => q.count > 0),
        };
    });
    const seasonByPage = new Map(linkable.map((c) => [c.catalog.config.liquipedia, c.season]));
    const links = qualifierLinks(linkEnds, placementRows).flatMap((l) => {
        const to = seasonByPage.get(l.to)!;
        const open = to.field.teams - to.field.announced.length;
        const label = to.field.invites?.qualifiers.find((q) => slotKey(q) === l.slotKey);
        const count = Math.min(l.count, open, label ? label.count - Object.values(to.field.announcedVia).filter((k) => k === l.slotKey).length : l.count);
        return count > 0 ? [{ ...l, count }] : [];
    });
    for (const l of links) {
        const from = seasonByPage.get(l.from)!;
        from.feeds = { slug: seasonByPage.get(l.to)!.config.slug, slotKey: l.slotKey, count: l.count };
    }

    // --- Lists published by as-of

    const wantedMonths = new Set([
        ...events.flatMap((e) => (e.field.invites ?? models.get(e.config.slug)?.learnedRule)?.slots.map((s) => s.month) ?? []),
        publishedDates.at(-1)?.slice(0, 7) ?? "",
    ]);
    const published = new Map<string, ListEntry[]>();
    for (const { date, rosters } of allLists) {
        if (wantedMonths.has(date.slice(0, 7))) published.set(date.slice(0, 7), listEntries(rosters));
    }

    // --- Model

    const replayHorizon = (t: number) => Math.max(0, Math.floor((t - lastT) / 86400));
    const predictor = new Predictor(engine, DEFAULT_PARAMS, lastT, {
        driftPerDay: DRIFT_PER_DAY,
        horizons: [...events.map((e) => e.horizon), ...replayed.map((m) => replayHorizon(m.matchStartTime))],
        fallbackRating: engine.tierMean(2, lastT),
        previousNames,
    });

    const top = listEntries(today.rosters.slice()).slice(0, 40);
    const volume = volumeBaselines(base, top.map((e) => resolveTeamId(e.team)), asOf, daysBetween(asOf, end));
    const unmatchedRosters = today.rosters
        .filter((r) => r.globalRank !== null && r.globalRank <= LIST_DEPTH && !teamOfRoster(r))
        .map((r) => r.teamName);

    const teams = [...new Set([...lineups.keys()].map(pageOf).concat(events.flatMap((e) => e.field.announced)))];

    // --- Habits, and teams off the list that open slots can draw

    const horizonDays = daysBetween(asOf, end);
    const todayList = listEntries(today.rosters);
    const onTodayList = new Set(todayList.map((e) => e.team));
    const activeSince = Date.parse(`${asOf}T00:00:00Z`) / 1000 - ACTIVE_DAYS * 86400;
    const recentMatches = new Map<string, number>();
    for (const m of base.matches) {
        if (m.matchStartTime >= activeSince) for (const id of [String(m.team1Id), String(m.team2Id)]) recentMatches.set(id, (recentMatches.get(id) ?? 0) + 1);
    }
    const unranked: ListEntry[] = [];
    const unrankedIds: string[] = [];
    for (const [teamId, played] of recentMatches) {
        const team = pageOf(teamId);
        const lineup = lineups.get(teamId);
        if (played < MIN_ACTIVE_MATCHES || !lineup || onTodayList.has(team) || unranked.some((e) => e.team === team)) continue;
        const region = lineupRegion(lineup.players, valveRegion.getCountryRegion);
        if (!region) continue;
        unranked.push({ team, globalRank: null, regionalRank: null, region, subregion: region === "Americas" ? subregionOf(team) : null });
        unrankedIds.push(teamId);
    }
    const activity = fitActivity(
        editions,
        [
            ...todayList.map((e) => ({ teamId: resolveTeamId(e.team), globalRank: e.globalRank, region: e.region })),
            ...unranked.map((e, i) => ({ teamId: unrankedIds[i], globalRank: null, region: e.region })),
        ],
        { asOf }
    );
    const kept = new Set([
        ...todayList.filter((e) => e.globalRank !== null && e.globalRank <= LIST_DEPTH).map((e) => e.team),
        ...events.flatMap((e) => (e.fixed ? e.config.stages.flatMap((s) => s.invited ?? []) : e.field.announced)),
    ]);
    // Draws only pick teams checked here: a lineup that relinks Valve rosters, alone or next to another drawn team sharing 3 players, forces full reruns.
    const drawable = new Set<string>();
    const blocked = new Set<string>();
    if (learned) {
        const lastPlayed = new Map<string, number>();
        for (const m of base.matches) for (const id of [String(m.team1Id), String(m.team2Id)]) lastPlayed.set(id, Math.max(lastPlayed.get(id) ?? 0, m.matchStartTime));
        const candidates = [...new Set([...kept, ...todayList.map((e) => e.team), ...unranked.map((e) => e.team)])];
        const playersOf = (team: string) => lineups.get(resolveTeamId(team))?.players.map((p) => String(p.playerId)) ?? [];
        const teamsByPlayer = new Map<string, string[]>();
        for (const team of candidates) for (const p of playersOf(team)) teamsByPlayer.set(p, [...(teamsByPlayer.get(p) ?? []), team]);
        for (const team of candidates) {
            const lineup = lineups.get(resolveTeamId(team));
            if (kept.has(team)) {
                drawable.add(team);
                continue;
            }
            const shared = new Map<string, number>();
            for (const p of playersOf(team)) for (const other of teamsByPlayer.get(p) ?? []) if (other !== team) shared.set(other, (shared.get(other) ?? 0) + 1);
            const newer = [...shared].some(([other, k]) => k >= MIN_SHARED_PLAYERS && (kept.has(other) || (lastPlayed.get(resolveTeamId(other)) ?? 0) >= (lastPlayed.get(resolveTeamId(team)) ?? 0)));
            if (!lineup || newer || checkpoints.some((c) => !lineupKeepsLinks(c.world, lineup.players))) blocked.add(team);
            else drawable.add(team);
        }
    }
    const affinity = new Map<string, (team: string) => number>();
    const acceptance = new Map<string, (team: string, band: number) => number>();
    if (learned) {
        const index = new AffinityIndex(editions);
        const timeline = new EloTimeline(predictions, (link) => nickOf(link) ?? link);
        const samples = valueSamples(editions, allLists, index, nickCountries(editions), timeline, { from: addDays(asOf, -365), to: addDays(asOf, 1) });
        const beta = fitChoice(samples.choices, value ? CHOICE_USE : HABIT_ONLY);
        const offers = value ? fitAcceptance(samples.offers) : null;
        timeline.advanceTo(addDays(asOf, 1));
        const ratings = new Map<string, number | null>();
        const ratingOf = (team: string) => {
            if (!ratings.has(team)) ratings.set(team, timeline.ratingOf((lineups.get(resolveTeamId(team))?.players ?? []).map((p) => p.nick)));
            return ratings.get(team)!;
        };
        // Open places are expected to fill like the event's past editions, at each band's mean rating on today's list.
        const bandRatings = Array.from({ length: BANDS }, () => [] as number[]);
        for (const entry of todayList) {
            const r = ratingOf(entry.team);
            if (r !== null) bandRatings[bandOf(entry.globalRank)].push(r);
        }
        const bandMean = bandRatings.map((rs) => (rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null));
        const fieldRating = (e: SeasonEvent, model: EventFieldModel): number | null => {
            const known = e.field.announced.map(ratingOf).filter((r): r is number => r !== null);
            let weight = 0;
            let sum = 0;
            model.open.forEach((share, b) => {
                if (share > 0 && bandMean[b] !== null) {
                    weight += share;
                    sum += share * bandMean[b]!;
                }
            });
            const open = weight > 0 ? Math.max(0, e.field.teams - e.field.announced.length) : 0;
            const total = known.length + open;
            return total >= 2 ? (known.reduce((a, b) => a + b, 0) + open * (sum / Math.max(weight, 1e-9))) / total : null;
        };
        for (const c of calendar) {
            const e = c.season;
            if (!e || e.unannounced || !models.has(e.config.slug)) continue;
            const event = {
                series: seriesKey(e.config.liquipedia),
                organizer: c.catalog.organizer ?? "",
                country: c.catalog.kind === "lan" ? (e.config.location?.country ?? "") : "",
                startDate: e.config.startDate,
            };
            const field = value ? fieldRating(e, models.get(e.config.slug)!) : null;
            const rows = new Map<string, number[]>();
            const rowOf = (team: string) => {
                let row = rows.get(team);
                if (!row) {
                    const players = (lineups.get(resolveTeamId(team))?.players ?? []).map((p) => ({ nick: p.nick, country: str(p.countryIso) }));
                    rows.set(team, (row = value ? choiceRow(index.pattern(players, event), ratingOf(team), field) : choiceRow(index.pattern(players, event), 0, null)));
                }
                return row;
            };
            const weights = new Map<string, number>();
            affinity.set(e.config.slug, (team) => {
                let w = weights.get(team);
                if (w === undefined) weights.set(team, (w = Math.exp(rowOf(team).reduce((s, x, i) => s + x * beta[i], 0))));
                return w;
            });
            if (offers) acceptance.set(e.config.slug, (team, band) => acceptanceShift(offers, band, rowOf(team)));
        }
    }
    const capCache = new Map<string, Caps>();
    const fields: SeasonFields | undefined = learned
        ? {
              models,
              unranked,
              drawable,
              activity,
              caps: (team) => {
                  let c = capCache.get(team);
                  if (!c) capCache.set(team, (c = capsFor(activity, resolveTeamId(team), horizonDays, volume.high)));
                  return c;
              },
              horizonEnd: end,
              horizonDays,
              affinity,
              ...(acceptance.size ? { acceptance } : {}),
          }
        : undefined;

    // --- Optimizer

    const intact = makeIntactCheck(squadSets(readSquadRows(), nickOf), target.minRetained);
    const regionEligible = makeRegionEligibleCheck(readPriorRegionalRosters(VALVE_ROOT, target.snapshotDate), target.regionExceptions ?? [], target.minRetained);
    const canEnterFor = new Map<TeamId, (e: SeasonEvent) => boolean>();
    const optimizerTeamFor = (r: Roster): { team: OptimizerTeam; canEnter: (e: SeasonEvent) => boolean } | null => {
        const team = teamOfRoster(r);
        const lineup = team ? lineups.get(resolveTeamId(team)) : undefined;
        if (!team || !lineup || r.globalRank === null) return null;
        // Without a known rule an open slot is an assumed invitation: only where it would plausibly be given, and the rules allow it.
        const canEnter = (e: SeasonEvent) => {
            const model = models.get(e.config.slug);
            if (e.field.invites || !model) return true;
            if (isLowerTier(e.field) && r.globalRank! <= LOWER_TIER_TOP_RANK) return false;
            if (model.region && model.sameRegion !== null && model.region !== r.region && 1 - model.sameRegion < MIN_CROSS_REGION) return false;
            return welcomes(model.open, bandOf(r.globalRank));
        };
        const optimizerTeam: OptimizerTeam = {
            team,
            teamId: resolveTeamId(team),
            rosterKey: r.rosterKey,
            teamName: r.teamName,
            region: r.region,
            playerIds: lineup.players.map((p) => String(p.playerId)),
            nicks: lineup.players.map((p) => p.nick),
            ...teamUniverse(events, team, asOf, volume, canEnter),
            paths: qualifyPaths(events, team, r.region, asOf),
        };
        return { team: optimizerTeam, canEnter };
    };
    const ranked = today.rosters.filter((x) => x.globalRank !== null).sort((a, b) => a.globalRank! - b.globalRank!);
    const normalized = (s: string) => s.replace(/_/g, " ").trim().toLowerCase();
    const matchesTeam = (r: Roster, name: string) => [teamOfRoster(r), r.teamName].some((s) => s !== null && normalized(s) === normalized(name));
    const focalNames = focal === undefined ? undefined : [focal].flat();
    const focalRosters = focalNames?.map((name) => {
        const r = ranked.find((x) => matchesTeam(x, name));
        if (!r) throw new Error(`No ranked roster matches "${name}"`);
        return r;
    });
    const optimizerTeams: OptimizerTeam[] = [];
    const seenTeams = new Set<string>();
    for (const r of focalRosters ?? ranked.filter((x) => x.globalRank! <= OPTIMIZER_TOP)) {
        const built = optimizerTeamFor(r);
        if (!built) {
            if (focalRosters) throw new Error(`"${r.teamName}" has no team page or lineup`);
            continue;
        }
        if (seenTeams.has(built.team.team)) continue;
        seenTeams.add(built.team.team);
        optimizerTeams.push(built.team);
        canEnterFor.set(built.team.team, built.canEnter);
    }
    const optimizer: OptimizerSetup = {
        teams: optimizerTeams,
        caps: { low: volume.low, average: volume.average, high: volume.high },
        previousMajor: target.previousMajor,
        stage1: target.stage1,
        eligible: (r) => intact(r as ProjectedRoster) !== false && regionEligible(r),
    };
    const regionOf = (standings: Standings) => {
        const byTeam = new Map(listEntries(standings.rosters).map((e) => [e.team, e.region]));
        return (team: string): Region => byTeam.get(canonical(team)) ?? REGIONS[predictor.lineageOf(team)?.region ?? 0];
    };
    const previousSlug = "slots" in target.previousMajor ? null : target.previousMajor.event;

    const input: SeasonInput = {
        events,
        checkpoints,
        base,
        predictor,
        teams,
        toDelta: (event, outcome) => simulationDelta([event], [outcome], lineups, resolveTeamId),
        teamIdOf: resolveTeamId,
        listEntries,
        rosterId,
        published,
        volumeCap: volume.average,
        ...(fields ? { fields } : {}),
        ...(replays
            ? {
                  replay: {
                      matches: replayed,
                      events: fullHistory.events.filter((e) => replayedEvents.has(String(e.eventId))),
                      teamOf: pageOf,
                      horizonOf: replayHorizon,
                      redraw: oracle === "results",
                  },
              }
            : {}),
        n,
        seed,
    };
    return {
        input,
        asOf,
        target,
        calendar,
        today,
        volume,
        editions,
        impactEvents: new Set(calendar.filter((c) => c.season && !c.catalog.generic).map((c) => c.catalog.config.slug)),
        unranked,
        blocked,
        unmatchedRosters,
        optimizer: { input, opt: optimizer, asOf, previousSlug, regionOf },
        canEnterFor,
    };
};
