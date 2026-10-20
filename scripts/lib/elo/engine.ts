import { makeLineupResolver } from "../lineups.ts";
import type { EloParams } from "./params.ts";
import { lineupRegion } from "./region.ts";
import { ActivePool, seriesLength, seriesWinProbability } from "./series.ts";
import type { EloMatch, EloPlayers } from "./types.ts";

export interface Lineage {
    id: number;
    team: string;
    core: string[];
    rating: number;
    mapOffsets: Map<string, number>;
    region: number | null;
    maps: number;
    /** Liquipedia tiers of its last 10 series. */
    tiers: number[];
    recent: string[][];
    firstT: number;
    lastT: number;
}

export interface SeriesPrediction {
    id: string;
    t: number;
    bestOf: number;
    teams: [string, string];
    lineups: [string[], string[]];
    /** Probability that teams[0] wins the series. */
    p: number;
    /** 1 if teams[0] won. */
    y: 0 | 1;
    maps: Array<{ map: string; p: number; y: 0 | 1 }>;
    crossRegion: boolean;
    standIn: boolean;
    tier: number;
    lan: boolean;
    ratings: [number, number];
}

const TIER_ACTIVE_SECONDS = 120 * 24 * 3600;
const DEFAULT_TIER = 4;
const BASE_RATING = 1500;

export const expectedScore = (diff: number, scale: number): number => 1 / (1 + 10 ** (-diff / scale));

/** Round margin of a map, crediting overtime wins with `otMargin`; MR12 regulation ends 13–x with x ≤ 11. */
export const mapMargin = (rounds: [number, number], otMargin: number): number => {
    const loser = Math.min(rounds[0], rounds[1]);
    return loser >= 12 ? otMargin : Math.abs(rounds[0] - rounds[1]);
};

/** K multiplier for margin of victory, damped when the favourite wins (538's autocorrelation correction). */
export const marginMultiplier = (margin: number, winnerEdge: number, marginWeight: number): number =>
    (1 + marginWeight * Math.log1p(margin)) * (2.2 / (Math.max(winnerEdge, -1000) * 0.001 + 2.2));

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

const clampTier = (tier: number | null): number => Math.min(5, Math.max(1, tier ?? DEFAULT_TIER));

export class EloEngine {
    readonly lineages: Lineage[] = [];
    private teamLineage = new Map<string, Lineage>();
    private playerLineage = new Map<string, Lineage>();
    private pool = new ActivePool();
    private tierMeanCache = { day: -1, means: [] as Array<number | null> };
    private params: EloParams;
    private players: EloPlayers;

    constructor(params: EloParams, players: EloPlayers) {
        this.params = params;
        this.players = players;
    }

    /** Runs every series in order and returns one prediction per non-forfeit series, made before its result. */
    run(matches: EloMatch[]): SeriesPrediction[] {
        const resolve = makeLineupResolver(
            matches.flatMap((m) => m.teams.map((team, i) => ({ team, t: m.t, players: m.lineups[i] }))),
            (p) => p
        );
        const predictions: SeriesPrediction[] = [];
        for (const m of matches) {
            if (m.forfeit) continue;
            const prediction = this.playSeries(m, [
                resolve(m.teams[0], m.t, m.lineups[0]),
                resolve(m.teams[1], m.t, m.lineups[1]),
            ]);
            if (prediction) predictions.push(prediction);
        }
        return predictions;
    }

    activePool(t: number): string[] {
        return this.pool.at(t);
    }

    teamLineageOf(team: string): Lineage | undefined {
        return this.teamLineage.get(team);
    }

    /** Map win probability for `a` over `b`; with no map, averaged over the pool active at `t`. */
    mapProbability(a: Lineage, b: Lineage, map: string | null, t: number): number {
        const { scale } = this.params;
        const diff = a.rating - b.rating;
        if (map) return expectedScore(diff + (a.mapOffsets.get(map) ?? 0) - (b.mapOffsets.get(map) ?? 0), scale);
        const pool = this.pool.at(t);
        if (pool.length === 0) return expectedScore(diff, scale);
        let total = 0;
        for (const m of pool) total += expectedScore(diff + (a.mapOffsets.get(m) ?? 0) - (b.mapOffsets.get(m) ?? 0), scale);
        return total / pool.length;
    }

    private playSeries(m: EloMatch, lineups: [string[] | null, string[] | null]): SeriesPrediction | null {
        const tier = clampTier(m.tier);
        const sides = m.teams.map((team, i) => this.lineageFor(team, lineups[i], tier, m.t));
        const [a, b] = sides;
        if (!a || !b || a.lineage === b.lineage) return null;
        const A = a.lineage;
        const B = b.lineage;

        const bestOf = seriesLength(m.bestOf);
        const pMap = this.mapProbability(A, B, null, m.t);
        const crossRegion = A.region !== null && B.region !== null && A.region !== B.region;
        const standIn = a.standIn || b.standIn;
        const prediction: SeriesPrediction = {
            id: m.id,
            t: m.t,
            bestOf,
            teams: m.teams,
            lineups: [lineups[0] ?? A.core, lineups[1] ?? B.core],
            p: seriesWinProbability(pMap, bestOf),
            y: m.winner === 0 ? 1 : 0,
            maps: [],
            crossRegion,
            standIn,
            tier,
            lan: m.lan,
            ratings: [A.rating, B.rating],
        };

        const p = this.params;
        const kBase =
            p.k * (m.lan ? 1 : p.onlineK) * p.tierK ** (tier - 1) * (crossRegion ? p.crossRegionK : 1) * (standIn ? p.standInK : 1);
        for (const map of m.maps) {
            const expected = this.mapProbability(A, B, map.map, m.t);
            const y = map.rounds[0] > map.rounds[1] ? 1 : 0;
            prediction.maps.push({ map: map.map, p: expected, y });

            const edge = (A.rating - B.rating) * (y ? 1 : -1);
            const mult = marginMultiplier(mapMargin(map.rounds, p.otMargin), edge, p.marginWeight);
            const provisional = (l: Lineage) => 1 + p.provisionalK * Math.max(0, 1 - l.maps / p.provisionalMaps);
            const surprise = y - expected;
            A.rating += kBase * mult * provisional(A) * surprise;
            B.rating -= kBase * mult * provisional(B) * surprise;
            A.maps++;
            B.maps++;

            this.updateMapOffset(A, map.map, p.kMap * surprise, m.t);
            this.updateMapOffset(B, map.map, -p.kMap * surprise, m.t);
            this.pool.record(m.t, map.map);
        }

        for (const l of [A, B]) {
            l.lastT = m.t;
            l.tiers.push(tier);
            if (l.tiers.length > 10) l.tiers.shift();
        }
        return prediction;
    }

    /** Offsets stay centred on the active pool so they only express map preference, never overall strength. */
    private updateMapOffset(l: Lineage, map: string, delta: number, t: number): void {
        l.mapOffsets.set(map, (l.mapOffsets.get(map) ?? 0) + delta);
        const pool = this.pool.at(t);
        const inPool = pool.length > 0 ? pool : [map];
        const mean = inPool.reduce((sum, m) => sum + (l.mapOffsets.get(m) ?? 0), 0) / inPool.length;
        const keep = 1 - this.params.mapShrink;
        for (const [m, offset] of l.mapOffsets) l.mapOffsets.set(m, (offset - (inPool.includes(m) ? mean : 0)) * keep);
    }

    /** Mean rating of rosters active in the last 120 days, by their median tier; recomputed once per day. */
    tierMean(tier: number, t: number): number {
        const day = Math.floor(t / 86400);
        if (this.tierMeanCache.day !== day) {
            const sums = [0, 0, 0, 0, 0, 0];
            const counts = [0, 0, 0, 0, 0, 0];
            for (const l of this.lineages) {
                if (l.lastT < t - TIER_ACTIVE_SECONDS || l.tiers.length === 0) continue;
                const lt = median(l.tiers);
                sums[lt] += l.rating;
                counts[lt]++;
            }
            this.tierMeanCache = { day, means: sums.map((s, i) => (counts[i] >= 5 ? s / counts[i] : null)) };
        }
        return this.tierMeanCache.means[tier] ?? BASE_RATING - this.params.tierGap * (tier - 1);
    }

    private regionOf(core: string[]): number | null {
        return lineupRegion(core.map((p) => this.players[p]?.country ?? ""));
    }

    /** Valve's continuity rule: a lineup belongs to the lineage whose core it shares at least 3 players with. */
    private lineageFor(
        team: string,
        lineup: string[] | null,
        tier: number,
        t: number
    ): { lineage: Lineage; standIn: boolean } | null {
        const current = this.teamLineage.get(team);
        if (!lineup) return current ? { lineage: current, standIn: false } : null;

        const candidates = new Set<Lineage>();
        if (current) candidates.add(current);
        for (const player of lineup) {
            const l = this.playerLineage.get(player);
            if (l) candidates.add(l);
        }
        let best: Lineage | null = null;
        let bestOverlap = 0;
        for (const l of candidates) {
            const overlap = lineup.filter((player) => l.core.includes(player)).length;
            if (overlap > bestOverlap || (overlap === bestOverlap && l === current)) {
                best = l;
                bestOverlap = overlap;
            }
        }

        const p = this.params;
        let lineage: Lineage;
        if (best && bestOverlap >= 3) {
            lineage = best;
            lineage.recent.push(lineup);
            if (lineage.recent.length > p.coreWindow) lineage.recent.shift();
            const newCore = this.voteCore(lineage);
            const replaced = 5 - newCore.filter((player) => lineage.core.includes(player)).length;
            if (replaced > 0) {
                const mean = this.tierMean(tier, t);
                lineage.rating += p.regress * (replaced / 5) * (mean - lineage.rating);
                lineage.core = newCore;
                lineage.region = this.regionOf(newCore);
            }
            lineage.team = team;
        } else {
            const mean = this.tierMean(tier, t);
            const seeds = lineup.map((player) => this.playerLineage.get(player)?.rating ?? mean);
            const seed = seeds.reduce((sum, r) => sum + r, 0) / seeds.length;
            lineage = {
                id: this.lineages.length,
                team,
                core: [...lineup],
                rating: seed + p.newRosterRegress * (mean - seed),
                mapOffsets: new Map(),
                region: this.regionOf(lineup),
                maps: 0,
                tiers: [],
                recent: [lineup],
                firstT: t,
                lastT: t,
            };
            this.lineages.push(lineage);
        }

        this.teamLineage.set(team, lineage);
        for (const player of lineage.core) this.playerLineage.set(player, lineage);
        return { lineage, standIn: lineup.some((player) => !lineage.core.includes(player)) };
    }

    /** The 5 players with the most appearances in the lineage's recent series; ties keep current core members. */
    private voteCore(l: Lineage): string[] {
        const counts = new Map<string, number>();
        for (const lineup of l.recent) for (const player of lineup) counts.set(player, (counts.get(player) ?? 0) + 1);
        return [...counts]
            .sort((x, y) => y[1] - x[1] || Number(l.core.includes(y[0])) - Number(l.core.includes(x[0])))
            .slice(0, 5)
            .map(([player]) => player);
    }
}
