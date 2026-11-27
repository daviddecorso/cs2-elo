import { expectedScore, type EloEngine } from "../elo/engine.ts";
import type { EloParams } from "../elo/params.ts";
import { seriesLength, seriesWinProbability } from "../elo/series.ts";
import { normal, type Rng } from "./rng.ts";
import type { TeamId } from "./types.ts";
import type { VetoModel } from "./veto.ts";

/** Elo² per day, from `npm run fit-sim-noise` on 2025-01 to 2026-10 series. */
export const DRIFT_PER_DAY = 58;
/** Multiplier on the map-level Elo gap by Liquipedia tier; 1 where unlisted. Tier 2 from `npm run fit-sim-noise` (2025 fit, 2026-11-18); tiers 1 and 3+ didn't improve on 2026. */
export const TIER_TEMP: Record<number, number> = { 2: 0.905 };

export interface SeriesModel {
    resample(teams: Iterable<TeamId>, rng: Rng): void;
    /** Days from the ratings' as-of date to the event being played. */
    setHorizon(days: number): void;
    /** Liquipedia tier of the event being played; null when unknown. */
    setTier?(tier: number | null): void;
    seriesProbability(a: TeamId, b: TeamId, bestOf: number): number;
    /** One simulated series, `a` the higher seed; models without it draw against `seriesProbability`. */
    playSeries?(a: TeamId, b: TeamId, bestOf: number, rng: Rng, vetoOrder?: string): 0 | 1;
}

export interface PredictorOptions {
    /** Random-walk variance of a team's rating, Elo² per day (`npm run fit-sim-noise`); 0 holds ratings fixed. */
    driftPerDay: number;
    /** Every horizon `setHorizon` will be called with, in days. */
    horizons: number[];
    /** Rating for teams with no Elo lineage. */
    fallbackRating: number;
    /** Earlier Liquipedia pages of a renamed team, tried in order when the current page has no Elo lineage yet. */
    previousNames?: Map<TeamId, TeamId[]>;
    /** Simulates each series' veto and plays its maps; without it every map gets the pool-averaged probability. */
    veto?: VetoModel;
    /** Defaults to `TIER_TEMP`; `{}` turns it off. */
    tierTemp?: Record<number, number>;
}

/** Series odds from Elo as of today, with each team's rating drifting along one random walk per simulation. */
export class Predictor implements SeriesModel {
    private mapP = new Map<string, number>();
    private horizons: number[];
    /** Team → rating offset at each of `horizons`. */
    private paths = new Map<TeamId, number[]>();
    private horizonIndex = 0;
    private tierTemp = 1;
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

    lineageOf(team: TeamId) {
        const lineage = this.engine.teamLineageOf(team);
        if (lineage) return lineage;
        for (const name of this.options.previousNames?.get(team) ?? []) {
            const previous = this.engine.teamLineageOf(name);
            if (previous) return previous;
        }
        return undefined;
    }

    /** Map win probability for `a`, averaged over the active pool, without drift. */
    mapProbability(a: TeamId, b: TeamId): number {
        const key = `${a}\u0000${b}`;
        let p = this.mapP.get(key);
        if (p === undefined) {
            const la = this.lineageOf(a);
            const lb = this.lineageOf(b);
            if (!la) this.unrated.add(a);
            if (!lb) this.unrated.add(b);
            if (la && lb) {
                p = this.engine.mapProbability(la, lb, null, this.t, 0, this.engine.playerGap(la.core, lb.core, null));
                const temp = this.engine.mapTemp(la, lb);
                if (temp !== 1) p = 1 / (1 + (p / (1 - p)) ** -temp);
            } else {
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

    setTier(tier: number | null): void {
        this.tierTemp = tier === null ? 1 : ((this.options.tierTemp ?? TIER_TEMP)[tier] ?? 1);
    }

    seriesProbability(a: TeamId, b: TeamId, bestOf: number): number {
        let p = this.mapProbability(a, b);
        const shift = this.shift(a, b);
        if (shift !== 0 || this.tierTemp !== 1) p = expectedScore(this.tierTemp * (this.params.scale * Math.log10(p / (1 - p)) + shift), this.params.scale);
        return seriesWinProbability(p, seriesLength(bestOf), this.params.seriesMapTemp);
    }

    private shift(a: TeamId, b: TeamId): number {
        return (this.paths.get(a)?.[this.horizonIndex] ?? 0) - (this.paths.get(b)?.[this.horizonIndex] ?? 0);
    }

    /** Natural-log map logit from overall ratings, region priors and drift, as `veto.py`'s base. */
    baseLogit(a: TeamId, b: TeamId): number {
        const lineage = (team: TeamId) => {
            const l = this.lineageOf(team);
            if (!l) this.unrated.add(team);
            return l;
        };
        const la = lineage(a);
        const lb = lineage(b);
        const gap = (la?.rating ?? this.options.fallbackRating) - (lb?.rating ?? this.options.fallbackRating);
        const blendedGap = la && lb ? this.engine.blendGap(gap + this.engine.regionGap(la, lb), this.engine.playerGap(la.core, lb.core, null)) : gap;
        return ((blendedGap + this.shift(a, b)) * Math.LN10) / this.params.scale;
    }

    private pairTemp(a: TeamId, b: TeamId): number {
        const la = this.lineageOf(a);
        const lb = this.lineageOf(b);
        return la && lb ? this.engine.mapTemp(la, lb) : 1;
    }

    /** The veto model's key for a team: its page, an earlier name, or its lineage's current name. */
    vetoKey(team: TeamId): TeamId {
        const veto = this.options.veto!;
        for (const name of [team, ...(this.options.previousNames?.get(team) ?? []), this.lineageOf(team)?.team]) {
            if (name && veto.has(name)) return name;
        }
        return team;
    }

    playSeries(a: TeamId, b: TeamId, bestOf: number, rng: Rng, vetoOrder?: string): 0 | 1 {
        const veto = this.options.veto;
        if (!veto || ![1, 3, 5].includes(bestOf)) return rng() < this.seriesProbability(a, b, bestOf) ? 0 : 1;
        const sampled = veto.sample(this.vetoKey(a), this.vetoKey(b), bestOf, rng, vetoOrder);
        const temp = (bestOf > 1 ? this.params.seriesMapTemp : 1) * this.tierTemp * this.pairTemp(a, b);
        const need = Math.floor(bestOf / 2) + 1;
        const wins = [0, 0];
        for (const l of veto.logits(sampled, this.baseLogit(a, b))) {
            const w = rng() < 1 / (1 + Math.exp(-l * temp)) ? 0 : 1;
            if (++wins[w] === need) return w;
        }
        throw new Error(`Bo${bestOf} veto produced ${sampled.maps.length} maps`);
    }
}
