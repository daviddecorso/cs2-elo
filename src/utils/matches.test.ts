import { describe, expect, it } from "vitest";
import type { ScheduledMatch } from "../elo/types.ts";
import { computeExcitement, getExcitementTier, groupByDay, isUpset, sortMatches } from "./matches.ts";

const makeMatch = (overrides: Partial<ScheduledMatch> = {}): ScheduledMatch => ({
    id: "m1",
    t: Math.floor(Date.parse("2026-11-24T12:00:00Z") / 1000),
    dateExact: true,
    status: "upcoming",
    event: "PGL/2026/Singapore",
    eventName: "PGL Major Singapore 2026",
    eventSlug: "pgl-major-singapore-2026",
    page: "PGL/2026/Singapore/Stage_1",
    tier: 1,
    lan: true,
    bestOf: 3,
    sides: [
        { team: "MOUZ", rank: 1, vrsRank: 1, rating: 168, rated: true },
        { team: "Team Vitality", rank: 2, vrsRank: 2, rating: 136, rated: true },
    ],
    p: 0.52,
    maps: [],
    ...overrides,
});

const TOP_RATING = 168;

describe("match utilities", () => {
    it("rates close elite matchups higher than lopsided or low-tier ones", () => {
        const eliteClose = computeExcitement(makeMatch(), TOP_RATING);
        const eliteLopsided = computeExcitement(makeMatch({ p: 0.92 }), TOP_RATING);
        const lowClose = computeExcitement(
            makeMatch({
                sides: [
                    { team: "Low A", rank: 200, vrsRank: null, rating: -405, rated: true },
                    { team: "Low B", rank: 205, vrsRank: null, rating: -415, rated: true },
                ],
                p: 0.5,
            }),
            TOP_RATING
        );

        expect(eliteClose.score).toBeGreaterThan(85);
        expect(getExcitementTier(eliteClose.score)).toBe("elite");
        expect(eliteClose.score).toBeGreaterThan(eliteLopsided.score);
        expect(eliteClose.score).toBeGreaterThan(lowClose.score);
    });

    it("detects completed upsets only when the pre-match underdog wins", () => {
        expect(isUpset(makeMatch({ status: "upcoming", p: 0.8 }))).toBe(false);
        expect(isUpset(makeMatch({ status: "completed", p: 0.8, winner: 0 }))).toBe(false);
        expect(isUpset(makeMatch({ status: "completed", p: 0.8, winner: 1 }))).toBe(true);
        expect(isUpset(makeMatch({ status: "completed", p: 0.25, winner: 0 }))).toBe(true);
        expect(isUpset(makeMatch({ status: "completed", p: 0.5, winner: 1 }))).toBe(false);
    });

    it("groups by day in ascending or descending order with TBD last", () => {
        const d1 = makeMatch({ id: "d1", t: Math.floor(Date.parse("2026-11-24T12:00:00Z") / 1000) });
        const d2 = makeMatch({ id: "d2", t: Math.floor(Date.parse("2026-11-26T12:00:00Z") / 1000) });
        const tbd = makeMatch({ id: "tbd", t: null, dateExact: false });

        const asc = groupByDay([d2, tbd, d1], "asc");
        expect(asc.map((g) => g.items[0].id)).toEqual(["d1", "d2", "tbd"]);

        const desc = groupByDay([d1, tbd, d2], "desc");
        expect(desc.map((g) => g.items[0].id)).toEqual(["d2", "d1", "tbd"]);
    });

    it("sorts by excitement or time", () => {
        const earlyLow = makeMatch({ id: "early", t: 1000, p: 0.9 });
        const lateHigh = makeMatch({ id: "late", t: 2000, p: 0.5 });

        expect(sortMatches([earlyLow, lateHigh], "excitement", "asc", TOP_RATING).map((m) => m.id)).toEqual(["late", "early"]);
        expect(sortMatches([lateHigh, earlyLow], "time", "asc", TOP_RATING).map((m) => m.id)).toEqual(["early", "late"]);
        expect(sortMatches([earlyLow, lateHigh], "time", "desc", TOP_RATING).map((m) => m.id)).toEqual(["late", "early"]);
    });
});
