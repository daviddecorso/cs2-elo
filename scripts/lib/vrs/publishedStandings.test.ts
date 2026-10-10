import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPublishedSnapshot } from "./publishedStandings.ts";

describe("publishedStandings", () => {
    const valveRoot = path.resolve(process.cwd(), "vendor/counter-strike_regional_standings");

    it("parses 2026-10-05 snapshot with correct counts and Spirit details", () => {
        const standings = readPublishedSnapshot(valveRoot, "2026-10-05");

        expect(standings.rosters.length).toBe(380);

        const euCount = standings.rosters.filter((r) => r.region === "Europe").length;
        const amCount = standings.rosters.filter((r) => r.region === "Americas").length;
        const asiaCount = standings.rosters.filter((r) => r.region === "Asia").length;

        expect(euCount).toBe(245);
        expect(amCount).toBe(89);
        expect(asiaCount).toBe(46);

        const spirit = standings.rosters.find((r) => r.globalRank === 1);
        expect(spirit).toBeDefined();
        expect(spirit!.teamName).toBe("Spirit");
        expect(spirit!.points).toBe(2046);
        expect(spirit!.players).toEqual(["donk", "magixx", "sh1ro", "tN1R", "zont1x"]);
        expect(spirit!.factors.bountyOffered).toBe(1.0);
        expect(spirit!.factors.bountyCollected).toBe(0.872);
        expect(spirit!.factors.opponentNetwork).toBe(0.398);
        expect(spirit!.factors.lanFactor).toBe(0.932);
    });
});
