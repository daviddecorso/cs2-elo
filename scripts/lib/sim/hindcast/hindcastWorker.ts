import { parentPort, workerData } from "node:worker_threads";
import { loadWorld, rerun } from "../../vrs/valveWorld.ts";
import { runSeason } from "../season.ts";
import { loadSeasonSetup, type SeasonSetupOptions } from "../seasonSetup.ts";
import { applyDelta } from "../vrsProjection.ts";
import { scoreCohort, type CohortScores } from "./cohorts.ts";
import { cohortGains, type CohortGain } from "./gains.ts";

export interface HindcastWorkerData {
    setup: SeasonSetupOptions;
    cohort: Array<{ players: string[] }>;
    /** Also report what each event a cohort roster played between checkpoints added to its points (`cohortGains`). */
    gains?: boolean;
}

export type CheckpointGain = CohortGain & { c: number };

export interface HindcastInfo {
    asOf: string;
    today: string;
    checkpoints: string[];
    events: number;
}

/** One request at a time: `play` streams a `run` message per run before `done`; `decay` reruns every checkpoint with no new matches. */
export type HindcastRequest = { kind: "play"; runs: number[] } | { kind: "decay" };
export type HindcastResponse =
    | { kind: "ready"; info: HindcastInfo }
    | { kind: "run"; run: number; scores: CohortScores[]; inexact: number; gains: CheckpointGain[] }
    | { kind: "done"; result?: CohortScores[] }
    | { kind: "error"; error: string };

const { setup: options, cohort, gains: wantsGains } = workerData as HindcastWorkerData;
const post = (msg: HindcastResponse) => parentPort!.postMessage(msg);
const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

try {
    const setup = loadSeasonSetup(options);
    const { input } = setup;
    let gains: CheckpointGain[] = [];
    if (wantsGains) {
        const bounds = [setup.asOf, ...input.checkpoints.map((c) => c.date)].map(dayStart);
        input.onCheckpoint = (_run, c, fast, standings, soFar) => {
            // A relinked rerun has no state, so a world loaded from the run's whole input stands in.
            const state =
                fast?.state ??
                (() => {
                    const full = applyDelta(input.base, soFar.delta);
                    return rerun(loadWorld(full.matches, full.events, input.checkpoints[c].date, { windowEndsAtPull: true })).state;
                })();
            for (const g of cohortGains(state, standings, cohort, bounds[c], bounds[c + 1])) gains.push({ ...g, c });
        };
    }
    post({
        kind: "ready",
        info: {
            asOf: setup.asOf,
            today: setup.today.snapshotDate,
            checkpoints: input.checkpoints.map((c) => c.date),
            events: input.events.length,
        },
    });
    parentPort!.on("message", (msg: HindcastRequest) => {
        try {
            if (msg.kind === "decay") {
                post({ kind: "done", result: input.checkpoints.map((c) => scoreCohort(cohort, rerun(c.world, {}).standings.rosters)) });
                return;
            }
            for (const run of msg.runs) {
                gains = [];
                const result = runSeason(input, run);
                post({ kind: "run", run, scores: result.standings.map((s) => scoreCohort(cohort, s.rosters)), inexact: result.inexact.length, gains });
            }
            post({ kind: "done" });
        } catch (err) {
            post({ kind: "error", error: (err as Error).stack ?? String(err) });
        }
    });
} catch (err) {
    post({ kind: "error", error: (err as Error).stack ?? String(err) });
}
