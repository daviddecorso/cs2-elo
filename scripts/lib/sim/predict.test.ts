import { describe, expect, it } from "vitest";
import { expectedScore, type EloEngine } from "../elo/engine.ts";
import { DEFAULT_PARAMS } from "../elo/params.ts";
import { Predictor } from "./predict.ts";

const ratings: Record<string, number> = { A: 1700, B: 1500 };
const makeEngine = (mapTemp = 1) =>
    ({
        teamLineageOf: (team: string) => (team in ratings ? { team, rating: ratings[team] } : undefined),
        mapProbability: (a: { rating: number }, b: { rating: number }) => expectedScore(a.rating - b.rating, DEFAULT_PARAMS.scale),
        mapTemp: () => mapTemp,
        regionGap: () => 0,
    }) as unknown as EloEngine;
const predictor = (tierTemp?: Record<number, number>, mapTemp?: number) =>
    new Predictor(makeEngine(mapTemp), DEFAULT_PARAMS, 0, { driftPerDay: 0, horizons: [0], fallbackRating: 1500, ...(tierTemp ? { tierTemp } : {}) });

describe("tier temperature", () => {
    it("leaves unlisted and unknown tiers alone", () => {
        const p = predictor({ 2: 0.5 });
        const base = p.seriesProbability("A", "B", 3);
        p.setTier(1);
        expect(p.seriesProbability("A", "B", 3)).toBe(base);
        p.setTier(null);
        expect(p.seriesProbability("A", "B", 3)).toBe(base);
    });

    it("pulls a listed tier's odds toward a coin flip", () => {
        const p = predictor({ 2: 0.5 });
        const base = p.seriesProbability("A", "B", 3);
        p.setTier(2);
        const tempered = p.seriesProbability("A", "B", 3);
        expect(tempered).toBeLessThan(base);
        expect(tempered).toBeGreaterThan(0.5);
    });
});

describe("pair temperature", () => {
    it("sharpens odds when the engine's map temperature is above 1", () => {
        const base = predictor().seriesProbability("A", "B", 3);
        const sharpened = predictor(undefined, 1.5).seriesProbability("A", "B", 3);
        expect(sharpened).toBeGreaterThan(base);
        expect(predictor(undefined, 1.5).seriesProbability("B", "A", 3)).toBeCloseTo(1 - sharpened, 10);
    });
});
