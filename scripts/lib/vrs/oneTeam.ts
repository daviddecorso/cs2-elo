import { getRosterKey } from "../../../src/vrs/types.ts";

// One roster's VRS points re-derived with Valve's formulas (model/team.js, ranking.js, glicko.js)
// while every other roster stays as it was in a `rerun` state. No Node imports.

const BUCKET = 10;
const OUTLIER = 5;
const MIN_SEEDED_RANK = 400;
const MAX_SEEDED_RANK = 2000;
const FIXED_RD = 75;
const RECOMPUTED_TOP_SEEDS = 4;
const Q = Math.log(10) / 400;
const G = 1 / Math.sqrt(1 + (3 * Q * Q * FIXED_RD * FIXED_RD) / (Math.PI * Math.PI));

export interface LedgerMatch {
    t: number;
    eventId: string;
    opponent: number;
    /** Opponent's rating going into the match. */
    opponentRating: number;
    won: boolean;
    lan: boolean;
    /** Event prize pool after qualifier links, clamped to [1, 1,000,000] USD. */
    prizePool: number;
}

export interface LedgerEvent {
    eventId: string;
    /** Latest match of the whole event, not just this roster's. */
    lastMatchTime: number;
    prize: number;
}

export interface Ledger {
    roster: number;
    /** In Valve's ascending match order. */
    matches: LedgerMatch[];
    events: LedgerEvent[];
}

export interface FrozenRoster {
    rosterKey: string;
    name: string;
    playerIds: string[];
    bountyOffered: number;
    ownNetwork: number;
    /** Unnormalized inputs to `bountyOffered` and `ownNetwork`, to rescale when the scored roster moves a reference. */
    scaledWinnings: number;
    distinctTeamsDefeated: number;
    seedValue: number;
    points: number;
    /** In the standings with a global rank. */
    ranked: boolean;
    seedRating: number;
    /** Match times ascending and the rating after each. */
    times: number[];
    ratings: number[];
}

interface Extremes {
    /** Highest first, with roster index, enough to drop one roster and still read the 5th. */
    top: Array<[number, number]>;
}

export interface FrozenWorld {
    windowStart: number;
    decayEnd: number;
    rosters: FrozenRoster[];
    ledgers: Ledger[];
    winnings: Extremes;
    opponents: Extremes;
    lanWins: Extremes;
    /** Two lowest seed values with roster index. */
    seedLow: Array<[number, number]>;
    /** Highest seed values first: the ones re-derived per score, then one more as a bound, then a spare for the scored roster. */
    seedHigh: Array<[number, number]>;
}

/** Shape of a `rerun` state that this module reads; kept structural so the browser needn't import Node code. */
export interface FreezeInput {
    teams: Array<{
        name: string;
        players: Array<{ playerId: string | number }>;
        activeRoster: Array<{ nick: string }>;
        bountyOffered: number;
        ownNetwork: number;
        seedValue: number;
        scaledWinnings: number;
        distinctTeamsDefeated: number;
        scaledLanWins: number;
        rankValueSeed: number;
        rankValue: number;
        satisfiesRankingCriteria: boolean;
        globalRank?: number;
        eventMap: Map<string | number, { event: { eventId: string | number; lastMatchTime: number }; winnings: number }>;
    }>;
    matchesAsc: Array<{
        matchStartTime: number;
        eventId: string | number;
        team1: FreezeInput["teams"][number];
        team2: FreezeInput["teams"][number];
        winningTeam: 1 | 2;
        winnerDeltaRankValue: number;
        loserDeltaRankValue: number;
    }>;
    events: Record<string, { lan: boolean; prizePool: number }>;
    ctx: { timeWindowStart: number; timeWindowEnd: number };
}

const remapClamped = (val: number, inStart: number, inEnd: number, outStart: number, outEnd: number) => {
    const interp = inStart === inEnd ? 0.5 : (val - inStart) / (inEnd - inStart);
    const clamped = Math.max(Math.min(interp, 1), 0);
    return clamped * outEnd + (1 - clamped) * outStart;
};
const safeRatio = (num: number, den: number) => (den <= 0 ? 0 : Math.min(num / den, 1));
const curve = (x: number) => (x <= 0 ? 0 : 1 / (1 + Math.abs(Math.log10(x))));
const topSum = (vals: number[]) => {
    vals.sort((a, b) => b - a);
    let s = 0;
    for (let i = 0; i < Math.min(BUCKET, vals.length); i++) s += vals[i];
    return s;
};

export const cappedPrizePool = (pool: number) => Math.min(Math.max(1, pool), 1000000);

const extremes = (values: number[]): Extremes => ({
    top: values
        .map((v, i) => [v, i] as [number, number])
        .sort((a, b) => b[0] - a[0])
        .slice(0, OUTLIER + 1),
});

/** Valve's 5th-highest across all rosters, with `roster`'s own value replaced. */
const referenceWith = (ex: Extremes, roster: number, value: number, rosterCount: number) => {
    const others = ex.top.filter(([, i]) => i !== roster).map(([v]) => v);
    const vals = [...others, value].sort((a, b) => b - a);
    return vals[Math.min(OUTLIER, rosterCount) - 1];
};

export const freeze = (state: FreezeInput): FrozenWorld => {
    const index = new Map(state.teams.map((t, i) => [t, i]));
    const rosters: FrozenRoster[] = state.teams.map((t) => ({
        rosterKey: getRosterKey(t.activeRoster.map((p) => p.nick)),
        name: t.name,
        playerIds: t.players.map((p) => String(p.playerId)),
        bountyOffered: t.bountyOffered,
        ownNetwork: t.ownNetwork,
        scaledWinnings: t.scaledWinnings,
        distinctTeamsDefeated: t.distinctTeamsDefeated,
        seedValue: t.seedValue,
        points: t.rankValue,
        ranked: t.satisfiesRankingCriteria && t.distinctTeamsDefeated > 0 && t.globalRank !== undefined,
        seedRating: t.rankValueSeed,
        times: [],
        ratings: [],
    }));
    const ledgers: Ledger[] = state.teams.map((t, i) => ({
        roster: i,
        matches: [],
        events: [...t.eventMap.values()]
            .filter((e) => e.winnings > 0)
            .map((e) => ({ eventId: String(e.event.eventId), lastMatchTime: e.event.lastMatchTime, prize: e.winnings })),
    }));

    const current = rosters.map((r) => r.seedRating);
    for (const m of state.matchesAsc) {
        const a = index.get(m.team1)!;
        const b = index.get(m.team2)!;
        const [w, l] = m.winningTeam === 1 ? [a, b] : [b, a];
        const before = [current[a], current[b]];
        current[w] += m.winnerDeltaRankValue;
        current[l] += m.loserDeltaRankValue;
        const ev = state.events[m.eventId];
        const shared = { t: m.matchStartTime, eventId: String(m.eventId), lan: Boolean(ev.lan), prizePool: cappedPrizePool(ev.prizePool) };
        ledgers[a].matches.push({ ...shared, opponent: b, opponentRating: before[1], won: w === a });
        ledgers[b].matches.push({ ...shared, opponent: a, opponentRating: before[0], won: w === b });
        for (const i of new Set([a, b])) {
            rosters[i].times.push(m.matchStartTime);
            rosters[i].ratings.push(current[i]);
        }
    }

    const seeds = state.teams.map((t, i) => [t.seedValue, i] as [number, number]).sort((x, y) => x[0] - y[0]);
    return {
        windowStart: state.ctx.timeWindowStart,
        decayEnd: state.ctx.timeWindowEnd,
        rosters,
        ledgers,
        winnings: extremes(state.teams.map((t) => t.scaledWinnings)),
        opponents: extremes(state.teams.map((t) => t.distinctTeamsDefeated)),
        lanWins: extremes(state.teams.map((t) => t.scaledLanWins)),
        seedLow: seeds.slice(0, 2),
        seedHigh: seeds.slice(-(RECOMPUTED_TOP_SEEDS + 2)).reverse(),
    };
};

/** The world `scoreTeam` reads for scoring `keep`: other rosters lose their match ratings, player ids and ledgers, so `withEvent` and `findRoster` no longer work on it. */
export const slimFrozen = (world: FrozenWorld, keep: number): FrozenWorld => {
    const ledgerKept = new Set([keep, ...world.seedHigh.map(([, i]) => i)]);
    return {
        ...world,
        rosters: world.rosters.map((r, i) => (i === keep ? r : { ...r, playerIds: [], times: [], ratings: [] })),
        ledgers: world.ledgers.map((l, i) => (ledgerKept.has(i) ? l : { roster: i, matches: [], events: [] })),
    };
};

/** A roster's rating going into a match at `t`: after its matches before `t`, or its seed rating. */
export const ratingAt = (r: FrozenRoster, t: number): number => {
    let lo = 0;
    let hi = r.times.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (r.times[mid] < t) lo = mid + 1;
        else hi = mid;
    }
    return lo === 0 ? r.seedRating : r.ratings[lo - 1];
};

/** Index of the frozen roster Valve would link `playerIds` to (3 shared players), or -1. */
export const findRoster = (world: FrozenWorld, playerIds: string[]): number => {
    const ids = new Set(playerIds.map(String));
    return world.rosters.findIndex((r) => r.playerIds.filter((p) => ids.has(p)).length >= 3);
};

export const withoutEvents = (ledger: Ledger, eventIds: ReadonlySet<string>): Ledger => ({
    roster: ledger.roster,
    matches: ledger.matches.filter((m) => !eventIds.has(m.eventId)),
    events: ledger.events.filter((e) => !eventIds.has(e.eventId)),
});

export interface AddedEvent {
    eventId: string;
    lan: boolean;
    /** Before clamping. */
    prizePool: number;
    lastMatchTime: number;
    prize: number;
    matches: Array<{ t: number; opponent: number; won: boolean }>;
}

/** The ledger with an event this roster didn't play in the frozen world, against frozen opponents. */
export const withEvent = (world: FrozenWorld, ledger: Ledger, event: AddedEvent): Ledger => {
    const added: LedgerMatch[] = event.matches.map((m) => ({
        t: m.t,
        eventId: event.eventId,
        opponent: m.opponent,
        opponentRating: ratingAt(world.rosters[m.opponent], m.t),
        won: m.won,
        lan: event.lan,
        prizePool: cappedPrizePool(event.prizePool),
    }));
    return {
        roster: ledger.roster,
        matches: [...ledger.matches, ...added].sort((a, b) => a.t - b.t),
        events: event.prize > 0 ? [...ledger.events, { eventId: event.eventId, lastMatchTime: event.lastMatchTime, prize: event.prize }] : ledger.events,
    };
};

export interface TeamScore {
    points: number;
    seedRating: number;
    seedValue: number;
    factors: { bountyOffered: number; bountyCollected: number; opponentNetwork: number; lanFactor: number };
    /** Null when the roster wouldn't be ranked (no wins, or fewer than 5 matches); undefined when not requested. */
    globalRank?: number | null;
}

interface Raw {
    distinct: number;
    scaledLanWins: number;
    scaledWinnings: number;
}

interface Refs {
    winnings: number;
    opponents: number;
    lanWins: number;
}

const rawOf = (age: (t: number) => number, ledger: Ledger): Raw => {
    const won = ledger.matches.filter((m) => m.won);
    const lastWin = new Map<number, number>();
    for (const m of won) {
        const prev = lastWin.get(m.opponent);
        if (prev === undefined || prev < m.t) lastWin.set(m.opponent, m.t);
    }
    let distinct = 0;
    for (const t of lastWin.values()) distinct += age(t);
    return {
        distinct,
        scaledLanWins: topSum(won.map((m) => (m.lan ? 1 : 0) * age(m.t))) / BUCKET,
        scaledWinnings: topSum(ledger.events.filter((e) => e.prize > 0).map((e) => e.prize * age(e.lastMatchTime))),
    };
};

/** Valve's seed value for one roster, with opponents normalized against `refs` and `scored` using its new totals. */
const seedOf = (
    world: FrozenWorld,
    age: (t: number) => number,
    ledger: Ledger,
    raw: Raw,
    refs: Refs,
    scored: { roster: number; raw: Raw }
) => {
    const bounties: number[] = [];
    const network: number[] = [];
    for (const m of ledger.matches) {
        if (!m.won) continue;
        const context = age(m.t) * curve(m.prizePool / 1000000);
        const opp = m.opponent === scored.roster ? scored.raw : { scaledWinnings: world.rosters[m.opponent].scaledWinnings, distinct: world.rosters[m.opponent].distinctTeamsDefeated };
        bounties.push(safeRatio(opp.scaledWinnings, refs.winnings) * context);
        network.push(safeRatio(opp.distinct, refs.opponents) * context);
    }
    const factors = {
        bountyCollected: curve(topSum(bounties) / BUCKET),
        bountyOffered: curve(safeRatio(raw.scaledWinnings, refs.winnings)),
        opponentNetwork: topSum(network) / BUCKET,
        lanFactor: safeRatio(raw.scaledLanWins, refs.lanWins),
    };
    // Valve's weights are 1 for these four and 0 for ownNetwork; summed in its order.
    return { factors, seedValue: (factors.bountyCollected + factors.bountyOffered + factors.opponentNetwork + factors.lanFactor) / 4 };
};

/** `rank: false` skips the global rank, which compares against every roster and is most of the cost. */
export const scoreTeam = (world: FrozenWorld, ledger: Ledger, options: { rank?: boolean } = { rank: true }): TeamScore => {
    const { rosters } = world;
    const n = rosters.length;
    const age = (t: number) => remapClamped(t, world.windowStart, world.decayEnd, 0, 1);
    const raw = rawOf(age, ledger);
    const refs: Refs = {
        winnings: referenceWith(world.winnings, ledger.roster, raw.scaledWinnings, n),
        opponents: referenceWith(world.opponents, ledger.roster, raw.distinct, n),
        lanWins: referenceWith(world.lanWins, ledger.roster, raw.scaledLanWins, n),
    };
    const scored = { roster: ledger.roster, raw };
    const { factors, seedValue } = seedOf(world, age, ledger, raw, refs, scored);

    // The top seed sets the remap's upper end and has usually played this roster, so it is re-derived
    // with its matches against this roster taken from this ledger.
    const tops = world.seedHigh.filter(([, i]) => i !== ledger.roster).slice(0, RECOMPUTED_TOP_SEEDS + 1);
    const rederive = tops.length > RECOMPUTED_TOP_SEEDS ? tops.slice(0, -1) : tops;
    let high = tops.length > RECOMPUTED_TOP_SEEDS ? tops[tops.length - 1][0] : seedValue;
    const rederived = new Map<number, number>();
    for (const [, r] of rederive) {
        const own = world.ledgers[r];
        const mirrored = ledger.matches
            .filter((m) => m.opponent === r)
            .map((m) => ({ ...m, opponent: ledger.roster, won: !m.won }));
        const adjusted: Ledger = { roster: r, matches: [...own.matches.filter((m) => m.opponent !== ledger.roster), ...mirrored], events: own.events };
        const value = seedOf(world, age, adjusted, rawOf(age, adjusted), refs, scored).seedValue;
        rederived.set(r, value);
        high = Math.max(high, value);
    }
    const otherLow = world.seedLow.find(([, i]) => i !== ledger.roster);
    const low = otherLow ? Math.min(otherLow[0], seedValue) : seedValue;
    high = Math.max(high, seedValue);
    const seedRating = remapClamped(seedValue, low, high, MIN_SEEDED_RANK, MAX_SEEDED_RANK);

    // A moved seed range shifts every opponent's starting rating; carry that shift into its match-time rating.
    const shift = new Map<number, number>();
    const shiftOf = (opp: number) => {
        let s = shift.get(opp);
        if (s === undefined) {
            const value = rederived.get(opp) ?? rosters[opp].seedValue;
            s = remapClamped(value, low, high, MIN_SEEDED_RANK, MAX_SEEDED_RANK) - rosters[opp].seedRating;
            shift.set(opp, s);
        }
        return s;
    };

    let rank = seedRating;
    for (const m of ledger.matches) {
        const info = age(m.t);
        const opponentRating = m.opponentRating + shiftOf(m.opponent);
        const ev = 1 / (1 + Math.pow(10, (G * (rank - opponentRating)) / -400));
        const adjRDSq = G * G * ev * (1 - ev) * info * info;
        const adjRank = G * ((m.won ? 1 : 0) - ev) * info;
        const adjustedRDSq = 1 / (1 / (FIXED_RD * FIXED_RD) + Q * Q * adjRDSq);
        rank += Q * adjustedRDSq * adjRank;
    }

    const ranked = raw.distinct > 0 && ledger.matches.length >= 5;
    return {
        points: rank,
        seedRating,
        seedValue,
        factors,
        globalRank: !ranked ? null : !options.rank ? undefined : 1 + rosters.filter((r, i) => i !== ledger.roster && r.ranked && r.points + shiftOf(i) > rank).length,
    };
};
