import { describe, expect, it } from "vitest";
import { testPlan } from "../../../../src/sim/testPlan.ts";
import type { PlanIndex, SeasonRoster } from "../../../../src/sim/types.ts";
import { type BatchCandidate, bubbleRosters, groupsOf, planEvents, prune, selectTeams } from "./batch.ts";

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

    it("puts teams without odds after every team with them in their region", () => {
        const picked = selectTeams([...candidates, { team: "EUbubble", teamName: "EUbubble", region: "Europe", invite: null }], { max: 10, min: 0.1, maxInvite: 0.9 });
        expect(picked.map((c) => c.team).at(-1)).toBe("EUbubble");
    });
});

describe("bubbleRosters", () => {
    const range = (p10: number | null, p50: number | null, p90: number | null) => ({ p10, p50, p90 });
    const roster = (teamName: string, rank: ReturnType<typeof range>): SeasonRoster => ({
        rosterKey: teamName,
        teamName,
        region: "Europe",
        players: [],
        today: null,
        checkpoints: [{ points: range(0, 0, 0), globalRank: range(null, null, null), regionalRank: rank, ranked: 1 }],
    });
    it("adds rosters without a team file whose rank range straddles the region's invite line", () => {
        const rosters = [roster("In", range(3, 5, 7)), roster("Line", range(6, 8, 10)), roster("Straddles", range(7, 11, 14)), roster("Below", range(12, 15, 20)), roster("Unranked", range(null, null, null))];
        const known = [team("In", "Europe", 0.8), team("Line", "Europe", 0.5)];
        const has = new Set(["In", "Line"]);
        expect(bubbleRosters(rosters, known, (name) => has.has(name)).map((c) => c.team)).toEqual(["Straddles"]);
    });
});

describe("groupsOf", () => {
    it("splits into consecutive groups", () => {
        expect(groupsOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(groupsOf([], 3)).toEqual([]);
    });
});

describe("planEvents", () => {
    it("lists each event of a team's default schedule with its route and worth", () => {
        const file = testPlan();
        const events = planEvents([file], "2026-11-20T00:00:00Z");
        const at = file.schedules.findIndex((s) => s.bestFor.includes("average"));
        const schedule = file.schedules[at >= 0 ? at : 0];
        const slugs = schedule.options.map((id) => file.options.find((o) => o.id === id)!.event.slug);
        expect(Object.keys(events.events).sort()).toEqual([...new Set(slugs)].sort());
        for (const list of Object.values(events.events)) expect(list[0].team).toBe(file.team);
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
