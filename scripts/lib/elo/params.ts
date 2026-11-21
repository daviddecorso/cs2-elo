import fs from "node:fs";
import path from "node:path";

export const TUNED_PARAMS_PATH = path.resolve(import.meta.dirname, "params.json");

export interface EloParams {
    /** Rating points per map at full surprise, before multipliers. */
    k: number;
    /** Rating gap for 10:1 map odds. */
    scale: number;
    /** Weight on ln(1 + round margin) in the K multiplier; 0 ignores margin. */
    marginWeight: number;
    /** Round margin credited to an overtime winner. */
    otMargin: number;
    /** K multiplier for online maps (LAN is 1). */
    onlineK: number;
    /** K multiplier per Liquipedia tier below tier 1, compounding. */
    tierK: number;
    /** K multiplier when the two rosters come from different Valve regions. */
    crossRegionK: number;
    /** Extra K fraction for a new lineage, fading to 0 over `provisionalMaps`. */
    provisionalK: number;
    provisionalMaps: number;
    /** K divides by 1 + (maps in the last ~`burstDays`, decayed) / `burstMaps`, so a run of maps at one event counts less than spread-out maps; 0 is off. */
    burstMaps: number;
    burstDays: number;
    /** Fraction of the gap to the tier mean closed when all 5 core players change; partial changes scale by replaced/5. */
    regress: number;
    /** Fraction of the gap to its tier mean every lineage closes at the CS:GO → CS2 switch; no effect without CS:GO series. */
    gameRegress: number;
    /** Fraction of the gap to the tier mean closed when seeding a new lineage from its players' old ratings. */
    newRosterRegress: number;
    /** Rating points per map moved into the per-map offsets. */
    kMap: number;
    /** Fraction of every map offset removed after each update. */
    mapShrink: number;
    /** Recent series of a lineage that vote on its core 5. */
    coreWindow: number;
    /** Rating gap between adjacent tiers before any tier has rated rosters. */
    tierGap: number;
    /** K multiplier for series with a player outside the core. */
    standInK: number;
    /** Map logit multiplier before converting to Bo3/Bo5 odds; below 1 softens the independent-maps binomial. */
    seriesMapTemp: number;
    /** `seriesMapTemp` for online series; LAN series use `seriesMapTemp`. Defaults to `seriesMapTemp` when unset. */
    seriesMapTempOnline: number;
    /** Weight on the duel-expected result in rating updates, 0–1; only maps with a luck row are affected. */
    luckWeight: number;
    /** Rating points added to the gap per unit of the sides' mean prior duel-skill (θ) difference; needs a SkillLookup. */
    skillWeight: number;
    /** Fixed rating offsets against Europe, added to the gap whenever two rosters' regions differ (Oceania split out of Asia). */
    regionPriorAmericas: number;
    regionPriorAsia: number;
    regionPriorOceania: number;
    /** 1 puts the region priors in the update's expected score too; 0 applies them to predictions only. */
    regionPriorInUpdate: number;
    /** 1 counts Oceania v the rest of Asia as cross-region for `crossRegionK`; 0 follows Valve's regions. */
    oceaniaCross: number;
    /** K multiplier for Oceania v Oceania maps. */
    oceaniaK: number;
    /** Map logit multiplier for Oceania v Oceania series odds; above 1 sharpens. Predictions only. */
    oceaniaTemp: number;
}

/** Values before tuning; `npm run backtest-elo -- --tune --write` saves the tuned set to `params.json`, which overrides these. */
export const STARTING_PARAMS: EloParams = {
    k: 24,
    scale: 400,
    marginWeight: 0.5,
    otMargin: 2,
    onlineK: 0.8,
    tierK: 0.9,
    crossRegionK: 1.5,
    provisionalK: 1,
    provisionalMaps: 20,
    regress: 0.5,
    gameRegress: 0.3,
    newRosterRegress: 0.3,
    kMap: 6,
    mapShrink: 0.01,
    coreWindow: 5,
    tierGap: 100,
    standInK: 1,
    seriesMapTemp: 1,
    seriesMapTempOnline: 1,
    luckWeight: 0,
    skillWeight: 0,
    burstMaps: 0,
    burstDays: 7,
    regionPriorAmericas: 0,
    regionPriorAsia: 0,
    regionPriorOceania: 0,
    regionPriorInUpdate: 1,
    oceaniaCross: 0,
    oceaniaK: 1,
    oceaniaTemp: 1,
};

const tuned = JSON.parse(fs.readFileSync(TUNED_PARAMS_PATH, "utf8")) as Partial<EloParams>;
export const DEFAULT_PARAMS: EloParams = {
    ...STARTING_PARAMS,
    ...tuned,
    seriesMapTempOnline: tuned.seriesMapTempOnline ?? tuned.seriesMapTemp ?? STARTING_PARAMS.seriesMapTempOnline,
};
