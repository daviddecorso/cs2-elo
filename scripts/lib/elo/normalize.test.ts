import { describe, expect, it } from "vitest";
import { normalizeMatches } from "./normalize.ts";

const opponent = (page: string, names: string[]) => ({
    type: "team",
    name: page,
    teamtemplate: { page },
    match2players: names.map((name) => ({ name, displayname: name.toLowerCase(), flag: "Sweden" })),
});

const raw = (overrides: Record<string, unknown> = {}) => ({
    pagename: "Event/2026",
    match2id: "R01-M001",
    game: "cs2",
    winner: "2",
    walkover: "",
    resulttype: "",
    bestof: 3,
    type: "Offline",
    liquipediatier: "1",
    date: "2026-10-18 15:00:00",
    extradata: { timestamp: 1792335600 },
    match2opponents: [opponent("A", ["A1", "A2", "A3", "A4", "A5"]), opponent("B", ["B1", "B2", "B3", "B4", "B5"])],
    match2games: [
        { map: "Dust II", scores: [6, 13], resulttype: "" },
        { map: "Nuke", scores: [16, 19], resulttype: "" },
        { map: "Mirage", scores: [], resulttype: "np" },
    ],
    ...overrides,
});

describe("normalizeMatches", () => {
    it("keeps scored maps and drops unplayed ones", () => {
        const { matches, players } = normalizeMatches([raw()], [{ pagename: "Event/2026", prizepool: 1000000 }]);
        expect(matches).toHaveLength(1);
        const m = matches[0];
        expect(m).toMatchObject({ id: "Event/2026:R01-M001", winner: 1, lan: true, tier: 1, bestOf: 3, prizePool: 1000000, forfeit: false });
        expect(m.maps).toEqual([
            { map: "Dust II", rounds: [6, 13] },
            { map: "Nuke", rounds: [16, 19] },
        ]);
        expect(players.A1).toEqual({ nick: "a1", country: "se" });
    });

    it("flags forfeits and skips abandoned maps", () => {
        const { matches } = normalizeMatches(
            [raw({ walkover: "ff", match2games: [{ map: "Nuke", scores: [5, 3] }] })],
            []
        );
        expect(matches[0].forfeit).toBe(true);
        expect(matches[0].maps).toEqual([]);
    });

    it("drops draws, non-CS2 games and duplicate rows", () => {
        const { matches } = normalizeMatches([raw({ winner: "0" }), raw({ game: "csgo", match2id: "x" }), raw({ match2id: "y" }), raw({ match2id: "y" })], []);
        expect(matches.map((m) => m.id)).toEqual(["Event/2026:y"]);
    });
});
