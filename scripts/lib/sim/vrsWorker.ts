import { parentPort, workerData } from "node:worker_threads";
import type { Matchdata } from "../vrs/buildMatchdata.ts";
import { loadProjectionWorld, projectOnce, type ProjectionDelta } from "./vrsPool.ts";

const { base, snapshotDate } = workerData as { base: Matchdata; snapshotDate: string };
const world = loadProjectionWorld(base, snapshotDate);

parentPort!.on("message", ({ id, delta }: { id: number; delta: ProjectionDelta }) => {
    try {
        parentPort!.postMessage({ id, projection: projectOnce(world, base, delta) });
    } catch (err) {
        parentPort!.postMessage({ id, error: (err as Error).stack ?? String(err) });
    }
});
