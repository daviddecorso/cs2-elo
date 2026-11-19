import { describe, expect, it } from "vitest";
import type { ValvePlayer } from "../vrs/buildMatchdata.ts";
import type { EventConfig } from "./config.ts";
import { genericStages } from "./formats/genericFormat.ts";
import { makeRng } from "./rng.ts";
import { runEvent } from "./simulate.ts";
import { simulationDelta, type ProjectionEvent } from "./vrsProjection.ts";

const teams = Array.from({ length: 64 }, (_, i) => `T${i + 1}`);
const lineups = new Map(teams.map((t) => [t, { name: t, players: [] as ValvePlayer[] }]));
const coinFlips = { resample: () => {}, setHorizon: () => {}, seriesProbability: () => 0.5 };

const qualifier = (extra: Partial<ProjectionEvent> = {}, allBo1 = false) => {
    const stages = genericStages("Q", 64, "qualifier", 2);
    stages[0].invited = teams;
    if (allBo1) stages[0].bestOf = { default: 1 };
    const config: EventConfig = { slug: "q", name: "Q", liquipedia: "Q", startDate: "2027-01-01", endDate: "2027-01-03", lan: false, stages };
    const event: ProjectionEvent = { config, eventId: "Q", prizePool: "$0", prizes: new Map(), qualifies: "Main", ...extra };
    const outcome = runEvent({ config, known: new Map(), horizon: 0 }, coinFlips, makeRng(1));
    return simulationDelta([event], [outcome], lineups, (t) => t);
};

describe("simulationDelta", () => {
    it("leaves Bo1 bracket rounds of more than 8 matches unranked, as Valve's data does", () => {
        const { matches } = qualifier();
        const ranked = matches.filter((m) => m.valveRanked);
        expect(matches).toHaveLength(62);
        expect(ranked).toHaveLength(62 - 32 - 16);
    });

    it("leaves every Bo1 bracket match of a Tier 2 qualifier, and every match of an unranked event, unranked", () => {
        expect(qualifier({}, true).matches.filter((m) => m.valveRanked)).toHaveLength(14);
        expect(qualifier({ publisherTier: "Tier 2 Qualifier" }, true).matches.some((m) => m.valveRanked)).toBe(false);
        expect(qualifier({ ranked: false }).matches.some((m) => m.valveRanked)).toBe(false);
    });

    it("points a qualifier's prize rows at the event it qualifies for, so Valve links the prize pools", () => {
        const { events } = qualifier();
        expect(events[0].prizeDistribution).toHaveLength(64);
        expect(events[0].prizeDistribution.every((p) => p.qualifiedEvents.join() === "Main")).toBe(true);
        expect(events[0].prizeDistribution.filter((p) => p.placement === 1)).toHaveLength(2);
    });
});
