import { Worker } from "node:worker_threads";
import type { SeasonSetup } from "../seasonSetup.ts";
import type { OptionSet } from "./options.ts";
import { createPlanShard, type ExactJob, type ExactResult, type PlanRunInfo, type PlanShard, type ScoreBatch } from "./planShard.ts";

export interface PlanPool {
    /** By run. */
    infos: PlanRunInfo[];
    /** Schedule s on `runs[j]` at s × runs.length + j, the same for any worker count. */
    score(schedules: number[][], runs: number[]): Promise<Omit<ScoreBatch, "runs">>;
    exact(jobs: ExactJob[]): Promise<ExactResult[]>;
    close(): Promise<void>;
}

type Response = { kind: "run"; info: PlanRunInfo } | { kind: "done"; result: unknown } | { kind: "error"; error: string };

const call = <T>(worker: Worker, msg: unknown, onRun?: (info: PlanRunInfo) => void) =>
    new Promise<T>((resolve, reject) => {
        const onMessage = (res: Response) => {
            if (res.kind === "run") return onRun?.(res.info);
            worker.off("message", onMessage);
            worker.off("error", reject);
            if (res.kind === "error") reject(new Error(res.error));
            else resolve(res.result as T);
        };
        worker.on("message", onMessage);
        worker.once("error", reject);
        worker.postMessage(msg);
    });

/** Places each batch's per-run values at their run's position in `runs`. */
const merge = (schedules: number, runs: number[], batches: ScoreBatch[]) => {
    const at = new Map(runs.map((r, j) => [r, j]));
    const size = schedules * runs.length;
    const out = { points: new Float32Array(size), smooth: new Float32Array(size), invited: new Uint8Array(size) };
    for (const b of batches) {
        b.runs.forEach((run, j) => {
            const col = at.get(run)!;
            for (let s = 0; s < schedules; s++) {
                out.points[s * runs.length + col] = b.points[s * b.runs.length + j];
                out.smooth[s * runs.length + col] = b.smooth[s * b.runs.length + j];
                out.invited[s * runs.length + col] = b.invited[s * b.runs.length + j];
            }
        });
    }
    return out;
};

/** Plays runs 0 … n − 1 for the focal team; run r goes to worker r mod W, which keeps its scoring inputs. */
export const playPlan = async (
    setup: SeasonSetup,
    set: OptionSet,
    options: { n: number; seed: number; focal: string; exactRuns: number[]; workers: number },
    onProgress?: (done: number) => void
): Promise<PlanPool> => {
    const { n, seed, focal, exactRuns } = options;
    const runs = [...Array(n).keys()];
    const infos: PlanRunInfo[] = new Array(n);
    let done = 0;
    const onRun = (info: PlanRunInfo) => {
        infos[info.run] = info;
        onProgress?.(++done);
    };

    if (options.workers <= 1) {
        const shard: PlanShard = createPlanShard(setup, set, new Set(exactRuns));
        shard.play(runs, onRun);
        return {
            infos,
            score: async (schedules, wanted) => merge(schedules.length, wanted, [shard.score(schedules, wanted)]),
            exact: async (jobs) => shard.exact(jobs),
            close: async () => {},
        };
    }

    const count = Math.min(options.workers, n);
    const workers = Array.from(
        { length: count },
        () =>
            new Worker(new URL("./planWorker.ts", import.meta.url), {
                workerData: { n, seed, focal, exactRuns },
                // Node 22 needs the flag to load TypeScript; later versions strip types by default.
                execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
            })
    );
    const close = async () => {
        await Promise.all(workers.map((w) => w.terminate()));
    };
    try {
        await Promise.all(workers.map((w, k) => call<number>(w, { kind: "play", runs: runs.filter((r) => r % count === k) }, onRun)));
        return {
            infos,
            score: async (schedules, wanted) =>
                merge(
                    schedules.length,
                    wanted,
                    await Promise.all(workers.map((w, k) => call<ScoreBatch>(w, { kind: "score", schedules, runs: wanted.filter((r) => r % count === k) })))
                ),
            exact: async (jobs) => (await Promise.all(workers.map((w, k) => call<ExactResult[]>(w, { kind: "exact", jobs: jobs.filter((j) => j.run % count === k) })))).flat(),
            close,
        };
    } catch (err) {
        await close();
        throw err;
    }
};
