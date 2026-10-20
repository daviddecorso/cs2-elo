import type { StageConfig } from "./config.ts";
import { StageLocks, type KnownMatch } from "./locks.ts";
import { makeRng } from "./rng.ts";
import type { StageContext, TeamId } from "./types.ts";

export const stageConfig = (overrides: Partial<StageConfig>): StageConfig => ({
    id: "s",
    name: "Stage",
    page: "Test/Stage",
    format: "swiss",
    bestOf: { default: 1 },
    advance: 0,
    exits: {},
    ...overrides,
});

/** Played matches lock in; anything else goes to `pickWinner`, by default the earlier seed in `teams`. */
export const testContext = (
    config: StageConfig,
    { known = [], teams = [], pickWinner }: { known?: KnownMatch[]; teams?: TeamId[]; pickWinner?: (a: TeamId, b: TeamId) => 0 | 1 } = {}
): StageContext & { locks: StageLocks; invented: Array<[TeamId, TeamId]> } => {
    const locks = new StageLocks(known);
    const invented: Array<[TeamId, TeamId]> = [];
    const pick = pickWinner ?? ((a, b) => (teams.indexOf(a) <= teams.indexOf(b) ? 0 : 1));
    return {
        config,
        rng: makeRng(1),
        locks,
        invented,
        knownPairings: (round) => locks.pairings(round),
        play: (a, b, bestOf, round, place) => {
            const k = locks.take(a, b);
            if (k) return { stage: config.id, round, ...place, teams: [a, b], bestOf, winner: k.teams[k.winner!] === a ? 0 : 1, locked: true, t: k.t };
            invented.push([a, b]);
            return { stage: config.id, round, ...place, teams: [a, b], bestOf, winner: pick(a, b), locked: false, t: null };
        },
    };
};
