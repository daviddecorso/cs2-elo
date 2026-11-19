import { parentPort, workerData } from "node:worker_threads";
import { loadSeasonSetup } from "../seasonSetup.ts";
import { focalOptions } from "./options.ts";
import { createPlanShard, type ExactJob } from "./planShard.ts";

const { n, seed, focal, exactRuns } = workerData as { n: number; seed: number; focal: string; exactRuns: number[] };
const setup = loadSeasonSetup({ n, seed, focal });
const shard = createPlanShard(setup, focalOptions(setup), new Set(exactRuns));

type Request = { kind: "play"; runs: number[] } | { kind: "score"; schedules: number[][]; runs: number[] } | { kind: "exact"; jobs: ExactJob[] };

parentPort!.on("message", (msg: Request) => {
    try {
        if (msg.kind === "play") {
            const infos = shard.play(msg.runs, (info) => parentPort!.postMessage({ kind: "run", info }));
            parentPort!.postMessage({ kind: "done", result: infos.length });
        } else if (msg.kind === "score") {
            parentPort!.postMessage({ kind: "done", result: shard.score(msg.schedules, msg.runs) });
        } else {
            parentPort!.postMessage({ kind: "done", result: shard.exact(msg.jobs) });
        }
    } catch (err) {
        parentPort!.postMessage({ kind: "error", error: (err as Error).stack ?? String(err) });
    }
});
