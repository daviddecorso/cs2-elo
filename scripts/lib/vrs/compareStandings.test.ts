import { describe, expect, it } from "vitest";
import { compareStandings } from "./compareStandings.ts";
import type { Standings } from "../../../src/vrs/types.ts";

describe("compareStandings", () => {
    const cutoffs = {
        Europe: 16,
        Americas: 8,
        Asia: 8,
    };

    const makeStandings = (rosters: Standings["rosters"]): Standings => ({
        snapshotDate: "2026-10-05",
        valveCommit: "commit1",
        modelCommit: "commit2",
        source: "model",
        generatedAt: "2026-10-05T00:00:00Z",
        rosters,
    });

    it("evaluates strict mismatches, rank deviations, points errors, and the ±3 cutoff band", () => {
        const published = makeStandings([
            {
                rosterKey: "p1,p2,p3,p4,p5",
                teamName: "Team Top",
                region: "Europe",
                regionalRank: 1,
                globalRank: 1,
                points: 2000,
                factors: { bountyOffered: 1, bountyCollected: 1, opponentNetwork: 1, lanFactor: 1 },
                startingValue: 2000,
                h2hAdjustment: 0,
                players: ["p1", "p2", "p3", "p4", "p5"],
            },
            {
                rosterKey: "q1,q2,q3,q4,q5",
                teamName: "Team Cutoff",
                region: "Europe",
                regionalRank: 16, // At cutoff
                globalRank: 20,
                points: 1500,
                factors: { bountyOffered: 0.5, bountyCollected: 0.5, opponentNetwork: 0.5, lanFactor: 0.5 },
                startingValue: 1500,
                h2hAdjustment: 0,
                players: ["q1", "q2", "q3", "q4", "q5"],
            },
            {
                rosterKey: "r1,r2,r3,r4,r5",
                teamName: "Team Asia",
                region: "Asia",
                regionalRank: 1,
                globalRank: 25,
                points: 1400,
                factors: { bountyOffered: 0.4, bountyCollected: 0.4, opponentNetwork: 0.4, lanFactor: 0.4 },
                startingValue: 1400,
                h2hAdjustment: 0,
                players: ["r1", "r2", "r3", "r4", "r5"],
            },
        ]);

        const model = makeStandings([
            {
                rosterKey: "p1,p2,p3,p4,p5",
                teamName: "Team Top",
                region: "Europe",
                regionalRank: 1, // exact match
                globalRank: 1,
                points: 2000.4, // rounded is 2000, exact match
                factors: { bountyOffered: 1, bountyCollected: 1, opponentNetwork: 1, lanFactor: 1 },
                startingValue: 2000,
                h2hAdjustment: 0.4,
                players: ["p1", "p2", "p3", "p4", "p5"],
            },
            {
                rosterKey: "q1,q2,q3,q4,q5",
                teamName: "Team Cutoff",
                region: "Europe",
                regionalRank: 17, // deviated within 16 ± 3 band!
                globalRank: 22, // dev = 2
                points: 1490.0, // error = 10 pts
                factors: { bountyOffered: 0.5, bountyCollected: 0.5, opponentNetwork: 0.5, lanFactor: 0.5 },
                startingValue: 1500,
                h2hAdjustment: -10,
                players: ["q1", "q2", "q3", "q4", "q5"],
            },
            {
                rosterKey: "r1,r2,r3,r4,r5",
                teamName: "Team Asia",
                region: "Asia",
                regionalRank: 1, // exact match
                globalRank: 25,
                points: 1400,
                factors: { bountyOffered: 0.4, bountyCollected: 0.4, opponentNetwork: 0.4, lanFactor: 0.4 },
                startingValue: 1400,
                h2hAdjustment: 0,
                players: ["r1", "r2", "r3", "r4", "r5"],
            },
        ]);

        const report = compareStandings(model, published, cutoffs);

        expect(report.passed).toBe(false);
        // Team Top has 0 strict mismatch, Team Cutoff has regional, global, points mismatch
        expect(report.strictMismatches.length).toBe(3);

        // Exact matches
        expect(report.exactMatchesPerRegion.Europe.exact).toBe(1);
        expect(report.exactMatchesPerRegion.Europe.total).toBe(2);
        expect(report.exactMatchesPerRegion.Asia.exact).toBe(1);
        expect(report.exactMatchesPerRegion.Asia.total).toBe(1);

        // Rank deviation
        expect(report.largestRankDeviation).toEqual({
            rosterKey: "q1,q2,q3,q4,q5",
            teamName: "Team Cutoff",
            deviation: 2,
            modelRank: 22,
            publishedRank: 20,
        });

        // Points error
        expect(report.pointsError.max).toBeCloseTo(10.0);
        expect(report.pointsError.mean).toBeCloseTo((0.4 + 10.0 + 0.0) / 3);

        // Cutoff mismatch
        expect(report.cutoffMismatches.length).toBe(1);
        expect(report.cutoffMismatches[0]).toEqual({
            region: "Europe",
            rosterKey: "q1,q2,q3,q4,q5",
            teamName: "Team Cutoff",
            cutoff: 16,
            modelRegionalRank: 17,
            publishedRegionalRank: 16,
        });
    });

    it("ignores unranked model rosters with null globalRank when checking for extra rosters", () => {
        const published = makeStandings([
            {
                rosterKey: "p1,p2,p3,p4,p5",
                teamName: "Team Ranked",
                region: "Europe",
                regionalRank: 1,
                globalRank: 1,
                points: 2000,
                factors: { bountyOffered: 1, bountyCollected: 1, opponentNetwork: 1, lanFactor: 1 },
                startingValue: 2000,
                h2hAdjustment: 0,
                players: ["p1", "p2", "p3", "p4", "p5"],
            },
        ]);

        const model = makeStandings([
            {
                rosterKey: "p1,p2,p3,p4,p5",
                teamName: "Team Ranked",
                region: "Europe",
                regionalRank: 1,
                globalRank: 1,
                points: 2000,
                factors: { bountyOffered: 1, bountyCollected: 1, opponentNetwork: 1, lanFactor: 1 },
                startingValue: 2000,
                h2hAdjustment: 0,
                players: ["p1", "p2", "p3", "p4", "p5"],
            },
            {
                rosterKey: "u1,u2,u3,u4,u5",
                teamName: "Team Under 5 Matches",
                region: "Europe",
                regionalRank: null,
                globalRank: null,
                points: 1200,
                factors: { bountyOffered: 0, bountyCollected: 0, opponentNetwork: 0, lanFactor: 0 },
                startingValue: 1200,
                h2hAdjustment: 0,
                players: ["u1", "u2", "u3", "u4", "u5"],
            },
        ]);

        const report = compareStandings(model, published, cutoffs);
        expect(report.strictMismatches).toEqual([]);
        expect(report.passed).toBe(true);
    });

    describe("gate", () => {
        const roster = (
            name: string,
            globalRank: number | null,
            regionalRank: number | null,
            points: number,
            region: "Europe" | "Americas" | "Asia" = "Europe"
        ): Standings["rosters"][number] => ({
            rosterKey: name,
            teamName: name,
            region,
            regionalRank,
            globalRank,
            points,
            factors: { bountyOffered: 0, bountyCollected: 0, opponentNetwork: 0, lanFactor: 0 },
            startingValue: points,
            h2hAdjustment: 0,
            players: [],
        });

        const smallCutoffs = { Europe: 2, Americas: 1, Asia: 1 };

        it("passes with rank swaps within ±2 that don't cross a cutoff", () => {
            const published = makeStandings([
                roster("A", 1, 1, 2000),
                roster("B", 2, 2, 1990),
                roster("C", 3, 3, 1980),
                roster("D", 4, 4, 1970),
                roster("E", 5, 1, 1960, "Asia"),
            ]);
            const model = makeStandings([
                roster("B", 1, 1, 1995),
                roster("A", 2, 2, 1993),
                roster("D", 3, 3, 1972),
                roster("C", 4, 4, 1978),
                roster("E", 5, 1, 1960, "Asia"),
            ]);

            const { gate, passed } = compareStandings(model, published, smallCutoffs);
            expect(passed).toBe(false);
            expect(gate.passed).toBe(true);
            expect(gate.exactRank).toBe(1);
            expect(gate.withinMaxMiss).toBe(5);
            expect(gate.meanPointsError).toBeCloseTo((7 + 5 + 2 + 2 + 0) / 5);
        });

        it("fails on cutoff membership even when ranks are within ±2", () => {
            const published = makeStandings([
                roster("A", 1, 1, 2000),
                roster("B", 2, 2, 1990),
                roster("C", 3, 3, 1980),
            ]);
            const model = makeStandings([
                roster("A", 1, 1, 2000),
                roster("C", 2, 2, 1990),
                roster("B", 3, 3, 1980),
            ]);

            const { gate } = compareStandings(model, published, smallCutoffs);
            expect(gate.rankMisses).toEqual([]);
            expect(gate.cutoffMembership.Europe).toEqual({ cutoff: 2, missing: ["B"], extra: ["C"] });
            expect(gate.passed).toBe(false);
        });

        it("counts rank misses beyond ±2 and unranked rosters", () => {
            const published = makeStandings([
                roster("A", 1, 1, 2000),
                roster("B", 2, 2, 1990),
                roster("C", 3, 3, 1980),
                roster("D", 4, 4, 1970),
                roster("E", 5, 5, 1960),
            ]);
            const model = makeStandings([
                roster("A", 1, 1, 2000),
                roster("B", 2, 2, 1990),
                roster("D", 3, 3, 1970),
                roster("E", 4, 4, 1960),
                roster("C", 6, 6, 1980),
            ]);
            const unranked = makeStandings(model.rosters.filter((r) => r.rosterKey !== "C"));

            expect(compareStandings(model, published, smallCutoffs).gate.rankMisses).toEqual([
                { rosterKey: "C", teamName: "C", publishedRank: 3, modelRank: 6 },
            ]);

            const { gate } = compareStandings(unranked, published, smallCutoffs);
            expect(gate.rankMisses).toEqual([{ rosterKey: "C", teamName: "C", publishedRank: 3, modelRank: null }]);
            expect(gate.meanPointsError).toBeCloseTo(1980 / 5);
            expect(gate.passed).toBe(false);
        });

        it("only scores the published top 50", () => {
            const published = makeStandings(
                Array.from({ length: 52 }, (_, i) => roster(`T${i + 1}`, i + 1, i + 1, 2000 - i))
            );
            const model = makeStandings(
                published.rosters.map((r) => (r.globalRank! > 50 ? { ...r, globalRank: 60, points: 0 } : r))
            );

            const { gate } = compareStandings(model, published, smallCutoffs);
            expect(gate.total).toBe(50);
            expect(gate.passed).toBe(true);
        });
    });
});
