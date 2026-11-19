import { describe, expect, it } from "vitest";
import type { Region } from "../../../src/vrs/types.ts";
import { allocateInvites, countAbove, makeIntactCheck, makeRegionEligibleCheck, previousMajorSlots, totalSlots } from "./invites.ts";
import { isCoachRole, preferSquads, type ProjectedRoster } from "./vrsProjection.ts";
import type { Matchdata, ValvePlayer } from "../vrs/buildMatchdata.ts";

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

describe("countAbove and totalSlots", () => {
    it("agree with allocateInvites on whether a roster gets any invite", () => {
        let seed = 7;
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let trial = 0; trial < 50; trial++) {
            // Distinct points, since Valve's regional rank breaks ties in its own order.
            const list = Array.from({ length: 30 }, (_, i) => ({ ...roster(`r${i}`, "Europe", 0), points: Math.round(rand() * 2000) * 31 + i }))
                .sort((a, b) => b.points - a.points)
                .map((r, i) => ({ ...r, regionalRank: i + 1 }));
            const blocked = new Set(list.filter(() => rand() < 0.2).map((r) => r.rosterKey));
            const eligible = (r: ProjectedRoster) => !blocked.has(r.rosterKey);
            const stageSlots = slots({ Europe: 3, Americas: 0, Asia: 0 });
            const invites = allocateInvites(list, stageSlots, eligible);
            for (const r of list) {
                const rivals = list.filter((x) => x !== r && eligible(x)).map((x) => x.points);
                const expected = eligible(r) && countAbove(rivals, r.points) < totalSlots(stageSlots, "Europe");
                expect(invites.has(r.rosterKey)).toBe(expected);
            }
        }
    });

    it("counts strictly greater values in a descending list", () => {
        expect(countAbove([9, 7, 7, 3], 7)).toBe(1);
        expect(countAbove([9, 7, 7, 3], 2)).toBe(4);
        expect(countAbove([], 5)).toBe(0);
    });
});

describe("previousMajorSlots", () => {
    const regionOf = (team: string): Region => (team.startsWith("e") ? "Europe" : team.startsWith("a") ? "Americas" : "Asia");

    it("counts playoff teams as Stage 3 and Stage 3 exits as Stage 2, by region", () => {
        const reached = new Map([
            ["e1", ["stage2", "stage3", "playoffs"]],
            ["a1", ["stage3", "playoffs"]],
            ["e2", ["stage3"]],
            ["s1", ["stage1"]],
        ]);
        expect(previousMajorSlots({ event: "m", stage3From: "playoffs", stage2From: "stage3" }, reached, regionOf)).toEqual({
            3: { Europe: 1, Americas: 1, Asia: 0 },
            2: { Europe: 1, Americas: 0, Asia: 0 },
        });
    });

    it("uses fixed slots once the Major is played", () => {
        const fixed = { stage3: { Europe: 5, Americas: 2, Asia: 1 }, stage2: { Europe: 4, Americas: 3, Asia: 1 } };
        expect(previousMajorSlots({ event: "m", slots: fixed }, null, regionOf)).toEqual({ 3: fixed.stage3, 2: fixed.stage2 });
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

describe("preferSquads", () => {
    const vp = (id: string, nick = id): ValvePlayer => ({ playerId: id, nick, countryIso: "se" });
    const matchdata: Matchdata = {
        matches: [
            {
                matchStartTime: 1000,
                team1Id: "Team A",
                team2Id: "Team B",
                team1Name: "Team A",
                team2Name: "Team B",
                team1Players: [vp("p1"), vp("p2"), vp("p3"), vp("p4"), vp("p5")],
                team2Players: [vp("alias_q1", "q1"), vp("q2"), vp("q3"), vp("q4"), vp("q5")],
                eventId: "Ev",
                winningTeam: 1,
                valveRanked: true,
            },
        ],
        events: [],
    };

    it("identifies coach roles and swaps a 5-player squad keeping 3+ players", () => {
        expect(isCoachRole("Coach")).toBe(true);
        expect(isCoachRole("Interim Coach")).toBe(true);
        expect(isCoachRole("Captain")).toBe(false);
        expect(isCoachRole("")).toBe(false);

        const lineups = new Map([["Team A", { name: "Team A", players: [vp("p1"), vp("p2"), vp("p3"), vp("p4"), vp("p5")] }]]);
        const squads = new Map([["Team A", ["p1", "p2", "p3", "p4", "q1"]]]);
        expect(preferSquads(matchdata, lineups, squads)).toBe(1);
        expect(lineups.get("Team A")!.players.map((p) => p.nick)).toEqual(["p1", "p2", "p3", "p4", "q1"]);
    });
});

describe("makeRegionEligibleCheck", () => {
    const prior = [
        { region: "Europe" as Region, players: ["electroNic", "Magisk", "mzinho", "s1mple", "Senzu"] },
        { region: "Americas" as Region, players: ["a1", "a2", "a3", "a4", "a5"] },
    ];

    it("blocks rosters whose 3+ player core appeared in another region within 3 months", () => {
        const eligible = makeRegionEligibleCheck(prior);
        expect(eligible({ region: "Asia", players: ["asap", "Magisk", "mzinho", "s1mple", "Senzu"] })).toBe(false);
        expect(eligible({ region: "Europe", players: ["asap", "Magisk", "mzinho", "s1mple", "Senzu"] })).toBe(true);
        expect(eligible({ region: "Asia", players: ["x1", "x2", "x3", "x4", "x5"] })).toBe(true);
    });

    it("honors explicit Valve exceptions", () => {
        const eligible = makeRegionEligibleCheck(prior, [
            { players: ["asap", "Magisk", "mzinho", "s1mple", "Senzu"], region: "Asia", reason: "Singapore exception" },
        ]);
        expect(eligible({ region: "Asia", players: ["asap", "Magisk", "mzinho", "s1mple", "Senzu"] })).toBe(true);
    });
});
