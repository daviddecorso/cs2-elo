import { describe, expect, it } from "vitest";
import type { ProtocolLeagueMap, ProtocolLeagueZone, ProtocolTeam } from "./protocolTypes.ts";
import { binLabels, outlier, playerProtocolZones, pp, protocolRows, visibleRows, zoneLabel, zoneTooltip } from "./protocols.ts";

const zone = (id: number, extra: Partial<ProtocolLeagueZone> = {}): ProtocolLeagueZone => ({
    id,
    side: "t",
    type: "smoke",
    level: "upper",
    land: [400, 470],
    r: 10,
    place: "SnipersNest",
    from: [[100, 100, 5]],
    league: { gun: { rate: 0.9, tMed: 0.5, bins: [9, 1, 0, 0, 0, 0], hits: 10 } },
    reliability: { gun: 0.2, pistol: null, light: null },
    ...extra,
});

const league = (zones: ProtocolLeagueZone[]): ProtocolLeagueMap => ({
    version: 1,
    map: "mirage",
    levels: ["upper"],
    generatedAt: "",
    window: { from: "2026-05-11", to: "2026-11-11", months: 6 },
    source: { demos: "", attribution: "", liquipedia: "" },
    rounds: { t: { gun: 100, pistol: 10, light: 30 }, ct: { gun: 100, pistol: 10, light: 30 } },
    fastShare: 0.04,
    timeEdges: [5, 10, 20, 35, 50],
    zones,
});

const teamFile = (zones: ProtocolTeam["maps"][number]["sides"]["t"]): ProtocolTeam => ({
    version: 1,
    team: "Team Vitality",
    generatedAt: "",
    window: { from: "2026-05-11", to: "2026-11-11", months: 6 },
    source: { demos: "", attribution: "", liquipedia: "" },
    from: "2026-05-11",
    stint: null,
    players: { "1": "ZywOo" },
    maps: [{ map: "mirage", maps: 17, lowSample: false, sides: { t: zones } }],
});

describe("protocolRows", () => {
    const lg = league([
        zone(0),
        zone(1, { type: "molotov", place: "TopofMid", league: { gun: { rate: 0.4, tMed: 8, bins: [], hits: 40 } } }),
        zone(2, { type: "flash", place: null, league: { gun: { rate: 0.3, tMed: 3, bins: [], hits: 30 } } }),
        zone(3, { side: "ct" }),
    ]);
    const side = {
        rounds: { gun: 108, pistol: 17, light: 43 },
        allRounds: 168,
        fastShare: 0.05,
        classes: {
            gun: {
                rounds: 108,
                zones: [
                    { id: 0, hits: 104, rate: 0.963, diff: 0.049, lo: 0.017, hi: 0.076, tMed: 0.4, bins: [100, 4, 0, 0, 0, 0] },
                    { id: 1, hits: 5, rate: 0.05, diff: -0.35, lo: -0.4, hi: -0.3, tMed: 9 },
                    { id: 2, hits: 0, rate: 0, diff: -0.3, lo: -0.35, hi: -0.25 },
                    { id: 3, hits: 1, rate: 0.01, diff: 0, lo: -0.1, hi: 0.1 },
                ],
            },
        },
    };

    it("joins league zones of the side and orders by team, then league, median time", () => {
        const rows = protocolRows(side, lg, "t", "gun");
        expect(rows.map((r) => r.zone.id)).toEqual([0, 2, 1]);
        expect(rows[0]).toMatchObject({ label: "Smoke Snipers Nest", league: 0.9, differs: true, tMed: 0.4 });
        expect(rows[1]).toMatchObject({ label: "Flash (no callout)", tMed: null, leagueTMed: 3, bins: [] });
    });

    it("hides rare zones unless they differ clearly from a common league zone", () => {
        const rows = protocolRows(side, lg, "t", "gun");
        expect(visibleRows(rows, false).map((r) => r.zone.id)).toEqual([0, 2, 1]);
        const quiet = rows.map((r) => ({ ...r, differs: false }));
        expect(visibleRows(quiet, false).map((r) => r.zone.id)).toEqual([0]);
        expect(visibleRows(quiet, true)).toHaveLength(3);
    });

    it("flags outliers only with a clear, large gap on enough rounds", () => {
        const rows = protocolRows(side, lg, "t", "gun");
        expect(rows.map((r) => outlier(r, 108))).toEqual([null, "less", "less"]);
        expect(rows.map((r) => outlier(r, 20))).toEqual([null, null, null]);
        expect(outlier({ ...rows[0], diff: 0.12, lo: 0.05 }, 108)).toBe("more");
        expect(outlier({ ...rows[0], diff: 0.12, lo: -0.01, hi: 0.2, differs: false }, 108)).toBeNull();
    });

    it("returns nothing for a class the team has no rounds in", () => {
        expect(protocolRows(side, lg, "t", "pistol")).toEqual([]);
        expect(protocolRows(undefined, lg, "t", "gun")).toEqual([]);
    });
});

describe("playerProtocolZones", () => {
    it("keeps gun zones where the player's own rate reaches 20%", () => {
        const team = teamFile({
            rounds: { gun: 100, pistol: 10, light: 30 },
            allRounds: 140,
            fastShare: 0,
            classes: {
                gun: {
                    rounds: 100,
                    zones: [
                        { id: 0, hits: 90, rate: 0.9, diff: 0, lo: 0, hi: 0, tMed: 0.4, throwers: [["1", 0.5, 0.45], ["2", 0.4, 0.4]] },
                        { id: 1, hits: 30, rate: 0.3, diff: 0, lo: 0, hi: 0, throwers: [["1", 0.6, 0.18]] },
                        { id: 2, hits: 40, rate: 0.4, diff: 0, lo: 0, hi: 0, tMed: 8, throwers: [["1", 0.9, 0.36]] },
                    ],
                },
            },
        });
        expect(playerProtocolZones(team, "1")).toEqual([
            { map: "mirage", side: "t", id: 0, rate: 0.45, share: 0.5, teamTMed: 0.4 },
            { map: "mirage", side: "t", id: 2, rate: 0.36, share: 0.9, teamTMed: 8 },
        ]);
        expect(playerProtocolZones(team, "3")).toEqual([]);
    });
});

describe("formatting", () => {
    it("formats points, bins and zone labels", () => {
        expect(pp(0.049)).toBe("+4.9");
        expect(pp(-0.3)).toBe("−30.0");
        expect(pp(0)).toBe("±0.0");
        expect(binLabels([5, 10, 20])).toEqual(["0–5s", "5–10s", "10–20s", "20s+"]);
        expect(zoneLabel({ type: "he", place: "TopofMid" })).toBe("HE Top of Mid");
        expect(zoneLabel({ type: "smoke", place: "SnipersNest", name: "Window smoke" })).toBe("Window smoke");
        expect(zoneTooltip({ place: "SnipersNest", description: "Blocks mid window." })).toBe(
            "Blocks mid window. (Callout: Snipers Nest)"
        );
        expect(zoneTooltip({ place: "SnipersNest" })).toBe("Callout: Snipers Nest");
        expect(zoneTooltip({ place: null, description: "Blocks mid." })).toBe("Blocks mid.");
        expect(zoneTooltip({ place: null })).toBeNull();
    });
});
