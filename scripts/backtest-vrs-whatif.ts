import fs from "node:fs";
import { runSeason } from "./lib/sim/season.ts";
import { loadSeasonSetup } from "./lib/sim/seasonSetup.ts";
import { applyDelta, latestLineups } from "./lib/sim/vrsProjection.ts";
import type { Matchdata, ValveEvent, ValveMatch } from "./lib/vrs/buildMatchdata.ts";
import { findRoster, freeze, scoreTeam, withEvent, withoutEvents, type FrozenWorld } from "./lib/vrs/oneTeam.ts";
import { calibratedSnapshotDates, computeStandings } from "./lib/vrs/valveModel.ts";
import { loadWorld, rerun, type ValveWorld, type VTeam } from "./lib/vrs/valveWorld.ts";
import type { Standings } from "../src/vrs/types.ts";
import type { RawRow } from "./lib/elo/normalize.ts";

// Checks the two fast VRS what-if models (docs/vrs-simulator.md): `rerun` against full Valve runs,
// and the one-team model against `rerun`. Local data only.

const GATE = { meanError: 5, p95Error: 15, meanRegret: 5 };
const TOP = 60;
const REGRET_TEAMS = 20;
const REGRET_SUBSETS = 30;
const FULL_CHECKS = 25;
/** The biggest LANs of the last 75 days, replayed 9 days apart after the last match. */
const FUTURE_EVENTS = 6;
/** Lower-tier cases: attendees up to this global rank, events whose last match is this recent. */
const TOP_WIDE = 150;
const RECENT_DAYS = 150;
const CATEGORY_CASES = 60;
/** Schedule cases: rosters in this global rank band, adding back 5–10 of their recent events at once. */
const SCHEDULE_RANKS = [15, 80];
const SCHEDULE_EVENTS = [5, 10];
const FUTURE_REGRET_TEAMS = 20;
const FUTURE_REGRET_EVENTS = 8;

const args = process.argv.slice(2);
const seedArg = args.indexOf("--seed");
let rngState = seedArg >= 0 ? Number(args[seedArg + 1]) : 1;
const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) % 4294967296;
    return rngState / 4294967296;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const shuffle = <T>(xs: T[]): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

const md = JSON.parse(fs.readFileSync("data/matchdata.json", "utf8")) as Matchdata;
const pastDate = calibratedSnapshotDates().at(-1)!;
const lastMatch = Math.max(...md.matches.map((m) => m.matchStartTime));
const day = 86400;
const isoDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const futureDate = isoDate(lastMatch + (10 + FUTURE_EVENTS * 9) * day);

const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return {
        n: s.length,
        mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length),
        p95: s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] ?? 0,
        max: s.at(-1) ?? 0,
    };
};
const fmt = (s: ReturnType<typeof stats>) => `n ${s.n}, mean ${s.mean.toFixed(2)}, p95 ${s.p95.toFixed(2)}, max ${s.max.toFixed(2)}`;

const maxDifference = (a: Standings, b: Standings): number => {
    if (a.rosters.length !== b.rosters.length) return Infinity;
    let worst = 0;
    a.rosters.forEach((r, i) => {
        const o = b.rosters[i];
        if (r.rosterKey !== o.rosterKey || r.teamName !== o.teamName || r.globalRank !== o.globalRank || r.regionalRank !== o.regionalRank) {
            worst = Infinity;
        }
        worst = Math.max(worst, Math.abs(r.points - o.points), Math.abs(r.startingValue - o.startingValue));
    });
    return worst;
};

const matchKey = (m: ValveMatch) => `${m.eventId}|${m.matchStartTime}|${m.team1Id}|${m.team2Id}`;

// --- Synthetic future events: recent LANs replayed after the last match with current lineups.

const lineups = latestLineups(md);
const eventsById = new Map(md.events.map((e) => [String(e.eventId), e]));
const recentLans = [...new Set(md.matches.filter((m) => m.matchStartTime > lastMatch - 75 * day).map((m) => String(m.eventId)))]
    .map((id) => eventsById.get(id))
    .filter((e): e is ValveEvent => !!e && e.lan && e.finished && e.prizeDistribution.length >= 8)
    .sort((a, b) => Number(b.prizePool.replace(/\D/g, "")) - Number(a.prizePool.replace(/\D/g, "")));

const futureEvent = (ev: ValveEvent, slot: number): { matches: ValveMatch[]; events: ValveEvent[] } => {
    const source = md.matches.filter((m) => String(m.eventId) === String(ev.eventId));
    const first = Math.min(...source.map((m) => m.matchStartTime));
    const shift = lastMatch + (2 + slot * 9) * day - first;
    const eventId = `${ev.eventId}-future`;
    const lineupOf = (id: string | number, fallback: ValveMatch["team1Players"]) => lineups.get(String(id))?.players ?? fallback;
    const matches = source.map((m) => ({
        ...m,
        eventId,
        matchStartTime: m.matchStartTime + shift,
        team1Players: lineupOf(m.team1Id, m.team1Players),
        team2Players: lineupOf(m.team2Id, m.team2Players),
    }));
    return {
        matches,
        events: [{ ...ev, eventId, eventName: `${ev.eventName} (replayed)`, endDate: isoDate(Math.max(...matches.map((m) => m.matchStartTime))), prizeDistribution: ev.prizeDistribution.map((p) => ({ ...p, qualifiedEvents: [] })) }],
    };
};
const futures = recentLans.slice(0, FUTURE_EVENTS).map(futureEvent);
const combine = (parts: Array<{ matches: ValveMatch[]; events: ValveEvent[] }>) => ({
    matches: parts.flatMap((p) => p.matches),
    events: parts.flatMap((p) => p.events),
});

console.log(`Past window ${pastDate}; future window ${futureDate} with ${futures.length} replayed LANs (${recentLans.slice(0, FUTURE_EVENTS).map((e) => e.eventName).join(", ")}).`);
const t0 = Date.now();
const past = loadWorld(md.matches, md.events, pastDate);
const future = loadWorld(md.matches, md.events, futureDate, { windowEndsAtPull: true });
console.log(`Loaded both worlds in ${Date.now() - t0} ms.`);

// --- 1. rerun against full Valve runs

const pastBase = rerun(past);
const topPast = pastBase.state.ranked.slice(0, TOP);
// Team objects are reused by later reruns, so read their base matches now.
const played = new Map(topPast.map((t) => [t, t.teamMatches.map((tm) => ({ eventId: String(tm.match.eventId), key: matchKey(tm.match) }))]));

interface Snapshot {
    team: VTeam;
    points: number;
    seed: number;
    globalRank: number | null;
    players: string[];
    matches: Array<{ eventId: string; key: string; t: number; won: boolean; teamId: string; opponentPlayers: string[] }>;
}
const ids = (players: ValveMatch["team1Players"]) => players.map((p) => String(p.playerId));
const snapshots: Snapshot[] = pastBase.state.ranked.slice(0, TOP_WIDE).map((team) => {
    const matches = team.teamMatches.map((tm) => {
        const side = tm.match.team1 === team ? 1 : 2;
        return {
            eventId: String(tm.match.eventId),
            key: matchKey(tm.match),
            t: tm.match.matchStartTime,
            won: tm.isWinner,
            teamId: String(side === 1 ? tm.match.team1Id : tm.match.team2Id),
            opponentPlayers: ids(side === 1 ? tm.match.team2Players : tm.match.team1Players),
            ownPlayers: ids(side === 1 ? tm.match.team1Players : tm.match.team2Players),
        };
    });
    const latest = matches.reduce((a, b) => (b.t > a.t ? b : a));
    return { team, points: team.rankValue, seed: team.rankValueSeed, globalRank: team.globalRank ?? null, players: latest.ownPlayers, matches };
});
const eventInfo = new Map(Object.entries(pastBase.state.events).map(([id, e]) => [id, { lan: e.lan, prizePool: e.prizePool, lastMatchTime: e.lastMatchTime }]));
const eventsOf = (team: VTeam) => [...new Set(played.get(team)!.map((p) => p.eventId))];
const teamMatchKeys = (team: VTeam, eventIds: ReadonlySet<string>) =>
    new Set(played.get(team)!.filter((p) => eventIds.has(p.eventId)).map((p) => p.key));

let inexact = 0;
let fullFailures = 0;
const rerunTimes: number[] = [];
for (let i = 0; i < FULL_CHECKS * 2; i++) {
    let world: ValveWorld;
    let date: string;
    let delta: Parameters<typeof rerun>[1];
    let input: Matchdata;
    if (i % 2 === 0) {
        const team = pick(topPast);
        const keys = teamMatchKeys(team, new Set([pick(eventsOf(team))]));
        world = past;
        date = pastDate;
        delta = { excludeMatch: (m) => keys.has(matchKey(m)) };
        input = { matches: md.matches.filter((m) => !keys.has(matchKey(m))), events: md.events };
    } else {
        const parts = shuffle(futures).slice(0, 1 + Math.floor(rand() * futures.length));
        world = future;
        date = futureDate;
        delta = combine(parts);
        input = applyDelta(md, delta as { matches: ValveMatch[]; events: ValveEvent[] });
    }
    const started = performance.now();
    const fast = rerun(world, delta);
    rerunTimes.push(performance.now() - started);
    if (!fast.exact) {
        inexact++;
        continue;
    }
    const full = computeStandings(input.matches, input.events, date, i % 2 === 0 ? {} : { windowEndsAtPull: true });
    const diff = maxDifference(fast.standings, full);
    if (diff > 1e-9) {
        fullFailures++;
        console.log(`  mismatch on check ${i}: max difference ${diff}`);
    }
}
console.log(
    `\n1. rerun vs full model: ${FULL_CHECKS * 2 - inexact - fullFailures}/${FULL_CHECKS * 2} identical, ${inexact} flagged inexact, ${fullFailures} mismatched; ${stats(rerunTimes).mean.toFixed(1)} ms per rerun.`
);

// --- 2. One-team model against rerun

const pointsOf = (team: VTeam) => team.rankValue;

const removeErrors: number[] = [];
const removeSeedErrors: number[] = [];
let removeRankAgree = 0;
let skipped = 0;
{
    const base = rerun(past);
    const frozen = freeze(base.state);
    const index = new Map(base.state.teams.map((t, i) => [t, i]));
    const cases = topPast.flatMap((team) => eventsOf(team).map((eventId) => ({ team, eventId })));
    for (const { team, eventId } of cases) {
        const ids = new Set([eventId]);
        const estimate = scoreTeam(frozen, withoutEvents(frozen.ledgers[index.get(team)!], ids));
        const keys = teamMatchKeys(team, ids);
        const truth = rerun(past, { excludeMatch: (m) => keys.has(matchKey(m)) });
        if (!truth.exact || !truth.state.teams.includes(team)) {
            skipped++;
            continue;
        }
        removeErrors.push(Math.abs(estimate.points - pointsOf(team)));
        removeSeedErrors.push(Math.abs(estimate.seedRating - team.rankValueSeed));
        if (estimate.globalRank === (team.globalRank ?? null)) removeRankAgree++;
    }
}

type Delta = { matches: ValveMatch[]; events: ValveEvent[] };
interface AddResult {
    errors: number[];
    seedErrors: number[];
    rankAgree: number;
}

/** Each top-60 attendee of `part` added back with `withEvent` to the rerun of `context` without its matches, against the rerun with them. */
const addCase = (world: ValveWorld, context: Delta, part: Delta, out: AddResult) => {
    const withAll = rerun(world, context);
    if (!withAll.exact) {
        skipped++;
        return;
    }
    const eventId = String(part.events[0].eventId);
    const ev = withAll.state.events[eventId];
    const top = new Set(withAll.state.ranked.slice(0, TOP));
    const truthPoints = new Map(withAll.state.teams.map((t) => [t, pointsOf(t)]));
    const truthRanks = new Map(withAll.state.teams.map((t) => [t, t.globalRank ?? null]));
    const truthSeeds = new Map(withAll.state.teams.map((t) => [t, t.rankValueSeed]));
    const attendees = [...new Set(part.matches.flatMap((m) => [m.team1Id, m.team2Id]).map(String))];
    for (const teamId of attendees) {
        const own = part.matches.filter((m) => String(m.team1Id) === teamId || String(m.team2Id) === teamId);
        const keys = new Set(own.map(matchKey));
        const without = rerun(world, { ...context, excludeMatch: (m) => keys.has(matchKey(m)) });
        if (!without.exact) {
            skipped++;
            continue;
        }
        const frozen: FrozenWorld = freeze(without.state);
        const players = (m: ValveMatch, side: 1 | 2) => (side === 1 ? m.team1Players : m.team2Players).map((p) => String(p.playerId));
        const mySide = (m: ValveMatch): 1 | 2 => (String(m.team1Id) === teamId ? 1 : 2);
        const self = findRoster(frozen, players(own[0], mySide(own[0])));
        const linked = withAll.state.matchesAsc.find((m) => String(m.eventId) === eventId && matchKey(m) === matchKey(own[0]));
        const team = linked && (mySide(linked) === 1 ? linked.team1 : linked.team2);
        if (self < 0 || !team || !top.has(team)) continue;
        const opponents = own.map((m) => findRoster(frozen, players(m, mySide(m) === 1 ? 2 : 1)));
        if (opponents.some((o) => o < 0)) {
            skipped++;
            continue;
        }
        const prizeRow = part.events[0].prizeDistribution.find((p) => String(p.teamId) === teamId);
        const ledger = withEvent(frozen, frozen.ledgers[self], {
            eventId,
            lan: ev.lan,
            prizePool: ev.prizePool,
            lastMatchTime: ev.lastMatchTime,
            prize: prizeRow ? prizeRow.prize + prizeRow.clubShare : 0,
            matches: own.map((m, k) => ({ t: m.matchStartTime, opponent: opponents[k], won: m.winningTeam === mySide(m) })),
        });
        const estimate = scoreTeam(frozen, ledger);
        out.errors.push(Math.abs(estimate.points - truthPoints.get(team)!));
        out.seedErrors.push(Math.abs(estimate.seedRating - truthSeeds.get(team)!));
        if (estimate.globalRank === truthRanks.get(team)) out.rankAgree++;
    }
};

const replayed: AddResult = { errors: [], seedErrors: [], rankAgree: 0 };
for (const part of futures) addCase(future, part, part, replayed);
const addErrors = replayed.errors;
const addSeedErrors = replayed.seedErrors;
const addRankAgree = replayed.rankAgree;

// --- 2b. Adding simulated future events: one season run of the upcoming calendar, each event added on top of all the others.

const simulated: AddResult = { errors: [], seedErrors: [], rankAgree: 0 };
let simulatedEvents = 0;
let splitSkipped = 0;
{
    const setup = loadSeasonSetup({ n: 1, seed: rngState });
    const target = setup.input.checkpoints.at(-1)!;
    const run = runSeason(setup.input, 0);
    for (const ev of setup.input.events) {
        const outcome = run.events.get(ev.config.slug);
        // An event already under way keeps its played matches in the base, so a team's ledger would hold it twice.
        if (!outcome || outcome.field === null || ev.config.startDate <= setup.asOf) continue;
        const part = setup.input.toDelta({ ...ev.projection }, outcome.outcome);
        // `withEvent` adds one event; a Major split into stage events would need one per stage.
        if (part.events.length !== 1) {
            splitSkipped++;
            continue;
        }
        const ids = new Set(part.events.map((e) => String(e.eventId)));
        const own = { matches: run.delta.matches.filter((m) => ids.has(String(m.eventId))), events: part.events };
        simulatedEvents++;
        addCase(target.world, run.delta, own, simulated);
    }
    console.log(`\nSimulated season to ${target.date}: ${simulatedEvents} events added (${splitSkipped} split Majors skipped).`);
}

const removeStats = stats(removeErrors);
const addStats = stats(addErrors);
const simulatedStats = stats(simulated.errors);
console.log(`\n2. One-team model vs rerun, absolute error in points (${skipped} cases skipped as inexact):`);
console.log(`   remove a played event: ${fmt(removeStats)}; global rank agrees ${((100 * removeRankAgree) / Math.max(1, removeStats.n)).toFixed(1)}%`);
console.log(`   add a future event:    ${fmt(addStats)}; global rank agrees ${((100 * addRankAgree) / Math.max(1, addStats.n)).toFixed(1)}%`);
console.log(`   add a simulated event: ${fmt(simulatedStats)}; global rank agrees ${((100 * simulated.rankAgree) / Math.max(1, simulatedStats.n)).toFixed(1)}%`);
console.log(`   starting value only:   remove ${fmt(stats(removeSeedErrors))}; add ${fmt(stats(addSeedErrors))}; simulated ${fmt(stats(simulated.seedErrors))}`);

// --- 3. Schedule regret: choose which played events to keep

const regrets: number[] = [];
{
    const base = rerun(past);
    const frozen = freeze(base.state);
    const index = new Map(base.state.teams.map((t, i) => [t, i]));
    for (const team of topPast.slice(0, REGRET_TEAMS)) {
        const events = eventsOf(team);
        if (events.length < 3) continue;
        const ledger = frozen.ledgers[index.get(team)!];
        const options: Array<{ estimate: number; truth: number }> = [];
        for (let s = 0; s < REGRET_SUBSETS; s++) {
            const drop = new Set(shuffle(events).slice(0, 1 + Math.floor(rand() * Math.min(3, events.length - 1))));
            const keys = teamMatchKeys(team, drop);
            const truth = rerun(past, { excludeMatch: (m) => keys.has(matchKey(m)) });
            if (!truth.exact || !truth.state.teams.includes(team)) continue;
            options.push({ estimate: scoreTeam(frozen, withoutEvents(ledger, drop)).points, truth: pointsOf(team) });
        }
        if (options.length < 2) continue;
        const chosen = options.reduce((a, b) => (b.estimate > a.estimate ? b : a));
        regrets.push(Math.max(...options.map((o) => o.truth)) - chosen.truth);
    }
}
const regretStats = stats(regrets);
console.log(`\n3. Schedule regret (points lost by picking with the one-team model): ${fmt(regretStats)}`);

// --- 4. Below the top: lower-tier events and whole schedules added back to rosters ranked up to 150, on the past world without them.

const tournamentByPage = new Map(JSON.parse(fs.readFileSync("data/raw/tournaments.json", "utf8")).map((r: RawRow) => [String(r.pagename), r]) as Array<[string, RawRow]>);
const recentFrom = past.windowEnd - RECENT_DAYS * day;
const isRecent = (id: string) => (eventInfo.get(id)?.lastMatchTime ?? 0) >= recentFrom;
const recentEvents = (snap: Snapshot) => [...new Set(snap.matches.map((m) => m.eventId))].filter(isRecent);
const isLinked = (id: string) => eventsById.get(id)?.prizeDistribution.some((p) => p.qualifiedEvents.length > 0) ?? false;
const tierOf = (id: string) => Number(tournamentByPage.get(id)?.liquipediatier) || null;
const categories: Array<{ name: string; test: (id: string) => boolean }> = [
    { name: "an online tier-3 main", test: (id) => !isLinked(id) && eventInfo.get(id)?.lan === false && tierOf(id) === 3 },
    { name: "a tier 3–4 LAN", test: (id) => !isLinked(id) && eventInfo.get(id)?.lan === true && (tierOf(id) === 3 || tierOf(id) === 4) },
    { name: "a linked qualifier", test: (id) => isLinked(id) },
];

let wideSkipped = 0;
/** The past world without `snap`'s matches in `eventIds`, frozen, with the roster's index; null when the rerun relinks. */
const worldWithout = (snap: Snapshot, eventIds: ReadonlySet<string>) => {
    const keys = new Set(snap.matches.filter((m) => eventIds.has(m.eventId)).map((m) => m.key));
    const without = rerun(past, { excludeMatch: (m) => keys.has(matchKey(m)) });
    if (!without.exact) return null;
    const frozen = freeze(without.state);
    const self = findRoster(frozen, snap.players);
    return self < 0 ? null : { frozen, self };
};
/** Chained `withEvent` for each of `eventIds`, in order; null when an opponent isn't in the world. */
const addBack = (w: { frozen: FrozenWorld; self: number }, snap: Snapshot, eventIds: Iterable<string>) => {
    let ledger = w.frozen.ledgers[w.self];
    for (const id of eventIds) {
        const own = snap.matches.filter((m) => m.eventId === id);
        const opponents = own.map((m) => findRoster(w.frozen, m.opponentPlayers));
        if (opponents.some((o) => o < 0)) return null;
        const info = eventInfo.get(id)!;
        const prizeRow = eventsById.get(id)?.prizeDistribution.find((p) => String(p.teamId) === own[0].teamId);
        ledger = withEvent(w.frozen, ledger, {
            eventId: id,
            lan: info.lan,
            prizePool: info.prizePool,
            lastMatchTime: info.lastMatchTime,
            prize: prizeRow ? prizeRow.prize + prizeRow.clubShare : 0,
            matches: own.map((m, k) => ({ t: m.t, opponent: opponents[k], won: m.won })),
        });
    }
    return scoreTeam(w.frozen, ledger);
};
const addBackCase = (snap: Snapshot, eventIds: string[], out: AddResult) => {
    const w = worldWithout(snap, new Set(eventIds));
    const estimate = w && addBack(w, snap, eventIds);
    if (!estimate) {
        wideSkipped++;
        return;
    }
    out.errors.push(Math.abs(estimate.points - snap.points));
    out.seedErrors.push(Math.abs(estimate.seedRating - snap.seed));
    if (estimate.globalRank === snap.globalRank) out.rankAgree++;
};

const categoryResults = categories.map(({ name, test }) => {
    const out: AddResult = { errors: [], seedErrors: [], rankAgree: 0 };
    const cases = snapshots.flatMap((snap) => recentEvents(snap).filter(test).map((id) => ({ snap, id })));
    for (const { snap, id } of shuffle(cases).slice(0, CATEGORY_CASES)) addBackCase(snap, [id], out);
    return { name, out, available: cases.length };
});

const inBand = snapshots.filter((s) => s.globalRank !== null && s.globalRank >= SCHEDULE_RANKS[0] && s.globalRank <= SCHEDULE_RANKS[1] && recentEvents(s).length >= SCHEDULE_EVENTS[0]);
const schedule: AddResult = { errors: [], seedErrors: [], rankAgree: 0 };
const scheduleSizes: number[] = [];
for (const snap of inBand) {
    const events = recentEvents(snap);
    const k = Math.min(events.length, SCHEDULE_EVENTS[0] + Math.floor(rand() * (SCHEDULE_EVENTS[1] - SCHEDULE_EVENTS[0] + 1)));
    const chosen = shuffle(events).slice(0, k);
    const before = schedule.errors.length;
    addBackCase(snap, chosen, schedule);
    if (schedule.errors.length > before) scheduleSizes.push(k);
}

// Future-choice regret: from the world without a roster's recent events, pick which half to play by the chained estimate, as a cap forces.
const futureRegrets: number[] = [];
/** Best minus worst true points among each roster's options, so a zero regret isn't a choice between equals. */
const futureSpreads: number[] = [];
for (const snap of shuffle(inBand).slice(0, FUTURE_REGRET_TEAMS)) {
    const events = shuffle(recentEvents(snap)).slice(0, FUTURE_REGRET_EVENTS);
    const w = worldWithout(snap, new Set(events));
    if (!w) {
        wideSkipped++;
        continue;
    }
    const options: Array<{ estimate: number; truth: number }> = [];
    for (let s = 0; s < REGRET_SUBSETS; s++) {
        const chosen = shuffle(events).slice(0, Math.ceil(events.length / 2));
        const dropped = new Set(events.filter((e) => !chosen.includes(e)));
        const keys = new Set(snap.matches.filter((m) => dropped.has(m.eventId)).map((m) => m.key));
        const truth = rerun(past, { excludeMatch: (m) => keys.has(matchKey(m)) });
        const estimate = addBack(w, snap, chosen);
        if (!truth.exact || !truth.state.teams.includes(snap.team) || !estimate) continue;
        options.push({ estimate: estimate.points, truth: pointsOf(snap.team) });
    }
    if (options.length < 2) continue;
    const best = options.reduce((a, b) => (b.estimate > a.estimate ? b : a));
    futureRegrets.push(Math.max(...options.map((o) => o.truth)) - best.truth);
    futureSpreads.push(Math.max(...options.map((o) => o.truth)) - Math.min(...options.map((o) => o.truth)));
}

const pct = (r: AddResult) => ((100 * r.rankAgree) / Math.max(1, r.errors.length)).toFixed(1);
console.log(`\n4. Below the top (ranks ≤ ${TOP_WIDE}, events in the last ${RECENT_DAYS} days, added back with withEvent; ${wideSkipped} cases skipped as inexact or unlinkable):`);
for (const { name, out, available } of categoryResults) {
    console.log(`   add ${name}: ${fmt(stats(out.errors))} of ${available} available; global rank agrees ${pct(out)}%`);
}
const scheduleStats = stats(schedule.errors);
const futureRegretStats = stats(futureRegrets);
console.log(
    `   add a ${SCHEDULE_EVENTS.join("–")} event schedule, ranks ${SCHEDULE_RANKS.join("–")}: ${fmt(scheduleStats)} (mean ${(scheduleSizes.reduce((a, b) => a + b, 0) / Math.max(1, scheduleSizes.length)).toFixed(1)} events); global rank agrees ${pct(schedule)}%`
);
console.log(
    `   future-choice regret, half of up to ${FUTURE_REGRET_EVENTS} events: ${fmt(futureRegretStats)}; best − worst option ${fmt(stats(futureSpreads))}`
);

const withinGate = (s: ReturnType<typeof stats>) => s.n > 0 && s.mean <= GATE.meanError && s.p95 <= GATE.p95Error;
const passed =
    fullFailures === 0 &&
    withinGate(removeStats) &&
    withinGate(addStats) &&
    withinGate(simulatedStats) &&
    regretStats.mean <= GATE.meanRegret &&
    categoryResults.every((c) => withinGate(stats(c.out.errors))) &&
    withinGate(scheduleStats) &&
    futureRegretStats.n > 0 &&
    futureRegretStats.mean <= GATE.meanRegret;
console.log(
    `\nGate (rerun identical; one-team mean ≤ ${GATE.meanError} and p95 ≤ ${GATE.p95Error} for removing, adding replayed, simulated, lower-tier and schedule events; both regrets mean ≤ ${GATE.meanRegret}): ${passed ? "PASS" : "FAIL"} (${((Date.now() - t0) / 1000).toFixed(0)} s)`
);
if (!passed) process.exit(1);
