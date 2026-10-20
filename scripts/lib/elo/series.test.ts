import { describe, expect, it } from "vitest";
import { ActivePool, seriesLength, seriesWinProbability } from "./series.ts";

describe("seriesWinProbability", () => {
    it("matches the closed forms for Bo1, Bo3 and Bo5", () => {
        const p = 0.6;
        expect(seriesWinProbability(p, 1)).toBeCloseTo(0.6, 10);
        expect(seriesWinProbability(p, 3)).toBeCloseTo(p * p * (3 - 2 * p), 10);
        expect(seriesWinProbability(p, 5)).toBeCloseTo(p ** 3 * (10 - 15 * p + 6 * p * p), 10);
    });

    it("is symmetric and fixed at a coin flip", () => {
        expect(seriesWinProbability(0.5, 3)).toBeCloseTo(0.5, 10);
        expect(seriesWinProbability(0.7, 5) + seriesWinProbability(0.3, 5)).toBeCloseTo(1, 10);
    });

    it("softens multi-map series by mapTemp and leaves Bo1 alone", () => {
        expect(seriesWinProbability(0.7, 1, 0.5)).toBeCloseTo(0.7, 10);
        expect(seriesWinProbability(0.7, 3, 1)).toBeCloseTo(seriesWinProbability(0.7, 3), 10);
        const softened = 1 / (1 + Math.sqrt(0.3 / 0.7));
        expect(seriesWinProbability(0.7, 3, 0.5)).toBeCloseTo(seriesWinProbability(softened, 3), 10);
        expect(seriesWinProbability(0.5, 5, 0.5)).toBeCloseTo(0.5, 10);
    });

    it("scores Bo2 as Bo3 and Bo7 as Bo5", () => {
        expect(seriesLength(2)).toBe(3);
        expect(seriesLength(7)).toBe(5);
        expect(seriesLength(0)).toBe(1);
    });
});

describe("ActivePool", () => {
    const day = 86400;

    it("keeps maps above 3% share in the trailing 60 days", () => {
        const pool = new ActivePool();
        for (let i = 0; i < 40; i++) pool.record(i * 3600, i % 2 ? "Mirage" : "Nuke");
        pool.record(10, "Vertigo");
        expect(pool.at(5 * day)).toEqual(["Mirage", "Nuke"]);
    });

    it("drops a map once it ages out of the window", () => {
        const pool = new ActivePool();
        pool.record(0, "Vertigo");
        pool.record(50 * day, "Dust II");
        expect(pool.at(51 * day)).toEqual(["Dust II", "Vertigo"]);
        expect(pool.at(62 * day)).toEqual(["Dust II"]);
    });

    it("ignores placeholder map names", () => {
        const pool = new ActivePool();
        pool.record(0, "Unknown");
        pool.record(0, "Default");
        pool.record(0, "Ancient");
        expect(pool.at(day)).toEqual(["Ancient"]);
    });
});
