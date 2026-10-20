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
