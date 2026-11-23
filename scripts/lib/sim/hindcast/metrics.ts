/** Scores for forecasts against realized values: point errors, rank agreement, and proper scores for sampled distributions. */

/** Floor-index quantile of an ascending array, as the season outputs use. */
export const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

export const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

/** Ranks from 0 with ties at their average rank. */
const ranks = (xs: number[]): number[] => {
    const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(xs.length);
    for (let i = 0; i < order.length; ) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
        for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2;
        i = j + 1;
    }
    return out;
};

export const pearson = (a: number[], b: number[]) => {
    const [ma, mb] = [mean(a), mean(b)];
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < a.length; i++) {
        cov += (a[i] - ma) * (b[i] - mb);
        va += (a[i] - ma) ** 2;
        vb += (b[i] - mb) ** 2;
    }
    return cov / Math.sqrt(va * vb);
};

export const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));

/** CRPS of an empirical distribution: E|X − y| − ½E|X − X'|, in the forecast's units; a point forecast scores its absolute error. */
export const crps = (samples: number[], y: number) => {
    const s = [...samples].sort((a, b) => a - b);
    const n = s.length;
    let spread = 0;
    let miss = 0;
    for (let i = 0; i < n; i++) {
        miss += Math.abs(s[i] - y);
        spread += (2 * i - n + 1) * s[i];
    }
    return miss / n - spread / (n * n);
};

export const brier = (p: number[], y: number[]) => mean(p.map((v, i) => (v - y[i]) ** 2));

export const logLoss = (p: number[], y: number[], eps = 1e-3) =>
    -mean(p.map((v, i) => {
        const c = Math.min(1 - eps, Math.max(eps, v));
        return y[i] ? Math.log(c) : Math.log(1 - c);
    }));
