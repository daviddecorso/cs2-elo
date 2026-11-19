import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    fitBeta,
    fitRankBeta,
    HLTV_POINTS_LINKS,
    logisticProbability,
    rankProbability,
    readHltvRanks,
} from "./hltvBaseline.ts";

describe("rankProbability", () => {
    it("is symmetric around 0.5", () => {
        expect(rankProbability(3, 12, 0.8) + rankProbability(12, 3, 0.8)).toBeCloseTo(1, 12);
    });

    it("returns 0.5 for equal ranks", () => {
        expect(rankProbability(7, 7, 1.2)).toBe(0.5);
    });

    it("favors the better (lower) rank", () => {
        expect(rankProbability(2, 15, 0.7)).toBeGreaterThan(0.5);
        expect(rankProbability(15, 2, 0.7)).toBeLessThan(0.5);
    });
});

describe("fitRankBeta", () => {
    it("recovers a known beta on synthetic outcomes", () => {
        const trueBeta = 0.85;
        let state = 42;
        const rand = () => {
            state = (state * 1664525 + 1013904223) % 4294967296;
            return state / 4294967296;
        };
        const rows: Array<{ rankA: number; rankB: number; y: 0 | 1 }> = [];
        for (let i = 0; i < 10000; i++) {
            const rankA = 1 + Math.floor(rand() * 30);
            const rankB = 1 + Math.floor(rand() * 30);
            const p = rankProbability(rankA, rankB, trueBeta);
            rows.push({ rankA, rankB, y: rand() < p ? 1 : 0 });
        }
        expect(fitRankBeta(rows)).toBeCloseTo(trueBeta, 1);
    });
});

describe("fitBeta", () => {
    it("recovers a known beta over an arbitrary difference and returns mean log loss", () => {
        const trueBeta = 1.35;
        let state = 17;
        const rand = () => {
            state = (state * 1664525 + 1013904223) % 4294967296;
            return state / 4294967296;
        };
        const rows: Array<{ diff: number; y: 0 | 1 }> = [];
        for (let i = 0; i < 10000; i++) {
            const diff = (rand() - 0.5) * 4;
            const p = logisticProbability(diff, trueBeta);
            rows.push({ diff, y: rand() < p ? 1 : 0 });
        }
        const fit = fitBeta(rows);
        expect(fit.beta).toBeCloseTo(trueBeta, 1);
        expect(fit.loss).toBeGreaterThan(0);
        expect(fit.loss).toBeLessThan(Math.log(2));
    });

    it("computes log and linear points diffs", () => {
        const [logLink, linearLink] = HLTV_POINTS_LINKS;
        expect(logLink.diff(400, 100)).toBeCloseTo(Math.log(4), 12);
        expect(linearLink.diff(450, 200)).toBeCloseTo(2.5, 12);
    });
});

describe("readHltvRanks", () => {
    it("returns null when the file is missing and parses ranks and optional points otherwise", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hltv-ranks-"));
        try {
            const missing = path.join(dir, "missing.jsonl");
            expect(readHltvRanks(missing)).toBeNull();

            const file = path.join(dir, "ranks.jsonl");
            fs.writeFileSync(
                file,
                [
                    JSON.stringify({ match2id: "m1", hltvMatchId: 100, ranks: [4, 18], rankingDate: "2025-02-03" }),
                    JSON.stringify({ match2id: "m2", hltvMatchId: 101, ranks: [1, 3], points: [912, 836], rankingDate: "2026-11-09" }),
                ].join("\n") + "\n"
            );
            const loaded = readHltvRanks(file);
            expect(loaded?.get("m1")).toEqual({ ranks: [4, 18], points: null });
            expect(loaded?.get("m2")).toEqual({ ranks: [1, 3], points: [912, 836] });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
