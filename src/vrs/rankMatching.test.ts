import { describe, expect, it } from "vitest";
import { getPlayerOverlap, matchPreviousRanks } from "./rankMatching.ts";
import type { Roster } from "./types.ts";

const makeRoster = (
    teamName: string,
    players: string[],
    globalRank: number | null = 1,
    points = 1000
): Roster => ({
    rosterKey: [...players].map((p) => p.toLowerCase()).sort().join(","),
    teamName,
    region: "Europe",
    regionalRank: globalRank,
    globalRank,
    points,
    startingValue: points,
    h2hAdjustment: 0,
    players,
    factors: {
        bountyOffered: 1,
        bountyCollected: 1,
        opponentNetwork: 1,
        lanFactor: 1,
    },
});

describe("getPlayerOverlap", () => {
    it("counts case-insensitive shared player nicks", () => {
        expect(getPlayerOverlap(["ZywOo", "flameZ", "mezii"], ["zywoo", "FLAMEZ", "ropz"])).toBe(2);
        expect(getPlayerOverlap([], ["a", "b"])).toBe(0);
    });
});

describe("matchPreviousRanks", () => {
    it("matches exact rosterKey rosters", () => {
        const prev = [makeRoster("MOUZ", ["torzsi", "xertioN", "Spinx", "Brollan", "siuhy"], 4)];
        const live = [makeRoster("MOUZ", ["torzsi", "xertioN", "Spinx", "Brollan", "siuhy"], 1)];

        const ranks = matchPreviousRanks(live, prev);
        expect(ranks.get(live[0].rosterKey)).toBe(4);
    });

    it("matches 4 of 5 players with same team name", () => {
        const prev = [makeRoster("Vitality", ["apEX", "flameZ", "mezii", "ropz", "ZywOo"], 3)];
        const live = [makeRoster("Vitality", ["ZywOo", "flameZ", "mezii", "ropz", "jL"], 2)];

        const ranks = matchPreviousRanks(live, prev);
        expect(ranks.get(live[0].rosterKey)).toBe(3);
    });

    it("matches 3 of 5 players with same team name", () => {
        const prev = [makeRoster("Astralis", ["HooXi", "jabbi", "phzy", "ryu", "Staehr"], 10)];
        const live = [makeRoster("Astralis", ["Staehr", "phzy", "ryu", "siuhy", "stavn"], 12)];

        const ranks = matchPreviousRanks(live, prev);
        expect(ranks.get(live[0].rosterKey)).toBe(10);
    });

    it("matches 3+ players across a team rename or org change", () => {
        const prev = [makeRoster("6666", ["amster", "dENZY", "kL1o", "rendysky", "skcH"], 40)];
        const live = [makeRoster("ex-6666 Esports", ["skcH", "rendysky", "amster", "kL1o", "stefienson"], 38)];

        const ranks = matchPreviousRanks(live, prev);
        expect(ranks.get(live[0].rosterKey)).toBe(40);
    });

    it("returns null when player overlap is below 3", () => {
        const prev = [makeRoster("OG", ["adamb", "bodyy", "cadiaN", "pr1metapz", "spooke"], 107)];
        const live = [makeRoster("OG", ["spooke", "bodyy", "Ex3rcice", "Chucky", "nut nut"], 221)];

        const ranks = matchPreviousRanks(live, prev);
        expect(ranks.get(live[0].rosterKey)).toBeNull();
    });

    it("prioritizes higher overlap and same team name when resolving multiple candidates", () => {
        const prevVitality = makeRoster("Vitality", ["apEX", "flameZ", "mezii", "ropz", "ZywOo"], 3, 1900);
        const prevOther = makeRoster("Other", ["flameZ", "mezii", "ropz", "a", "b"], 50, 800);

        const liveVitality = makeRoster("Vitality", ["ZywOo", "flameZ", "mezii", "ropz", "jL"], 2, 1920);

        const ranks = matchPreviousRanks([liveVitality], [prevOther, prevVitality]);
        expect(ranks.get(liveVitality.rosterKey)).toBe(3);
    });

    it("returns null when previous roster has null rank", () => {
        const prev = [makeRoster("Newbie", ["a", "b", "c", "d", "e"], null)];
        const live = [makeRoster("Newbie", ["a", "b", "c", "d", "e"], 50)];

        const ranks = matchPreviousRanks(live, prev);
        expect(ranks.get(live[0].rosterKey)).toBeNull();
    });

    it("ignores incomplete rosters with fewer than 3 players", () => {
        const prev = [makeRoster("Partial", ["p1", "p2"], 20)];
        const live = [makeRoster("Partial", ["p1", "p2"], 25)];

        const ranks = matchPreviousRanks(live, prev);
        expect(ranks.get(live[0].rosterKey)).toBeNull();
    });
});
