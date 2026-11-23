import { describe, expect, it } from "vitest";
import type { SeriesPrediction } from "../elo/engine.ts";
import { makeRng } from "./rng.ts";
import {
    acceptanceLogLikelihood,
    acceptanceShift,
    choiceLogLikelihood,
    choiceRow,
    EloTimeline,
    fitAcceptance,
    fitChoice,
    HABIT_ONLY,
    type ChoiceSample,
    type OfferSample,
} from "./value.ts";

const draw = (weights: number[], u: number) => {
    let left = u * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) if ((left -= weights[i]) <= 0) return i;
    return weights.length - 1;
};

describe("fitChoice", () => {
    it("recovers a planted repeat effect and a preference for fields near a team's level", () => {
        const rng = makeRng(5);
        const planted = [1.2, 0, 0, 0, -0.4, 0];
        const samples: ChoiceSample[] = Array.from({ length: 2500 }, () => {
            const rows = Array.from({ length: 15 }, () => choiceRow(Math.floor(rng() * 8), 1500 + (rng() - 0.5) * 600, 1500));
            return { date: "2026-01-01", chosen: draw(rows.map((r) => Math.exp(r.reduce((s, x, i) => s + x * planted[i], 0))), rng()), rows };
        });
        const beta = fitChoice(samples);
        expect(beta[0]).toBeCloseTo(1.2, 0);
        expect(beta[4]).toBeCloseTo(-0.4, 0);
        expect(Math.abs(beta[3])).toBeLessThan(0.15);
        expect(choiceLogLikelihood(beta, samples)).toBeGreaterThan(choiceLogLikelihood(fitChoice(samples, HABIT_ONLY), samples));
        expect(fitChoice(samples, HABIT_ONLY).slice(3)).toEqual([0, 0, 0]);
    });
});

describe("fitAcceptance", () => {
    it("recovers a planted strength effect, centered so each band keeps its rate", () => {
        const rng = makeRng(9);
        const samples: OfferSample[] = Array.from({ length: 4000 }, () => {
            const band = Math.floor(rng() * 4);
            const row = choiceRow(0, 1500 + (rng() - 0.5) * 600, 1500);
            const p = 1 / (1 + Math.exp(-(0.5 - 0.3 * band - 0.8 * row[3])));
            return { date: "2026-01-01", band, accepted: rng() < p, row };
        });
        const model = fitAcceptance(samples);
        expect(model.beta[3]).toBeCloseTo(-0.8, 0);
        const shifts = samples.filter((s) => s.band === 2).map((s) => acceptanceShift(model, 2, s.row));
        expect(Math.abs(shifts.reduce((a, b) => a + b, 0) / shifts.length)).toBeLessThan(1e-9);
        expect(acceptanceLogLikelihood(model, samples)).toBeGreaterThan(acceptanceLogLikelihood(fitAcceptance(samples, []), samples));
    });
});

describe("EloTimeline", () => {
    const series = (t: number, teams: [string, string], lineups: [string[], string[]], after: [number, number]) =>
        ({ t, teams, lineups, after }) as unknown as SeriesPrediction;
    const a = ["a1", "a2", "a3", "a4", "a5"];
    const b = ["b1", "b2", "b3", "b4", "b5"];
    const timeline = new EloTimeline(
        [series(100, ["A", "B"], [a, b], [1550, 1450]), series(86400 * 10, ["A", "B"], [a, b], [1600, 1400])],
        (link) => link
    );

    it("rates a lineup by its team's latest series before the date, and restarts for earlier dates", () => {
        expect(timeline.advanceTo("1970-01-05").ratingOf(["A1", "a2", "a3", "x", "y"])).toBe(1550);
        expect(timeline.advanceTo("1970-01-20").ratingOf(a)).toBe(1600);
        expect(timeline.advanceTo("1970-01-05").ratingOf(b)).toBe(1450);
        expect(timeline.ratingOf(["a1", "a2", "x", "y", "z"])).toBeNull();
    });
});
