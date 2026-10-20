import { describe, expect, it } from "vitest";
import type { BracketMatch } from "../config.ts";
import { stageConfig, testContext } from "../testContext.ts";
import { bracket } from "./bracket.ts";

const teams = (n: number) => Array.from({ length: n }, (_, i) => `T${i + 1}`);
const m = (id: string, a: string, b: string, bestOf?: number): BracketMatch => ({ id, teams: [a, b], bestOf });

// IEM-style group: upper bracket finalists and the lower bracket winner advance.
const iemGroup = [
    m("u1", "s1", "s2"),
    m("u2", "s3", "s4"),
    m("u3", "s5", "s6"),
    m("u4", "s7", "s8"),
    m("l1", "l:u1", "l:u2"),
    m("l2", "l:u3", "l:u4"),
    m("u5", "w:u1", "w:u2"),
    m("u6", "w:u3", "w:u4"),
    m("l3", "w:l1", "l:u6"),
    m("l4", "w:l2", "l:u5"),
    m("uf", "w:u5", "w:u6"),
    m("lf", "w:l3", "w:l4"),
];

describe("bracket", () => {
    it("advances the configured results and exits everyone else by match", () => {
        const t = teams(8);
        const ctx = testContext(stageConfig({ format: "bracket", bestOf: { default: 3 }, matches: iemGroup, qualify: ["w:uf", "l:uf", "w:lf"] }), {
            teams: t,
        });
        const { advancing, exits, matches } = bracket(t, ctx);
        expect(advancing).toEqual(["T1", "T5", "T2"]);
        expect(matches).toHaveLength(12);
        expect([...exits.values()].sort()).toEqual(["l1", "l2", "l3", "l4", "lf"]);
        expect(exits.get("T4")).toBe("l1");
        expect(exits.get("T3")).toBe("lf");
        expect(matches.find((x) => x.teams.includes("T3") && x.teams.includes("T6"))?.round).toBe(3);
    });

    it("puts losers' matches and everything they feed in the lower lane", () => {
        const t = teams(8);
        const spec = [...iemGroup, m("f", "w:uf", "w:lf"), m("tp", "l:uf", "l:lf")];
        const ctx = testContext(stageConfig({ format: "bracket", bestOf: { default: 3 }, matches: spec }), { teams: t });
        const lanes = Object.fromEntries(bracket(t, ctx).matches.map((x) => [x.slot, x.lane]));
        expect(Object.keys(lanes).filter((id) => lanes[id] === "lower").sort()).toEqual(["l1", "l2", "l3", "l4", "lf", "tp"]);
        expect(lanes.f).toBe("upper");
    });

    it("plays per-match best-of and exits the final's winner as w:<id>", () => {
        const t = teams(4);
        const spec = [m("sf1", "s1", "s4"), m("sf2", "s2", "s3"), m("f", "w:sf1", "w:sf2", 5)];
        const ctx = testContext(stageConfig({ format: "bracket", bestOf: { default: 3 }, matches: spec }), { teams: t });
        const { exits, matches } = bracket(t, ctx);
        expect(exits.get("T1")).toBe("w:f");
        expect(exits.get("T2")).toBe("f");
        expect(matches.map((x) => x.bestOf)).toEqual([3, 3, 5]);
    });

    it("locks played results", () => {
        const t = teams(4);
        const spec = [m("sf1", "s1", "s4"), m("sf2", "s2", "s3"), m("f", "w:sf1", "w:sf2")];
        const known = [{ id: "x", teams: ["T1", "T4"] as [string, string], winner: 1 as const, round: 1, t: 0 }];
        const ctx = testContext(stageConfig({ format: "bracket", matches: spec }), { teams: t, known });
        expect(bracket(t, ctx).exits.get("T1")).toBe("sf1");
    });

    it("uses Liquipedia's opening draw once all of it is known", () => {
        const t = teams(4);
        const spec = [m("sf1", "s1", "s4"), m("sf2", "s2", "s3"), m("f", "w:sf1", "w:sf2")];
        const known = [
            { id: "R01-M001", teams: ["T1", "T2"] as [string, string], winner: null, round: 1, t: 0 },
            { id: "R01-M002", teams: ["T3", "T4"] as [string, string], winner: null, round: 1, t: 0 },
        ];
        const ctx = testContext(stageConfig({ format: "bracket", matches: spec }), { teams: t, known });
        expect(bracket(t, ctx).matches.map((x) => x.teams)).toEqual([
            ["T1", "T2"],
            ["T3", "T4"],
            ["T1", "T3"],
        ]);
    });

    it("rejects a seed that never plays and a result used twice", () => {
        const spec = [m("a", "s1", "s2")];
        expect(() => bracket(teams(3), testContext(stageConfig({ format: "bracket", matches: spec })))).toThrow(/seed 3/);
        const twice = [m("a", "s1", "s2"), m("b", "w:a", "s3"), m("c", "w:a", "s4")];
        expect(() => bracket(teams(4), testContext(stageConfig({ format: "bracket", matches: twice })))).toThrow(/twice/);
    });
});
