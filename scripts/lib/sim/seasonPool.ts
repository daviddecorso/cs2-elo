import { Worker } from "node:worker_threads";
import { emptyOptimizerTally, mergeOptimizerTallies, type OptimizerTally, type RescoreJob, type RescoreResult } from "./optimizer.ts";
import { emptySeasonTally, mergeSeasonTally, type SeasonTally } from "./season.ts";
import type { SeasonSetup } from "./seasonSetup.ts";
import { createShard } from "./seasonShard.ts";

export interface PlayedSeason {
    season: SeasonTally;
    optimizer: OptimizerTally;
    rescore(jobs: RescoreJob[]): Promise<RescoreResult[]>;
    close(): Promise<void>;
}

type Response = { kind: "run"; run: number; season: SeasonTally } | { kind: "done"; result: unknown } | { kind: "error"; error: string };

/** One request at a time per worker; `run` messages stream back before the final `done`. */
const call = <T>(worker: Worker, msg: unknown, onRun?: (run: number, season: SeasonTally) => void) =>
    new Promise<T>((resolve, reject) => {
        const onMessage = (res: Response) => {
            if (res.kind === "run") return onRun?.(res.run, res.season);
            worker.off("message", onMessage);
            worker.off("error", reject);
            if (res.kind === "error") reject(new Error(res.error));
            else resolve(res.result as T);
        };
        worker.on("message", onMessage);
        worker.once("error", reject);
        worker.postMessage(msg);
    });

/** Run r goes to worker r mod W, which keeps its re-score data; tallies merge by run, so the result doesn't depend on W. */
export const playSeason = async (
    setup: SeasonSetup,
    options: { n: number; seed: number; rescoreN: number; impactCheckN: number; workers: number },
    onProgress?: (done: number) => void
): Promise<PlayedSeason> => {
    const { n, seed, rescoreN, impactCheckN } = options;
    const season = emptySeasonTally(setup.input.checkpoints.length);
    const runs = [...Array(n).keys()];
    let done = 0;

    if (options.workers <= 1) {
        const shard = createShard(setup, rescoreN, impactCheckN);
        const optimizer = shard.play(runs, (_run, tally) => {
            mergeSeasonTally(season, tally);
            onProgress?.(++done);
        });
        return { season, optimizer, rescore: async (jobs) => shard.rescore(jobs), close: async () => {} };
    }

    const count = Math.min(options.workers, n);
    const workers = Array.from(
        { length: count },
        () =>
            new Worker(new URL("./seasonWorker.ts", import.meta.url), {
                workerData: { n, seed, rescoreN, impactCheckN },
                // Node 22 needs the flag to load TypeScript; later versions strip types by default.
                execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
            })
    );
    const close = async () => {
        await Promise.all(workers.map((w) => w.terminate()));
    };
    try {
        const pending = new Map<number, SeasonTally>();
        let next = 0;
        const onRun = (run: number, tally: SeasonTally) => {
            pending.set(run, tally);
            while (pending.has(next)) {
                mergeSeasonTally(season, pending.get(next)!);
                pending.delete(next++);
                onProgress?.(++done);
            }
        };
        const shards = await Promise.all(workers.map((w, k) => call<OptimizerTally>(w, { kind: "play", runs: runs.filter((r) => r % count === k) }, onRun)));
        const optimizer = emptyOptimizerTally(setup.optimizer.opt, n);
        for (const s of shards) mergeOptimizerTallies(optimizer, s);
        const rescore = async (jobs: RescoreJob[]) => {
            const parts = await Promise.all(workers.map((w, k) => call<RescoreResult[]>(w, { kind: "rescore", jobs: jobs.filter((j) => j.run % count === k) })));
            return parts.flat();
        };
        return { season, optimizer, rescore, close };
    } catch (err) {
        await close();
        throw err;
    }
};
