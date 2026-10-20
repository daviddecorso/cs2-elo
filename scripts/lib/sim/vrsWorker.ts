import { parentPort, workerData } from "node:worker_threads";
import type { Matchdata } from "../vrs/buildMatchdata.ts";
import { projectOnce, type ProjectionDelta } from "./vrsPool.ts";

const { base, snapshotDate } = workerData as { base: Matchdata; snapshotDate: string };

parentPort!.on("message", ({ id, delta }: { id: number; delta: ProjectionDelta }) => {
    try {
        parentPort!.postMessage({ id, rosters: projectOnce(base, delta, snapshotDate) });
    } catch (err) {
        parentPort!.postMessage({ id, error: (err as Error).stack ?? String(err) });
    }
});
