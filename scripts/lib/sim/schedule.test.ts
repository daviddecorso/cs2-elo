import { describe, expect, it } from "vitest";
import type { Matchdata, ValveMatch } from "../vrs/buildMatchdata.ts";
import { indicesOf, maskOf, popcount } from "../../../src/sim/schedule.ts";
import { conflicts, feasibleMasks, feasibleSets, fits, ONLINE_CONCURRENCY, volumeBaselines } from "./schedule.ts";

describe("conflicts", () => {
    const a = { startDate: "2027-03-01", endDate: "2027-03-10", region: "Europe" as const };

    it("needs 2 clear days within a region and 4 across regions or with an unknown region", () => {
        expect(conflicts(a, { startDate: "2027-03-12", endDate: "2027-03-15", region: "Europe" })).toBe(false);
        expect(conflicts(a, { startDate: "2027-03-11", endDate: "2027-03-15", region: "Europe" })).toBe(true);
        expect(conflicts(a, { startDate: "2027-03-13", endDate: "2027-03-15", region: "Asia" })).toBe(true);
        expect(conflicts(a, { startDate: "2027-03-14", endDate: "2027-03-15", region: "Asia" })).toBe(false);
        expect(conflicts(a, { startDate: "2027-03-13", endDate: "2027-03-15", region: null })).toBe(true);
    });

    it("is symmetric and catches overlaps", () => {
        const b = { startDate: "2027-03-05", endDate: "2027-03-20", region: "Europe" as const };
        expect(conflicts(a, b)).toBe(true);
        expect(conflicts(b, a)).toBe(true);
    });
});

describe("feasibleMasks", () => {
    const stint = (start: string, end: string, region: "Europe" | "Asia" | null = "Europe") => ({ startDate: start, endDate: end, region });
    const stints = [
        stint("2027-01-01", "2027-01-05"),
        stint("2027-01-07", "2027-01-10"),
        stint("2027-01-08", "2027-01-12", "Asia"),
        stint("2027-01-20", "2027-01-25", null),
        stint("2027-01-28", "2027-02-01"),
    ];

    it("lists every non-conflicting subset within the cap, matching brute force", () => {
        for (const cap of [0, 1, 2, 5]) {
            const brute = [...Array(1 << stints.length).keys()].filter((mask) => {
                const chosen = indicesOf(mask);
                return chosen.length <= cap && chosen.every((i) => chosen.every((j) => i >= j || !conflicts(stints[i], stints[j])));
            });
            expect(feasibleMasks(stints, cap)).toEqual(brute);
        }
    });

    it("applies the travel buffers: 2 days in a region, 4 across or unknown", () => {
        const masks = new Set(feasibleMasks(stints, 5));
        expect(masks.has(maskOf([0, 1]))).toBe(true);
        expect(masks.has(maskOf([1, 2]))).toBe(false);
        expect(masks.has(maskOf([0, 2]))).toBe(false);
        expect(masks.has(maskOf([3, 4]))).toBe(false);
        expect(Math.max(...[...masks].map(popcount))).toBe(3);
    });
});

describe("online events", () => {
    const lan = { startDate: "2027-03-01", endDate: "2027-03-05", region: "Europe" as const };
    const online = (start: string, end: string) => ({ startDate: start, endDate: end, region: "Europe" as const, kind: "online" as const });

    it("clash with a LAN only on shared days, and never with each other", () => {
        expect(conflicts(lan, online("2027-03-05", "2027-03-08"))).toBe(true);
        expect(conflicts(lan, online("2027-03-06", "2027-03-08"))).toBe(false);
        expect(conflicts(online("2027-02-20", "2027-03-01"), lan)).toBe(true);
        expect(conflicts(online("2027-03-01", "2027-03-30"), online("2027-03-02", "2027-03-03"))).toBe(false);
    });

    it("run at most ONLINE_CONCURRENCY at once, under separate LAN and online caps", () => {
        const caps = { lan: 1, online: 5 };
        const a = online("2027-04-01", "2027-04-10");
        const b = online("2027-04-05", "2027-04-12");
        expect(ONLINE_CONCURRENCY).toBe(2);
        expect(fits([a], b, caps)).toBe(true);
        expect(fits([a, b], online("2027-04-09", "2027-04-20"), caps)).toBe(false);
        expect(fits([a, b], online("2027-04-11", "2027-04-20"), caps)).toBe(true);
        expect(fits([a, b], online("2027-03-20", "2027-04-02"), caps)).toBe(true);
        expect(fits([lan], { ...lan, startDate: "2027-05-01", endDate: "2027-05-02" }, caps)).toBe(false);
        expect(fits([a, b], lan, caps)).toBe(true);
        expect(fits([lan, a], b, { lan: 1, online: 1 })).toBe(false);
    });

    it("feasibleSets lists every allowed subset, matching brute force", () => {
        const stints = [lan, online("2027-03-04", "2027-03-09"), online("2027-03-06", "2027-03-20"), online("2027-03-08", "2027-03-10"), { ...lan, startDate: "2027-03-08", endDate: "2027-03-09" }];
        const caps = { lan: 2, online: 2 };
        const brute = [...Array(1 << stints.length).keys()]
            .map(indicesOf)
            .filter((chosen) => chosen.every((i, k) => fits(chosen.slice(0, k).map((j) => stints[j]), stints[i], caps)))
            .sort((x, y) => x.join(",").localeCompare(y.join(",")));
        const sets = feasibleSets(stints, caps).sort((x, y) => x.join(",").localeCompare(y.join(",")));
        expect(sets).toEqual(brute);
        expect(sets.some((s) => s.join() === "1,2")).toBe(true);
        expect(sets.some((s) => s.join() === "1,2,3")).toBe(false);
        expect(feasibleSets(stints, caps, 3)).toHaveLength(3);
    });
});

describe("volumeBaselines", () => {
    const t = (date: string) => Date.parse(`${date}T12:00:00Z`) / 1000;
    const match = (eventId: string, date: string, team1Id: string, team2Id = "X"): ValveMatch =>
        ({ eventId, matchStartTime: t(date), team1Id, team2Id }) as ValveMatch;
    const lan = (eventId: string) => ({ eventId, eventName: eventId, prizePool: "$1", lan: true, finished: true, prizeDistribution: [] });

    it("counts distinct LANs in the last 180 days, merges Major stages, and scales to the horizon", () => {
        const md: Matchdata = {
            events: [lan("A"), lan("B"), lan("Major"), lan("Major/Stage_1"), { ...lan("Online"), lan: false }, lan("Old")],
            matches: [
                match("A", "2026-10-01", "T1"),
                match("A", "2026-10-02", "T1"),
                match("B", "2026-10-10", "T1"),
                match("Major/Stage_1", "2026-09-01", "T1"),
                match("Major", "2026-09-10", "T1"),
                match("Online", "2026-10-05", "T1"),
                match("Old", "2026-01-01", "T1"),
                match("A", "2026-10-01", "T2"),
            ],
        };
        expect(volumeBaselines(md, ["T1", "T2"], "2026-11-01", 180)).toMatchObject({ low: 1, average: 3, high: 3, teamsCounted: 2 });
        expect(volumeBaselines(md, ["T1"], "2026-11-01", 90).average).toBe(2);
    });
});
