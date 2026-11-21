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
    /** `region` with Oceania split out of Asia as 3. */
    fineRegion?: number | null;
    maps: number;
    /** Liquipedia tiers of its last 10 series. */
    tiers: number[];
    recent: string[][];
    firstT: number;
    lastT: number;
    /** Maps played, decayed with time constant `burstDays`, as of `loadT`. */
    load?: number;
    loadT?: number;
    /** Time of its last cross-region series. */
    lastCrossT?: number;
    /** Starting rating and how many of the 5 seeds came from the tier mean (unrated players). */
    seed?: number;
    seedsFromMean?: number;
    seedTier?: number;
    /** Rating after its 30th map. */
    rating30?: number;
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
    /** `ratings` are each side's rating plus its offset for that map, before the map is played. `margin` is the real signed round margin for teams[0]. */
    maps: Array<{ map: string; p: number; y: 0 | 1; margin: number; ratings: [number, number] }>;
    crossRegion: boolean;
    regions: [number | null, number | null];
    /** Days since each side's last cross-region series, or null if it has none. */
    crossGapDays: [number | null, number | null];
    standIn: boolean;
    tier: number;
    lan: boolean;
    lineages: [number, number];
    ratings: [number, number];
    /** Each side's region prior; add it to `ratings` and `after` for a rating comparable across regions. */
    regionPriors: [number, number];
    /** Each side's rating once the series is played. */
    after: [number, number];
    /** Each side's map offsets over the pool active at the series start, before it is played. */
    poolOffsets: [Record<string, number>, Record<string, number>];
    /** Maps rated before this series by the less experienced side. */
    minMaps: number;
    /** Days since the less recently active side last played. */
    idleDays: number;
    /** Mean prior duel skill θ of teams[0]'s lineup minus teams[1]'s; 0 without a SkillLookup or unless both sides have 3+ players with history. */
    skillGap: number;
}

/** A map's luck-adjusted result from duel expectations, from teams[0]'s view. */
export interface LuckRow {
    /** Signed round margin had every duel gone at its expected rate. */
    xMargin: number;
    /** P(teams[0] wins the map | xMargin). */
    yHat: number;
}

/** Looks up a series' map by its position among the scored maps. */
export type LuckLookup = (seriesId: string, index: number) => LuckRow | undefined;

/** A player's duel skill θ from demo series strictly before `t`; undefined with none. */
export type SkillLookup = (player: string, t: number) => number | undefined;

/** `data/elo/player-skill.json` from `cs2wp luck`: per player page, `[t, exec, duels]` per demo series sorted by `t`. */
export interface PlayerSkill {
    /** Shrinkage in duels. */
    k: number;
    players: Record<string, Array<[number, number, number]>>;
}

/** θ = execution summed over earlier series / (their duels + k). The maps of one series share `t`, so a series never sees itself. */
export const makeSkillLookup = ({ k, players }: PlayerSkill): SkillLookup => {
    const cumulative = new Map<string, { t: number[]; exec: number[]; duels: number[] }>();
    for (const [player, rows] of Object.entries(players)) {
        let e = 0;
        let d = 0;
        cumulative.set(player, {
            t: rows.map((r) => r[0]),
            exec: rows.map((r) => (e += r[1])),
            duels: rows.map((r) => (d += r[2])),
        });
    }
    return (player, t) => {
        const c = cumulative.get(player);
        if (!c) return undefined;
        let lo = 0;
        let hi = c.t.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (c.t[mid] < t) lo = mid + 1;
            else hi = mid;
        }
        return lo === 0 ? undefined : c.exec[lo - 1] / (c.duels[lo - 1] + k);
    };
};

const TIER_ACTIVE_SECONDS = 120 * 24 * 3600;
const DEFAULT_TIER = 4;
const MIN_SKILL_PLAYERS = 3;
const BASE_RATING = 1500;
const OCEANIA = new Set(["au", "nz"]);
const FINE_OCEANIA = 3;

export const expectedScore = (diff: number, scale: number): number => 1 / (1 + 10 ** (-diff / scale));

/** Round margin of a map, crediting overtime wins with `otMargin`; MR12 regulation ends 13–x with x ≤ 11, MR15 ends 16–x with x ≤ 14 and is scaled to MR12. */
export const mapMargin = (rounds: [number, number], otMargin: number, mr15 = false): number => {
    const loser = Math.min(rounds[0], rounds[1]);
    if (loser >= (mr15 ? 15 : 12)) return otMargin;
    return Math.abs(rounds[0] - rounds[1]) * (mr15 ? 12 / 15 : 1);
};

/** K multiplier for margin of victory, damped when the favourite wins (538's autocorrelation correction). */
export const marginMultiplier = (margin: number, winnerEdge: number, marginWeight: number): number =>
    (1 + marginWeight * Math.log1p(margin)) * (2.2 / (Math.max(winnerEdge, -1000) * 0.001 + 2.2));

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

const crossGapDays = (l: Lineage, t: number): number | null => (l.lastCrossT === undefined ? null : (t - l.lastCrossT) / 86400);

const clampTier = (tier: number | null): number => Math.min(5, Math.max(1, tier ?? DEFAULT_TIER));

export class EloEngine {
    readonly lineages: Lineage[] = [];
    private teamLineage = new Map<string, Lineage>();
    private playerLineage = new Map<string, Lineage>();
    private pool = new ActivePool();
    private tierMeanCache = { day: -1, means: [] as Array<number | null> };    private params: EloParams;
    private players: EloPlayers;
    private luck: LuckLookup | undefined;
    private skill: SkillLookup | undefined;

    constructor(params: EloParams, players: EloPlayers, luck?: LuckLookup, skill?: SkillLookup) {
        this.params = params;
        this.players = players;
        this.luck = luck;
        this.skill = skill;
    }

    /** Runs every series in order and returns one prediction per non-forfeit series, made before its result. */
    run(matches: EloMatch[]): SeriesPrediction[] {
        const resolve = makeLineupResolver(
            matches.flatMap((m) => m.teams.map((team, i) => ({ team, t: m.t, players: m.lineups[i] }))),
            (p) => p
        );
        const predictions: SeriesPrediction[] = [];
        let pendingSwitch = false;
        for (const m of matches) {
            if (m.game === "csgo") pendingSwitch = true;
            else if (pendingSwitch) {
                this.switchGame(m.t);
                pendingSwitch = false;
            }
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

    /** Map win probability for `a` over `b`, with `extraGap` added to their rating gap; with no map, averaged over the pool active at `t`. */
    mapProbability(a: Lineage, b: Lineage, map: string | null, t: number, extraGap = 0): number {
        const { scale } = this.params;
        const diff = a.rating - b.rating + extraGap + this.regionGap(a, b);
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
        const sideLineups: [string[], string[]] = [lineups[0] ?? A.core, lineups[1] ?? B.core];
        const skillGap = this.skillGap(sideLineups, m.t);
        // The shifted expectation feeds the update too, so the rating learns only what the skill term leaves over.
        const shift = this.params.skillWeight * skillGap;
        const bothOceania = A.fineRegion === FINE_OCEANIA && B.fineRegion === FINE_OCEANIA;
        const rawMap = this.mapProbability(A, B, null, m.t, shift);
        const mapTemp = this.mapTemp(A, B);
        const pMap = mapTemp !== 1 ? 1 / (1 + (rawMap / (1 - rawMap)) ** -mapTemp) : rawMap;
        const [ra, rb] = this.params.oceaniaCross ? [A.fineRegion ?? null, B.fineRegion ?? null] : [A.region, B.region];
        const crossRegion = ra !== null && rb !== null && ra !== rb;
        const standIn = a.standIn || b.standIn;
        const pool = this.pool.at(m.t);
        const offsetsOf = (l: Lineage) => Object.fromEntries(pool.map((name) => [name, l.mapOffsets.get(name) ?? 0]));
        const prediction: SeriesPrediction = {
            id: m.id,
            t: m.t,
            bestOf,
            teams: m.teams,
            lineups: sideLineups,
            p: seriesWinProbability(pMap, bestOf, m.lan ? this.params.seriesMapTemp : this.params.seriesMapTempOnline),
            y: m.winner === 0 ? 1 : 0,
            maps: [],
            crossRegion,
            regions: [A.region, B.region],
            crossGapDays: [crossGapDays(A, m.t), crossGapDays(B, m.t)],
            standIn,
            tier,
            lan: m.lan,
            lineages: [A.id, B.id],
            ratings: [A.rating, B.rating],
            regionPriors: [this.regionPrior(A), this.regionPrior(B)],
            after: [A.rating, B.rating],
            poolOffsets: [offsetsOf(A), offsetsOf(B)],
            minMaps: Math.min(A.maps, B.maps),
            idleDays: (m.t - Math.min(A.lastT, B.lastT)) / 86400,
            skillGap,
        };

        const p = this.params;
        const kBase =
            p.k * (m.lan ? 1 : p.onlineK) * p.tierK ** (tier - 1) * (crossRegion ? p.crossRegionK : 1) * (standIn ? p.standInK : 1) * (bothOceania ? p.oceaniaK : 1);
        m.maps.forEach((map, index) => {
            const expected = this.mapProbability(A, B, map.map, m.t, shift);
            const y = map.rounds[0] > map.rounds[1] ? 1 : 0;
            const ratings: [number, number] = [
                A.rating + (A.mapOffsets.get(map.map) ?? 0),
                B.rating + (B.mapOffsets.get(map.map) ?? 0),
            ];
            let margin = mapMargin(map.rounds, p.otMargin, m.game === "csgo") * (y ? 1 : -1);
            prediction.maps.push({ map: map.map, p: expected, y, margin, ratings });

            // Updates use a blend of the real result and the luck-adjusted one; predictions above always use the real y and margin.
            let target: number = y;
            const luck = p.luckWeight > 0 ? this.luck?.(m.id, index) : undefined;
            if (luck) {
                margin = (1 - p.luckWeight) * margin + p.luckWeight * luck.xMargin;
                target = (1 - p.luckWeight) * y + p.luckWeight * luck.yHat;
            }
            const winnerSign = margin > 0 || (margin === 0 && y) ? 1 : -1;
            const edge = (A.rating - B.rating) * winnerSign;
            const mult = marginMultiplier(Math.abs(margin), edge, p.marginWeight);
            const provisional = (l: Lineage) => 1 + p.provisionalK * Math.max(0, 1 - l.maps / p.provisionalMaps);
            const burst = (l: Lineage) => {
                if (p.burstMaps <= 0) return 1;
                const load = (l.load ?? 0) * Math.exp(-(m.t - (l.loadT ?? m.t)) / (p.burstDays * 86400));
                l.load = load + 1;
                l.loadT = m.t;
                return 1 / (1 + load / p.burstMaps);
            };
            const updateExpected = p.regionPriorInUpdate
                ? expected
                : this.mapProbability(A, B, map.map, m.t, shift - this.regionGap(A, B));
            const surprise = target - updateExpected;
            A.rating += kBase * mult * provisional(A) * burst(A) * surprise;
            B.rating -= kBase * mult * provisional(B) * burst(B) * surprise;
            A.maps++;
            B.maps++;
            for (const l of [A, B]) if (l.maps === 30) l.rating30 = l.rating;

            this.updateMapOffset(A, map.map, p.kMap * surprise, m.t);
            this.updateMapOffset(B, map.map, -p.kMap * surprise, m.t);
            this.pool.record(m.t, map.map);
        });

        prediction.after = [A.rating, B.rating];
        for (const l of [A, B]) {
            l.lastT = m.t;
            if (crossRegion) l.lastCrossT = m.t;
            l.tiers.push(tier);
            if (l.tiers.length > 10) l.tiers.shift();
        }
        return prediction;
    }

    /** At the first CS2 series after CS:GO ones, every lineage closes `gameRegress` of its gap to its tier's mean. */
    private switchGame(t: number): void {
        const targets = this.lineages.map((l) => (l.tiers.length ? this.tierMean(median(l.tiers), t) : l.rating));
        this.lineages.forEach((l, i) => (l.rating += this.params.gameRegress * (targets[i] - l.rating)));
    }

    /** Players without history take their teammates' mean θ, so a side's θ̄ is the mean over those with history. */
    private skillGap(lineups: [string[], string[]], t: number): number {
        if (!this.skill) return 0;
        const known = lineups.map((l) => l.map((player) => this.skill!(player, t)).filter((θ) => θ !== undefined));
        if (known.some((θs) => θs.length < MIN_SKILL_PLAYERS)) return 0;
        const [a, b] = known.map((θs) => θs.reduce((s, θ) => s + θ, 0) / θs.length);
        return a - b;
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

    /** Valve region, with Oceania (3+ AU/NZ players) split out of Asia as 3. */
    private fineRegionOf(core: string[]): number | null {
        const oceania = core.filter((p) => OCEANIA.has((this.players[p]?.country ?? "").toLowerCase())).length;
        return oceania >= 3 ? FINE_OCEANIA : this.regionOf(core);
    }

    /** Fixed rating offset of a lineage's region against Europe; 0 when unknown. */
    regionPrior(l: Lineage): number {
        const p = this.params;
        return l.fineRegion == null ? 0 : [0, p.regionPriorAmericas, p.regionPriorAsia, p.regionPriorOceania][l.fineRegion];
    }

    /** Fixed rating offset between two regions; 0 within a region or when either is unknown. */
    regionGap(a: Lineage, b: Lineage): number {
        if (a.fineRegion == null || b.fineRegion == null || a.fineRegion === b.fineRegion) return 0;
        return this.regionPrior(a) - this.regionPrior(b);
    }

    /** Multiplier on the map logit for series odds; `oceaniaTemp` for Oceania v Oceania, else 1. */
    mapTemp(a: Lineage, b: Lineage): number {
        return a.fineRegion === FINE_OCEANIA && b.fineRegion === FINE_OCEANIA ? this.params.oceaniaTemp : 1;
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
                lineage.fineRegion = this.fineRegionOf(newCore);
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
                seed: seed + p.newRosterRegress * (mean - seed),
                seedsFromMean: lineup.filter((player) => !this.playerLineage.has(player)).length,
                seedTier: tier,
                mapOffsets: new Map(),
                region: this.regionOf(lineup),
                fineRegion: this.fineRegionOf(lineup),
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
