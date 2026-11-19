import { scoreTeam, withoutEvents, type FrozenWorld } from "../vrs/oneTeam.ts";
import type { TeamId } from "./types.ts";

/** Index of the first checkpoint after the event ends, or null when it ends after the last. */
export const impactCheckpoint = (checkpointDates: string[], endDate: string): number | null => {
    const i = checkpointDates.findIndex((d) => d > endDate);
    return i < 0 ? null : i;
};

export interface ImpactSample {
    team: TeamId;
    placement: string;
    /** Points with the event minus points without it. */
    delta: number;
    /** The part of `delta` from the roster's starting (seed) rating. */
    start: number;
}

/** Each team's points change from removing the event, other rosters frozen; `roster` indexes `frozen.rosters`. */
export const eventImpact = (
    frozen: FrozenWorld,
    eventIds: ReadonlySet<string>,
    teams: Array<{ team: TeamId; roster: number; placement: string }>
): ImpactSample[] =>
    teams.map(({ team, roster, placement }) => {
        const own = frozen.rosters[roster];
        const without = scoreTeam(frozen, withoutEvents(frozen.ledgers[roster], eventIds), { rank: false });
        return { team, placement, delta: own.points - without.points, start: own.seedRating - without.seedRating };
    });

export interface ImpactCell {
    count: number;
    sumDelta: number;
    sumStart: number;
}

/** Event slug → team → placement → sums over runs. */
export type ImpactTally = Map<string, Map<TeamId, Map<string, ImpactCell>>>;

const addCell = (tally: ImpactTally, slug: string, team: TeamId, placement: string, add: ImpactCell) => {
    let byTeam = tally.get(slug);
    if (!byTeam) tally.set(slug, (byTeam = new Map()));
    let byPlacement = byTeam.get(team);
    if (!byPlacement) byTeam.set(team, (byPlacement = new Map()));
    const cell = byPlacement.get(placement) ?? { count: 0, sumDelta: 0, sumStart: 0 };
    byPlacement.set(placement, { count: cell.count + add.count, sumDelta: cell.sumDelta + add.sumDelta, sumStart: cell.sumStart + add.sumStart });
};

export const tallyImpact = (tally: ImpactTally, slug: string, samples: ImpactSample[]) => {
    for (const s of samples) addCell(tally, slug, s.team, s.placement, { count: 1, sumDelta: s.delta, sumStart: s.start });
};

/** Appends `from` to `into`; merging one-run tallies in run order matches tallying in sequence. */
export const mergeImpact = (into: ImpactTally, from: ImpactTally) => {
    for (const [slug, byTeam] of from) {
        for (const [team, byPlacement] of byTeam) {
            for (const [placement, cell] of byPlacement) addCell(into, slug, team, placement, cell);
        }
    }
};
