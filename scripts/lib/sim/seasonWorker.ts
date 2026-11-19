import { parentPort, workerData } from "node:worker_threads";
import type { RescoreJob } from "./optimizer.ts";
import { loadSeasonSetup } from "./seasonSetup.ts";
import { createShard } from "./seasonShard.ts";

const { n, seed, rescoreN, impactCheckN } = workerData as { n: number; seed: number; rescoreN: number; impactCheckN: number };
const shard = createShard(loadSeasonSetup({ n, seed }), rescoreN, impactCheckN);

type Request = { kind: "play"; runs: number[] } | { kind: "rescore"; jobs: RescoreJob[] };

parentPort!.on("message", (msg: Request) => {
    try {
        if (msg.kind === "play") {
            const optimizer = shard.play(msg.runs, (run, season) => parentPort!.postMessage({ kind: "run", run, season }));
            parentPort!.postMessage({ kind: "done", result: optimizer });
        } else {
            parentPort!.postMessage({ kind: "done", result: shard.rescore(msg.jobs) });
        }
    } catch (err) {
        parentPort!.postMessage({ kind: "error", error: (err as Error).stack ?? String(err) });
    }
});
