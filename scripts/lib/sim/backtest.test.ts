import { describe, expect, it } from "vitest";
import { calibration, championOf, pickemCorrect, pickemSets, scoreEvent, scoreStage, stageOutcomes, tallyEvent } from "./backtest.ts";
import type { EventConfig } from "./config.ts";
import type { SeriesModel } from "./predict.ts";
import { makeRng } from "./rng.ts";
import { runEvent } from "./simulate.ts";

const teams = Array.from({ length: 16 }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);
const config: EventConfig = {
    slug: "test-major",
    name: "Test Major",
    liquipedia: "Test/Major",
    startDate: "2026-01-01",
    endDate: "2026-01-10",
    lan: true,
    stages: [
        {
            id: "swiss",
            name: "Swiss",
            page: "Test/Major/Swiss",
            format: "swiss",
            bestOf: { default: 1, decider: 3 },
            invited: teams,
            advance: 8,
            exits: { "2-3": "9-11", "1-3": "12-14", "0-3": "15-16" },
        },
        {
            id: "playoffs",
            name: "Playoffs",
            page: "Test/Major/Playoffs",
            format: "single_elim",
            bestOf: { default: 3 },
            from: "swiss",
            advance: 0,
            exits: { r1: "5-8", r2: "3-4", r3: "2", champion: "1" },
        },
    ],
};
const favouriteWins: SeriesModel = { resample: () => {}, setHorizon: () => {}, seriesProbability: (a, b) => (a < b ? 1 : 0) };

describe("Major backtest scoring", () => {
    const actual = runEvent({ config, known: new Map(), horizon: 0 }, favouriteWins, makeRng(1));
    const tally = tallyEvent(config, new Map(), favouriteWins, { n: 50, seed: 1 });

    it("scores a model that knew every result as certain", () => {
        expect(championOf(actual)).toBe("t01");
        const swiss = scoreStage(config, actual, tally, config.stages[0]);
        expect(swiss.logLoss).toBe(0);
        expect(swiss.pChampion).toBe(1);
        expect(swiss.championRank).toBe(1);
        expect(swiss.advance.every((f) => f.p === f.y)).toBe(true);
        const event = scoreEvent(config, actual, tally);
        expect(event.placementLogLoss).toBe(0);
        expect(event.championBrier).toBe(0);
    });

    it("buckets Swiss records the way Pick'em scores them", () => {
        const truth = stageOutcomes(actual, config, config.stages[0]);
        expect(truth.get("t01")).toBe("3-0");
        expect(truth.get("t16")).toBe("0-3");
        expect([...truth.values()].filter((v) => v === "3-0")).toHaveLength(2);
        expect(stageOutcomes(actual, config, config.stages[1]).get("t01")).toBe("1");
    });

    it("picks a perfect Pick'em set when results are certain", () => {
        const truth = stageOutcomes(actual, config, config.stages[0]);
        const sets = pickemSets(config.stages[0], teams, favouriteWins.seriesProbability, { n: 50, seed: 1 })!;
        expect(pickemCorrect(sets.coin, truth)).toBe(10);
        expect(pickemCorrect(sets.favourites, truth)).toBe(10);
    });

    it("buckets calibration by tenths", () => {
        const buckets = calibration([
            { p: 0.05, y: 0 },
            { p: 0.95, y: 1 },
            { p: 1, y: 1 },
        ]);
        expect(buckets[0].n).toBe(1);
        expect(buckets[9]).toMatchObject({ n: 2, observed: 1 });
    });
});
