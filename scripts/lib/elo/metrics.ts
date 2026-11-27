export interface Forecast {
    p: number;
    y: 0 | 1;
}

export interface Score {
    n: number;
    logLoss: number;
    brier: number;
    accuracy: number;
}

const EPS = 1e-6;

export const score = (forecasts: Forecast[]): Score => {
    let logLoss = 0;
    let brier = 0;
    let correct = 0;
    for (const { p, y } of forecasts) {
        const q = Math.min(1 - EPS, Math.max(EPS, p));
        logLoss -= y ? Math.log(q) : Math.log(1 - q);
        brier += (q - y) ** 2;
        if ((q > 0.5 ? 1 : 0) === y) correct++;
    }
    const n = forecasts.length;
    return { n, logLoss: n ? logLoss / n : NaN, brier: n ? brier / n : NaN, accuracy: n ? correct / n : NaN };
};

export interface CalibrationBin {
    /** Bin bounds on the favourite's probability, 0.5–1. */
    lo: number;
    hi: number;
    n: number;
    predicted: number;
    actual: number;
}

/** Folds every forecast onto its favourite so bins run 50–100% with twice the data per bin. */
export const calibration = (forecasts: Forecast[], bins = 10): CalibrationBin[] => {
    const width = 0.5 / bins;
    const out: CalibrationBin[] = Array.from({ length: bins }, (_, i) => ({
        lo: 0.5 + i * width,
        hi: 0.5 + (i + 1) * width,
        n: 0,
        predicted: 0,
        actual: 0,
    }));
    for (const { p, y } of forecasts) {
        const fav = p >= 0.5 ? p : 1 - p;
        const won = p >= 0.5 ? y : 1 - y;
        const bin = out[Math.min(bins - 1, Math.floor((fav - 0.5) / width))];
        bin.n++;
        bin.predicted += fav;
        bin.actual += won;
    }
    for (const bin of out) {
        if (bin.n) {
            bin.predicted /= bin.n;
            bin.actual /= bin.n;
        }
    }
    return out;
};

/** Expected calibration error over the favourite-folded bins, weighted by bin size. */
export const expectedCalibrationError = (forecasts: Forecast[], bins = 10): number => {
    const n = forecasts.length;
    return n ? calibration(forecasts, bins).reduce((sum, bin) => sum + bin.n * Math.abs(bin.predicted - bin.actual), 0) / n : NaN;
};

export const logit = (p: number): number => {
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    return Math.log(q / (1 - q));
};

/** Logistic regression with offset logit(p) and no intercept, by Newton steps on a small design; `weights` are per-row multiplicities. */
export function fitOffsetLogit(
    rs: Array<{ offset: number; y: 0 | 1 }>,
    xs: number[][],
    weights?: ArrayLike<number>,
): { beta: number[]; se: number[] } {
    const invert = (m: number[][]) => {
        const n = m.length;
        const a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
        for (let c = 0; c < n; c++) {
            const pivot = a.slice(c).reduce((best, row, i) => (Math.abs(row[c]) > Math.abs(a[best][c]) ? c + i : best), c);
            [a[c], a[pivot]] = [a[pivot], a[c]];
            const d = a[c][c];
            a[c] = a[c].map((v) => v / d);
            for (let r = 0; r < n; r++) if (r !== c) a[r] = a[r].map((v, j) => v - a[r][c] * a[c][j]);
        }
        return a.map((row) => row.slice(n));
    };
    const kf = xs[0]?.length ?? 0;
    const beta = new Array<number>(kf).fill(0);
    let H: number[][] = [];
    for (let iter = 0; iter < 25; iter++) {
        const g = new Array<number>(kf).fill(0);
        H = Array.from({ length: kf }, () => new Array<number>(kf).fill(0));
        rs.forEach((r, i) => {
            const w = weights ? weights[i] : 1;
            if (!w) return;
            const x = xs[i];
            const q = 1 / (1 + Math.exp(-(r.offset + x.reduce((s, v, j) => s + v * beta[j], 0))));
            for (let j = 0; j < kf; j++) {
                g[j] += w * (r.y - q) * x[j];
                for (let l = 0; l < kf; l++) H[j][l] += w * q * (1 - q) * x[j] * x[l];
            }
        });
        const inv = invert(H);
        for (let j = 0; j < kf; j++) beta[j] += inv[j].reduce((s, v, l) => s + v * g[l], 0);
    }
    const inv = invert(H);
    return { beta, se: beta.map((_, j) => Math.sqrt(inv[j][j])) };
}

/** Logistic fit of y on logit(p) by Newton's method: slope below 1 means overconfident. */
export const calibrationSlope = (forecasts: Forecast[]): { slope: number; intercept: number } => {
    let a = 0;
    let b = 1;
    for (let iter = 0; iter < 50; iter++) {
        let ga = 0;
        let gb = 0;
        let haa = 0;
        let hab = 0;
        let hbb = 0;
        for (const { p, y } of forecasts) {
            const x = logit(p);
            const q = 1 / (1 + Math.exp(-(a + b * x)));
            const w = q * (1 - q);
            ga += y - q;
            gb += (y - q) * x;
            haa += w;
            hab += w * x;
            hbb += w * x * x;
        }
        const det = haa * hbb - hab * hab;
        if (!det) break;
        const da = (hbb * ga - hab * gb) / det;
        const db = (haa * gb - hab * ga) / det;
        a += da;
        b += db;
        if (Math.abs(da) + Math.abs(db) < 1e-9) break;
    }
    return { slope: b, intercept: a };
};
