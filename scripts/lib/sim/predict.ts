import { expectedScore, type EloEngine } from "../elo/engine.ts";
import type { EloParams } from "../elo/params.ts";
import { seriesLength, seriesWinProbability } from "../elo/series.ts";
import { normal, type Rng } from "./rng.ts";
import type { TeamId } from "./types.ts";

export interface SeriesModel {
    resample(teams: Iterable<TeamId>, rng: Rng): void;
    /** Days from the ratings' as-of date to the event being played. */
    setHorizon(days: number): void;
    seriesProbability(a: TeamId, b: TeamId, bestOf: number): number;
}

export interface PredictorOptions {
    /** Random-walk variance of a team's rating, Elo² per day (`npm run fit-sim-noise`); 0 holds ratings fixed. */
    driftPerDay: number;
    /** Every horizon `setHorizon` will be called with, in days. */
    horizons: number[];
    /** Rating for teams with no Elo lineage. */
    fallbackRating: number;
}

/** Series odds from Elo as of today, with each team's rating drifting along one random walk per simulation. */
export class Predictor implements SeriesModel {
    private mapP = new Map<string, number>();
    private horizons: number[];
    /** Team → rating offset at each of `horizons`. */
    private paths = new Map<TeamId, number[]>();
    private horizonIndex = 0;
    readonly unrated = new Set<TeamId>();
    private engine: EloEngine;
    private params: EloParams;
    private t: number;
    private options: PredictorOptions;

    constructor(engine: EloEngine, params: EloParams, t: number, options: PredictorOptions) {
        this.engine = engine;
        this.params = params;
        this.t = t;
        this.options = options;
        this.horizons = [...new Set(options.horizons.map((h) => Math.max(0, h)))].sort((a, b) => a - b);
    }

    /** Map win probability for `a`, averaged over the active pool, without drift. */
    mapProbability(a: TeamId, b: TeamId): number {
        const key = `${a}\u0000${b}`;
        let p = this.mapP.get(key);
        if (p === undefined) {
            const la = this.engine.teamLineageOf(a);
            const lb = this.engine.teamLineageOf(b);
            if (!la) this.unrated.add(a);
            if (!lb) this.unrated.add(b);
            if (la && lb) p = this.engine.mapProbability(la, lb, null, this.t);
            else {
                const ra = la?.rating ?? this.options.fallbackRating;
                const rb = lb?.rating ?? this.options.fallbackRating;
                p = expectedScore(ra - rb, this.params.scale);
            }
            this.mapP.set(key, p);
        }
        return p;
    }

    resample(teams: Iterable<TeamId>, rng: Rng): void {
        this.paths.clear();
        if (this.options.driftPerDay === 0) return;
        for (const team of teams) {
            let offset = 0;
            let prev = 0;
            this.paths.set(
                team,
                this.horizons.map((h) => {
                    offset += Math.sqrt(this.options.driftPerDay * (h - prev)) * normal(rng);
                    prev = h;
                    return offset;
                })
            );
        }
    }

    setHorizon(days: number): void {
        const i = this.horizons.indexOf(Math.max(0, days));
        if (i < 0) throw new Error(`Horizon ${days} wasn't registered`);
        this.horizonIndex = i;
    }

    seriesProbability(a: TeamId, b: TeamId, bestOf: number): number {
        let p = this.mapProbability(a, b);
        const shift = (this.paths.get(a)?.[this.horizonIndex] ?? 0) - (this.paths.get(b)?.[this.horizonIndex] ?? 0);
        if (shift !== 0) p = expectedScore(this.params.scale * Math.log10(p / (1 - p)) + shift, this.params.scale);
        return seriesWinProbability(p, seriesLength(bestOf), this.params.seriesMapTemp);
    }
}
