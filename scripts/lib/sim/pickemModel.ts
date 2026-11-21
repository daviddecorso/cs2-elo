import { COIN_THRESHOLD, encodeSample, modelPickem, PickemBucket, runPickem, swissBucket } from "../../../src/sim/pickem.ts";
import { newSwissRecords, pairSwissRound, recordSwissResult, swissActive } from "../../../src/sim/swissPairing.ts";
import type { PickemData, PickemModel, PickemSet, PickemStage } from "../../../src/sim/types.ts";
import { makeRng, shuffle, subSeed, type Rng } from "./rng.ts";

type SwissStage = Extract<PickemStage, { format: "swiss" }>;
type SeriesOdds = (a: string, b: string, bestOf: number) => number;

const OPTIMIZE_N = 20000;
const SAMPLE_N = 5000;
const RANDOM_STARTS = 20;

/** Pre-stage simulations, ignoring played results: `out[sim * seeds.length + seed]` is a `PickemBucket`. */
export const simulateSwissStage = (seeds: string[], bestOf: SwissStage["bestOf"], p: SeriesOdds, n: number, rng: Rng): Uint8Array => {
    const k = seeds.length;
    const out = new Uint8Array(n * k);
    for (let s = 0; s < n; s++) {
        const records = newSwissRecords(seeds);
        for (let round = 1; swissActive(records).length > 0; round++) {
            for (const [a, b] of pairSwissRound(records, round)) {
                const decider = a.wins === 2 || a.losses === 2;
                const bo = decider ? (bestOf.decider ?? bestOf.default) : bestOf.default;
                if (rng() < p(a.team, b.team, bo)) recordSwissResult(a, b);
                else recordSwissResult(b, a);
            }
        }
        records.forEach((r, i) => (out[s * k + i] = swissBucket(r.wins, r.losses)));
    }
    return out;
};

const NONE = -1;
const SLOTS: Array<[PickemBucket, number]> = [
    [PickemBucket.ThreeZero, 2],
    [PickemBucket.Advance, 6],
    [PickemBucket.ZeroThree, 2],
];

/** The 2× 3-0, 6× 3-X, 2× 0-3 set most likely to reach `COIN_THRESHOLD` correct, ties broken by expected correct. */
export const coinPickem = (seeds: string[], buckets: Uint8Array, rng: Rng): PickemSet | null => {
    const k = seeds.length;
    if (k < 10) return null;
    const n = buckets.length / k;

    const evaluate = (assign: number[]) => {
        let coin = 0;
        let total = 0;
        const score = new Int8Array(n);
        for (let s = 0; s < n; s++) {
            let sc = 0;
            for (let t = 0; t < k; t++) if (assign[t] !== NONE && buckets[s * k + t] === assign[t]) sc++;
            score[s] = sc;
            total += sc;
            if (sc >= COIN_THRESHOLD) coin++;
        }
        return { coin, total, score };
    };

    const climb = (start: number[]) => {
        const assign = [...start];
        let cur = evaluate(assign);
        const score = (changes: Array<[number, number]>) => {
            let coin = 0;
            let total = 0;
            for (let s = 0; s < n; s++) {
                let sc = cur.score[s];
                for (const [t, to] of changes) {
                    const b = buckets[s * k + t];
                    if (b === assign[t]) sc--;
                    if (b === to) sc++;
                }
                total += sc;
                if (sc >= COIN_THRESHOLD) coin++;
            }
            return { coin, total, changes };
        };
        for (;;) {
            const moves: Array<Array<[number, number]>> = [];
            for (let t = 0; t < k; t++) {
                if (assign[t] === NONE) continue;
                for (let u = 0; u < k; u++) {
                    if (assign[u] === NONE) moves.push([[t, NONE], [u, assign[t]]]);
                    else if (u > t && assign[u] !== assign[t]) moves.push([[t, assign[u]], [u, assign[t]]]);
                }
            }
            let best: ReturnType<typeof score> | null = null;
            for (const move of moves) {
                const r = score(move);
                const ref = best ?? cur;
                if (r.coin > ref.coin || (r.coin === ref.coin && r.total > ref.total)) best = r;
            }
            if (!best) return { assign, ...cur };
            for (const [t, to] of best.changes) assign[t] = to;
            cur = evaluate(assign);
        }
    };

    const fromSet = (set: PickemSet) => {
        const assign = seeds.map(() => NONE);
        set.threeZero.forEach((t) => (assign[seeds.indexOf(t)] = PickemBucket.ThreeZero));
        set.advance.forEach((t) => (assign[seeds.indexOf(t)] = PickemBucket.Advance));
        set.zeroThree.forEach((t) => (assign[seeds.indexOf(t)] = PickemBucket.ZeroThree));
        return assign;
    };
    const randomStart = () => {
        const order = shuffle(seeds.map((_, i) => i), rng);
        const assign = seeds.map(() => NONE);
        let i = 0;
        for (const [bucket, count] of SLOTS) for (let c = 0; c < count; c++) assign[order[i++]] = bucket;
        return assign;
    };

    const marginals = seeds.map((team, t) => {
        const hits = [0, 0, 0];
        for (let s = 0; s < n; s++) {
            const b = buckets[s * k + t];
            if (b < 3) hits[b]++;
        }
        return { team, p30: hits[0] / n, p3x: hits[1] / n, p03: hits[2] / n };
    });
    const ev = modelPickem(marginals)!;
    const starts = [
        fromSet({ threeZero: ev.threeZero.map((t) => t.team), advance: ev.advance.map((t) => t.team), zeroThree: ev.zeroThree.map((t) => t.team) }),
        ...Array.from({ length: RANDOM_STARTS }, randomStart),
    ];

    let best: ReturnType<typeof climb> | null = null;
    for (const start of starts) {
        const r = climb(start);
        if (!best || r.coin > best.coin || (r.coin === best.coin && r.total > best.total)) best = r;
    }
    const of = (bucket: PickemBucket) => seeds.filter((_, t) => best!.assign[t] === bucket);
    return { threeZero: of(PickemBucket.ThreeZero), advance: of(PickemBucket.Advance), zeroThree: of(PickemBucket.ZeroThree) };
};

export const buildPickemModel = (stage: SwissStage, seeds: string[], p: SeriesOdds, asOf: string, seed: number): PickemModel | null => {
    const optimizeSet = simulateSwissStage(seeds, stage.bestOf, p, OPTIMIZE_N, makeRng(subSeed(seed, `pickem:${stage.id}:optimize`)));
    const picks = coinPickem(seeds, optimizeSet, makeRng(subSeed(seed, `pickem:${stage.id}:search`)));
    if (!picks) return null;
    const sample = simulateSwissStage(seeds, stage.bestOf, p, SAMPLE_N, makeRng(subSeed(seed, `pickem:${stage.id}:sample`)));
    return { asOf, seeds, picks, n: SAMPLE_N, sample: encodeSample(sample) };
};

/** A Swiss stage's model is kept from `previous` once the stage has a played result and its seeds are unchanged. */
export const pickemModels = (
    data: PickemData,
    previous: PickemData["model"] | undefined,
    build: (stage: SwissStage, seeds: string[]) => PickemModel | null
): Record<string, PickemModel> => {
    const out: Record<string, PickemModel> = {};
    for (const run of runPickem(data, {})) {
        const stage = run.stage;
        if (stage.format !== "swiss" || run.seeds.length === 0) continue;
        const prev = previous?.[stage.id];
        const frozen = stage.played.length > 0 && prev && prev.seeds.join("|") === run.seeds.join("|");
        const model = frozen ? prev : build(stage, run.seeds);
        if (model) out[stage.id] = model;
    }
    return out;
};
