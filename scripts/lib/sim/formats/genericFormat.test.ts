import { describe, expect, it } from "vitest";
import type { EventConfig } from "../config.ts";
import { makeRng } from "../rng.ts";
import { runEvent } from "../simulate.ts";
import { labelPositions } from "../catalog.ts";
import { genericStages, type EventRole } from "./genericFormat.ts";

const teams = (n: number) => Array.from({ length: n }, (_, i) => `T${i + 1}`);
const coinFlip = { seriesProbability: () => 0.5, setHorizon: () => {}, resample: () => {} };

const play = (n: number, role: EventRole, qualifying?: number, seed = 1) => {
    const stages = genericStages("Page", n, role, qualifying);
    stages[0].invited = teams(n);
    const config = { slug: "e", name: "E", liquipedia: "Page", startDate: "2027-01-01", endDate: "2027-01-03", lan: true, stages } as EventConfig;
    return runEvent({ config, known: new Map(), horizon: 0 }, coinFlip as never, makeRng(seed));
};

const perTeam = (n: number, role: EventRole, qualifying?: number) => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) total += (2 * play(n, role, qualifying, seed).matches.length) / n;
    return total / 20;
};

describe("genericStages", () => {
    it("places every team once, at labels that cover each position exactly", () => {
        for (const [n, role, q] of [[2, "main"], [3, "main"], [4, "main"], [6, "main"], [10, "main"], [24, "main"], [56, "main"], [5, "qualifier", 1], [64, "qualifier", 2], [100, "qualifier", 4]] as const) {
            const outcome = play(n, role, q);
            expect(outcome.placements.size).toBe(n);
            const counts = new Map<string, number>();
            for (const label of outcome.placements.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
            for (const [label, k] of counts) expect(k).toBe(labelPositions(label).length);
        }
    });

    it("plays about as many matches per team as observed: 3.4–3.7 at main events, 2.0–2.3 in qualifiers", () => {
        for (const n of [8, 16, 24]) expect(Math.abs(perTeam(n, "main") - 3.6)).toBeLessThan(0.4);
        for (const n of [32, 64, 128]) expect(Math.abs(perTeam(n, "qualifier", 2) - 2.1)).toBeLessThan(0.4);
    });

    it("plays Bo1 in qualifier rounds of more than 8 matches and Bo3 after", () => {
        const { matches } = play(64, "qualifier", 2);
        expect(matches.filter((m) => m.round <= 2).every((m) => m.bestOf === 1)).toBe(true);
        expect(matches.filter((m) => m.round > 2).every((m) => m.bestOf === 3)).toBe(true);
    });

    it("gives byes to the top seeds", () => {
        const { matches } = play(6, "qualifier", 1);
        const firstRound = matches.filter((m) => m.round === 1).flatMap((m) => m.teams);
        expect(firstRound).not.toContain("T1");
        expect(firstRound).not.toContain("T2");
        expect(firstRound).toHaveLength(4);
    });
});
