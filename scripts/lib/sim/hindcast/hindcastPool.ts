import { Worker } from "node:worker_threads";
import type { CohortScores } from "./cohorts.ts";
import type { CheckpointGain, HindcastInfo, HindcastRequest, HindcastResponse, HindcastWorkerData } from "./hindcastWorker.ts";

export interface HindcastRuns {
    info: HindcastInfo;
    /** [run][checkpoint] */
    runs: CohortScores[][];
    /** [run], empty unless the worker data asked for gains. */
    gains: CheckpointGain[][];
    /** [checkpoint]: the as-of matches alone, decayed. */
    decay: CohortScores[];
    inexact: number;
}

const spawn = (data: HindcastWorkerData) =>
    new Promise<{ worker: Worker; info: HindcastInfo }>((resolve, reject) => {
        const worker = new Worker(new URL("./hindcastWorker.ts", import.meta.url), {
            workerData: data,
            // Node 22 needs the flag to load TypeScript; later versions strip types by default.
            execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
        });
        const onMessage = (res: HindcastResponse) => {
            worker.off("message", onMessage);
            if (res.kind === "ready") resolve({ worker, info: res.info });
            else reject(new Error(res.kind === "error" ? res.error : `unexpected ${res.kind} before ready`));
        };
        worker.on("message", onMessage);
        worker.once("error", reject);
    });

const call = (worker: Worker, msg: HindcastRequest, onRun?: (run: number, scores: CohortScores[], inexact: number, gains: CheckpointGain[]) => void) =>
    new Promise<CohortScores[] | undefined>((resolve, reject) => {
        const onMessage = (res: HindcastResponse) => {
            if (res.kind === "run") return onRun?.(res.run, res.scores, res.inexact, res.gains);
            worker.off("message", onMessage);
            worker.off("error", reject);
            if (res.kind === "error") reject(new Error(res.error));
            else if (res.kind === "done") resolve(res.result);
            else reject(new Error(`unexpected ${res.kind}`));
        };
        worker.on("message", onMessage);
        worker.once("error", reject);
        worker.postMessage(msg);
    });

/** Run r on worker r mod W; workers load one at a time, since a setup's load is its memory peak. */
export const playHindcast = async (data: HindcastWorkerData, n: number, workers: number, onProgress?: (done: number) => void): Promise<HindcastRuns> => {
    const count = Math.max(1, Math.min(workers, n));
    const pool: Array<{ worker: Worker; info: HindcastInfo }> = [];
    try {
        for (let k = 0; k < count; k++) pool.push(await spawn(data));
        const runs: CohortScores[][] = new Array(n);
        const gains: CheckpointGain[][] = new Array(n);
        let inexact = 0;
        let done = 0;
        // A worker handles one request at a time, so the decay reruns go before worker 0's runs.
        const decay = await call(pool[0].worker, { kind: "decay" });
        await Promise.all(
            pool.map(({ worker }, k) =>
                call(worker, { kind: "play", runs: [...Array(n).keys()].filter((r) => r % count === k) }, (run, scores, bad, runGains) => {
                    runs[run] = scores;
                    gains[run] = runGains;
                    inexact += bad;
                    onProgress?.(++done);
                })
            )
        );
        return { info: pool[0].info, runs, gains, decay: decay!, inexact };
    } finally {
        await Promise.all(pool.map(({ worker }) => worker.terminate()));
    }
};
