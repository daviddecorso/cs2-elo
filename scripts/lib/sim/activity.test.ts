import { describe, expect, it } from "vitest";
import { capsFor, fitActivity, Pacer, PACE_FLOOR, poisson, poissonQuantile, type ActivityTeam } from "./activity.ts";
import type { PastEdition } from "./history.ts";
import { seriesKey } from "./series.ts";
import { makeRng } from "./rng.ts";

const edition = (page: string, startDate: string, teams: string[], category: PastEdition["category"] = "online"): PastEdition => ({
    page,
    name: page,
    series: seriesKey(page),
    kind: category.startsWith("lan") ? "lan" : "online",
    role: category === "qualifier" ? "qualifier" : "main",
    tier: 3,
    publisherTier: "Tier 2",
    category,
    region: "Europe",
    prizePool: 0,
    teams: teams.length,
    startDate,
    endDate: startDate,
    listDate: null,
    attendees: teams.map((teamId) => ({ teamId, globalRank: 50, regionalRank: 50, region: "Europe" })),
    labeled: false,
});
const population: ActivityTeam[] = ["busy", "idle", "mid"].map((teamId) => ({ teamId, globalRank: 50, region: "Europe" }));
// Over the 365 days to the as-of date, "busy" plays 12 online events, "mid" 4, "idle" none.
const editions = Array.from({ length: 12 }, (_, k) => edition(`Cup/${k}`, `2026-${String(k + 1).padStart(2, "0")}-10`, k % 3 === 0 ? ["busy", "mid"] : ["busy"]));
const model = fitActivity(editions, population, { asOf: "2026-12-31" });

describe("fitActivity", () => {
    it("shrinks each team's rate toward its band's mean", () => {
        const band = model.bandRates(50, "Europe").online;
        expect(band).toBeCloseTo(16 / 3 / 365, 6);
        expect(model.rates("busy").online).toBeGreaterThan(band);
        expect(model.rates("idle").online).toBeLessThan(band);
        expect(model.rates("idle").online).toBeGreaterThan(0);
        expect(model.rates("busy").lan1).toBe(0);
    });

    it("gives a team off the population its band's rate, or everyone's when its band is empty", () => {
        expect(model.rates("stranger").online).toBeCloseTo((365 * model.bandRates(50, "Europe").online) / 730, 6);
    });
});

describe("capsFor", () => {
    it("takes the team's own p90 over the horizon, at least the LAN floor and two online events", () => {
        expect(capsFor(model, "idle", 120, 6)).toEqual({ lan: 6, online: 2 });
        expect(capsFor(model, "busy", 120, 6).online).toBeGreaterThan(2);
    });
});

describe("Pacer", () => {
    it("keeps a team on habit near 1, and holds it back once it passes its budget", () => {
        const pacer = new Pacer(model, "2027-04-01", 120, 1);
        const start = pacer.pace("idle", "online", "2026-12-01");
        expect(start).toBeGreaterThan(0.3);
        for (let k = 0; k < 10; k++) pacer.record("idle", "online");
        expect(pacer.pace("idle", "online", "2026-12-01")).toBe(PACE_FLOOR);
    });

    it("draws the same budgets for the same seed and team", () => {
        const a = new Pacer(model, "2027-04-01", 120, 5);
        const b = new Pacer(model, "2027-04-01", 120, 5);
        expect(a.pace("busy", "online", "2027-01-01")).toBe(b.pace("busy", "online", "2027-01-01"));
    });
});

describe("poisson", () => {
    it("matches its mean and quantile", () => {
        const rng = makeRng(3);
        const draws = Array.from({ length: 4000 }, () => poisson(3, rng));
        expect(draws.reduce((a, b) => a + b, 0) / draws.length).toBeCloseTo(3, 1);
        expect(poissonQuantile(3, 0.9)).toBe(5);
        expect(poissonQuantile(0, 0.9)).toBe(0);
    });
});
