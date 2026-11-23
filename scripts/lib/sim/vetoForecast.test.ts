import { describe, expect, it } from "vitest";
import type { SeriesPrediction } from "../elo/engine.ts";
import { loadVetoWeights } from "./veto.ts";
import { makeVetoForecaster } from "./vetoForecast.ts";

const pool = ["A", "B", "C", "D", "E", "F", "G"];
const offsets = Object.fromEntries(pool.map((m) => [m, 0]));
const weights = loadVetoWeights()!;

const series = (lineages: [number, number], maps: string[]) =>
    ({
        t: 0,
        lineages,
        ratings: [0, 0],
        poolOffsets: [offsets, offsets],
        maps: maps.map((map) => ({ map, y: 1 })),
    }) as unknown as SeriesPrediction;

const predictions = Array.from({ length: 20 }, () => [series([0, 2], ["A", "A", "B"]), series([1, 3], ["C", "C", "D"])]).flat();
const forecast = makeVetoForecaster({ weights, predictions, pool, t: 0, eloScale: 400 });
const ask = (bestOf: number, lineages: [number, number] = [0, 1]) => forecast({ lineages, ratings: [100, 0], bestOf });

describe("makeVetoForecaster", () => {
    it("labels every map of a Bo3 and names each side's likeliest pick", () => {
        const veto = ask(3);
        if (veto?.kind !== "chances") throw new Error("expected chances");
        expect(veto.maps.map((m) => m.map).sort()).toEqual(pool);
        // Either of a team's two maps: the opponent tends to ban its favourite.
        expect(["A", "B"]).toContain(veto.maps.find((m) => m.pickedBy?.includes(0))?.map);
        expect(["C", "D"]).toContain(veto.maps.find((m) => m.pickedBy?.includes(1))?.map);
    });

    it("names no pick when two maps tie", () => {
        const tied = Array.from({ length: 20 }, () => [series([0, 2], ["A", "B"]), series([1, 3], ["C", "D"])]).flat();
        const veto = makeVetoForecaster({ weights, predictions: tied, pool, t: 0, eloScale: 400 })({
            lineages: [0, 1],
            ratings: [0, 0],
            bestOf: 3,
        });
        if (veto?.kind !== "chances") throw new Error("expected chances");
        expect(veto.maps.some((m) => m.pickedBy)).toBe(false);
    });

    it("labels a Bo5 without naming picks", () => {
        const veto = ask(5);
        if (veto?.kind !== "chances") throw new Error("expected chances");
        expect(veto.maps).toHaveLength(7);
        expect(veto.maps.some((m) => m.pickedBy)).toBe(false);
    });

    it("gives a Bo1 only its top maps", () => {
        const veto = ask(1);
        if (veto?.kind !== "shortlist") throw new Error("expected a shortlist");
        expect(veto.maps).toHaveLength(weights.forecast.bo1Shown);
    });

    it("stays silent for other formats, short pools, one lineage twice and teams it knows nothing about", () => {
        expect(ask(0)).toBeUndefined();
        expect(ask(2)).toBeUndefined();
        expect(ask(3, [0, 0])).toBeUndefined();
        expect(ask(3, [8, 9])).toBeUndefined();
        const short = makeVetoForecaster({ weights, predictions, pool: pool.slice(1), t: 0, eloScale: 400 });
        expect(short({ lineages: [0, 1], ratings: [0, 0], bestOf: 3 })).toBeUndefined();
    });
});
