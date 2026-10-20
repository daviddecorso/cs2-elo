import { describe, expect, it } from "vitest";
import { stageConfig, testContext } from "../testContext.ts";
import { bracketOrder, doubleElim, singleElim } from "./elimination.ts";

const teams = (n: number) => Array.from({ length: n }, (_, i) => `T${i + 1}`);

describe("bracketOrder", () => {
    it("pairs 1 v 8, 4 v 5, 2 v 7, 3 v 6", () => {
        expect(bracketOrder(8)).toEqual([0, 7, 3, 4, 1, 6, 2, 5]);
    });
    it("rejects non-powers of two", () => {
        expect(() => bracketOrder(6)).toThrow();
    });
});

describe("singleElim", () => {
    it("lets the top seed win with chalk results and plays the final at bestOf.final", () => {
        const t = teams(8);
        const ctx = testContext(stageConfig({ format: "single_elim", bestOf: { default: 3, final: 5 } }), { teams: t });
        const { exits, matches } = singleElim(t, ctx);
        expect(exits.get("T1")).toBe("champion");
        expect(exits.get("T2")).toBe("r3");
        expect([...exits.values()].filter((k) => k === "r1")).toHaveLength(4);
        expect(matches.at(-1)!.bestOf).toBe(5);
        expect(matches.slice(0, -1).every((m) => m.bestOf === 3)).toBe(true);
    });

    it("uses Liquipedia's round-1 draw once all of it is known", () => {
        const t = teams(4);
        const known = [
            { id: "R01-M001", teams: ["T1", "T2"] as [string, string], winner: null, round: 1, t: 0 },
            { id: "R01-M002", teams: ["T3", "T4"] as [string, string], winner: null, round: 1, t: 0 },
        ];
        const ctx = testContext(stageConfig({ format: "single_elim" }), { teams: t, known });
        const { matches } = singleElim(t, ctx);
        expect(matches[0].teams).toEqual(["T1", "T2"]);
    });

    it("stops when `advance` teams remain", () => {
        const t = teams(8);
        const ctx = testContext(stageConfig({ format: "single_elim", advance: 2 }), { teams: t });
        const { advancing, exits } = singleElim(t, ctx);
        expect(advancing).toEqual(["T1", "T2"]);
        expect(exits.size).toBe(6);
    });
});

describe("doubleElim", () => {
    it("eliminates everyone but the champion exactly once over 2n - 2 matches", () => {
        const t = teams(8);
        const ctx = testContext(stageConfig({ format: "double_elim", bestOf: { default: 3, final: 5 } }), { teams: t });
        const { exits, matches } = doubleElim(t, ctx);
        expect(matches).toHaveLength(14);
        expect(exits.size).toBe(8);
        expect(exits.get("T1")).toBe("champion");
        expect(exits.get("T2")).toBe("gf");
        expect([...exits.values()].filter((k) => k.startsWith("lb-r"))).toHaveLength(6);

        for (const n of [4, 16, 32]) {
            const r = doubleElim(teams(n), testContext(stageConfig({ format: "double_elim" }), { teams: teams(n) }));
            expect(r.matches).toHaveLength(2 * n - 2);
            expect(r.exits.size).toBe(n);
        }
    });

    it("never repeats a pairing", () => {
        const t = teams(8);
        let x = 7;
        const ctx = testContext(stageConfig({ format: "double_elim" }), {
            pickWinner: () => ((x = (x * 1103515245 + 12345) % 2147483648) % 2) as 0 | 1,
        });
        for (let i = 0; i < 30; i++) {
            const { matches } = doubleElim(t, ctx);
            const pairs = matches.map((m) => [...m.teams].sort().join("|"));
            // Only the grand final can repeat an upper-bracket meeting.
            expect(new Set(pairs.slice(0, -1)).size).toBe(pairs.length - 1);
        }
    });

    it("advances both bracket winners without a grand final", () => {
        const t = teams(8);
        const ctx = testContext(stageConfig({ format: "double_elim", advance: 2 }), { teams: t });
        const { advancing, matches } = doubleElim(t, ctx);
        expect(advancing).toEqual(["T1", "T2"]);
        expect(matches).toHaveLength(13);
    });
});
