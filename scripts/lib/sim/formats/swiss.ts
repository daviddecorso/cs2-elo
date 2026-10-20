import { loserOf, winnerOf, type SimMatch, type StageRunner, type TeamId } from "../types.ts";

interface SwissRecord {
    team: TeamId;
    seed: number;
    wins: number;
    losses: number;
    opponents: TeamId[];
}

/** Valve's priority table for six-team pools in rounds 4 and 5, as indexes into the pool's seed order. */
const SIX_TEAM_PRIORITY: Array<Array<[number, number]>> = [
    [[0, 5], [1, 4], [2, 3]],
    [[0, 5], [1, 3], [2, 4]],
    [[0, 4], [1, 5], [2, 3]],
    [[0, 4], [1, 3], [2, 5]],
    [[0, 3], [1, 5], [2, 4]],
    [[0, 3], [1, 4], [2, 5]],
    [[0, 5], [1, 2], [3, 4]],
    [[0, 4], [1, 2], [3, 5]],
    [[0, 2], [1, 5], [3, 4]],
    [[0, 2], [1, 4], [3, 5]],
    [[0, 3], [1, 2], [4, 5]],
    [[0, 2], [1, 3], [4, 5]],
    [[0, 1], [2, 5], [3, 4]],
    [[0, 1], [2, 4], [3, 5]],
    [[0, 1], [2, 3], [4, 5]],
];

const rematch = (a: SwissRecord, b: SwissRecord) => a.opponents.includes(b.team);

/** Highest seed against the lowest seed it hasn't played, backtracking when that strands a later team. */
const pairHighLow = (pool: SwissRecord[]): Array<[SwissRecord, SwissRecord]> | null => {
    if (pool.length === 0) return [];
    const [top, ...rest] = pool;
    for (let i = rest.length - 1; i >= 0; i--) {
        if (rematch(top, rest[i])) continue;
        const tail = pairHighLow(rest.filter((_, j) => j !== i));
        if (tail) return [[top, rest[i]], ...tail];
    }
    return null;
};

const pairPool = (pool: SwissRecord[], round: number): Array<[SwissRecord, SwissRecord]> => {
    if (pool.length % 2 !== 0) throw new Error(`Swiss pool of ${pool.length} teams in round ${round}`);
    if (pool.length === 6 && round >= 4) {
        for (const option of SIX_TEAM_PRIORITY) {
            if (option.every(([i, j]) => !rematch(pool[i], pool[j]))) {
                return option.map(([i, j]) => [pool[i], pool[j]]);
            }
        }
    }
    return pairHighLow(pool) ?? pairHighLow([...pool].reverse())!.map(([a, b]) => [b, a]);
};

/** Major Swiss per Valve's rulebook; pools sort by Buchholz difficulty, then initial seed. Exit keys are the final record, e.g. `2-3`. */
export const swiss: StageRunner = (teams, ctx) => {
    const { config } = ctx;
    const needWins = config.wins ?? 3;
    const maxLosses = config.losses ?? 3;
    const records = teams.map((team, seed): SwissRecord => ({ team, seed, wins: 0, losses: 0, opponents: [] }));
    const byTeam = new Map(records.map((r) => [r.team, r]));
    const difficulty = (r: SwissRecord) =>
        r.opponents.reduce((sum, o) => sum + byTeam.get(o)!.wins - byTeam.get(o)!.losses, 0);
    const matches: SimMatch[] = [];

    for (let round = 1; ; round++) {
        const active = records.filter((r) => r.wins < needWins && r.losses < maxLosses);
        if (active.length === 0) break;

        const pairs: Array<[SwissRecord, SwissRecord]> = [];
        const paired = new Set<TeamId>();
        for (const [a, b] of ctx.knownPairings(round)) {
            const ra = byTeam.get(a);
            const rb = byTeam.get(b);
            if (!ra || !rb || !active.includes(ra) || !active.includes(rb)) continue;
            pairs.push([ra, rb]);
            paired.add(a).add(b);
        }

        const pools = new Map<string, SwissRecord[]>();
        for (const r of active) {
            if (paired.has(r.team)) continue;
            const key = `${r.wins}-${r.losses}`;
            if (!pools.has(key)) pools.set(key, []);
            pools.get(key)!.push(r);
        }
        for (const pool of pools.values()) {
            if (round === 1) {
                pool.sort((a, b) => a.seed - b.seed);
                const half = pool.length / 2;
                for (let i = 0; i < half; i++) pairs.push([pool[i], pool[i + half]]);
                continue;
            }
            pool.sort((a, b) => difficulty(b) - difficulty(a) || a.seed - b.seed);
            pairs.push(...pairPool(pool, round));
        }

        for (const [a, b] of pairs) {
            const decider = a.wins === needWins - 1 || a.losses === maxLosses - 1;
            const bestOf = decider ? (config.bestOf.decider ?? config.bestOf.default) : config.bestOf.default;
            const m = ctx.play(a.team, b.team, bestOf, round, { slot: `r${round}:${a.wins}-${a.losses}`, lane: "upper" });
            matches.push(m);
            byTeam.get(winnerOf(m))!.wins++;
            byTeam.get(loserOf(m))!.losses++;
            a.opponents.push(b.team);
            b.opponents.push(a.team);
        }
    }

    const exits = new Map<TeamId, string>();
    for (const r of records) if (r.losses >= maxLosses) exits.set(r.team, `${r.wins}-${r.losses}`);
    const advancing = records
        .filter((r) => r.wins >= needWins)
        .sort((a, b) => a.losses - b.losses || difficulty(b) - difficulty(a) || a.seed - b.seed)
        .map((r) => r.team);
    return { advancing, exits, matches };
};
