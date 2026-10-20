import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KnownMatch } from "../locks.ts";
import { stageConfig, testContext } from "../testContext.ts";
import { swiss } from "./swiss.ts";

interface Fixture {
    stages: Array<{ page: string; invited: string[]; matches: Array<Omit<KnownMatch, "id">> }>;
}

const fixture = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../../../../fixtures/cologne-2026-swiss.json"), "utf8")
) as Fixture;

describe("swiss", () => {
    it("reproduces every pairing of Cologne 2026 Stages 1–3 from seeds and results alone", () => {
        let advancing: string[] = [];
        fixture.stages.forEach((stage, i) => {
            const known = stage.matches.map((m, j) => ({ ...m, id: String(j) }));
            const ctx = testContext(stageConfig({ bestOf: { default: i === 2 ? 3 : 1, decider: 3 }, advance: 8 }), { known });
            const result = swiss([...stage.invited, ...advancing], { ...ctx, knownPairings: () => [] });

            expect(ctx.invented).toEqual([]);
            expect(ctx.locks.unused()).toEqual([]);
            expect(result.advancing).toHaveLength(8);
            expect(result.exits.size).toBe(8);
            advancing = result.advancing;
        });
    });

    it("plays deciders as Bo3 and the rest as Bo1", () => {
        const teams = Array.from({ length: 16 }, (_, i) => `T${i + 1}`);
        const ctx = testContext(stageConfig({ bestOf: { default: 1, decider: 3 }, advance: 8 }), { teams });
        const { matches, exits } = swiss(teams, ctx);
        const bo3ByRound = [1, 2, 3, 4, 5].map((r) => matches.filter((m) => m.round === r && m.bestOf === 3).length);
        const bo1ByRound = [1, 2, 3, 4, 5].map((r) => matches.filter((m) => m.round === r && m.bestOf === 1).length);
        // Round 3's 1-1 pool is the only one neither advancing nor eliminating.
        expect(bo3ByRound).toEqual([0, 0, 4, 6, 3]);
        expect(bo1ByRound).toEqual([8, 8, 4, 0, 0]);
        expect([...exits.values()].sort()).toEqual(["0-3", "0-3", "1-3", "1-3", "1-3", "2-3", "2-3", "2-3"]);
    });

    it("never pairs a rematch", () => {
        const teams = Array.from({ length: 16 }, (_, i) => `T${i + 1}`);
        for (let seed = 0; seed < 50; seed++) {
            let x = seed;
            const ctx = testContext(stageConfig({ bestOf: { default: 1, decider: 3 }, advance: 8 }), {
                pickWinner: () => ((x = (x * 1103515245 + 12345) % 2147483648) % 2) as 0 | 1,
            });
            const { matches } = swiss(teams, ctx);
            const pairs = matches.map((m) => [...m.teams].sort().join("|"));
            expect(new Set(pairs).size).toBe(pairs.length);
        }
    });
});
