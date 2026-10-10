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
});
