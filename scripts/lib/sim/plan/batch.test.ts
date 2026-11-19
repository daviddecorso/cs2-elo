import { describe, expect, it } from "vitest";
import type { PlanIndex } from "../../../../src/sim/types.ts";
import { type BatchCandidate, prune, selectTeams } from "./batch.ts";

const team = (name: string, region: BatchCandidate["region"], invite: number): BatchCandidate => ({ team: name, teamName: name, region, invite });

describe("selectTeams", () => {
    const candidates = [
        team("EU1", "Europe", 0.5),
        team("EU2", "Europe", 0.45),
        team("EU3", "Europe", 0.6),
        team("AM1", "Americas", 0.3),
        team("AS1", "Asia", 0.75),
        team("EUsafe", "Europe", 0.95),
        team("AMout", "Americas", 0.05),
    ];

    it("takes the closest to even odds round-robin across regions, within the range", () => {
        expect(selectTeams(candidates, { max: 4, min: 0.1, maxInvite: 0.9 }).map((c) => c.team)).toEqual(["EU1", "AM1", "AS1", "EU2"]);
    });

    it("fills from regions with more candidates once the others run out", () => {
        expect(selectTeams(candidates, { max: 10, min: 0.1, maxInvite: 0.9 }).map((c) => c.team)).toEqual(["EU1", "AM1", "AS1", "EU2", "EU3"]);
    });
});

describe("prune", () => {
    it("drops entries generated before the cutoff and reports their files", () => {
        const entry = (name: string, generatedAt: string) => ({
            team: name,
            teamName: name,
            file: `${name}.json`,
            asOf: "2026-11-12",
            target: { slug: "m", name: "M", date: "2027-04-05", estimated: true },
            generatedAt,
        });
        const index: PlanIndex = { generatedAt: "2026-11-18T00:00:00Z", teams: [entry("old", "2026-11-01T00:00:00Z"), entry("fresh", "2026-11-10T00:00:00Z")] };
        const { index: kept, removed } = prune(index, new Date("2026-11-18T00:00:00Z"), 14);
        expect(kept.teams.map((t) => t.team)).toEqual(["fresh"]);
        expect(removed).toEqual(["old.json"]);
    });
});
