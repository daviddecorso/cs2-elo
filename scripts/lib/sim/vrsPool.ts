import { Worker } from "node:worker_threads";
import type { Matchdata, ValveEvent, ValveMatch } from "../vrs/buildMatchdata.ts";
import { computeStandings } from "../vrs/valveModel.ts";
import { applyDelta, type ProjectedRoster } from "./vrsProjection.ts";

export interface ProjectionDelta {
    matches: ValveMatch[];
    events: ValveEvent[];
}

export const projectOnce = (base: Matchdata, delta: ProjectionDelta, snapshotDate: string): ProjectedRoster[] => {
    const input = applyDelta(base, delta);
    return computeStandings(input.matches, input.events, snapshotDate, { windowEndsAtPull: true })
        .rosters.filter((r) => r.regionalRank !== null)
        .map(({ rosterKey, teamName, region, regionalRank, points, players }) => ({
            rosterKey,
            teamName,
            region,
            regionalRank,
            points,
            players,
        }));
};

/** Valve's model keeps its input in a module-level variable, so parallel runs each need their own worker. */
export const projectStandings = async (
    base: Matchdata,
    snapshotDate: string,
    deltas: ProjectionDelta[],
    workerCount: number,
    onProgress?: (done: number) => void
): Promise<ProjectedRoster[][]> => {
    const results: ProjectedRoster[][] = new Array(deltas.length);
    if (workerCount <= 1) {
        deltas.forEach((d, i) => {
            results[i] = projectOnce(base, d, snapshotDate);
            onProgress?.(i + 1);
        });
        return results;
    }

    let next = 0;
    let done = 0;
    const workers = Array.from(
        { length: Math.min(workerCount, deltas.length) },
        () =>
            new Worker(new URL("./vrsWorker.ts", import.meta.url), {
                workerData: { base, snapshotDate },
                // Node 22 needs the flag to load TypeScript; later versions strip types by default.
                execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
            })
    );
    try {
        await Promise.all(
            workers.map(
                (worker) =>
                    new Promise<void>((resolve, reject) => {
                        const feed = () => {
                            if (next >= deltas.length) return resolve();
                            const id = next++;
                            worker.postMessage({ id, delta: deltas[id] });
                        };
                        worker.on("message", (msg: { id: number; rosters?: ProjectedRoster[]; error?: string }) => {
                            if (msg.error) return reject(new Error(msg.error));
                            results[msg.id] = msg.rosters!;
                            onProgress?.(++done);
                            feed();
                        });
                        worker.on("error", reject);
                        feed();
                    })
            )
        );
    } finally {
        await Promise.all(workers.map((w) => w.terminate()));
    }
    return results;
};
