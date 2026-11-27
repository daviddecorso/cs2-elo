import { describe, expect, it } from "vitest";
import type { SeriesPrediction } from "../elo/engine.ts";
import { eloGain, oriented, sideFeatures, type MarketRow } from "./diagnose.ts";

const D = 86400;
const pred = (id: string, t: number, lineages: [number, number], ratings: [number, number], after: [number, number]) =>
    ({ id, t, p: 0.7, y: 1, lineages, ratings, after, maps: [{}, {}], mapsSinceCoreChange: [null, null] }) as unknown as SeriesPrediction;

describe("oriented", () => {
    const row = { pred: pred("a", 0, [1, 2], [0, 0], [0, 0]), close: 0.6 } as MarketRow;

    it("flips probabilities and result for side 1 without changing the gain", () => {
        expect(oriented(row, 0)).toEqual({ elo: 0.7, close: 0.6, y: 1 });
        const b = oriented(row, 1);
        expect(b.elo).toBeCloseTo(0.3);
        expect(b.close).toBeCloseTo(0.4);
        expect(b.y).toBe(0);
        expect(eloGain(row)).toBeCloseTo(Math.log(0.7 / 0.6));
    });
});

describe("sideFeatures", () => {
    const preds = [0, 1, 2, 3, 4, 5, 6].map((i) => pred(`s${i}`, i * 10 * D, [1, 100 + i], [1000 + 10 * i, 900], [1005 + 10 * i, 895]));
    const features = sideFeatures(preds);

    it("tracks each side's idle days and maps played before the series", () => {
        expect(features.get("s0")!.idleDays).toEqual([null, null]);
        expect(features.get("s3")!.idleDays).toEqual([10, null]);
        expect(features.get("s3")!.maps).toEqual([6, 0]);
    });

    it("takes form over the last five series and the change up to the fifth next one", () => {
        expect(features.get("s4")!.form[0]).toBeNull();
        expect(features.get("s5")!.form[0]).toBe(50);
        expect(features.get("s0")!.future[0]).toBe(1050 - 1005);
        expect(features.get("s2")!.future[0]).toBeNull();
    });
});
