import path from "node:path";
import type { Roster } from "../src/vrs/types.ts";
import { EVENTS_DIR } from "./lib/sim/config.ts";
import { allocateInvites, loadInviteConfigs, previousMajorSlots } from "./lib/sim/invites.ts";
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
    /** Simulated invite share against Valve's list run through the invite rules; null when the target's slots depend on a simulated Major. */
    invites: { brier: number; logLoss: number; base: number; calibration: Array<{ bin: string; n: number; predicted: number; actual: number }> } | null;
}

const INVITE_BINS = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001];

const score = (name: string, options: Omit<SeasonSetupOptions, "n" | "seed" | "asOf">, actual: Roster[]): Score => {
    const started = Date.now();
    const setup = loadSeasonSetup({ n, seed, asOf, ...options });
    const date = setup.input.checkpoints.at(-1)!.date;
    if (date !== setup.target.snapshotDate) throw new Error(`last checkpoint ${date} isn't the target ${setup.target.snapshotDate}`);
    const { opt, regionOf } = setup.optimizer;
    const slotsFor = (standings: Parameters<typeof regionOf>[0]) =>
        "slots" in opt.previousMajor ? { ...previousMajorSlots(opt.previousMajor, null, regionOf(standings)), 1: opt.stage1 } : null;
    const points = actual.map(() => [] as number[]);
    const invited = actual.map(() => 0);
    let slotsKnown = false;
    for (let r = 0; r < n; r++) {
        const final = runSeason(setup.input, r).standings.at(-1)!;
        const slots = slotsFor(final);
        const invites = slots ? allocateInvites(final.rosters, slots, opt.eligible) : null;
        slotsKnown = slots !== null;
        actual.forEach((a, i) => {
            const same = final.rosters.filter((s) => s.globalRank !== null && shares(a, s)).sort((x, y) => y.points - x.points)[0];
            points[i].push(same?.points ?? 0);
            if (same && invites?.has(same.rosterKey)) invited[i]++;
        });
    }
    const errors: number[] = [];
    let inside = 0;
    actual.forEach((a, i) => {
        const sorted = points[i].sort((x, y) => x - y);
        errors.push(quantile(sorted, 0.5) - a.points);
        if (quantile(sorted, 0.1) <= a.points && a.points <= quantile(sorted, 0.9)) inside++;
    });

    let invites: Score["invites"] = null;
    const realSlots = slotsFor(published);
    if (slotsKnown && realSlots) {
        const real = allocateInvites(published.rosters, realSlots, opt.eligible);
        const pairs = actual.map((a, i) => ({ p: invited[i] / n, y: Number(real.has(a.rosterKey)) }));
        const clamp = (p: number) => Math.min(1 - 1e-3, Math.max(1e-3, p));
        const base = pairs.reduce((s, x) => s + x.y, 0) / pairs.length;
        invites = {
            brier: pairs.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / pairs.length,
            logLoss: -pairs.reduce((s, x) => s + (x.y ? Math.log(clamp(x.p)) : Math.log(1 - clamp(x.p))), 0) / pairs.length,
            base,
            calibration: INVITE_BINS.slice(0, -1).flatMap((lo, b) => {
                const hi = INVITE_BINS[b + 1];
                const inBin = pairs.filter((x) => x.p >= lo && x.p < hi);
                return inBin.length
                    ? [
                          {
                              bin: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`,
                              n: inBin.length,
                              predicted: inBin.reduce((s, x) => s + x.p, 0) / inBin.length,
                              actual: inBin.reduce((s, x) => s + x.y, 0) / inBin.length,
                          },
                      ]
                    : [];
            }),
        };
    }
    const s = {
        name,
        medianError: median(errors),
        medianAbsError: median(errors.map(Math.abs)),
        coverage: inside / actual.length,
        events: setup.input.events.length,
        invites,
    };
    console.log(
        `  ${name.padEnd(9)} ${String(s.events).padStart(3)} events: median error ${s.medianError.toFixed(1)}, median |error| ${s.medianAbsError.toFixed(1)}, inside p10–p90 ${(s.coverage * 100).toFixed(0)}% (${((Date.now() - started) / 1000).toFixed(0)} s)`
    );
    if (invites) {
        const climatology = invites.base * (1 - invites.base);
        console.log(
            `            invites: Brier ${invites.brier.toFixed(3)} (always ${(invites.base * 100).toFixed(0)}%: ${climatology.toFixed(3)}), log loss ${invites.logLoss.toFixed(3)}; by predicted share: ${invites.calibration
                .map((c) => `${c.bin} n ${c.n} predicted ${(c.predicted * 100).toFixed(0)}% invited ${(c.actual * 100).toFixed(0)}%`)
                .join("; ")}`
        );
    }
    return s;
};

const target = loadInviteConfigs(EVENTS_DIR).find((c) => c.snapshotDate > asOf);
if (!target) throw new Error(`No invite snapshot after ${asOf}`);
const shares = (a: Roster, b: Roster) => {
    const nicks = new Set(a.players.map((p) => p.toLowerCase()));
    return b.players.filter((p) => nicks.has(p.toLowerCase())).length >= MIN_SHARED_PLAYERS;
};
const asOfList = readPublishedSnapshot(VALVE_ROOT, publishedSnapshotDates(VALVE_ROOT, ["invitation"]).filter((d) => d <= asOf).at(-1)!).rosters;
const published = readPublishedSnapshot(VALVE_ROOT, target.snapshotDate);
const ranked = published.rosters.filter((r) => r.globalRank !== null && r.globalRank >= RANKS[0] && r.globalRank <= RANKS[1]);
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
