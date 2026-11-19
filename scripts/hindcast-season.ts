import path from "node:path";
import type { Roster } from "../src/vrs/types.ts";
import { EVENTS_DIR } from "./lib/sim/config.ts";
import { loadInviteConfigs } from "./lib/sim/invites.ts";
import { runSeason } from "./lib/sim/season.ts";
import { loadSeasonSetup, type SeasonSetupOptions } from "./lib/sim/seasonSetup.ts";
import { publishedSnapshotDates, readPublishedSnapshot } from "./lib/vrs/publishedStandings.ts";

/** Season simulation from a past as-of date against Valve's published points at the next Major invite snapshot; see `docs/vrs-simulator.md`, "Hindcast". */

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const asOf = option("as-of", "2026-07-06");
const n = Number(option("n", "100"));
const seed = Number(option("seed", "1"));
const only = option("setup", "");
const VALVE_ROOT = path.resolve("vendor/counter-strike_regional_standings");
const RANKS: [number, number] = [15, 80];
const MIN_SHARED_PLAYERS = 3;
const MEDIAN_ERROR = 30;
const COVERAGE: [number, number] = [0.7, 0.9];

const SETUPS: Record<string, Omit<SeasonSetupOptions, "n" | "seed" | "asOf">> = {
    full: {},
    projected: { unannounced: false },
    listed: { projections: false },
    "lan-only": { learned: false, scope: "lan" },
};

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

interface Score {
    name: string;
    medianError: number;
    medianAbsError: number;
    coverage: number;
    events: number;
}

const score = (name: string, options: Omit<SeasonSetupOptions, "n" | "seed" | "asOf">, actual: Roster[]): Score => {
    const started = Date.now();
    const setup = loadSeasonSetup({ n, seed, asOf, ...options });
    const date = setup.input.checkpoints.at(-1)!.date;
    if (date !== setup.target.snapshotDate) throw new Error(`last checkpoint ${date} isn't the target ${setup.target.snapshotDate}`);
    const points = actual.map(() => [] as number[]);
    for (let r = 0; r < n; r++) {
        const final = runSeason(setup.input, r).standings.at(-1)!;
        actual.forEach((a, i) => {
            const same = final.rosters.filter((s) => s.globalRank !== null && shares(a, s)).sort((x, y) => y.points - x.points)[0];
            points[i].push(same?.points ?? 0);
        });
    }
    const errors: number[] = [];
    let inside = 0;
    actual.forEach((a, i) => {
        const sorted = points[i].sort((x, y) => x - y);
        errors.push(quantile(sorted, 0.5) - a.points);
        if (quantile(sorted, 0.1) <= a.points && a.points <= quantile(sorted, 0.9)) inside++;
    });
    const s = {
        name,
        medianError: median(errors),
        medianAbsError: median(errors.map(Math.abs)),
        coverage: inside / actual.length,
        events: setup.input.events.length,
    };
    console.log(
        `  ${name.padEnd(9)} ${String(s.events).padStart(3)} events: median error ${s.medianError.toFixed(1)}, median |error| ${s.medianAbsError.toFixed(1)}, inside p10–p90 ${(s.coverage * 100).toFixed(0)}% (${((Date.now() - started) / 1000).toFixed(0)} s)`
    );
    return s;
};

const target = loadInviteConfigs(EVENTS_DIR).find((c) => c.snapshotDate > asOf);
if (!target) throw new Error(`No invite snapshot after ${asOf}`);
const shares = (a: Roster, b: Roster) => {
    const nicks = new Set(a.players.map((p) => p.toLowerCase()));
    return b.players.filter((p) => nicks.has(p.toLowerCase())).length >= MIN_SHARED_PLAYERS;
};
const asOfList = readPublishedSnapshot(VALVE_ROOT, publishedSnapshotDates(VALVE_ROOT, ["invitation"]).filter((d) => d <= asOf).at(-1)!).rosters;
const ranked = readPublishedSnapshot(VALVE_ROOT, target.snapshotDate).rosters.filter((r) => r.globalRank !== null && r.globalRank >= RANKS[0] && r.globalRank <= RANKS[1]);
// A roster formed after as-of has no history to project from.
const actual = ranked.filter((r) => asOfList.some((o) => o.globalRank !== null && shares(r, o)));
console.log(
    `Hindcast ${asOf} → ${target.snapshotDate} (${target.name}), ${n} runs, Valve's published points for global ranks ${RANKS[0]}–${RANKS[1]}: ${actual.length} of ${ranked.length} rosters that were ranked at as-of:`
);
const scores = Object.entries(SETUPS)
    .filter(([name]) => !only || name === only)
    .map(([name, options]) => score(name, options, actual));

const full = scores.find((s) => s.name === "full");
const lanOnly = scores.find((s) => s.name === "lan-only");
if (full) {
    const checks = [
        [`median error within ±${MEDIAN_ERROR}`, Math.abs(full.medianError) <= MEDIAN_ERROR],
        [`${COVERAGE[0] * 100}–${COVERAGE[1] * 100}% inside p10–p90`, full.coverage >= COVERAGE[0] && full.coverage <= COVERAGE[1]],
        ...(lanOnly ? [["LAN-only decays more", lanOnly.medianError < full.medianError] as const] : []),
    ] as const;
    const pass = checks.every(([, ok]) => ok);
    console.log(`Gate: ${pass ? "PASS" : "FAIL"} (${checks.map(([label, ok]) => `${label} ${ok ? "✓" : "✗"}`).join(", ")}).`);
    if (!pass) process.exitCode = 1;
}
