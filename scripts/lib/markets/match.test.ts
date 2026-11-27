import { describe, expect, it } from "vitest";
import { closeAndOpen, matchMarkets, normalizeTeam, type FeedSeries } from "./match.ts";

const H = 3600;

describe("normalizeTeam", () => {
    it("drops filler words, accents, punctuation and parentheticals", () => {
        expect(normalizeTeam("Team Vitality")).toBe("vitality");
        expect(normalizeTeam("Grêmio Esports")).toBe("gremio");
        expect(normalizeTeam("MAYBE (Ukrainian team)")).toBe("maybe");
        expect(normalizeTeam("5star eSports")).toBe("5star");
        expect(normalizeTeam("FORZE Reload")).toBe("forzereload");
        expect(normalizeTeam("Fire Flux E-Sports")).toBe("fireflux");
    });
});

describe("matchMarkets", () => {
    const series: FeedSeries[] = [
        { id: "a", t: 100 * H, teams: ["Team Vitality", "Natus Vincere"] },
        { id: "b", t: 200 * H, teams: ["FaZe Clan", "MOUZ"] },
        { id: "c", t: 203 * H, teams: ["MOUZ", "FaZe Clan"] },
        { id: "d", t: 300 * H, teams: ["1w Team", "BIG"] },
    ];

    it("matches either order and flags a swap", () => {
        const { matches } = matchMarkets(series, [
            { marketId: "m1", outcomes: ["Vitality", "Natus Vincere"], start: 101 * H },
            { marketId: "m2", outcomes: ["Natus Vincere", "Vitality"], start: 99 * H },
        ]);
        expect(matches).toEqual([
            { marketId: "m1", seriesId: "a", swapped: false },
            { marketId: "m2", seriesId: "a", swapped: true },
        ]);
    });

    it("leaves markets outside the time window unmatched", () => {
        const { matches, unmatched } = matchMarkets(series, [{ marketId: "m", outcomes: ["Vitality", "Natus Vincere"], start: 140 * H }]);
        expect(matches).toHaveLength(0);
        expect(unmatched.map((m) => m.marketId)).toEqual(["m"]);
    });

    it("drops a market when two series of the pair are close together", () => {
        const { matches, ambiguous } = matchMarkets(series, [{ marketId: "m", outcomes: ["FaZe", "MOUZ"], start: 201 * H }]);
        expect(matches).toHaveLength(0);
        expect(ambiguous).toHaveLength(1);
    });

    it("uses extra team names and outcome aliases", () => {
        const names = new Map([["1w Team", ["1win"]]]);
        const viaNames = matchMarkets(series, [{ marketId: "m", outcomes: ["1win", "BIG"], start: 300 * H }], names);
        expect(viaNames.matches[0]).toMatchObject({ seriesId: "d", swapped: false });
        const viaAlias = matchMarkets(series, [{ marketId: "m", outcomes: ["BIG", "One Win"], start: 300 * H }], new Map(), { "One Win": "1w Team" });
        expect(viaAlias.matches[0]).toMatchObject({ seriesId: "d", swapped: true });
    });
});

describe("closeAndOpen", () => {
    const history = [
        { t: 0, p: 0.4 },
        { t: 10 * H, p: 0.45 },
        { t: 30 * H, p: 0.5 },
        { t: 36 * H, p: 0.6 },
    ];

    it("takes the last pre-start point as close and the price 24h out as open", () => {
        expect(closeAndOpen(history, 35 * H)).toEqual({ close: { t: 30 * H, p: 0.5 }, open: { t: 10 * H, p: 0.45 } });
    });

    it("has no open when trading began inside the lead", () => {
        expect(closeAndOpen(history.slice(2), 35 * H)?.open).toBeNull();
    });

    it("has no open when the price 24h out is still the seed", () => {
        expect(closeAndOpen([{ t: 0, p: 0.5 }, ...history.slice(2)], 35 * H)?.open).toBeNull();
    });

    it("returns null with no pre-start prices", () => {
        expect(closeAndOpen(history, 0)).toBeNull();
    });
});
