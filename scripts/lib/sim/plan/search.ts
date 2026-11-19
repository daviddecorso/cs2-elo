import { makeRng } from "../rng.ts";

export interface SearchProblem {
    size: number;
    /** Must be monotone: a superset of an infeasible set is infeasible. */
    feasible(chosen: number[]): boolean;
    /** Higher is better; called with batches so a pool can score them together. */
    evaluate(schedules: number[][]): Promise<number[]>;
}

export interface SearchOptions {
    beam: number;
    restarts: number;
    seed: number;
    /** Beam iterations without a better best before stopping. */
    patience?: number;
    maxIterations?: number;
    /** Restarts choose among this many best adds. */
    greedyWidth?: number;
}

export interface Scored {
    chosen: number[];
    value: number;
}

export const keyOf = (chosen: number[]) => [...chosen].sort((a, b) => a - b).join(",");
const byValue = (a: Scored, b: Scored) => b.value - a.value || keyOf(a.chosen).localeCompare(keyOf(b.chosen));

/** Scores schedules once each, however many searches ask. */
export class ScoreCache {
    private values = new Map<string, number>();
    private evaluate: SearchProblem["evaluate"];
    constructor(evaluate: SearchProblem["evaluate"]) {
        this.evaluate = evaluate;
    }
    async score(schedules: number[][]): Promise<Scored[]> {
        const sorted = schedules.map((s) => [...s].sort((a, b) => a - b));
        const missing = [...new Map(sorted.filter((s) => !this.values.has(keyOf(s))).map((s) => [keyOf(s), s])).values()];
        if (missing.length) (await this.evaluate(missing)).forEach((v, i) => this.values.set(keyOf(missing[i]), v));
        return sorted.map((chosen) => ({ chosen, value: this.values.get(keyOf(chosen))! }));
    }
    get size() {
        return this.values.size;
    }
    all(): Scored[] {
        return [...this.values].map(([key, value]) => ({ chosen: key === "" ? [] : key.split(",").map(Number), value })).sort(byValue);
    }
}

const adds = (p: SearchProblem, chosen: number[]) => {
    const has = new Set(chosen);
    const out: number[][] = [];
    for (let o = 0; o < p.size; o++) if (!has.has(o) && p.feasible([...chosen, o])) out.push([...chosen, o]);
    return out;
};

/** Adds, removes, and swaps where the added option only fits once the removed one is gone; other swaps are an add and a remove apart. */
export const neighbors = (p: SearchProblem, chosen: number[]): number[][] => {
    const has = new Set(chosen);
    const out = adds(p, chosen);
    for (const o of chosen) out.push(chosen.filter((x) => x !== o));
    for (let j = 0; j < p.size; j++) {
        if (has.has(j) || p.feasible([...chosen, j])) continue;
        for (const o of chosen) {
            const swapped = [...chosen.filter((x) => x !== o), j];
            if (p.feasible(swapped)) out.push(swapped);
        }
    }
    return out;
};

/** Adds the best-gain option until none helps; with `rng`, picks among the `width` best gains instead. */
export const greedy = async (p: SearchProblem, cache: ScoreCache, rng?: () => number, width = 3): Promise<Scored> => {
    let current = (await cache.score([[]]))[0];
    for (;;) {
        const better = (await cache.score(adds(p, current.chosen))).filter((s) => s.value > current.value).sort(byValue);
        if (better.length === 0) return current;
        current = rng ? better[Math.floor(rng() * Math.min(width, better.length))] : better[0];
    }
};

/** Beam search from `start`; returns the best schedule it saw. */
export const beamSearch = async (p: SearchProblem, cache: ScoreCache, start: Scored, opts: SearchOptions): Promise<Scored> => {
    const patience = opts.patience ?? 2;
    const maxIterations = opts.maxIterations ?? 20;
    let beam = [start];
    let best = start;
    let stall = 0;
    for (let it = 0; it < maxIterations && stall < patience; it++) {
        const scored = await cache.score(beam.flatMap((s) => neighbors(p, s.chosen)));
        const pool = new Map([...beam, ...scored].map((s) => [keyOf(s.chosen), s]));
        beam = [...pool.values()].sort(byValue).slice(0, opts.beam);
        if (byValue(beam[0], best) < 0) {
            best = beam[0];
            stall = 0;
        } else stall++;
    }
    return best;
};

/** Greedy then beam search, plus `restarts` beam searches from randomized greedy starts; every schedule scored lands in `cache`. */
export const searchSchedules = async (p: SearchProblem, cache: ScoreCache, opts: SearchOptions): Promise<Scored> => {
    const rng = makeRng(opts.seed);
    let best = await beamSearch(p, cache, await greedy(p, cache), opts);
    for (let r = 0; r < opts.restarts; r++) {
        const found = await beamSearch(p, cache, await greedy(p, cache, rng, opts.greedyWidth), opts);
        if (byValue(found, best) < 0) best = found;
    }
    return best;
};

/** Every feasible schedule, or null past `limit`. */
export const feasibleSchedules = (p: SearchProblem, limit = 200000): number[][] | null => {
    const out: number[][] = [];
    const visit = (from: number, chosen: number[]): boolean => {
        if (out.length >= limit) return false;
        out.push(chosen);
        for (let o = from; o < p.size; o++) {
            const next = [...chosen, o];
            if (p.feasible(next) && !visit(o + 1, next)) return false;
        }
        return true;
    };
    return visit(0, []) ? out : null;
};
