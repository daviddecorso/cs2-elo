import { makeLineupResolver } from "../lineups.ts";
import type { EloParams } from "./params.ts";
import { PlayerRatings } from "./playerElo.ts";
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
    /** Oldest `lastT` among the lineages its rated seed players came from; undefined when every seed was unrated. */
    seedT?: number;
    /** Rating after its 30th map. */
    rating30?: number;
    /** `maps` at its latest core change; undefined if its core never changed. */
    coreChangeMaps?: number;
    /** Its series, with whether the opponent shared its Valve region; trimmed to `INSULARITY_WINDOW`. */
    regionHistory?: Array<{ t: number; maps: number; same: boolean }>;
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
    /** `regions` with Oceania split out of Asia as 3. */
    fineRegions: [number | null, number | null];
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
    /** Maps each side has played since its latest core change, or null if its core never changed. */
    mapsSinceCoreChange: [number | null, number | null];
    /** Each side's share of its maps in the last 180 days against its own Valve region; null under 10 maps. */
    ownRegionShare: [number | null, number | null];
    /** Maps each side's lineage had rated before this series. */
    sideMaps: [number, number];
    /** Days since each side's previous series; null for a lineage's first. */
    sideIdleDays: [number | null, number | null];
    /** How many of each lineage's seed players were unrated at its creation. */
    seedsFromMean: [number, number];
    /** Days between the stalest seed player's last series and the lineage's creation; null when no seed was rated. */
    seedAgeDays: [number | null, number | null];
    /** Player Elo gap of `lineups` before the series (`playerElo.ts`), whatever `playerBlend` is. */
    playerGap: number;
}

/** A map's luck-adjusted result from duel expectations, from teams[0]'s view. */
export interface LuckRow {
    /** Signed round margin had every duel gone at its expected rate. */
    xMargin: number;
    /** P(teams[0] wins the map | xMargin). */
    yHat: number;
    /** 0–1: mean share of the map's θ that rests on the players' own duels rather than the prior; scales `luckWeight` under `luckReliability`. */
    reliability?: number;
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

/** θ = execution over earlier series / (their duels + k), each series weighted `0.5^(age / halfLifeDays)` when that is > 0; a series never sees its own maps. */
export const makeSkillLookup = ({ k, players }: PlayerSkill, halfLifeDays = 0): SkillLookup => {
    const halfLife = halfLifeDays * 86400;
    // Running sums of values scaled by 2^((t − t0) / halfLife), rescaled at the query time.
    const growth = (t: number, t0: number) => (halfLife > 0 ? 2 ** ((t - t0) / halfLife) : 1);
    const cumulative = new Map<string, { t: number[]; exec: number[]; duels: number[] }>();
    for (const [player, rows] of Object.entries(players)) {
        let e = 0;
        let d = 0;
        const t0 = rows[0]?.[0] ?? 0;
        cumulative.set(player, {
            t: rows.map((r) => r[0]),
            exec: rows.map((r) => (e += r[1] * growth(r[0], t0))),
            duels: rows.map((r) => (d += r[2] * growth(r[0], t0))),
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
        if (lo === 0) return undefined;
        const scale = growth(t, c.t[0]);
        return c.exec[lo - 1] / scale / (c.duels[lo - 1] / scale + k);
    };
};

const TIER_ACTIVE_SECONDS = 120 * 24 * 3600;
const TRANSFER_ACTIVE_SECONDS = 180 * 24 * 3600;
const TRANSFER_MIN_MAPS = 30;
const DEFAULT_TIER = 4;
const MIN_SKILL_PLAYERS = 3;
const BASE_RATING = 1500;
const OCEANIA = new Set(["au", "nz"]);
export const FINE_OCEANIA = 3;
export const ASIA = 2;

export const isOceaniaInternal = (p: Pick<SeriesPrediction, "fineRegions">): boolean =>
    p.fineRegions[0] === FINE_OCEANIA && p.fineRegions[1] === FINE_OCEANIA;
const INSULARITY_WINDOW = 180 * 24 * 3600;
const INSULARITY_MIN_MAPS = 10;

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
    private tierMeanCache = { day: -1, means: [] as Array<number | null> };
    private params: EloParams;
    private players: EloPlayers;
    private luck: LuckLookup | undefined;
    private skill: SkillLookup | undefined;
    private playerRatings: PlayerRatings;

    constructor(params: EloParams, players: EloPlayers, luck?: LuckLookup, skill?: SkillLookup) {
        this.params = params;
        this.players = players;
        this.luck = luck;
        this.skill = skill;
        this.playerRatings = new PlayerRatings(params);
    }

    /** Player Elo gap of lineup `a` over `b`, without rating anyone new; `tier` seeds unrated players. */
    playerGap(a: string[], b: string[], tier: number | null): number {
        const t = clampTier(tier);
        return this.playerRatings.teamRating(a, t) - this.playerRatings.teamRating(b, t);
    }

    /** A lineage rating gap blended with a player Elo gap by `playerBlend`; the lineage gap alone when `playerGap` is undefined or the blend is off. */
    blendGap(lineageGap: number, playerGap: number | undefined): number {
        const { playerBlend, playerTemp } = this.params;
        if (playerGap === undefined || !playerBlend) return lineageGap;
        return (1 - playerBlend) * lineageGap + playerBlend * playerTemp * playerGap;
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

    /** Map win probability for `a` over `b`, with `extraGap` added to their rating gap; with no map, averaged over the pool active at `t`. A `playerGap` blends in player Elo (`blendGap`). */
    mapProbability(a: Lineage, b: Lineage, map: string | null, t: number, extraGap = 0, playerGap?: number): number {
        const { scale } = this.params;
        const diff = a.rating - b.rating + extraGap + this.regionGap(a, b);
        const onMap = (m: string) => expectedScore(this.blendGap(diff + (a.mapOffsets.get(m) ?? 0) - (b.mapOffsets.get(m) ?? 0), playerGap), scale);
        if (map) return onMap(map);
        const pool = this.pool.at(t);
        if (pool.length === 0) return expectedScore(this.blendGap(diff, playerGap), scale);
        let total = 0;
        for (const m of pool) total += onMap(m);
        return total / pool.length;
    }

    private playSeries(m: EloMatch, lineups: [string[] | null, string[] | null]): SeriesPrediction | null {
        const tier = clampTier(m.tier);
        const sides = m.teams.map((team, i) => this.lineageFor(team, lineups[i], tier, m.t));
        const [a, b] = sides;
        if (!a || !b || a.lineage === b.lineage) return null;
        const A = a.lineage;
        const B = b.lineage;
        const sideIdleDays = [A, B].map((l) => (l.maps === 0 ? null : (m.t - l.lastT) / 86400)) as [number | null, number | null];

        const bestOf = seriesLength(m.bestOf);
        const sideLineups: [string[], string[]] = [lineups[0] ?? A.core, lineups[1] ?? B.core];
        const skillGap = this.skillGap(sideLineups, m.t);
        // The shifted expectation feeds the update too, so the rating learns only what the skill term leaves over.
        const shift = this.params.skillWeight * skillGap;
        const ownRegionShare: [number | null, number | null] = [this.ownRegionShare(A, m.t), this.ownRegionShare(B, m.t)];
        const insular = this.insularityGap(A, B, ownRegionShare);
        const bothOceania = A.fineRegion === FINE_OCEANIA && B.fineRegion === FINE_OCEANIA;
        // Predictions only: the update keeps the unshifted expectation, so the offset never moves rating points.
        const debut = this.debutGap(A, B) + this.newLanGap(A, B, m.lan);
        let playerGap = this.playerRatings.seed(sideLineups[0], tier) - this.playerRatings.seed(sideLineups[1], tier);
        const blended = this.params.playerBlend !== 0;
        const rawMap = this.mapProbability(A, B, null, m.t, shift + insular + debut, playerGap);
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
            fineRegions: [A.fineRegion ?? null, B.fineRegion ?? null],
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
            mapsSinceCoreChange: [A, B].map((l) => (l.coreChangeMaps === undefined ? null : l.maps - l.coreChangeMaps)) as [number | null, number | null],
            ownRegionShare,
            sideMaps: [A.maps, B.maps],
            sideIdleDays,
            seedsFromMean: [A.seedsFromMean ?? 0, B.seedsFromMean ?? 0],
            seedAgeDays: [A, B].map((l) => (l.seedT === undefined ? null : (l.firstT - l.seedT) / 86400)) as [number | null, number | null],
            playerGap,
        };

        const p = this.params;
        const kBase =
            p.k * (m.lan ? 1 : p.onlineK) * p.tierK ** (tier - 1) * (crossRegion ? p.crossRegionK : 1) * (standIn ? p.standInK : 1) * (bothOceania ? p.oceaniaK : 1);
        m.maps.forEach((map, index) => {
            const expected = this.mapProbability(A, B, map.map, m.t, shift + insular);
            const y = map.rounds[0] > map.rounds[1] ? 1 : 0;
            const ratings: [number, number] = [
                A.rating + (A.mapOffsets.get(map.map) ?? 0),
                B.rating + (B.mapOffsets.get(map.map) ?? 0),
            ];
            let margin = mapMargin(map.rounds, p.otMargin, m.game === "csgo") * (y ? 1 : -1);
            const predictionTemp = p.predictionTemp;
            const predicted = debut || blended ? this.mapProbability(A, B, map.map, m.t, shift + insular + debut, playerGap) : expected;
            const mapP = predictionTemp !== 1 ? 1 / (1 + (predicted / (1 - predicted)) ** -predictionTemp) : predicted;
            prediction.maps.push({ map: map.map, p: mapP, y, margin, ratings });
            // Player Elo learns from the real result and margin, never the luck- or round-adjusted target below.
            this.playerRatings.update(sideLineups, tier, playerGap, margin, y);
            playerGap = this.playerRatings.teamRating(sideLineups[0], tier) - this.playerRatings.teamRating(sideLineups[1], tier);

            // Updates use a blend of the real result and the luck-adjusted one; predictions above always use the real y and margin.
            let target: number = y;
            const roundWeight = p.roundWeight * (tier === 1 ? p.roundTier1Scale : 1);
            if (roundWeight > 0) target = (1 - roundWeight) * y + roundWeight / (1 + Math.exp(-p.roundSlope * margin));
            const luck = p.luckWeight > 0 ? this.luck?.(m.id, index) : undefined;
            if (luck) {
                const w = p.luckWeight * (p.luckReliability ? (luck.reliability ?? 1) : 1);
                margin = (1 - w) * margin + w * luck.xMargin;
                target = (1 - w) * target + w * luck.yHat;
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
            const updateGap = shift + (p.insularityInUpdate ? insular : 0) - (p.regionPriorInUpdate ? 0 : this.regionGap(A, B));
            const updateExpected = updateGap === shift + insular ? expected : this.mapProbability(A, B, map.map, m.t, updateGap);
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
        const sameRegion = A.region !== null && A.region === B.region;
        for (const l of [A, B]) {
            (l.regionHistory ??= []).push({ t: m.t, maps: m.maps.length, same: sameRegion });
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

    /** Share of its maps in the last 180 days against its own Valve region; null under 10 maps. */
    ownRegionShare(l: Lineage, t: number): number | null {
        const history = (l.regionHistory ?? []).filter((e) => e.t >= t - INSULARITY_WINDOW);
        l.regionHistory = history;
        const total = history.reduce((n, e) => n + e.maps, 0);
        return total < INSULARITY_MIN_MAPS ? null : history.reduce((n, e) => n + (e.same ? e.maps : 0), 0) / total;
    }

    /** Read-only lineage lookup for an upcoming side: 3+ player overlap first, then team page, then earlier team names. */
    resolveLineage(team: string, lineup?: string[], previousNames?: string[]): Lineage | undefined {
        const current = this.teamLineage.get(team);
        if (lineup && lineup.length >= 3) {
            const candidates = new Set<Lineage>();
            if (current) candidates.add(current);
            for (const player of lineup) {
                const l = this.playerLineage.get(player);
                if (l) candidates.add(l);
            }
            let best: Lineage | undefined;
            let bestOverlap = 0;
            for (const l of candidates) {
                const overlap = lineup.filter((player) => l.core.includes(player)).length;
                if (overlap > bestOverlap || (overlap === bestOverlap && l === current)) {
                    best = l;
                    bestOverlap = overlap;
                }
            }
            if (best && bestOverlap >= 3) return best;
        }
        if (current) return current;
        for (const prev of previousNames ?? []) {
            const hit = this.teamLineage.get(prev);
            if (hit) return hit;
        }
        return undefined;
    }

    /** Pre-series odds and active-pool map probabilities for an unplayed matchup, without mutating engine state. */
    predictMatchup(
        teams: [string, string],
        opts: {
            t: number;
            bestOf: number;
            lan: boolean;
            tier: number | null;
            lineups?: [string[], string[]];
            previousNames?: [string[], string[]];
        }
    ): {
        p: number;
        seriesOdds: { bo1: number; bo3: number; bo5: number };
        lineages: [Lineage | null, Lineage | null];
        ratings: [number | null, number | null];
        maps: Array<{ map: string; p: number; offsets: [number, number] }>;
    } {
        const la = this.resolveLineage(teams[0], opts.lineups?.[0], opts.previousNames?.[0]) ?? null;
        const lb = this.resolveLineage(teams[1], opts.lineups?.[1], opts.previousNames?.[1]) ?? null;
        const tier = clampTier(opts.tier);
        const fallback = this.tierMean(tier, opts.t);
        const pool = this.pool.at(opts.t);
        const seriesTemp = opts.lan ? this.params.seriesMapTemp : this.params.seriesMapTempOnline;
        const applyTemp = (prob: number, temp: number) =>
            temp !== 1 && prob > 0 && prob < 1 ? 1 / (1 + (prob / (1 - prob)) ** -temp) : prob;

        let pMap: number;
        let maps: Array<{ map: string; p: number; offsets: [number, number] }>;

        if (la && lb) {
            const shareOf = (l: Lineage) => {
                const recent = (l.regionHistory ?? []).filter((e) => e.t >= opts.t - INSULARITY_WINDOW);
                const total = recent.reduce((n, e) => n + e.maps, 0);
                return total < INSULARITY_MIN_MAPS ? null : recent.reduce((n, e) => n + (e.same ? e.maps : 0), 0) / total;
            };
            const gap = this.insularityGap(la, lb, [shareOf(la), shareOf(lb)]) + this.debutGap(la, lb) + this.newLanGap(la, lb, opts.lan);
            const lineupOf = (i: 0 | 1, l: Lineage) => (opts.lineups && opts.lineups[i].length >= 3 ? opts.lineups[i] : l.core);
            const playerGap = this.playerGap(lineupOf(0, la), lineupOf(1, lb), tier);
            const temp = this.mapTemp(la, lb);
            pMap = applyTemp(this.mapProbability(la, lb, null, opts.t, gap, playerGap), temp);
            maps = pool.map((map) => ({
                map,
                p: applyTemp(this.mapProbability(la, lb, map, opts.t, gap, playerGap), temp),
                offsets: [la.mapOffsets.get(map) ?? 0, lb.mapOffsets.get(map) ?? 0],
            }));
        } else {
            const ra = la ? la.rating + this.regionPrior(la) : fallback;
            const rb = lb ? lb.rating + this.regionPrior(lb) : fallback;
            const temp = this.params.predictionTemp;
            if (pool.length === 0) {
                pMap = applyTemp(expectedScore(ra - rb, this.params.scale), temp);
                maps = [];
            } else {
                let sum = 0;
                maps = pool.map((map) => {
                    const oa = la?.mapOffsets.get(map) ?? 0;
                    const ob = lb?.mapOffsets.get(map) ?? 0;
                    const raw = expectedScore(ra - rb + oa - ob, this.params.scale);
                    sum += raw;
                    return { map, p: applyTemp(raw, temp), offsets: [oa, ob] };
                });
                pMap = applyTemp(sum / pool.length, temp);
            }
        }

        const bo1 = seriesWinProbability(pMap, 1, seriesTemp);
        const bo3 = seriesWinProbability(pMap, 3, seriesTemp);
        const bo5 = seriesWinProbability(pMap, 5, seriesTemp);
        const len = seriesLength(opts.bestOf > 0 ? opts.bestOf : 3);
        const p = len === 1 ? bo1 : len === 5 ? bo5 : bo3;
        return {
            p,
            seriesOdds: { bo1, bo3, bo5 },
            lineages: [la, lb],
            ratings: [la ? la.rating + this.regionPrior(la) : null, lb ? lb.rating + this.regionPrior(lb) : null],
            maps,
        };
    }

    /** `insularityPrior` for insular rest-of-Asia rosters on cross-region maps, as a gap for `a` over `b`. */
    private insularityGap(a: Lineage, b: Lineage, shares: [number | null, number | null]): number {
        const prior = this.params.insularityPrior;
        if (!prior || a.region === null || b.region === null || a.region === b.region) return 0;
        const offset = (l: Lineage, share: number | null) =>
            l.fineRegion === ASIA && share !== null ? (prior * Math.max(0, share - 0.5)) / 0.5 : 0;
        return offset(a, shares[0]) - offset(b, shares[1]);
    }

    /** `debutOffset` for lineages seeded from unrated players, scaled by their share of the seed and fading over `debutMaps`, as a gap for `a` over `b`. */
    debutGap(a: Lineage, b: Lineage): number {
        const { debutOffset, debutMaps } = this.params;
        if (!debutOffset) return 0;
        const offset = (l: Lineage) => (debutOffset * (l.seedsFromMean ?? 0) * Math.max(0, 1 - l.maps / debutMaps)) / 5;
        return offset(b) - offset(a);
    }

    newLanGap(a: Lineage, b: Lineage, lan: boolean): number {
        const { newLanOffset, newLanMaps } = this.params;
        if (!lan || !newLanOffset) return 0;
        const offset = (l: Lineage) => newLanOffset * Math.max(0, 1 - l.maps / newLanMaps);
        return offset(b) - offset(a);
    }

    /** Multiplier on the map logit for predictions: `predictionTemp`, times `oceaniaTemp` for Oceania v Oceania. */
    mapTemp(a: Lineage, b: Lineage): number {
        return this.params.predictionTemp * (a.fineRegion === FINE_OCEANIA && b.fineRegion === FINE_OCEANIA ? this.params.oceaniaTemp : 1);
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
            const incoming = newCore.filter((player) => !lineage.core.includes(player));
            const replaced = incoming.length;
            if (replaced > 0) {
                const mean = this.tierMean(tier, t);
                lineage.rating += p.regress * (replaced / 5) * (mean - lineage.rating);
                if (p.transferWeight > 0) {
                    const priors = incoming.map((player) => this.transferPrior(player, lineage, t));
                    const target = priors.reduce((sum, r) => sum + r, 0) / replaced;
                    lineage.rating += p.transferWeight * (replaced / 5) * (target - lineage.rating);
                }
                lineage.core = newCore;
                lineage.coreChangeMaps = lineage.maps;
                lineage.region = this.regionOf(newCore);
                lineage.fineRegion = this.fineRegionOf(newCore);
            }
            lineage.team = team;
        } else {
            const mean = this.tierMean(tier, t);
            const sources = lineup.map((player) => this.playerLineage.get(player));
            const seeds = sources.map((l) => l?.rating ?? mean - p.unratedSeedOffset);
            const seed = seeds.reduce((sum, r) => sum + r, 0) / seeds.length;
            const rated = sources.filter((l) => l !== undefined);
            lineage = {
                id: this.lineages.length,
                team,
                core: [...lineup],
                rating: seed + p.newRosterRegress * (mean - seed),
                seed: seed + p.newRosterRegress * (mean - seed),
                seedsFromMean: lineup.filter((player) => !this.playerLineage.has(player)).length,
                seedTier: tier,
                seedT: rated.length ? Math.min(...rated.map((l) => l.lastT)) : undefined,
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

    /** An incoming player's rating from their previous lineage, on `to`'s region scale; `to`'s own rating when that lineage is unproven or stale. */
    private transferPrior(player: string, to: Lineage, t: number): number {
        const from = this.playerLineage.get(player);
        if (!from || from === to || from.maps < TRANSFER_MIN_MAPS || from.lastT < t - TRANSFER_ACTIVE_SECONDS) return to.rating;
        return from.rating + this.regionPrior(from) - this.regionPrior(to);
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
