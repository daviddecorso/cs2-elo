import { Worker } from "node:worker_threads";
import type { Standings } from "../../../src/vrs/types.ts";
import type { Matchdata, ValveEvent, ValveMatch } from "../vrs/buildMatchdata.ts";
import { computeStandings } from "../vrs/valveModel.ts";
import { loadWorld, rerun, type ValveWorld } from "../vrs/valveWorld.ts";
import { applyDelta, type ProjectedRoster } from "./vrsProjection.ts";

export interface ProjectionDelta {
    matches: ValveMatch[];
    events: ValveEvent[];
}

export interface Projection {
    rosters: ProjectedRoster[];
    /** The rerun would have relinked rosters, so this came from a full run. */
    inexact: boolean;
}

const toProjected = (standings: Standings): ProjectedRoster[] =>
    standings.rosters
        .filter((r) => r.regionalRank !== null)
        .map(({ rosterKey, teamName, region, regionalRank, points, players }) => ({
            rosterKey,
            teamName,
            region,
            regionalRank,
            points,
            players,
        }));

export const loadProjectionWorld = (base: Matchdata, snapshotDate: string): ValveWorld =>
    loadWorld(base.matches, base.events, snapshotDate, { windowEndsAtPull: true });

/** A full run of Valve's model on the base plus `delta`. */
export const projectFull = (base: Matchdata, delta: ProjectionDelta, snapshotDate: string): ProjectedRoster[] => {
    const input = applyDelta(base, delta);
    return toProjected(computeStandings(input.matches, input.events, snapshotDate, { windowEndsAtPull: true }));
};

export const projectOnce = (world: ValveWorld, base: Matchdata, delta: ProjectionDelta): Projection => {
    const fast = rerun(world, delta);
    if (fast.exact) return { rosters: toProjected(fast.standings), inexact: false };
    return { rosters: projectFull(base, delta, world.snapshotDate), inexact: true };
};

/** A world's rerun mutates its rosters, so parallel runs each need their own worker and world. */
export const projectStandings = async (
    base: Matchdata,
    snapshotDate: string,
    deltas: ProjectionDelta[],
    workerCount: number,
    onProgress?: (done: number) => void
): Promise<{ projected: ProjectedRoster[][]; inexact: number }> => {
    const projected: ProjectedRoster[][] = new Array(deltas.length);
    let inexact = 0;
    if (workerCount <= 1) {
        const world = loadProjectionWorld(base, snapshotDate);
        deltas.forEach((d, i) => {
            const p = projectOnce(world, base, d);
            projected[i] = p.rosters;
            inexact += Number(p.inexact);
            onProgress?.(i + 1);
        });
        return { projected, inexact };
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
                        worker.on("message", (msg: { id: number; projection?: Projection; error?: string }) => {
                            if (msg.error) return reject(new Error(msg.error));
                            projected[msg.id] = msg.projection!.rosters;
                            inexact += Number(msg.projection!.inexact);
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
    return { projected, inexact };
};
