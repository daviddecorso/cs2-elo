import { describe, expect, it } from "vitest";
import { addDays } from "../liquipedia/rawStore.ts";
import type { Roster } from "../../../src/vrs/types.ts";
import { AFFINITY_DAYS, AffinityIndex, affinityLogLikelihood, affinitySamples, affinityWeight, emptyCell, fitAffinity, type AffinitySample } from "./affinity.ts";
import { makeRng } from "./rng.ts";
import type { PastEdition } from "./history.ts";

const players = (nicks: string[], country = "de") => nicks.map((nick) => ({ nick, country }));
const edition = (series: string, organizer: string, startDate: string, lineups: string[][]): PastEdition => ({
    page: series,
    name: series,
    series,
    kind: "lan",
    role: "main",
    tier: 3,
    publisherTier: "Tier 2",
    category: "lan34",
    region: "Europe",
    organizer,
    country: "de",
    prizePool: 10000,
    teams: lineups.length,
    startDate,
    endDate: addDays(startDate, 2),
    listDate: null,
    attendees: lineups.map((nicks, i) => ({ teamId: `t${i}`, globalRank: null, regionalRank: null, region: "Europe", players: players(nicks) })),
    labeled: false,
});

describe("AffinityIndex", () => {
    const index = new AffinityIndex([edition("Cup/#", "Org", "2026-01-10", [["a", "b", "c", "d", "e"]]), edition("Other/#", "Org", "2026-02-10", [["f", "g", "h", "i", "j"]])]);
    const event = (startDate: string, country = "") => ({ series: "Cup/#", organizer: "Org", country, startDate });

    it("finds a lineup's history with the series, else the organizer, within the window", () => {
        expect(index.pattern(players(["a", "b", "c", "x", "y"]), event("2026-06-01"))).toBe(0b001);
        expect(index.pattern(players(["f", "g", "h", "x", "y"]), event("2026-06-01"))).toBe(0b010);
        expect(index.pattern(players(["a", "b", "x", "y", "z"]), event("2026-06-01"))).toBe(0);
        expect(index.pattern(players(["a", "b", "c"]), event("2026-01-10"))).toBe(0);
        expect(index.pattern(players(["a", "b", "c"]), event(addDays("2026-01-10", AFFINITY_DAYS + 1)))).toBe(0);
    });

    it("counts home when three players come from the venue's country", () => {
        expect(index.pattern(players(["x", "y", "z"], "de"), event("2026-06-01", "de"))).toBe(0b100);
        expect(index.pattern(players(["x", "y", "z"], "fr"), event("2026-06-01", "de"))).toBe(0);
    });
});

describe("affinitySamples", () => {
    const roster = (rank: number, nicks: string[]): Roster => ({
        rosterKey: `r${rank}`,
        teamName: `T${rank}`,
        players: nicks,
        points: 2000 - rank,
        globalRank: rank,
        regionalRank: rank,
        region: "Europe",
    } as Roster);
    const list = { date: "2026-03-02", rosters: [roster(40, ["a1", "a2", "a3", "a4", "a5"]), roster(41, ["b1", "b2", "b3", "b4", "b5"]), roster(42, ["c1", "c2", "c3", "c4", "c5"])] };
    const at = (page: string, startDate: string, attendee: { nicks: string[]; rank: number | null; label?: "vrs" | "qualifier" | "direct" }[], labeled: boolean): PastEdition => ({
        ...edition(page, "Org", startDate, []),
        page,
        listDate: list.date,
        labeled,
        attendees: attendee.map((a, i) => ({ teamId: `${page}${i}`, globalRank: a.rank, regionalRank: a.rank, region: "Europe", label: a.label, players: players(a.nicks) })),
    });
    const range = { from: "2026-03-01", to: "2026-04-01" };

    it("skips unlabelled editions, whose VRS invitees would count as free choices", () => {
        const e = at("Cup/1", "2026-03-10", [{ nicks: list.rosters[0].players, rank: 40 }], false);
        expect(affinitySamples([e], [list], new AffinityIndex([e]), new Map(), range)).toEqual([]);
    });

    it("leaves rosters at a clashing LAN out of the chosen team's cell", () => {
        const e = at("Cup/1", "2026-03-10", [{ nicks: list.rosters[0].players, rank: 40, label: "direct" }], true);
        const clash = at("Other/1", "2026-03-11", [{ nicks: list.rosters[1].players, rank: 41 }], true);
        const samples = affinitySamples([e, clash], [list], new AffinityIndex([e, clash]), new Map(), { ...range, to: "2026-03-11" });
        expect(samples).toHaveLength(1);
        expect(samples[0].cell.reduce((a, b) => a + b, 0)).toBe(2);
    });
});

describe("fitAffinity", () => {
    it("recovers a planted repeat effect and leaves the others near 0", () => {
        const rng = makeRng(3);
        const planted = [1.5, 0, 0];
        const samples: AffinitySample[] = Array.from({ length: 3000 }, () => {
            const cell = emptyCell();
            const teams = Array.from({ length: 20 }, () => Math.floor(rng() * 8));
            for (const p of teams) cell[p]++;
            const weights = teams.map((p) => affinityWeight(planted, p));
            let u = rng() * weights.reduce((a, b) => a + b, 0);
            const chosen = teams.find((_, i) => (u -= weights[i]) <= 0) ?? teams.at(-1)!;
            return { chosen, cell, date: "2026-01-01" };
        });
        const beta = fitAffinity(samples);
        expect(beta[0]).toBeCloseTo(1.5, 0);
        expect(Math.abs(beta[1])).toBeLessThan(0.2);
        expect(Math.abs(beta[2])).toBeLessThan(0.2);
        expect(affinityLogLikelihood(beta, samples)).toBeGreaterThan(affinityLogLikelihood([0, 0, 0], samples));
        expect(fitAffinity(samples, ["home"])[0]).toBe(0);
    });
});
