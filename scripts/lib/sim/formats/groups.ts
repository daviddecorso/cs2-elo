import { shuffle } from "../rng.ts";
import { loserOf, winnerOf, type Lane, type SimMatch, type StageContext, type StageRunner, type TeamId } from "../types.ts";

/** Explicit draw from config, else seeds snaked across groups (1, 2, 3, 4 / 8, 7, 6, 5 / …). */
const drawGroups = (teams: TeamId[], ctx: StageContext): TeamId[][] => {
    const { groupTeams, groups = 1 } = ctx.config;
    if (groupTeams) return groupTeams;
    const out: TeamId[][] = Array.from({ length: groups }, () => []);
    teams.forEach((t, i) => {
        const lap = Math.floor(i / groups);
        out[lap % 2 === 0 ? i % groups : groups - 1 - (i % groups)].push(t);
    });
    return out;
};

/** Order group winners first, then runners-up, and so on. */
const byPlace = (placed: TeamId[][], perGroup: number): TeamId[] =>
    Array.from({ length: perGroup }, (_, k) => placed.map((g) => g[k])).flat();

/** Four-team GSL groups; the winners' match winner places first, the decider winner second. Exit keys `gsl-3`, `gsl-4`. */
export const gsl: StageRunner = (teams, ctx) => {
    const { bestOf } = ctx.config;
    const matches: SimMatch[] = [];
    const exits = new Map<TeamId, string>();
    const placed: TeamId[][] = [];
    const play = (a: TeamId, b: TeamId, round: number, slot: string, lane: Lane, bo = bestOf.default) => {
        const m = ctx.play(a, b, bo, round, { slot, lane });
        matches.push(m);
        return m;
    };
    for (const [k, group] of drawGroups(teams, ctx).entries()) {
        if (group.length !== 4) throw new Error(`GSL group of ${group.length} teams`);
        const g = `g${k + 1}`;
        const o1 = play(group[0], group[3], 1, `${g}-o1`, "upper");
        const o2 = play(group[1], group[2], 1, `${g}-o2`, "upper");
        const winners = play(winnerOf(o1), winnerOf(o2), 2, `${g}-win`, "upper");
        const elimination = play(loserOf(o1), loserOf(o2), 2, `${g}-elim`, "lower");
        const decider = play(loserOf(winners), winnerOf(elimination), 3, `${g}-dec`, "lower", bestOf.decider ?? bestOf.default);
        exits.set(loserOf(elimination), "gsl-4");
        exits.set(loserOf(decider), "gsl-3");
        placed.push([winnerOf(winners), winnerOf(decider)]);
    }
    return { advancing: byPlace(placed, 2), exits, matches };
};

/** Single round robin per group, ranked by wins then head-to-head among tied teams; remaining ties break at random. Exit keys `pos<n>`. */
export const roundRobin: StageRunner = (teams, ctx) => {
    const groups = drawGroups(teams, ctx);
    const perGroup = ctx.config.advance / groups.length;
    if (!Number.isInteger(perGroup)) throw new Error(`advance ${ctx.config.advance} doesn't split across ${groups.length} groups`);
    const matches: SimMatch[] = [];
    const exits = new Map<TeamId, string>();
    const placed: TeamId[][] = [];

    for (const [k, group] of groups.entries()) {
        const beat = new Map<TeamId, Set<TeamId>>(group.map((t) => [t, new Set()]));
        for (let i = 0; i < group.length; i++) {
            for (let j = i + 1; j < group.length; j++) {
                const m = ctx.play(group[i], group[j], ctx.config.bestOf.default, 1, { slot: `g${k + 1}-${i + 1}v${j + 1}`, lane: "upper" });
                matches.push(m);
                beat.get(winnerOf(m))!.add(loserOf(m));
            }
        }
        const wins = (t: TeamId) => beat.get(t)!.size;
        const order = shuffle(group, ctx.rng).sort((a, b) => {
            if (wins(a) !== wins(b)) return wins(b) - wins(a);
            const tied = group.filter((t) => wins(t) === wins(a));
            const h2h = (t: TeamId) => tied.filter((o) => beat.get(t)!.has(o)).length;
            return h2h(b) - h2h(a);
        });
        order.forEach((t, k) => {
            if (k >= perGroup) exits.set(t, `pos${k + 1}`);
        });
        placed.push(order.slice(0, perGroup));
    }
    return { advancing: byPlace(placed, perGroup), exits, matches };
};
