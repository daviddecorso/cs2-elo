export const lcg = (seed: number) => {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** ML λ in logit(p) = logit(p_base) + λ · (logit(p_adjusted) − logit(p_base)): 0 is no signal, 1 is the frozen weights. */
export function fitLambda(offsets: ArrayLike<number>, deltas: ArrayLike<number>, ys: ArrayLike<number>, weights?: ArrayLike<number>, start = 0): number {
    let lambda = start;
    for (let iter = 0; iter < 50; iter++) {
        let u = 0;
        let info = 0;
        for (let i = 0; i < offsets.length; i++) {
            const w = weights ? weights[i] : 1;
            if (!w || !deltas[i]) continue;
            const q = sigmoid(offsets[i] + lambda * deltas[i]);
            u += w * deltas[i] * (ys[i] - q);
            info += w * deltas[i] * deltas[i] * q * (1 - q);
        }
        if (info <= 0) return 0;
        const step = u / info;
        lambda += step;
        if (Math.abs(step) < 1e-10) break;
    }
    return lambda;
}

/** Per-row multiplicities for `draws` cluster-bootstrap resamples of `clusters`. */
export function clusterWeights(clusters: string[], draws: number, seed: number): Float64Array[] {
    const ids = [...new Set(clusters)];
    const index = new Map(ids.map((c, i) => [c, i]));
    const rowCluster = clusters.map((c) => index.get(c)!);
    const rand = lcg(seed);
    const out: Float64Array[] = [];
    for (let d = 0; d < draws; d++) {
        const mult = new Float64Array(ids.length);
        for (let k = 0; k < ids.length; k++) mult[Math.floor(rand() * ids.length)]++;
        out.push(Float64Array.from(rowCluster, (c) => mult[c]));
    }
    return out;
}

const quantiles90 = (xs: number[]): [number, number] => {
    const sorted = [...xs].sort((a, b) => a - b);
    return [sorted[Math.floor(0.05 * sorted.length)], sorted[Math.floor(0.95 * sorted.length)]];
};

/** λ̂ and its 90% cluster-bootstrap interval. */
export function lambdaCi(offsets: number[], deltas: number[], ys: number[], clusters: string[], draws = 2000, seed = 1) {
    const lambda = fitLambda(offsets, deltas, ys);
    const fits = clusterWeights(clusters, draws, seed).map((w) => fitLambda(offsets, deltas, ys, w, lambda));
    const [lo, hi] = quantiles90(fits);
    return { lambda, lo, hi };
}

/** 90% interval for the mean of `values`, resampling whole clusters, as `warcheck.paired_ci` does. */
export function clusterCi(values: number[], clusters: string[], draws = 2000, seed = 1): [number, number] {
    const ids = [...new Set(clusters)];
    const index = new Map(ids.map((c, i) => [c, i]));
    const sums = new Array(ids.length).fill(0);
    const counts = new Array(ids.length).fill(0);
    values.forEach((v, i) => {
        const c = index.get(clusters[i])!;
        sums[c] += v;
        counts[c]++;
    });
    const rand = lcg(seed);
    const means: number[] = [];
    for (let d = 0; d < draws; d++) {
        let s = 0;
        let n = 0;
        for (let k = 0; k < ids.length; k++) {
            const c = Math.floor(rand() * ids.length);
            s += sums[c];
            n += counts[c];
        }
        means.push(n ? s / n : 0);
    }
    return quantiles90(means);
}
