import fs from "node:fs";
import type { Range } from "./season.ts";

/** Displayed season projections, shrunk toward today and widened per rank band and months ahead, fit on rolling-hindcast origins; see `docs/vrs-simulator.md`, "Calibrated display". */
export const SEASON_CALIBRATION = "data/sim/season-calibration.json";

export interface SeasonCalibration {
    /** Label of the rolling hindcast run it was fit on. */
    source: string;
    fittedAt: string;
    /** `lambda[h - 1]`: weight on the simulated p50 against today's value, `h` months ahead (the last applies beyond); `widen[h - 1]` scales p10–p90 around it. */
    bands: Array<{ band: string; lo: number; hi: number; lambda: number[]; widen: number[] }>;
    /** Invite share shown = a + b × simulated share, clamped to [0, 1]. */
    invite: { a: number; b: number };
}

/** The fields of a rolling-hindcast row the fit reads. */
export interface CalibrationRow {
    band: string;
    horizon: number;
    persistence: number;
    truth: number;
    sim: { p10: number; p50: number; p90: number };
    invite: { sim: number; truth: number };
}

const grid = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Per band and horizon, λ minimizing the absolute error of the shrunk p50, then the least widening that covers `coverage` of outcomes. */
export const fitCalibration = (rows: CalibrationRow[], bands: Array<[string, number, number]>, source: string, coverage = 0.8): SeasonCalibration => {
    const horizons = Math.max(...rows.map((r) => r.horizon));
    const center = (r: CalibrationRow, l: number) => r.persistence + l * (r.sim.p50 - r.persistence);
    const fitted = bands.map(([band, lo, hi]) => {
        const lambda: number[] = [];
        const widen: number[] = [];
        for (let h = 1; h <= horizons; h++) {
            const g = rows.filter((r) => r.band === band && r.horizon === h);
            const l = grid(0, 1, 0.05).reduce((best, x) => (mean(g.map((r) => Math.abs(center(r, x) - r.truth))) < mean(g.map((r) => Math.abs(center(r, best) - r.truth))) ? x : best), 1);
            const inside = (k: number) => mean(g.map((r) => Number(center(r, l) - k * (r.sim.p50 - r.sim.p10) <= r.truth && r.truth <= center(r, l) + k * (r.sim.p90 - r.sim.p50))));
            lambda.push(g.length ? Math.round(l * 100) / 100 : 1);
            widen.push(g.length ? Math.round((grid(1, 3, 0.05).find((k) => inside(k) >= coverage) ?? 3) * 100) / 100 : 1);
        }
        return { band, lo, hi, lambda, widen };
    });
    const [mx, my] = [mean(rows.map((r) => r.invite.sim)), mean(rows.map((r) => r.invite.truth))];
    const sxx = rows.reduce((s, r) => s + (r.invite.sim - mx) ** 2, 0);
    const b = sxx > 0 ? rows.reduce((s, r) => s + (r.invite.sim - mx) * (r.invite.truth - my), 0) / sxx : 1;
    return { source, fittedAt: new Date().toISOString(), bands: fitted, invite: { a: Math.round((my - b * mx) * 1000) / 1000, b: Math.round(b * 1000) / 1000 } };
};

export const readCalibration = (file = SEASON_CALIBRATION): SeasonCalibration | null =>
    fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as SeasonCalibration) : null;

/** Unranked teams and ranks past the last band take the last band's factors. */
const factors = (cal: SeasonCalibration, rank: number | null, horizon: number) => {
    const band = cal.bands.find((b) => rank !== null && rank >= b.lo && rank <= b.hi) ?? cal.bands.at(-1)!;
    const i = Math.max(0, Math.min(band.lambda.length, horizon) - 1);
    return { lambda: band.lambda[i], widen: band.widen[i] };
};

/** `r` shrunk toward `today` and widened, for a team ranked `rank` today, `horizon` months ahead; unchanged without a calibration or a value today. */
export const calibrateRange = (
    cal: SeasonCalibration | null,
    rank: number | null,
    today: number | null,
    horizon: number,
    r: Range,
    clamp: (x: number) => number = (x) => x
): Range => {
    if (!cal || today === null || r.p50 === null) return r;
    const { lambda, widen } = factors(cal, rank, horizon);
    const center = today + lambda * (r.p50 - today);
    return {
        p10: r.p10 === null ? null : clamp(center - widen * (r.p50 - r.p10)),
        p50: clamp(center),
        p90: r.p90 === null ? null : clamp(center + widen * (r.p90 - r.p50)),
    };
};

export const calibrateInvite = (cal: SeasonCalibration | null, p: number) => (cal ? Math.min(1, Math.max(0, cal.invite.a + cal.invite.b * p)) : p);

/** A difference of two invite shares, on the calibrated scale. */
export const calibrateInviteGain = (cal: SeasonCalibration | null, d: number) => (cal ? cal.invite.b * d : d);
