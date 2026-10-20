import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getRosterKey } from "../../../src/vrs/types.ts";
import { parseDetailsFile, readDetailsSnapshot } from "./valveDetails.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../");
const valveRoot = path.resolve(repoRoot, "vendor/counter-strike_regional_standings");

describe("valveDetails", () => {
    it("parses Spirit details file correctly (high-ranked)", () => {
        const filePath = path.join(
            valveRoot,
            "live/2026/details/2026_10_05/0001--spirit--donk-magixx-sh1ro-tn1r-zont1x.md"
        );
        const markdown = fs.readFileSync(filePath, "utf8");
        const parsed = parseDetailsFile(markdown);

        expect(parsed.teamName).toBe("Spirit");
        expect(parsed.roster).toEqual(["donk", "magixx", "sh1ro", "tN1R", "zont1x"]);
        expect(parsed.globalRank).toBe(1);
        expect(parsed.region).toBe("Europe");
        expect(parsed.regionalRank).toBe(1);
        expect(parsed.finalRankValue).toBe(2046.2);
        expect(parsed.startingRankValue).toBe(2000.0);
        expect(parsed.h2hAdjustments).toBe(46.2);

        expect(parsed.factors.bountyOffered).toBe(1.0);
        expect(parsed.factors.bountyCollected).toBe(0.872);
        expect(parsed.factors.opponentNetwork).toBe(0.398);
        expect(parsed.factors.lanFactor).toBe(0.932);

        expect(parsed.top10ScaledWinnings).toBe(1058245.04);
        expect(parsed.fifthHighestScaledWinnings).toBe(479090.66);
        expect(parsed.bountyOfferedRows.length).toBe(6);
        expect(parsed.bountyOfferedRows[0]).toEqual({
            eventDate: "2026-09-06",
            ageWeight: 1.0,
            prizeWinnings: 250000,
            scaledWinnings: 250000,
        });

        expect(parsed.matches.length).toBe(38);
        expect(parsed.matches[0].matchId).toBe(1319);
        expect(parsed.matches[0].matchPlayed).toBe(38);
        expect(parsed.matches[0].opponent).toBe("MOUZ");
        expect(parsed.matches[0].result).toBe("W");
        expect(parsed.matches[0].eventWeight).toBe(1.0);
        expect(parsed.matches[0].h2hAdjustment).toBe(10.35);
    });

    it("parses Fruju details file correctly (low-ranked)", () => {
        const filePath = path.join(
            valveRoot,
            "live/2026/details/2026_10_05/0380--fruju--camille-elephant-harbor-kezza-lawlkay.md"
        );
        const markdown = fs.readFileSync(filePath, "utf8");
        const parsed = parseDetailsFile(markdown);

        expect(parsed.teamName).toBe("Fruju");
        expect(parsed.roster).toEqual(["camille", "ElephanT", "Harbor", "Kezza", "lawlkay"]);
        expect(parsed.globalRank).toBe(380);
        expect(parsed.region).toBe("Asia");
        expect(parsed.regionalRank).toBe(46);
        expect(parsed.finalRankValue).toBe(381.1);
        expect(parsed.startingRankValue).toBe(400.0);
        expect(parsed.h2hAdjustments).toBe(-18.9);

        expect(parsed.factors.bountyOffered).toBe(0.0);
        expect(parsed.factors.bountyCollected).toBe(0.0);
        expect(parsed.factors.opponentNetwork).toBe(0.0);
        expect(parsed.factors.lanFactor).toBe(0.0);

        expect(parsed.top10ScaledWinnings).toBe(0);
        expect(parsed.fifthHighestScaledWinnings).toBe(479090.66);
        expect(parsed.bountyOfferedRows.length).toBe(0);

        expect(parsed.matches.length).toBe(7);
        expect(parsed.matches[0].matchPlayed).toBe(7);
        expect(parsed.matches[0].matchId).toBe(537);
        expect(parsed.matches[0].opponent).toBe("LFO 8");
        expect(parsed.matches[0].result).toBe("L");
    });

    it("reads full snapshot directory", () => {
        const snapshot = readDetailsSnapshot(valveRoot, "2026-10-05");
        expect(snapshot.size).toBeGreaterThan(300);
        const spiritKey = getRosterKey(["donk", "magixx", "sh1ro", "tn1r", "zont1x"]);
        expect(snapshot.has(spiritKey)).toBe(true);
    });
});
