import { loserOf, winnerOf, type Lane, type SimMatch, type StageContext, type StageRunner, type TeamId } from "../types.ts";

/** Standard bracket order of 0-based seeds, so adjacent pairs meet in round 1 (1 v 8, 4 v 5, 2 v 7, 3 v 6). */
export const bracketOrder = (n: number): number[] => {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`Bracket of ${n} teams; expected a power of two`);
    let order = [0];
    while (order.length < n) {
        const size = order.length * 2;
        order = order.flatMap((s) => [s, size - 1 - s]);
    }
    return order;
};

/** Elimination rounds with more matches than this play `bestOf.largeRound`; HLTV, and so Valve, skips such rounds when they're Bo1. */
export const LARGE_ROUND = 8;

const nextPowerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(n, 1)));

/** Round-1 slots: Liquipedia's draw once it's fully known, otherwise standard seeding with byes (null) for the top seeds. */
const firstRound = (teams: TeamId[], ctx: StageContext): Array<TeamId | null> => {
    const known = ctx.knownPairings(1).flat();
    if (known.length === teams.length && teams.every((t) => known.includes(t))) return known;
    return bracketOrder(nextPowerOfTwo(teams.length)).map((i) => teams[i] ?? null);
};

/** Slots are `<prefix>-m<i>`, 1-based in bracket order; a team drawn against a bye advances without a match. */
const playRound = (alive: Array<TeamId | null>, ctx: StageContext, bestOf: number, round: number, matches: SimMatch[], prefix: string, lane: Lane) => {
    const winners: TeamId[] = [];
    const losers: TeamId[] = [];
    for (let i = 0; i < alive.length; i += 2) {
        const [a, b] = [alive[i], alive[i + 1]];
        if (a === null || b === null) {
            const through = a ?? b;
            if (through !== null) winners.push(through);
            continue;
        }
        const m = ctx.play(a, b, bestOf, round, { slot: `${prefix}-m${i / 2 + 1}`, lane });
        matches.push(m);
        winners.push(winnerOf(m));
        losers.push(loserOf(m));
    }
    return { winners, losers };
};

const realPairs = (alive: Array<TeamId | null>) => {
    let n = 0;
    for (let i = 0; i < alive.length; i += 2) if (alive[i] !== null && alive[i + 1] !== null) n++;
    return n;
};

/** Exit keys: `r<round>` for the round a team lost in, `champion` for the winner. Stops early when `advance` teams remain. */
export const singleElim: StageRunner = (teams, ctx) => {
    const { bestOf } = ctx.config;
    const target = Math.max(ctx.config.advance, 1);
    const matches: SimMatch[] = [];
    const exits = new Map<TeamId, string>();
    let alive: Array<TeamId | null> = firstRound(teams, ctx);
    for (let round = 1; alive.filter((t) => t !== null).length > target; round++) {
        const large = realPairs(alive) > LARGE_ROUND ? bestOf.largeRound : undefined;
        const bo = alive.length === 2 ? (bestOf.final ?? bestOf.default) : (large ?? bestOf.default);
        const { winners, losers } = playRound(alive, ctx, bo, round, matches, `r${round}`, "upper");
        for (const t of losers) exits.set(t, `r${round}`);
        alive = winners;
    }
    const remaining = alive.filter((t): t is TeamId => t !== null);
    if (ctx.config.advance === 0) exits.set(remaining[0], "champion");
    return { advancing: ctx.config.advance ? remaining : [], exits, matches };
};

/** Exit keys `lb-r<n>`, `gf`, `champion`; with `advance: 2` there's no grand final and both bracket winners advance, upper first. */
export const doubleElim: StageRunner = (teams, ctx) => {
    const { bestOf, advance } = ctx.config;
    if (advance !== 0 && advance !== 2) throw new Error(`Double elimination supports advance 0 or 2, not ${advance}`);
    const matches: SimMatch[] = [];
    const exits = new Map<TeamId, string>();
    if (teams.length !== nextPowerOfTwo(teams.length)) throw new Error(`Double elimination of ${teams.length} teams; expected a power of two`);
    let upper = firstRound(teams, ctx) as TeamId[];
    let lower: TeamId[] = [];
    let lbRound = 0;
    // Lower rounds are numbered after the upper ones so locked results in either bracket can't collide.
    const lbRoundId = () => 100 + lbRound;

    for (let ubRound = 1; upper.length > 1; ubRound++) {
        const { winners, losers } = playRound(upper, ctx, bestOf.default, ubRound, matches, `ub-r${ubRound}`, "upper");
        upper = winners;
        lbRound++;
        if (ubRound === 1) {
            const r = playRound(losers, ctx, bestOf.default, lbRoundId(), matches, `lb-r${lbRound}`, "lower");
            for (const t of r.losers) exits.set(t, `lb-r${lbRound}`);
            lower = r.winners;
        } else {
            // Alternate the drop order so teams don't meet the opponent they just beat.
            const drops = ubRound % 2 === 0 ? [...losers].reverse() : losers;
            if (drops.length !== lower.length) throw new Error(`${lower.length} lower-bracket teams for ${drops.length} drops`);
            const r = playRound(lower.flatMap((t, i) => [t, drops[i]]), ctx, bestOf.default, lbRoundId(), matches, `lb-r${lbRound}`, "lower");
            for (const t of r.losers) exits.set(t, `lb-r${lbRound}`);
            lower = r.winners;
        }
        if (upper.length > 1 && lower.length > upper.length / 2) {
            lbRound++;
            const r = playRound(lower, ctx, bestOf.default, lbRoundId(), matches, `lb-r${lbRound}`, "lower");
            for (const t of r.losers) exits.set(t, `lb-r${lbRound}`);
            lower = r.winners;
        }
    }

    if (advance === 2) return { advancing: [upper[0], lower[0]], exits, matches };
    const gf = ctx.play(upper[0], lower[0], bestOf.final ?? bestOf.default, 200, { slot: "gf", lane: "upper" });
    matches.push(gf);
    exits.set(loserOf(gf), "gf");
    exits.set(winnerOf(gf), "champion");
    return { advancing: [], exits, matches };
};
