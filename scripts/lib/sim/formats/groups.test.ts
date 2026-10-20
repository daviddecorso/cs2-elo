import { describe, expect, it } from "vitest";
import { stageConfig, testContext } from "../testContext.ts";
import { gsl, roundRobin } from "./groups.ts";

const teams = (n: number) => Array.from({ length: n }, (_, i) => `T${i + 1}`);

describe("gsl", () => {
    it("snakes seeds into groups and advances winners before runners-up", () => {
        const t = teams(8);
        const ctx = testContext(stageConfig({ format: "gsl", groups: 2, advance: 4 }), { teams: t });
        const { advancing, exits, matches } = gsl(t, ctx);
        // Groups are [T1, T4, T5, T8] and [T2, T3, T6, T7].
        expect(advancing).toEqual(["T1", "T2", "T4", "T3"]);
        expect(exits.get("T8")).toBe("gsl-4");
        expect(exits.get("T5")).toBe("gsl-3");
        expect(matches).toHaveLength(10);
    });
});

describe("roundRobin", () => {
    it("plays every pair once and ranks by wins", () => {
        const t = teams(6);
        const ctx = testContext(stageConfig({ format: "round_robin", groups: 1, advance: 2 }), { teams: t });
        const { advancing, exits, matches } = roundRobin(t, ctx);
        expect(matches).toHaveLength(15);
        expect(advancing).toEqual(["T1", "T2"]);
        expect(exits.get("T6")).toBe("pos6");
    });

    it("breaks a two-way tie on head-to-head", () => {
        const t = ["A", "B", "C"];
        // A beats B, B beats C, C beats A: a three-way tie on one win each, so only the random break applies.
        const beats: Record<string, string> = { A: "B", B: "C", C: "A" };
        const ctx = testContext(stageConfig({ format: "round_robin", advance: 1 }), {
            pickWinner: (a, b) => (beats[a] === b ? 0 : 1),
        });
        const { advancing, exits } = roundRobin(t, ctx);
        expect(advancing).toHaveLength(1);
        expect(exits.size).toBe(2);

        const ctx2 = testContext(stageConfig({ format: "round_robin", advance: 1 }), {
            // A and B both beat C; A beats B.
            pickWinner: (a, b) => (a === "A" || (a === "B" && b === "C") ? 0 : 1),
        });
        expect(roundRobin(t, ctx2).advancing).toEqual(["A"]);
    });
});
