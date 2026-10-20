import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventIndexEntry, EventOdds, InviteIndexEntry, InviteOdds, InviteOddsRoster } from "../src/sim/types.ts";
import { getRosterKey, type Region } from "../src/vrs/types.ts";
import { EloEngine } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import type { RawRow } from "./lib/elo/normalize.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";
import { readUpcoming } from "./lib/liquipedia/upcoming.ts";
import { stageBrackets } from "./lib/sim/bracketView.ts";
import { EVENTS_DIR, loadEventConfigs, type EventConfig } from "./lib/sim/config.ts";
import {
    allocateInvites,
    loadInviteConfig,
    loadInviteConfigs,
    makeIntactCheck,
    REGIONS,
    type InviteConfig,
} from "./lib/sim/invites.ts";
import { knownMatches } from "./lib/sim/locks.ts";
import { Predictor } from "./lib/sim/predict.ts";
import { simulateEvents, type EventInput, type EventSummary } from "./lib/sim/simulate.ts";
import { projectStandings } from "./lib/sim/vrsPool.ts";
import {
    canonicalEventId,
    canonicalTeamId,
    latestLineups,
    missingPrizeLabels,
    preferSquads,
    prizeTable,
    simulationDelta,
    type ProjectedRoster,
    type ProjectionEvent,
} from "./lib/sim/vrsProjection.ts";
import type { Matchdata, Overrides } from "./lib/vrs/buildMatchdata.ts";
import { isMajorTier } from "./lib/vrs/majorStages.ts";
import { saveJson } from "./lib/writeJson.ts";

/** Elo² per day, from `npm run fit-sim-noise` on 2025-01 to 2026-10 series. */
const DRIFT_PER_DAY = 58;
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CONFIG_DIR = path.resolve(option("config-dir", EVENTS_DIR));
const INVITE_FILE = option("invites", "");
const OUT_DIR = path.resolve(option("out", "public/data/sim"));
const n = Number(option("n", "10000"));
const vrsN = Number(option("vrs-n", "1000"));
const seed = Number(option("seed", "1"));
const workers = Number(option("workers", String(Math.max(1, Math.min(os.availableParallelism() - 1, 8)))));
const only = option("events", "").split(",").filter(Boolean);
const skipVrs = args.includes("--no-vrs");

const readJson = <T>(file: string, fallback: T): T =>
    fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback;
const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const placementOrder = (a: string, b: string) => Number(/^\d+/.exec(a)?.[0] ?? 99) - Number(/^\d+/.exec(b)?.[0] ?? 99);

// --- Inputs

const feed = loadFeed();
const engine = new EloEngine(DEFAULT_PARAMS, feed.players);
engine.run(feed.matches);
const lastT = feed.matches.at(-1)!.t;
const asOf = dayOf(lastT);

const upcoming = readUpcoming();
const finishedRows = readJson<RawRow[]>("data/raw/matches.json", []);
const matchRows = [...finishedRows, ...(upcoming?.matches ?? [])];
const placementRows = [...readJson<RawRow[]>("data/raw/placements.json", []), ...(upcoming?.placements ?? [])];
const tournamentRows = [...readJson<RawRow[]>("data/raw/tournaments.json", []), ...(upcoming?.tournaments ?? [])];
const overrides = readJson<Overrides>("data/overrides.json", {});

const selected = loadEventConfigs(CONFIG_DIR).filter((c) => only.length === 0 || only.includes(c.slug));
// A stage with an empty `invited` list is waiting on Liquipedia's participant list.
const isPending = (c: EventConfig) => c.stages.some((s) => s.invited !== undefined && s.invited.length === 0);
const pending = selected.filter(isPending);
const configs = selected.filter((c) => !isPending(c));
for (const c of pending) console.log(`${c.slug}: participants not announced yet; skipped.`);
// Once a snapshot has passed, Valve's published standings replace the projection.
const inviteConfigs = (INVITE_FILE ? [loadInviteConfig(INVITE_FILE)] : loadInviteConfigs(CONFIG_DIR)).filter(
    (c) => c.snapshotDate >= asOf
);
if (configs.length === 0) {
    console.log("No event with announced participants; nothing to simulate.");
    process.exit(0);
}

const inputs: EventInput[] = configs.map((config) => ({
    config,
    known: new Map(config.stages.map((s) => [s.id, knownMatches(matchRows, s.page, s.sections)])),
    horizon: Math.max(0, daysBetween(asOf, config.startDate)),
}));

const predictor = new Predictor(engine, DEFAULT_PARAMS, lastT, {
    driftPerDay: DRIFT_PER_DAY,
    horizons: inputs.map((i) => i.horizon),
    fallbackRating: engine.tierMean(2, lastT),
});

// --- Event simulation

const keep = inviteConfigs.length && !skipVrs ? vrsN : 0;
console.log(`Simulating ${configs.map((c) => c.slug).join(", ")} ${n} times (ratings as of ${asOf})...`);
const { summaries, outcomes } = simulateEvents(inputs, predictor, { n, seed, keep });
if (predictor.unrated.size) console.warn(`No Elo lineage, using the tier 2 mean: ${[...predictor.unrated].join(", ")}`);

const prizesByEvent = new Map(configs.map((c) => [c.slug, prizeTable(placementRows, c.liquipedia)]));

const eventOdds = (config: EventConfig, summary: EventSummary, input: EventInput): EventOdds => {
    const labels = [...new Set(config.stages.flatMap((s) => Object.values(s.exits)))].sort(placementOrder);
    const advancedInto = config.stages.filter((s) => s.from);
    const prizes = prizesByEvent.get(config.slug);
    const share = (counts: Map<string, number> | undefined, keys: string[]) =>
        Object.fromEntries(keys.map((k) => [k, (counts?.get(k) ?? 0) / summary.n]));
    return {
        slug: config.slug,
        name: config.name,
        liquipedia: config.liquipedia,
        startDate: config.startDate,
        endDate: config.endDate,
        generatedAt: new Date().toISOString(),
        asOf,
        n: summary.n,
        stages: advancedInto.map(({ id, name }) => ({ id, name })),
        placements: labels,
        prizes: prizes ? Object.fromEntries(labels.map((l) => [l, prizes.get(l) ?? 0])) : null,
        playedMatches: [...input.known.values()].flat().filter((k) => k.winner !== null).length,
        teams: summary.teams
            .map((team) => {
                const lineage = engine.teamLineageOf(team);
                return {
                    team,
                    rating: lineage ? Math.round(lineage.rating * 10) / 10 : null,
                    reach: share(summary.reached.get(team), advancedInto.map((s) => s.id)),
                    placements: share(summary.placements.get(team), labels),
                };
            })
            .sort((a, b) => {
                for (const l of labels) if (a.placements[l] !== b.placements[l]) return b.placements[l] - a.placements[l];
                return 0;
            }),
        bracket: stageBrackets(config, summary),
    };
};

fs.mkdirSync(path.join(OUT_DIR, "events"), { recursive: true });
configs.forEach((config, i) => {
    const s = summaries[i];
    if (s.divergedRuns) console.warn(`${config.slug}: ${s.divergedRuns} of ${s.n} runs missed a played match; check the stage config.`);
    saveJson(path.join(OUT_DIR, "events", `${config.slug}.json`), JSON.stringify(eventOdds(config, s, inputs[i])), `${s.n} runs`);
});
const index: EventIndexEntry[] = loadEventConfigs(CONFIG_DIR)
    .filter((c) => fs.existsSync(path.join(OUT_DIR, "events", `${c.slug}.json`)))
    .map(({ slug, name, startDate, endDate }) => ({ slug, name, startDate, endDate }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
saveJson(path.join(OUT_DIR, "events", "index.json"), JSON.stringify(index), `${index.length} events`);

// --- VRS projection and invites

const storedSquads = readJson<{ rows: Array<{ pagename: string; link: string; objectname?: string }> }>("data/raw/squads.json", {
    rows: [],
}).rows;
// Without `objectname` the store kept one player per team, which would fail every roster's intact check.
const squadRows = storedSquads.every((r) => r.objectname) ? storedSquads : [];
if (squadRows.length < storedSquads.length) console.warn("data/raw/squads.json is incomplete; ignoring squads until the next fetch-liquipedia.");

const loadSquads = (): Map<string, Set<string>> => {
    const squads = new Map<string, Set<string>>();
    for (const { pagename, link } of squadRows) {
        const team = pagename.replace(/_/g, " ");
        if (!squads.has(team)) squads.set(team, new Set());
        squads.get(team)!.add(link.toLowerCase());
        const nick = feed.players[link]?.nick ?? feed.players[link.replace(/_/g, " ")]?.nick;
        if (nick) squads.get(team)!.add(nick.toLowerCase());
    }
    return squads;
};

const roundSlots = (slots: Record<Region, number>) =>
    Object.fromEntries(REGIONS.map((r) => [r, Math.round(slots[r] * 100) / 100])) as Record<Region, number>;

const percentile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** Null while the previous Major can't be simulated, since its results set the Stage 3 and Stage 2 slots. */
const projectInvites = async (invite: InviteConfig): Promise<InviteOdds | null> => {
    const base = readJson<Matchdata | null>("data/matchdata.json", null);
    if (!base) throw new Error("data/matchdata.json is missing; run npm run build-matchdata first");
    const teamIdOf = canonicalTeamId(overrides);
    const lineups = latestLineups(base);
    const squadsByTeamId = new Map<string, string[]>();
    for (const { pagename, link } of squadRows) {
        const id = teamIdOf(pagename.replace(/_/g, " "));
        squadsByTeamId.set(id, [...(squadsByTeamId.get(id) ?? []), link]);
    }
    console.log(`Using the current Liquipedia squad for ${preferSquads(base, lineups, squadsByTeamId)} teams.`);

    const eventStatus: InviteOdds["events"] = [];
    const included: Array<{ index: number; event: ProjectionEvent }> = [];
    configs.forEach((config, index) => {
        const entry = { slug: config.slug, name: config.name, liquipedia: config.liquipedia };
        const prizes = prizesByEvent.get(config.slug);
        const missingLineups = summaries[index].teams.filter((t) => !lineups.has(teamIdOf(t)));
        let reason: string | undefined;
        if (config.endDate > invite.snapshotDate) reason = "Ends after the snapshot";
        else if (!prizes) reason = "No prize distribution on Liquipedia yet";
        else if (missingPrizeLabels(config, prizes).length)
            reason = `Prize table has no row for ${missingPrizeLabels(config, prizes).join(", ")}`;
        else if (missingLineups.length) reason = `No match history for ${missingLineups.join(", ")}`;
        eventStatus.push({ ...entry, included: !reason, ...(reason ? { reason } : {}) });
        if (reason) return;
        const tournament = tournamentRows.find((t) => t.pagename === config.liquipedia);
        included.push({
            index,
            event: {
                config,
                eventId: canonicalEventId(overrides, config.liquipedia),
                prizePool: `$${Math.round(Number(tournament?.prizepool) || [...prizes!.values()].reduce((a, b) => a + b, 0)).toLocaleString("en-US")}`,
                prizes: prizes!,
                major: isMajorTier(tournament?.publishertier),
            },
        });
    });

    for (const c of pending) {
        eventStatus.push({ slug: c.slug, name: c.name, liquipedia: c.liquipedia, included: false, reason: "Participants not announced yet" });
    }
    const previous = invite.previousMajor;
    const majorIndex = configs.findIndex((c) => c.slug === previous.event);
    if (!("slots" in previous) && majorIndex < 0) return null;

    const deltas = outcomes.map((run) =>
        simulationDelta(
            included.map((i) => i.event),
            included.map((i) => run[i.index]),
            lineups,
            teamIdOf
        )
    );
    console.log(`Projecting VRS at ${invite.snapshotDate} for ${deltas.length} simulations on ${workers} workers...`);
    const started = Date.now();
    const projected = await projectStandings(base, invite.snapshotDate, deltas, workers, (done) => {
        if (done % 100 === 0) console.log(`  ${done}/${deltas.length} (${Math.round((Date.now() - started) / 1000)}s)`);
    });

    const rosterOfTeam = (team: string) => {
        const lineup = lineups.get(teamIdOf(team));
        return lineup ? getRosterKey(lineup.players.map((p) => p.nick)) : null;
    };
    const intactCheck = makeIntactCheck(loadSquads(), invite.minRetained);
    const stats = new Map<string, { roster: ProjectedRoster; stages: number[]; ranks: number[]; regions: Map<Region, number> }>();
    const zero = (): Record<Region, number> => ({ Europe: 0, Americas: 0, Asia: 0 });
    const slotTotals = { stage3: zero(), stage2: zero() };

    const previousMajorSlots = (s: number, rosters: ProjectedRoster[]) => {
        if ("slots" in previous) return { 3: previous.slots.stage3, 2: previous.slots.stage2 };
        const byKey = new Map(rosters.map((r) => [r.rosterKey, r]));
        const slots = { 3: zero(), 2: zero() };
        for (const [team, stages] of outcomes[s][majorIndex].reached) {
            const stage = stages.includes(previous.stage3From) ? 3 : stages.includes(previous.stage2From) ? 2 : null;
            if (!stage) continue;
            const key = rosterOfTeam(team);
            const region = (key && byKey.get(key)?.region) || REGIONS[engine.teamLineageOf(team)?.region ?? 0];
            slots[stage][region]++;
        }
        return slots;
    };

    projected.forEach((rosters, s) => {
        const slots = { ...previousMajorSlots(s, rosters), 1: invite.stage1 };
        for (const r of REGIONS) {
            slotTotals.stage3[r] += slots[3][r] / projected.length;
            slotTotals.stage2[r] += slots[2][r] / projected.length;
        }

        const invites = allocateInvites(rosters, slots, (r) => intactCheck(r) !== false);
        for (const r of rosters) {
            if (!stats.has(r.rosterKey)) stats.set(r.rosterKey, { roster: r, stages: [0, 0, 0, 0], ranks: [], regions: new Map() });
            const st = stats.get(r.rosterKey)!;
            st.stages[invites.get(r.rosterKey) ?? 0]++;
            st.ranks.push(r.regionalRank!);
            st.regions.set(r.region, (st.regions.get(r.region) ?? 0) + 1);
        }
    });

    const total = projected.length;
    const rosters: InviteOddsRoster[] = [...stats.values()]
        .map(({ roster, stages, ranks, regions }) => {
            // A roster unranked in some runs counts as a miss there.
            const missing = total - ranks.length;
            const sorted = [...ranks, ...Array<number>(missing).fill(999)].sort((a, b) => a - b);
            return {
                rosterKey: roster.rosterKey,
                teamName: roster.teamName,
                region: [...regions].sort((a, b) => b[1] - a[1])[0][0],
                players: roster.players,
                stage3: stages[3] / total,
                stage2: stages[2] / total,
                stage1: stages[1] / total,
                miss: (stages[0] + missing) / total,
                rank: { p10: percentile(sorted, 0.1), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) },
                intact: intactCheck(roster),
            };
        })
        .filter((r) => r.miss < 1 || r.rank.p50 <= 40)
        .sort((a, b) => a.rank.p50 - b.rank.p50 || b.stage3 + b.stage2 + b.stage1 - (a.stage3 + a.stage2 + a.stage1));

    return {
        slug: invite.slug,
        name: invite.name,
        liquipedia: invite.liquipedia,
        snapshotDate: invite.snapshotDate,
        snapshotEstimated: invite.snapshotEstimated,
        generatedAt: new Date().toISOString(),
        asOf,
        n: total,
        events: eventStatus,
        slots: {
            stage3: roundSlots(slotTotals.stage3),
            stage2: roundSlots(slotTotals.stage2),
            stage1: invite.stage1,
            source: invite.source,
            verified: invite.verified,
        },
        rosters,
    };
};

const writeInvites = async () => {
    const dir = path.join(OUT_DIR, "invites");
    const index: InviteIndexEntry[] = [];
    for (const invite of inviteConfigs) {
        const odds = await projectInvites(invite);
        if (!odds) {
            console.log(`${invite.slug} invites skipped: ${invite.previousMajor.event} can't be simulated yet.`);
            continue;
        }
        saveJson(path.join(dir, `${odds.slug}.json`), JSON.stringify(odds), `${odds.rosters.length} rosters, ${odds.n} runs`);
        index.push({ slug: odds.slug, name: odds.name, snapshotDate: odds.snapshotDate });
    }
    saveJson(path.join(dir, "index.json"), JSON.stringify(index), `${index.length} invite projections`);
};

if (inviteConfigs.length && !skipVrs) {
    writeInvites().catch((err) => {
        console.error("Invite projection failed:", err);
        process.exit(1);
    });
}
