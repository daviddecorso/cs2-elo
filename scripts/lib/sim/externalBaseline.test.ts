import { describe, expect, it } from "vitest";
import { scoreStage, stageOutcomes } from "./backtest.ts";
import type { EventConfig, StageConfig } from "./config.ts";
import { externalTally } from "./externalBaseline.ts";
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
const actual = runEvent({ config, known: new Map(), horizon: 0 }, favouriteWins, makeRng(1));
const [swiss, playoffs] = config.stages;

const SWISS_ROW: Record<string, number[]> = { "3-0": [100, 100, 0, 0, 0], "3-X": [100, 0, 100, 0, 0], "0-3": [0, 0, 0, 0, 100], out: [0, 0, 0, 0, 0] };
const PLAYOFF_ROW: Record<string, number[]> = { "1": [100, 100, 100], "2": [100, 100, 0], "3-4": [100, 0, 0], "5-8": [0, 0, 0] };
const certain = (stage: StageConfig, rows: Record<string, number[]>): Record<string, Array<number | null>> =>
    Object.fromEntries([...stageOutcomes(actual, config, stage)].map(([team, label]) => [team, rows[label]]));

describe("external forecasts", () => {
    it("scores marginals that knew every result as certain", () => {
        const { tally, buckets } = externalTally(swiss, "playoffs", actual.entrants.get("swiss")!, certain(swiss, SWISS_ROW));
        expect(buckets).toBe(true);
        const score = scoreStage(config, actual, tally, swiss);
        expect(score.logLoss).toBe(0);
        expect(score.advance.every((f) => f.p === f.y)).toBe(true);

        const bracket = externalTally(playoffs, undefined, actual.entrants.get("playoffs")!, certain(playoffs, PLAYOFF_ROW));
        expect(scoreStage(config, actual, bracket.tally, playoffs).logLoss).toBe(0);
    });

    it("scores only advancement when the 0-3 column is missing", () => {
        const rows = Object.fromEntries(Object.entries(certain(swiss, SWISS_ROW)).map(([t, r]) => [t, [...r.slice(0, 4), null]]));
        expect(externalTally(swiss, "playoffs", actual.entrants.get("swiss")!, rows).buckets).toBe(false);
    });

    it("rejects a 0-3 column that doesn't sum like 3-0", () => {
        const rows = certain(swiss, SWISS_ROW);
        const out = Object.keys(rows).find((t) => rows[t][0] === 0 && rows[t][4] === 0)!;
        rows[out] = [0, 0, 0, 0, 100];
        expect(() => externalTally(swiss, "playoffs", actual.entrants.get("swiss")!, rows)).toThrow(/0-3 sums/);
    });

    it("rejects a field that doesn't match the stage's entrants", () => {
        const rows = certain(swiss, SWISS_ROW);
        delete rows.t01;
        expect(() => externalTally(swiss, "playoffs", actual.entrants.get("swiss")!, rows)).toThrow(/missing t01/);
    });
});
