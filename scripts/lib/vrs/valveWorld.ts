import path from "node:path";
import type { Standings } from "../../../src/vrs/types.ts";
import type { ValveEvent, ValveMatch, ValvePlayer } from "./buildMatchdata.ts";
import {
    finishedAtSnapshot,
    getSnapshotWindow,
    getSubmoduleCommits,
    loadValveCjs,
    toRoster,
    valveModelDir,
    type StandingsOptions,
    type ValveTeam,
} from "./valveModel.ts";

// Valve's model, loaded once and re-run on a changed match list. Loading (filters, roster linking) is
// most of a full run's cost; seeding and the Glicko pass take a few milliseconds.

const WINDOW_SECONDS = 6 * 30 * 24 * 3600;
const GRACE_SECONDS = 30 * 24 * 3600;
const SHARED_PLAYERS = 3;

export interface VEvent {
    eventId: string | number;
    name: string;
    prizePool: number;
    lan: boolean;
    finished: boolean;
    lastMatchTime: number;
    qualifiedEvents: string | number | -1;
    prizeDistributionByTeamId: Record<string, { prize: number }>;
    accumulateMatch(m: VMatch): void;
}

export interface VTeamMatch {
    match: VMatch;
    team: VTeam;
    isWinner: boolean;
    opponent: VTeam;
}

export interface VTeam extends ValveTeam {
    rosterId: number;
    players: ValvePlayer[];
    isPendingUpdate: boolean;
    teamMatches: VTeamMatch[];
    wonMatches: VTeamMatch[];
    eventMap: Map<string | number, { event: VEvent; teamId: string | number; winnings: number }>;
    matchesPlayed: number;
    distinctTeamsDefeated: number;
    scaledWinnings: number;
    scaledLanWins: number;
    bountyOffered: number;
    ownNetwork: number;
    seedValue: number;
    lanParticipation: number;
    sharesRoster(players: ValvePlayer[]): boolean;
    accumulateMatch(m: VMatch): void;
    recordEventParticipation(event: VEvent | undefined, teamId: string | number): void;
    setActiveRoster(): void;
    setPluralityRegion(): void;
}

export interface VMatch extends ValveMatch {
    team1: VTeam;
    team2: VTeam;
    umid: number;
    informationContent: number;
    winnerDeltaRankValue: number;
    loserDeltaRankValue: number;
}

export interface VContext {
    timeWindowStart: number;
    timeWindowEnd: number;
    setTimeWindow(start: number, end: number): void;
    setHveMod(v: number): VContext;
    setOutlierCount(n: number): VContext;
    getOutlierCount(): number;
    getTimestampModifier(t: number): number;
}

interface TeamClass {
    new (rosterId: number, name: string, players: ValvePlayer[], isPendingUpdate: boolean): VTeam;
    initializeSeedingModifiers(teams: VTeam[], ctx: VContext): void;
}

interface Valve {
    Team: TeamClass;
    Event: new (json: ValveEvent) => VEvent;
    sortMatches(matches: VMatch[], order: "asc" | "desc"): void;
    filterIncompleteMatches<T extends ValveMatch>(m: T[]): T[];
    filterUnrankedMatches<T extends ValveMatch>(m: T[]): T[];
    filterMatchesByTime<T extends ValveMatch>(m: T[], start: number, end: number): T[];
    RankingContext: new () => VContext;
    Glicko: new () => { setFixedRD(v: number): unknown };
    seedTeams(glicko: unknown, teams: VTeam[]): void;
    runMatches(glicko: unknown, matches: VMatch[]): void;
    applyRanking(teams: VTeam[]): void;
}

let valve: Valve | null = null;
const getValve = (): Valve => {
    if (valve) return valve;
    const load = (file: string) => loadValveCjs(path.join(valveModelDir, file)) as Record<string, unknown>;
    const loader = load("data_loader.js");
    const ranking = load("ranking.js");
    valve = {
        Team: load("team.js") as unknown as TeamClass,
        Event: loader.Event as Valve["Event"],
        sortMatches: loader.sortMatches as Valve["sortMatches"],
        filterIncompleteMatches: loader.filterIncompleteMatches as Valve["filterIncompleteMatches"],
        filterUnrankedMatches: loader.filterUnrankedMatches as Valve["filterUnrankedMatches"],
        filterMatchesByTime: loader.filterMatchesByTime as Valve["filterMatchesByTime"],
        RankingContext: load("ranking_context.js") as unknown as Valve["RankingContext"],
        Glicko: load("glicko.js") as unknown as Valve["Glicko"],
        seedTeams: ranking.seedTeams as Valve["seedTeams"],
        runMatches: ranking.runMatches as Valve["runMatches"],
        applyRanking: ranking.applyRanking as Valve["applyRanking"],
    };
    return valve;
};

export interface ValveWorld {
    snapshotDate: string;
    pullTime: number;
    versionTimestamp: number;
    windowStart: number;
    windowEnd: number;
    ctx: VContext;
    rawEvents: ValveEvent[];
    /** Events whose pull holds matches after `pullTime`. */
    laterEventIds: Set<string>;
    /** Complete, ranked, in-window matches up to the pull, in input order, owned by the world. */
    pool: VMatch[];
    /** Roster of each side of every match Valve linked at load. */
    baseLinks: Map<VMatch, [VTeam, VTeam]>;
    baseTeams: VTeam[];
    /** Players each base roster was linked with at load, before any rerun changed them. */
    basePlayers: Map<VTeam, ValvePlayer[]>;
}

export interface WorldDelta {
    matches?: ValveMatch[];
    /** Replace base events with the same id. */
    events?: ValveEvent[];
    /** Drop these input matches (base or delta) before anything else, as if they were never in the pull. */
    excludeMatch?: (m: ValveMatch) => boolean;
}

export interface WorldState {
    /** Every roster with a match, in Valve's creation order. */
    teams: VTeam[];
    /** Rosters in the standings, best first. */
    ranked: VTeam[];
    matchesAsc: VMatch[];
    events: Record<string, VEvent>;
    ctx: VContext;
}

export interface RerunResult {
    standings: Standings;
    /** Valid until the next `rerun` on the same world. */
    state: WorldState;
    /** False when Valve would link some match to a different roster than this rerun did; use `computeStandings`. */
    exact: boolean;
    /** The first side that would link differently. */
    inexact?: string;
}

const copyMatch = (m: ValveMatch): VMatch =>
    ({
        ...m,
        team1Players: m.team1Players.map((p) => ({ ...p })),
        team2Players: m.team2Players.map((p) => ({ ...p })),
    }) as VMatch;

/** Port of the linked-prize-pool closure in `DataLoader.loadData`; it mutates in `for…in` order, so insertion order matters. */
const linkPrizePools = (events: Record<string, VEvent>) => {
    const linked = (id: string | number, counter = 0, prizePool = 0): [number, number] => {
        const qualified = events[id].qualifiedEvents;
        if (qualified !== -1 && events[qualified] !== undefined && events[qualified].finished) {
            return linked(qualified, counter + 1, Math.min(events[qualified].prizePool, 1000000));
        }
        return [counter, prizePool];
    };
    for (const id in events) {
        const [counter, pool] = linked(id);
        if (counter > 0) {
            events[id].prizePool = Math.min(events[id].prizePool + pool * Math.pow(0.5, counter), 1000000);
        }
    }
};

const filterInput = <T extends ValveMatch>(v: Valve, matches: T[]) => v.filterUnrankedMatches(v.filterIncompleteMatches(matches));

export const loadWorld = (
    matchData: ValveMatch[],
    eventData: ValveEvent[],
    snapshotDate: string,
    options: StandingsOptions = {}
): ValveWorld => {
    const v = getValve();
    const window = getSnapshotWindow(snapshotDate);
    const { pullTime } = window;
    const versionTimestamp = options.windowEndsAtPull ? pullTime : window.versionTimestamp;

    const laterEventIds = new Set(matchData.filter((m) => m.matchStartTime > pullTime).map((m) => String(m.eventId)));
    const inPull = filterInput(
        v,
        matchData.filter((m) => m.matchStartTime <= pullTime)
    );
    const windowEnd = versionTimestamp < 0 ? Math.max(...inPull.map((m) => m.matchStartTime)) : versionTimestamp;
    const windowStart = windowEnd - WINDOW_SECONDS;
    const ctx = new v.RankingContext().setHveMod(1).setOutlierCount(5);
    ctx.setTimeWindow(windowStart, windowEnd - GRACE_SECONDS);

    const world: ValveWorld = {
        snapshotDate,
        pullTime,
        versionTimestamp,
        windowStart,
        windowEnd,
        ctx,
        rawEvents: eventData,
        laterEventIds,
        pool: v.filterMatchesByTime(inPull, windowStart, windowEnd).map(copyMatch),
        baseLinks: new Map(),
        baseTeams: [],
        basePlayers: new Map(),
    };

    // Port of `insertTeam` in Valve's `initTeams`.
    const teams: VTeam[] = [];
    const insert = (name: string, players: ValvePlayer[], forfeited: boolean) => {
        let team = teams.find((t) => t.sharesRoster(players));
        if (team) {
            if (team.isPendingUpdate) {
                team.name = name;
                team.players = players;
                team.isPendingUpdate = forfeited;
            }
            return team;
        }
        team = new v.Team(teams.length, name, players, forfeited);
        teams.push(team);
        return team;
    };
    for (const m of assemble(world, {}).desc) {
        world.baseLinks.set(m, [insert(m.team1Name, m.team1Players, Boolean(m.forfeited)), insert(m.team2Name, m.team2Players, Boolean(m.forfeited))]);
    }
    world.baseTeams = teams;
    for (const t of teams) world.basePlayers.set(t, t.players);
    return world;
};

const sideIndex = new WeakMap<ValveWorld, { byPlayer: Map<string, number[]>; teamOf: VTeam[]; sides: Map<VTeam, number> }>();

/** Whether a match by `players` newer than the window keeps `rerun` exact: its roster shares 3 players with each of its own sides and no other roster's. */
export const lineupKeepsLinks = (world: ValveWorld, players: ValvePlayer[]): boolean => {
    let index = sideIndex.get(world);
    if (!index) {
        index = { byPlayer: new Map(), teamOf: [], sides: new Map() };
        for (const [m, pair] of world.baseLinks) {
            for (const [team, lineup] of [
                [pair[0], m.team1Players],
                [pair[1], m.team2Players],
            ] as const) {
                const side = index.teamOf.push(team) - 1;
                index.sides.set(team, (index.sides.get(team) ?? 0) + 1);
                for (const p of lineup) {
                    const key = String(p.playerId);
                    if (!index.byPlayer.has(key)) index.byPlayer.set(key, []);
                    index.byPlayer.get(key)!.push(side);
                }
            }
        }
        sideIndex.set(world, index);
    }
    const ids = new Set(players.map((p) => String(p.playerId)));
    const sharing = world.baseTeams.filter((t) => (world.basePlayers.get(t) ?? t.players).filter((p) => ids.has(String(p.playerId))).length >= SHARED_PLAYERS);
    if (sharing.length > 1) return false;
    const own = sharing[0] ?? null;
    const overlap = new Map<number, number>();
    for (const id of ids) for (const side of index.byPlayer.get(id) ?? []) overlap.set(side, (overlap.get(side) ?? 0) + 1);
    let ownSides = 0;
    for (const [side, n] of overlap) {
        if (n < SHARED_PLAYERS) continue;
        if (index.teamOf[side] !== own) return false;
        ownSides++;
    }
    return own === null || ownSides === index.sides.get(own);
};

const rosterCache = new WeakMap<VTeam, { newest: VMatch[]; activeRoster: VTeam["activeRoster"]; region: number[] }>();
/** Events and matches for one run, after Valve's snapshot and loader filters; `desc` is Valve's linking order. */
const assemble = (world: ValveWorld, delta: WorldDelta) => {
    const v = getValve();
    const deltaEvents = delta.events ?? [];
    const replaced = new Set(deltaEvents.map((e) => String(e.eventId)));
    const later = new Set(world.laterEventIds);
    for (const m of delta.matches ?? []) if (m.matchStartTime > world.pullTime) later.add(String(m.eventId));

    const events: Record<string, VEvent> = {};
    const rawEvents = replaced.size ? [...world.rawEvents.filter((e) => !replaced.has(String(e.eventId))), ...deltaEvents] : world.rawEvents;
    for (const ev of rawEvents) {
        const finished = finishedAtSnapshot(ev, world.snapshotDate, later);
        events[ev.eventId] = new v.Event(finished === ev.finished ? ev : { ...ev, finished });
    }
    linkPrizePools(events);

    const added = filterInput(
        v,
        (delta.matches ?? []).filter((m) => m.matchStartTime <= world.pullTime)
    );
    if (world.versionTimestamp < 0 && added.some((m) => m.matchStartTime > world.windowEnd)) {
        throw new Error("A delta match moves the window end; load the world with windowEndsAtPull");
    }
    const exclude = delta.excludeMatch;
    let all: VMatch[] = [...world.pool, ...v.filterMatchesByTime(added, world.windowStart, world.windowEnd).map(copyMatch)];
    if (exclude) all = all.filter((m) => !exclude(m));

    for (const m of all) events[m.eventId]?.accumulateMatch(m);
    const desc = all.filter((m) => !events[m.eventId].name.toLowerCase().includes("showmatch") && events[m.eventId].finished);
    for (const m of desc) m.informationContent = world.ctx.getTimestampModifier(m.matchStartTime);
    v.sortMatches(desc, "desc");
    return { events, desc };
};

interface Identity {
    /** Side position (2 × match index + side) in Valve's linking order. */
    created: number;
    name: string;
    players: ValvePlayer[];
    isPendingUpdate: boolean;
    /** Positions after which each lineup was the team's, for teams a forfeit left pending. */
    versions: Array<{ from: number; players: ValvePlayer[] }>;
}

/** Links each side, then checks Valve's rule: a side joins the earliest-created earlier roster sharing 3 players, or creates one. */
const baseRosterIndex = new WeakMap<ValveWorld, Map<unknown, number[]>>();

/** `world.baseTeams.find((t) => t.sharesRoster(players))` for the base lineups, through a player index instead of a scan. */
const firstBaseSharing = (world: ValveWorld, players: ValvePlayer[]): VTeam | undefined => {
    let index = baseRosterIndex.get(world);
    if (!index) {
        index = new Map();
        world.baseTeams.forEach((t, i) => {
            for (const p of world.basePlayers.get(t)!) index!.set(p.playerId, [...(index!.get(p.playerId) ?? []), i]);
        });
        baseRosterIndex.set(world, index);
    }
    const overlap = new Map<number, number>();
    let first = Infinity;
    for (const p of players) {
        for (const i of index.get(p.playerId) ?? []) {
            const n = (overlap.get(i) ?? 0) + 1;
            overlap.set(i, n);
            if (n >= SHARED_PLAYERS && i < first) first = i;
        }
    }
    return world.baseTeams[first];
};

const link = (world: ValveWorld, desc: VMatch[]) => {
    const v = getValve();
    for (const [t, players] of world.basePlayers) t.players = players;
    const newTeams: VTeam[] = [];
    let rosterId = world.baseTeams.length;
    for (const m of desc) {
        const base = world.baseLinks.get(m);
        if (base) {
            m.team1 = base[0];
            m.team2 = base[1];
            continue;
        }
        const pickTeam = (name: string, players: ValvePlayer[]) => {
            const team = newTeams.find((t) => t.sharesRoster(players)) ?? firstBaseSharing(world, players);
            if (team) return team;
            const created = new v.Team(rosterId++, name, players, Boolean(m.forfeited));
            newTeams.push(created);
            return created;
        };
        m.team1 = pickTeam(m.team1Name, m.team1Players);
        m.team2 = pickTeam(m.team2Name, m.team2Players);
    }

    const identities = new Map<VTeam, Identity>();
    desc.forEach((m, i) => {
        for (const [side, team, name, players] of [
            [0, m.team1, m.team1Name, m.team1Players],
            [1, m.team2, m.team2Name, m.team2Players],
        ] as const) {
            const pos = 2 * i + side;
            const id = identities.get(team);
            if (!id) {
                identities.set(team, { created: pos, name, players, isPendingUpdate: Boolean(m.forfeited), versions: [{ from: pos, players }] });
            } else if (id.isPendingUpdate) {
                id.name = name;
                id.players = players;
                id.isPendingUpdate = Boolean(m.forfeited);
                id.versions.push({ from: pos, players });
            }
        }
    });

    const byPlayer = new Map<string, Array<{ team: VTeam; from: number; until: number }>>();
    for (const [team, id] of identities) {
        id.versions.forEach((ver, k) => {
            const until = id.versions[k + 1]?.from ?? Infinity;
            for (const p of ver.players) {
                const key = String(p.playerId);
                if (!byPlayer.has(key)) byPlayer.set(key, []);
                byPlayer.get(key)!.push({ team, from: ver.from, until });
            }
        });
    }

    let inexact: string | undefined;
    const overlap = new Map<VTeam, number>();
    desc.forEach((m, i) => {
        if (inexact) return;
        for (const [side, team, players] of [
            [0, m.team1, m.team1Players],
            [1, m.team2, m.team2Players],
        ] as const) {
            const pos = 2 * i + side;
            overlap.clear();
            let expected: VTeam | null = null;
            let expectedCreated = Infinity;
            for (const p of players) {
                for (const entry of byPlayer.get(String(p.playerId)) ?? []) {
                    // Valve compares against the lineup the roster held when this side was linked.
                    if (entry.from >= pos || entry.until < pos) continue;
                    const n = (overlap.get(entry.team) ?? 0) + 1;
                    overlap.set(entry.team, n);
                    const created = identities.get(entry.team)!.created;
                    if (n >= SHARED_PLAYERS && created < expectedCreated) {
                        expected = entry.team;
                        expectedCreated = created;
                    }
                }
            }
            const ok = expected ? expected === team : identities.get(team)!.created === pos;
            if (!ok) {
                inexact = `${m.team1Name} vs ${m.team2Name} at ${new Date(m.matchStartTime * 1000).toISOString().slice(0, 10)}: ${side ? m.team2Name : m.team1Name} would link to ${expected?.name ?? "a new roster"}`;
                return;
            }
        }
    });

    const teams = [...identities.keys()].sort((a, b) => identities.get(a)!.created - identities.get(b)!.created);
    for (const t of teams) {
        const id = identities.get(t)!;
        t.name = id.name;
        t.players = id.players;
        t.isPendingUpdate = id.isPendingUpdate;
    }
    return { teams, inexact };
};

/** Valve's standings for the world's input plus `delta`, matching `computeStandings` on the combined input. */
export const rerun = (world: ValveWorld, delta: WorldDelta = {}): RerunResult => {
    const v = getValve();
    const { events, desc } = assemble(world, delta);
    const { teams, inexact } = link(world, desc);

    for (const t of teams) {
        t.teamMatches = [];
        t.wonMatches = [];
        t.eventMap = new Map();
        t.modifiers = {} as VTeam["modifiers"];
        t.regionalRank = [-1, -1, -1];
        t.globalRank = undefined;
        t.satisfiesRankingCriteria = false;
    }
    desc.forEach((m, idx) => {
        m.umid = idx;
        m.team1.accumulateMatch(m);
        m.team2.accumulateMatch(m);
        if (m.eventId !== undefined) {
            m.team1.recordEventParticipation(events[m.eventId], m.team1Id);
            m.team2.recordEventParticipation(events[m.eventId], m.team2Id);
        }
    });
    for (const t of teams) {
        // Both read only the 10 newest matches, and the region lookup dominates a rerun's cost.
        const newest = t.teamMatches.slice(0, 10).map((tm) => tm.match);
        const cached = rosterCache.get(t);
        if (cached && cached.newest.length === newest.length && cached.newest.every((m, i) => m === newest[i])) {
            t.activeRoster = cached.activeRoster;
            t.region = cached.region;
            continue;
        }
        t.setActiveRoster();
        t.setPluralityRegion();
        rosterCache.set(t, { newest, activeRoster: t.activeRoster, region: t.region });
    }
    v.Team.initializeSeedingModifiers(teams, world.ctx);

    const glicko = new v.Glicko();
    glicko.setFixedRD(75);
    v.seedTeams(glicko, teams);
    const asc = [...desc];
    v.sortMatches(asc, "asc");
    v.runMatches(glicko, asc);
    for (const t of teams) t.rankValue = t.glickoTeam.rank();
    const ranked = teams.filter((t) => t.distinctTeamsDefeated > 0);
    v.applyRanking(ranked);

    const { valveCommit, modelCommit } = getSubmoduleCommits();
    return {
        standings: {
            snapshotDate: world.snapshotDate,
            valveCommit,
            modelCommit,
            source: "model",
            generatedAt: new Date().toISOString(),
            rosters: ranked.map(toRoster),
        },
        state: { teams, ranked, matchesAsc: asc, events, ctx: world.ctx },
        exact: inexact === undefined,
        ...(inexact ? { inexact } : {}),
    };
};
