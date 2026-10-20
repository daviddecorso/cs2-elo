import fs from "node:fs";
import path from "node:path";
import { EloEngine } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import type { RawRow } from "./lib/elo/normalize.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";
import type { EventConfig } from "./lib/sim/config.ts";
import { knownMatches } from "./lib/sim/locks.ts";
import { Predictor, type SeriesModel } from "./lib/sim/predict.ts";
import { runEvent, simulateEvents, type EventInput } from "./lib/sim/simulate.ts";
import { makeRng } from "./lib/sim/rng.ts";
import { projectOnce } from "./lib/sim/vrsPool.ts";
import { canonicalEventId, canonicalTeamId, latestLineups, prizeTable, simulationDelta } from "./lib/sim/vrsProjection.ts";
import type { Matchdata, Overrides } from "./lib/vrs/buildMatchdata.ts";
import { isMajorTier, isSplitStagePage } from "./lib/vrs/majorStages.ts";

// Scores a finished event's pre-event simulation against what happened, then checks the VRS round trip:
// rebuilding the event from its replayed simulation must reproduce the standings from the real data.

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const config = JSON.parse(fs.readFileSync(path.resolve(option("config", "fixtures/events/cologne-2026.json")), "utf8")) as EventConfig;
const snapshot = option("snapshot", "2026-07-06");
const n = Number(option("n", "10000"));

const rows = JSON.parse(fs.readFileSync("data/raw/matches.json", "utf8")) as RawRow[];
const known = new Map(config.stages.map((s) => [s.id, knownMatches(rows, s.page)]));
const start = Date.parse(`${config.startDate}T00:00:00Z`) / 1000;

const feed = loadFeed();
const engine = new EloEngine(DEFAULT_PARAMS, feed.players);
engine.run(feed.matches.filter((m) => m.t < start));
const predictor = new Predictor(engine, DEFAULT_PARAMS, start, { driftPerDay: 0, horizons: [0], fallbackRating: engine.tierMean(2, start) });
const coinFlip: SeriesModel = { resample: () => {}, setHorizon: () => {}, seriesProbability: () => 0.5 };

const replayInput: EventInput = { config, known, horizon: 0 };
const actual = runEvent(replayInput, coinFlip, makeRng(1));
const unlocked = actual.matches.filter((m) => !m.locked).length;
console.log(`Replay: ${actual.matches.length} matches, ${unlocked} not on Liquipedia, ${actual.diverged.length} Liquipedia matches unreached.`);

const blind: EventInput = { config, known: new Map(), horizon: 0 };
const score = (model: SeriesModel, label: string) => {
    const { summaries } = simulateEvents([blind], model, { n, seed: 1 });
    const s = summaries[0];
    let logLoss = 0;
    let brierWin = 0;
    let brierPlayoffs = 0;
    const last = config.stages.at(-1)!.id;
    for (const team of s.teams) {
        const p = (s.placements.get(team)?.get(actual.placements.get(team)!) ?? 0) / n;
        logLoss -= Math.log(Math.max(p, 0.5 / n));
        const won = actual.placements.get(team) === "1" ? 1 : 0;
        brierWin += ((s.placements.get(team)?.get("1") ?? 0) / n - won) ** 2;
        const reached = actual.reached.get(team)!.includes(last) ? 1 : 0;
        brierPlayoffs += ((s.reached.get(team)?.get(last) ?? 0) / n - reached) ** 2;
    }
    const k = s.teams.length;
    console.log(
        `${label}: placement log loss ${(logLoss / k).toFixed(4)}, champion Brier ${(brierWin / k).toFixed(4)}, playoffs Brier ${(brierPlayoffs / k).toFixed(4)}`
    );
};
score(predictor, "Elo     ");
score(coinFlip, "Coin    ");

const overrides = JSON.parse(fs.readFileSync("data/overrides.json", "utf8")) as Overrides;
const eventId = canonicalEventId(overrides, config.liquipedia);
const teamIdOf = canonicalTeamId(overrides);
const eventTeams = new Set(config.stages.flatMap((s) => s.invited ?? []).map(teamIdOf));
const inEvent = (id: string | number) =>
    String(id) === eventId || (String(id).startsWith(`${eventId}/`) && isSplitStagePage(String(id)));
// Matches on the event outside its configured stages (showmatches) can't be rebuilt, so neither side has them.
const full = JSON.parse(fs.readFileSync("data/matchdata.json", "utf8")) as Matchdata;
const base: Matchdata = {
    ...full,
    matches: full.matches.filter(
        (m) => !inEvent(m.eventId) || (eventTeams.has(String(m.team1Id)) && eventTeams.has(String(m.team2Id)))
    ),
};
const outside = full.matches.length - base.matches.length;
if (outside) console.log(`Left out ${outside} ${eventId} matches between teams outside the configured stages.`);
const placements = JSON.parse(fs.readFileSync("data/raw/placements.json", "utf8")) as RawRow[];
const prizes = prizeTable(placements, config.liquipedia);
if (!prizes) throw new Error(`No prize table for ${config.liquipedia}`);
const tournament = (JSON.parse(fs.readFileSync("data/raw/tournaments.json", "utf8")) as RawRow[]).find(
    (t) => t.pagename === config.liquipedia
);
const stripped: Matchdata = {
    matches: base.matches.filter((m) => !inEvent(m.eventId)),
    events: base.events.filter((e) => !inEvent(e.eventId)),
};
// The lineups the event was played with, so the round trip tests the conversion rather than lineup prediction.
const lineups = latestLineups(stripped, start);
for (const m of [...base.matches].reverse()) {
    if (!inEvent(m.eventId)) continue;
    lineups.set(String(m.team1Id), { name: m.team1Name, players: m.team1Players });
    lineups.set(String(m.team2Id), { name: m.team2Name, players: m.team2Players });
}
const delta = simulationDelta(
    [
        {
            config,
            eventId,
            prizePool: `$${Math.round(Number(tournament?.prizepool) || 0).toLocaleString("en-US")}`,
            prizes,
            major: isMajorTier(tournament?.publishertier),
        },
    ],
    [actual],
    lineups,
    teamIdOf,
    true
);
console.log(`VRS: ${base.matches.length - stripped.matches.length} real matches for ${eventId}, ${delta.matches.length} rebuilt.`);

const real = projectOnce(base, { matches: [], events: [] }, snapshot);
const rebuilt = projectOnce(stripped, delta, snapshot);
const rebuiltByKey = new Map(rebuilt.map((r) => [r.rosterKey, r]));
const top = real.filter((r) => r.regionalRank! <= 50);
const sameRank = top.filter((r) => rebuiltByKey.get(r.rosterKey)?.regionalRank === r.regionalRank).length;
const maxDiff = Math.max(...top.map((r) => Math.abs((rebuiltByKey.get(r.rosterKey)?.points ?? 0) - r.points)));
console.log(`VRS at ${snapshot}: ${sameRank}/${top.length} regional top-50 ranks identical, max points difference ${maxDiff.toFixed(2)}.`);
