import { parentPort, workerData } from "node:worker_threads";
import { loadSeasonSetup } from "../seasonSetup.ts";
import { focalOptions } from "./options.ts";
import { createPlanShard, type ExactJob } from "./planShard.ts";

const { n, seed, focal, exactRuns } = workerData as { n: number; seed: number; focal: string[]; exactRuns: number[] };
const setup = loadSeasonSetup({ n, seed, focal });
const shard = createPlanShard(setup, focalOptions(setup), new Set(exactRuns));

type Request = { kind: "play"; runs: number[] } | { kind: "score"; k: number; schedules: number[][]; runs: number[] } | { kind: "exact"; k: number; jobs: ExactJob[] };

parentPort!.on("message", (msg: Request) => {
    try {
        if (msg.kind === "play") {
            const played = shard.play(msg.runs, (infos) => parentPort!.postMessage({ kind: "run", infos }));
            parentPort!.postMessage({ kind: "done", result: played });
        } else if (msg.kind === "score") {
            parentPort!.postMessage({ kind: "done", result: shard.score(msg.k, msg.schedules, msg.runs) });
        } else {
            parentPort!.postMessage({ kind: "done", result: shard.exact(msg.k, msg.jobs) });
        }
    } catch (err) {
        parentPort!.postMessage({ kind: "error", error: (err as Error).stack ?? String(err) });
    }
});
