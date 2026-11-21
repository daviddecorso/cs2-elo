import {
    newSwissRecords,
    pairSwissRound,
    recordSwissResult,
    swissActive,
    swissAdvancingOrder,
} from "../../../../src/sim/swissPairing.ts";
import { winnerOf, type SimMatch, type StageRunner, type TeamId } from "../types.ts";

/** Major Swiss per Valve's rulebook; pools sort by Buchholz difficulty, then initial seed. Exit keys are the final record, e.g. `2-3`. */
export const swiss: StageRunner = (teams, ctx) => {
    const { config } = ctx;
    const needWins = config.wins ?? 3;
    const maxLosses = config.losses ?? 3;
    const records = newSwissRecords(teams);
    const matches: SimMatch[] = [];

    for (let round = 1; swissActive(records, needWins, maxLosses).length > 0; round++) {
        for (const [a, b] of pairSwissRound(records, round, ctx.knownPairings(round), needWins, maxLosses)) {
            const decider = a.wins === needWins - 1 || a.losses === maxLosses - 1;
            const bestOf = decider ? (config.bestOf.decider ?? config.bestOf.default) : config.bestOf.default;
            const m = ctx.play(a.team, b.team, bestOf, round, { slot: `r${round}:${a.wins}-${a.losses}`, lane: "upper" });
            matches.push(m);
            const [w, l] = winnerOf(m) === a.team ? [a, b] : [b, a];
            recordSwissResult(w, l);
        }
    }

    const exits = new Map<TeamId, string>();
    for (const r of records) if (r.losses >= maxLosses) exits.set(r.team, `${r.wins}-${r.losses}`);
    return { advancing: swissAdvancingOrder(records, needWins), exits, matches };
};
