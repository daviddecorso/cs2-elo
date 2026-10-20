import { describe, expect, it } from "vitest";
import type { Region } from "../../../src/vrs/types.ts";
import { allocateInvites, makeIntactCheck } from "./invites.ts";
import type { ProjectedRoster } from "./vrsProjection.ts";

const roster = (key: string, region: Region, regionalRank: number, players: string[] = []): ProjectedRoster => ({
    rosterKey: key,
    teamName: key,
    region,
    regionalRank,
    points: 0,
    players,
});

const slots = (stage3: Record<Region, number>) => ({
    3: stage3,
    2: { Europe: 2, Americas: 1, Asia: 0 },
    1: { Europe: 2, Americas: 1, Asia: 1 },
});

describe("allocateInvites", () => {
    const rosters = [
        ...["e1", "e2", "e3", "e4", "e5", "e6", "e7"].map((k, i) => roster(k, "Europe", i + 1)),
        ...["a1", "a2", "a3", "a4"].map((k, i) => roster(k, "Americas", i + 1)),
        ...["s1", "s2"].map((k, i) => roster(k, "Asia", i + 1)),
    ];

    it("fills Stage 3 from previous-Major playoff counts, then Stage 2, then Stage 1", () => {
        const invites = allocateInvites(rosters, slots({ Europe: 2, Americas: 1, Asia: 0 }),() => true);
        expect(Object.fromEntries(invites)).toEqual({
            e1: 3, e2: 3, e3: 2, e4: 2, e5: 1, e6: 1,
            a1: 3, a2: 2, a3: 1,
            s1: 1,
        });
    });

    it("passes a skipped roster's slot to the next in line", () => {
        const invites = allocateInvites(rosters, slots({ Europe: 2, Americas: 1, Asia: 0 }),(r) => r.rosterKey !== "e2");
        expect(invites.has("e2")).toBe(false);
        expect(invites.get("e3")).toBe(3);
        expect(invites.get("e7")).toBe(1);
    });

    it("ignores unranked rosters", () => {
        const invites = allocateInvites([{ ...roster("x", "Asia", 1), regionalRank: null }], slots({ Europe: 0, Americas: 0, Asia: 1 }), () => true);
        expect(invites.size).toBe(0);
    });
});

describe("makeIntactCheck", () => {
    const squads = new Map([
        ["Team A", new Set(["p1", "p2", "p3", "x1", "x2"])],
        ["Team B", new Set(["p4", "p5"])],
    ]);
    const check = makeIntactCheck(squads, 3);

    it("needs three players still together on one squad", () => {
        expect(check(roster("r", "Europe", 1, ["P1", "p2", "p3", "p4", "p5"]))).toBe(true);
        expect(check(roster("r", "Europe", 1, ["p1", "p2", "p4", "p5", "q"]))).toBe(false);
    });

    it("returns null with no squad data", () => {
        expect(check(roster("r", "Europe", 1, ["q1", "q2", "q3", "q4", "q5"]))).toBeNull();
    });
});
