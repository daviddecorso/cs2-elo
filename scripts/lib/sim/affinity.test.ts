import { describe, expect, it } from "vitest";
import { addDays } from "../liquipedia/rawStore.ts";
import { AFFINITY_DAYS, AffinityIndex, affinityLogLikelihood, affinityWeight, emptyCell, fitAffinity, type AffinitySample } from "./affinity.ts";
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
