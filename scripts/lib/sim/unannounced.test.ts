import { describe, expect, it } from "vitest";
import type { RawRow } from "../elo/normalize.ts";
import { addDays } from "../liquipedia/rawStore.ts";
import { RATE_DAYS, unannouncedEvents } from "./unannounced.ts";

const countryRegion = (c: string) => ({ de: 0, us: 1 })[c] ?? 0;

let id = 0;
const row = (startdate: string, extra: RawRow = {}): RawRow => ({
    pagename: `Cup/${++id}`,
    name: `Cup ${id}`,
    startdate,
    enddate: addDays(startdate, 2),
    type: "Offline",
    liquipediatier: "3",
    liquipediatiertype: "",
    publishertier: "Tier 2",
    prizepool: 10000,
    participantsnumber: 8,
    locations: { country1: "de" },
    status: "",
    ...extra,
});
/** One event every `gap` days over the year before `asOf`. */
const pastYear = (asOf: string, gap: number, extra: RawRow = {}) => Array.from({ length: Math.floor(364 / gap) }, (_, i) => row(addDays(asOf, -1 - i * gap), extra));
const expected = (events: ReturnType<typeof unannouncedEvents>) => events.reduce((s, e) => s + e.chance, 0);

describe("unannouncedEvents", () => {
    const asOf = "2026-07-01";
    const until = addDays(asOf, 61);

    it("expects the recent rate, less what's listed and projected, at least 0", () => {
        const past = pastYear(asOf, 7);
        const none = unannouncedEvents(past, countryRegion, { asOf, until });
        expect(expected(none)).toBeCloseTo((past.filter((r) => String(r.startdate) > addDays(asOf, -RATE_DAYS)).length * 60) / RATE_DAYS, 5);
        const listed = [row(addDays(asOf, 3)), row(addDays(asOf, 10))];
        const projected = [{ row: row(addDays(asOf, 40)), chance: 0.5 }];
        const less = unannouncedEvents([...past, ...listed], countryRegion, { asOf, until, projected });
        expect(expected(none) - expected(less)).toBeCloseTo(2.5, 5);
        const crowded = Array.from({ length: 40 }, (_, i) => row(addDays(asOf, 1 + (i % 59))));
        expect(unannouncedEvents([...past, ...crowded], countryRegion, { asOf, until })).toEqual([]);
    });

    it("splits each bucket into ⌈expected⌉ events that sum to it, in its cell", () => {
        const events = unannouncedEvents([...pastYear(asOf, 7), ...pastYear(asOf, 30, { locations: { country1: "us" } })], countryRegion, { asOf, until });
        for (const region of ["Europe", "Americas"]) {
            const cell = events.filter((e) => e.region === region);
            expect(cell.length).toBeGreaterThan(0);
            expect(cell.every((e) => e.category === "lan34" && e.chance > 0 && e.chance <= 1)).toBe(true);
            expect(cell.every((e) => String(e.row.startdate) > asOf && String(e.row.startdate) < until)).toBe(true);
        }
        expect(new Set(events.map((e) => e.row.pagename)).size).toBe(events.length);
    });

    it("leaves out tier 1, unranked, cancelled and big open fields", () => {
        const rows = [
            ...pastYear(asOf, 7, { liquipediatier: "1" }),
            ...pastYear(asOf, 7, { publishertier: "" }),
            ...pastYear(asOf, 7, { status: "cancelled" }),
            ...pastYear(asOf, 7, { participantsnumber: 128 }),
        ];
        expect(unannouncedEvents(rows, countryRegion, { asOf, until })).toEqual([]);
    });

    it("learns only from events that started by as-of", () => {
        const later = Array.from({ length: 50 }, (_, i) => row(addDays(asOf, -200 + i)));
        const at = addDays(asOf, -201);
        expect(unannouncedEvents(later, countryRegion, { asOf: at, until: addDays(at, 61) })).toEqual([]);
    });
});
