import { newSwissRecords, pairSwissRound, recordSwissResult, swissActive, swissAdvancingOrder } from "./swissPairing.ts";
import type { PickemData, PickemModel, PickemSet, PickemStage, PlayedSeries } from "./types.ts";

/** Pick key → winning team. */
export type Picks = Record<string, string>;

export const pickKey = (stage: string, round: number | string, a: string, b: string) =>
    `${stage}:${round}:${[a, b].sort().join("|")}`;

export interface PickemMatch {
    key: string;
    /** Swiss round, or bracket column (1 = first). */
    round: number;
    /** Swiss pool record before the match (`1-0`), or the bracket match id. */
    label: string;
    teams: [string | null, string | null];
    bestOf: number;
    winner: string | null;
    /** Played on Liquipedia. */
    locked: boolean;
    lane: "upper" | "lower";
}

export interface SwissOutcome {
    team: string;
    wins: number;
    losses: number;
    /** Round the team reached 3 wins or 3 losses. */
    round: number;
}

export interface StageRun {
    stage: PickemStage;
    /** Empty until the stage it draws from is complete. */
    seeds: string[];
    rounds: PickemMatch[][];
    complete: boolean;
    /** In the next stage's seed order. */
    advancing: string[];
    /** Swiss stages only. */
    outcomes: SwissOutcome[];
    /** Bracket stages only. */
    champion: string | null;
}

export type OddsFn = (a: string, b: string, bestOf: number) => number;

export const oddsFn = (odds: PickemData["odds"]): OddsFn => {
    const index = new Map(odds.teams.map((t, i) => [t, i]));
    return (a, b, bestOf) => {
        const i = index.get(a);
        const j = index.get(b);
        if (i === undefined || j === undefined) return 0.5;
        const table = bestOf >= 5 ? odds.bo5 : bestOf >= 3 ? odds.bo3 : odds.bo1;
        return table[i][j];
    };
};

/** Each played result is used once, earliest first, preferring one from the same round. */
const playedLookup = (played: PlayedSeries[]) => {
    const used = new Set<PlayedSeries>();
    return (a: string, b: string, round: number | null): string | null => {
        const same = (p: PlayedSeries) => (p.teams[0] === a && p.teams[1] === b) || (p.teams[0] === b && p.teams[1] === a);
        const hit =
            played.find((p) => !used.has(p) && same(p) && p.round === round) ??
            played.find((p) => !used.has(p) && same(p) && (p.round === null || round === null));
        if (!hit) return null;
        used.add(hit);
        return hit.teams[hit.winner];
    };
};

const runSwiss = (stage: Extract<PickemStage, { format: "swiss" }>, seeds: string[], picks: Picks): StageRun => {
    const records = newSwissRecords(seeds);
    const byTeam = new Map(records.map((r) => [r.team, r]));
    const lookup = playedLookup(stage.played);
    const rounds: PickemMatch[][] = [];
    const outcomes: SwissOutcome[] = [];
    let complete = seeds.length > 0;

    for (let round = 1; seeds.length > 0 && swissActive(records).length > 0; round++) {
        const known = stage.played.filter((p) => p.round === round).map((p) => p.teams);
        const pairs = pairSwissRound(records, round, known);
        const matches = pairs.map(([a, b]): PickemMatch => {
            const decider = a.wins === 2 || a.losses === 2;
            const bestOf = decider ? (stage.bestOf.decider ?? stage.bestOf.default) : stage.bestOf.default;
            const key = pickKey(stage.id, round, a.team, b.team);
            const played = lookup(a.team, b.team, round);
            const pick = picks[key];
            const winner = played ?? (pick === a.team || pick === b.team ? pick : null);
            return { key, round, label: `${a.wins}-${a.losses}`, teams: [a.team, b.team], bestOf, winner, locked: played !== null, lane: "upper" };
        });
        rounds.push(matches);
        if (matches.some((m) => m.winner === null)) {
            complete = false;
            break;
        }
        for (const m of matches) {
            const [a, b] = m.teams as [string, string];
            const [w, l] = m.winner === a ? [a, b] : [b, a];
            recordSwissResult(byTeam.get(w)!, byTeam.get(l)!);
        }
        for (const team of [...new Set(matches.flatMap((m) => m.teams as string[]))]) {
            const r = byTeam.get(team)!;
            if (r.wins === 3 || r.losses === 3) outcomes.push({ team, wins: r.wins, losses: r.losses, round });
        }
    }

    return { stage, seeds, rounds, complete, advancing: complete ? swissAdvancingOrder(records) : [], outcomes, champion: null };
};

const runBracket = (stage: Extract<PickemStage, { format: "bracket" }>, seeds: string[], picks: Picks): StageRun => {
    const lookup = playedLookup(stage.played);
    const results = new Map<string, { winner: string | null; loser: string | null; depth: number; lane: "upper" | "lower" }>();
    const resolve = (ref: string): { team: string | null; depth: number; lower: boolean } => {
        if (ref.startsWith("s")) return { team: seeds[Number(ref.slice(1)) - 1] ?? null, depth: 0, lower: false };
        const [kind, id] = ref.split(":");
        const r = results.get(id);
        if (!r) return { team: null, depth: 0, lower: false };
        return { team: kind === "w" ? r.winner : r.loser, depth: r.depth, lower: kind === "l" || r.lane === "lower" };
    };

    const matches: PickemMatch[] = [];
    const last = stage.matches[stage.matches.length - 1];
    for (const m of stage.matches) {
        const [ra, rb] = m.teams.map(resolve);
        const [a, b] = [ra.team, rb.team];
        const depth = Math.max(ra.depth, rb.depth) + 1;
        const lane = ra.lower && rb.lower ? "lower" : "upper";
        const bestOf = m.bestOf ?? (m === last ? (stage.bestOf.final ?? stage.bestOf.default) : stage.bestOf.default);
        const key = pickKey(stage.id, m.id, a ?? "?", b ?? "?");
        const played = a && b ? lookup(a, b, null) : null;
        const pick = picks[key];
        const winner = played ?? (a && b && (pick === a || pick === b) ? pick : null);
        const loser = winner === null ? null : winner === a ? b : a;
        results.set(m.id, { winner, loser, depth, lane });
        matches.push({ key, round: depth, label: m.id, teams: [a, b], bestOf, winner, locked: played !== null, lane });
    }

    const byRound = new Map<number, PickemMatch[]>();
    for (const m of matches) byRound.set(m.round, [...(byRound.get(m.round) ?? []), m]);
    const rounds = [...byRound].sort((x, y) => x[0] - y[0]).map(([, ms]) => ms);
    const champion = last ? (results.get(last.id)?.winner ?? null) : null;
    const complete = matches.every((m) => m.winner !== null);
    return { stage, seeds, rounds, complete, advancing: [], outcomes: [], champion };
};

/** Every stage in order; a stage drawing from an incomplete one gets no seeds. */
export const runPickem = (data: PickemData, picks: Picks): StageRun[] => {
    const runs = new Map<string, StageRun>();
    for (const stage of data.stages) {
        const source = stage.from ? runs.get(stage.from) : undefined;
        const ready = !stage.from || source?.complete === true;
        const seeds = ready ? [...stage.seeds, ...(source?.advancing ?? [])] : [];
        runs.set(stage.id, stage.format === "swiss" ? runSwiss(stage, seeds, picks) : runBracket(stage, seeds, picks));
    }
    return [...runs.values()];
};

/** Fills every open match, stage by stage and round by round, with `choose`'s winner; existing picks stay. */
export const fillPicks = (data: PickemData, picks: Picks, choose: (a: string, b: string, bestOf: number) => string): Picks => {
    const out = { ...picks };
    for (let guard = 0; guard < 500; guard++) {
        const open = runPickem(data, out)
            .flatMap((r) => r.rounds.flat())
            .find((m) => m.winner === null && m.teams[0] && m.teams[1]);
        if (!open) return out;
        const [a, b] = open.teams as [string, string];
        out[open.key] = choose(a, b, open.bestOf);
    }
    return out;
};

export const favouritePicks = (data: PickemData, picks: Picks = {}) => {
    const p = oddsFn(data.odds);
    return fillPicks(data, picks, (a, b, bestOf) => (p(a, b, bestOf) >= 0.5 ? a : b));
};

export interface PickemTeamOdds {
    team: string;
    /** Shares of all simulations. */
    p30: number;
    p3x: number;
    p03: number;
}

/** Valve's per-stage correct picks for a coin upgrade. */
export const COIN_THRESHOLD = 5;

export const PickemBucket = { ThreeZero: 0, Advance: 1, ZeroThree: 2, Other: 3 } as const;
export type PickemBucket = (typeof PickemBucket)[keyof typeof PickemBucket];

export const swissBucket = (wins: number, losses: number): PickemBucket =>
    wins === 3 ? (losses === 0 ? PickemBucket.ThreeZero : PickemBucket.Advance) : losses === 3 && wins === 0 ? PickemBucket.ZeroThree : PickemBucket.Other;

/** `buckets[sim * teams + seed]`, packed four per byte. */
export const encodeSample = (buckets: Uint8Array): string => {
    const bytes = new Uint8Array(Math.ceil(buckets.length / 4));
    buckets.forEach((b, i) => (bytes[i >> 2] |= b << ((i & 3) * 2)));
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
};

export const decodeSample = (model: Pick<PickemModel, "sample" | "seeds" | "n">): Uint8Array => {
    const raw = atob(model.sample);
    const out = new Uint8Array(model.n * model.seeds.length);
    for (let i = 0; i < out.length; i++) out[i] = (raw.charCodeAt(i >> 2) >> ((i & 3) * 2)) & 3;
    return out;
};

export interface PickemScore {
    expected: number;
    /** Share of simulations with at least `COIN_THRESHOLD` correct. */
    coin: number;
    /** Hit rate of each pick in its bucket. */
    perTeam: Map<string, number>;
}

export const scorePicks = (seeds: string[], buckets: Uint8Array, picks: PickemSet): PickemScore => {
    const k = seeds.length;
    const n = buckets.length / k;
    const chosen = [
        ...picks.threeZero.map((t) => [t, PickemBucket.ThreeZero] as const),
        ...picks.advance.map((t) => [t, PickemBucket.Advance] as const),
        ...picks.zeroThree.map((t) => [t, PickemBucket.ZeroThree] as const),
    ].map(([team, bucket]) => ({ team, bucket, seed: seeds.indexOf(team), hits: 0 }));
    let coin = 0;
    let total = 0;
    for (let s = 0; s < n; s++) {
        let score = 0;
        for (const c of chosen) {
            if (c.seed >= 0 && buckets[s * k + c.seed] === c.bucket) {
                score++;
                c.hits++;
            }
        }
        total += score;
        if (score >= COIN_THRESHOLD) coin++;
    }
    return { expected: total / n, coin: coin / n, perTeam: new Map(chosen.map((c) => [c.team, c.hits / n])) };
};

export interface ModelPickem {
    threeZero: Array<{ team: string; p: number }>;
    advance: Array<{ team: string; p: number }>;
    zeroThree: Array<{ team: string; p: number }>;
    /** Expected correct picks out of 10. */
    expected: number;
}

/** The 2× 3-0, 6× 3-1/3-2, 2× 0-3 picks of distinct teams with the most expected correct picks. */
export const modelPickem = (teams: PickemTeamOdds[]): ModelPickem | null => {
    if (teams.length < 10) return null;
    let best: ModelPickem | null = null;
    for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
            const rest = teams.filter((_, k) => k !== i && k !== j);
            for (let k = 0; k < rest.length; k++) {
                for (let l = k + 1; l < rest.length; l++) {
                    const advance = rest
                        .filter((_, m) => m !== k && m !== l)
                        .sort((a, b) => b.p3x - a.p3x)
                        .slice(0, 6);
                    const expected =
                        teams[i].p30 + teams[j].p30 + rest[k].p03 + rest[l].p03 + advance.reduce((s, t) => s + t.p3x, 0);
                    if (best && expected <= best.expected) continue;
                    best = {
                        threeZero: [teams[i], teams[j]].map((t) => ({ team: t.team, p: t.p30 })),
                        advance: advance.map((t) => ({ team: t.team, p: t.p3x })),
                        zeroThree: [rest[k], rest[l]].map((t) => ({ team: t.team, p: t.p03 })),
                        expected,
                    };
                }
            }
        }
    }
    return best;
};
