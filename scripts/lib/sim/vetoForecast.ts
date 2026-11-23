import type { MatchVeto, VetoChance } from "../../../src/elo/types.ts";
import type { SeriesPrediction } from "../elo/engine.ts";
import { VetoModel, type ChoiceWeights, type VetoWeightsFile } from "./veto.ts";
import { VetoInputs } from "./vetoInputs.ts";

/** Probabilities closer than this are a tie, which names no map. */
const TIE = 1e-9;

export interface VetoForecastArgs {
    lineages: [number, number];
    /** Comparable across regions; they decide who probably bans second. */
    ratings: [number, number];
    bestOf: number;
    order?: string;
}

export type VetoForecaster = (args: VetoForecastArgs) => MatchVeto | undefined;

const scaled = (weights: ChoiceWeights, by: number): ChoiceWeights => {
    const times = (w: Record<string, number>) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v * by]));
    return { ban: times(weights.ban), pick: times(weights.pick) };
};

export const makeVetoForecaster = ({
    weights,
    predictions,
    pool,
    t,
    eloScale,
}: {
    weights: VetoWeightsFile;
    predictions: SeriesPrediction[];
    pool: string[];
    t: number;
    eloScale: number;
}): VetoForecaster => {
    const inputs = new VetoInputs(weights.inputs, eloScale);
    for (const s of predictions) inputs.add(s);
    const { shrink, bands, bo1Shown } = weights.forecast;
    const choice = scaled(weights.choice, shrink);

    return ({ lineages, ratings, bestOf, order }) => {
        const actions = weights.actions[bestOf];
        if (!actions || pool.length !== actions.length + 1 || lineages[0] === lineages[1]) return undefined;

        const model = new VetoModel(
            {
                asOf: weights.asOf,
                pool,
                actions: weights.actions,
                orders: weights.orders,
                modes: { liquipedia: { map: weights.map, choice } },
                teams: { a: inputs.team(lineages[0], pool, t), b: inputs.team(lineages[1], pool, t) },
            },
            "liquipedia"
        );
        const gap = ratings[0] - ratings[1];
        const aSecond = gap === 0 ? 0.5 : gap > 0 ? weights.favouriteSecond : 1 - weights.favouriteSecond;
        const ranked = model
            .distribution("a", "b", bestOf, aSecond, order)
            .map((o, i) => ({ map: pool[i], picks: o.picks, selected: o.picks[0] + o.picks[1] + o.decider }))
            .sort((x, y) => y.selected - x.selected || x.map.localeCompare(y.map));
        if (ranked[0].selected - ranked[ranked.length - 1].selected < TIE) return undefined;

        if (bestOf === 1) return { kind: "shortlist", maps: ranked.slice(0, bo1Shown).map((o) => o.map) };

        const chanceOf = (p: number): VetoChance => (p >= bands.likely ? "likely" : p >= bands.possible ? "possible" : "unlikely");
        // Each team's likeliest pick was only validated on Bo3.
        const likeliestPicks =
            bestOf === 3
                ? ([0, 1] as const).map((side) => {
                      const [first, second] = [...ranked].sort((x, y) => y.picks[side] - x.picks[side]);
                      return first.picks[side] - second.picks[side] < TIE ? null : first.map;
                  })
                : [];
        return {
            kind: "chances",
            maps: ranked.map(({ map, selected }) => {
                const pickedBy = ([0, 1] as const).filter((side) => likeliestPicks[side] === map);
                return { map, chance: chanceOf(selected), ...(pickedBy.length ? { pickedBy } : {}) };
            }),
        };
    };
};
