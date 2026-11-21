/** Major Swiss pairing per Valve's rulebook, shared by the simulator (`scripts/lib/sim/formats/swiss.ts`) and the site's Pick'em. */

export interface SwissRecord {
    team: string;
    /** 0-based initial seed. */
    seed: number;
    wins: number;
    losses: number;
    opponents: string[];
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

export const newSwissRecords = (teams: string[]): SwissRecord[] =>
    teams.map((team, seed) => ({ team, seed, wins: 0, losses: 0, opponents: [] }));

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

/** Buchholz: the sum of current opponents' wins minus losses. */
export const swissDifficulty = (records: SwissRecord[]) => {
    const byTeam = new Map(records.map((r) => [r.team, r]));
    return (r: SwissRecord) => r.opponents.reduce((sum, o) => sum + byTeam.get(o)!.wins - byTeam.get(o)!.losses, 0);
};

export const swissActive = (records: SwissRecord[], needWins = 3, maxLosses = 3) =>
    records.filter((r) => r.wins < needWins && r.losses < maxLosses);

/** `known` is Liquipedia's posted pairings, which win over ours. */
export const pairSwissRound = (
    records: SwissRecord[],
    round: number,
    known: Array<[string, string]> = [],
    needWins = 3,
    maxLosses = 3
): Array<[SwissRecord, SwissRecord]> => {
    const active = swissActive(records, needWins, maxLosses);
    const byTeam = new Map(records.map((r) => [r.team, r]));
    const difficulty = swissDifficulty(records);
    const pairs: Array<[SwissRecord, SwissRecord]> = [];
    const paired = new Set<string>();
    for (const [a, b] of known) {
        const ra = byTeam.get(a);
        const rb = byTeam.get(b);
        if (!ra || !rb || !active.includes(ra) || !active.includes(rb) || paired.has(a) || paired.has(b)) continue;
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
    return pairs;
};

export const recordSwissResult = (winner: SwissRecord, loser: SwissRecord) => {
    winner.wins++;
    loser.losses++;
    winner.opponents.push(loser.team);
    loser.opponents.push(winner.team);
};

/** Advancing teams in the next stage's seed order: record, then difficulty, then initial seed. */
export const swissAdvancingOrder = (records: SwissRecord[], needWins = 3): string[] => {
    const difficulty = swissDifficulty(records);
    return records
        .filter((r) => r.wins >= needWins)
        .sort((a, b) => a.losses - b.losses || difficulty(b) - difficulty(a) || a.seed - b.seed)
        .map((r) => r.team);
};
