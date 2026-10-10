import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateMatchdata } from "./matchdataSchema.ts";

describe("matchdataSchema", () => {
    const fixturePath = path.resolve(process.cwd(), "fixtures/matchdata.synthetic.json");
    const rawFixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

    it("validates fixture with zero errors", () => {
        const { errors, warnings } = validateMatchdata(rawFixture);
        expect(errors).toEqual([]);
        expect(warnings.length).toBeGreaterThan(0);
    });

    it("catches eventId with no matching event", () => {
        const clone = JSON.parse(JSON.stringify(rawFixture));
        clone.matches[0].eventId = "nonexistent-event-999";
        const { errors } = validateMatchdata(clone);
        expect(errors.some((e: string) => e.includes("nonexistent-event-999"))).toBe(true);
    });

    it("catches missing clubShare", () => {
        const clone = JSON.parse(JSON.stringify(rawFixture));
        delete clone.events[0].prizeDistribution[0].clubShare;
        const { errors } = validateMatchdata(clone);
        expect(errors.some((e: string) => e.includes("clubShare"))).toBe(true);
    });

    it("catches missing qualifiedEvents array", () => {
        const clone = JSON.parse(JSON.stringify(rawFixture));
        delete clone.events[0].prizeDistribution[0].qualifiedEvents;
        const { errors } = validateMatchdata(clone);
        expect(errors.some((e: string) => e.includes("qualifiedEvents"))).toBe(true);
    });

    it("catches invalid countryIso absent from region.js", () => {
        const clone = JSON.parse(JSON.stringify(rawFixture));
        clone.matches[0].team1Players[0].countryIso = "zz-invalid";
        const { errors } = validateMatchdata(clone);
        expect(errors.some((e: string) => e.includes("countryIso") && e.includes("zz-invalid"))).toBe(true);
    });

    it("catches malformed prizePool", () => {
        const clone = JSON.parse(JSON.stringify(rawFixture));
        clone.events[0].prizePool = "five million";
        const { errors } = validateMatchdata(clone);
        expect(errors.some((e: string) => e.includes("malformed prizePool"))).toBe(true);
    });

    it("catches bad winningTeam", () => {
        const clone = JSON.parse(JSON.stringify(rawFixture));
        clone.matches[0].winningTeam = 3;
        const { errors } = validateMatchdata(clone);
        expect(errors.some((e: string) => e.includes("winningTeam must be 1 or 2"))).toBe(true);
    });
});
