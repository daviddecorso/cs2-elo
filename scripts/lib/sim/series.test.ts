import { describe, expect, it } from "vitest";
import type { RawRow } from "../elo/normalize.ts";
import { addDays } from "../liquipedia/rawStore.ts";
import { backtestProjections, cadence, nextNumbered, projectEditions, projectionChances, seriesClusters, seriesKey } from "./series.ts";

const countryRegion = (c: string) => {
    const map: Record<string, number> = { de: 0, us: 1 };
    if (!(c in map)) throw new Error(`unknown ${c}`);
    return map[c];
};

const row = (pagename: string, startdate: string, extra: RawRow = {}): RawRow => ({
    pagename,
    name: pagename.replace(/_/g, " "),
    startdate,
    enddate: addDays(startdate, 2),
    type: "Online",
    liquipediatier: "3",
    liquipediatiertype: "",
    publishertier: "Tier 2",
    prizepool: 10000,
    participantsnumber: 16,
    organizers: JSON.stringify({ organizer1: "Org" }),
    status: "",
    ...extra,
});
const editions = (page: (i: number) => string, from: string, gap: number, n: number, extra: RawRow = {}) =>
    Array.from({ length: n }, (_, i) => row(page(i + 1), addDays(from, i * gap), extra));
const cup = (i: number) => `Cup/2026/Europe/Series_${i}`;

describe("seriesKey and nextNumbered", () => {
    it("replaces numbers, Roman numerals and seasons", () => {
        expect(seriesKey("CCT/2026/Europe/Series_14")).toBe(seriesKey("CCT/2025/Europe/Series_3"));
        expect(seriesKey("Stake_Pulse/Beat_II")).toBe("Stake_Pulse/Beat_{r}");
        expect(seriesKey("BLAST/Bounty/2025/Spring")).toBe(seriesKey("BLAST/Bounty/2025/Fall"));
        expect(seriesKey("Circuit_X/Curitiba")).toBe("Circuit_{r}/Curitiba");
    });

    it("moves the last number, else the Roman numeral, on", () => {
        expect(nextNumbered("CCT/2026/Europe/Series_14/Play-In", 2)).toBe("CCT/2026/Europe/Series_16/Play-In");
        expect(nextNumbered("Stake_Pulse/Beat_III", 1)).toBe("Stake_Pulse/Beat_IV");
        expect(nextNumbered("Gamers_Club/Masters/VIII", 2)).toBe("Gamers_Club/Masters/X");
        expect(nextNumbered("Rainbet_Cup", 1)).toBeNull();
        expect(nextNumbered("ESEA/Season_58/Open10/Europe", 1, "ESEA/Season_57/Open10/Europe")).toBe("ESEA/Season_59/Open10/Europe");
    });
});

describe("seriesClusters", () => {
    it("joins renamed editions by links with the same organizer, and splits by region", () => {
        const rows = [
            row("Galaxy/2025/Starter", "2025-03-01", { next: "Galaxy/2025/Phase 1" }),
            row("Galaxy/2025/Phase_1", "2025-04-01"),
            row("Other/2025/Starter", "2025-03-01", { next: "Galaxy/2025/Phase 1", organizers: JSON.stringify({ organizer1: "Else" }) }),
            row("Cup/2025/North_America/Series_1", "2025-03-01"),
        ];
        const clusters = seriesClusters(rows, countryRegion);
        const galaxy = clusters.find((c) => c.editions.some((e) => e.pagename === "Galaxy/2025/Phase_1"))!;
        expect(galaxy.editions.map((e) => e.pagename)).toEqual(["Galaxy/2025/Starter", "Galaxy/2025/Phase_1"]);
        expect(clusters).toHaveLength(3);
    });
});

describe("cadence", () => {
    it("finds the gap, the breaks and how long a run lasts", () => {
        const runs = [...editions(cup, "2025-01-06", 7, 4), ...editions((i) => cup(i + 4), "2025-03-03", 7, 4), ...editions((i) => cup(i + 8), "2025-04-28", 7, 2)];
        const c = cadence(runs);
        expect(c.gapDays).toBe(7);
        expect(c.breaks).toEqual([
            ["2025-01-27", "2025-03-03"],
            ["2025-03-24", "2025-04-28"],
        ]);
        expect(c).toMatchObject({ runLength: 4, breakDays: 35, currentRun: 2 });
    });

    it("projects bursts of daily qualifiers no closer than weekly", () => {
        expect(cadence(editions(cup, "2025-01-06", 1, 5)).gapDays).toBe(7);
    });
});

describe("projectEditions", () => {
    const project = (rows: RawRow[], asOf = "2026-03-01", days = 60) => projectEditions(rows, countryRegion, { asOf, days });

    it("steps a live series forward by its gap, numbering pages after the last edition", () => {
        const out = project(editions(cup, "2026-01-05", 14, 5));
        expect(out.map((p) => [p.row.pagename, p.row.startdate])).toEqual([
            ["Cup/2026/Europe/Series_6", "2026-03-16"],
            ["Cup/2026/Europe/Series_7", "2026-03-30"],
            ["Cup/2026/Europe/Series_8", "2026-04-13"],
            ["Cup/2026/Europe/Series_9", "2026-04-27"],
        ]);
        expect(out[0].row).toMatchObject({ enddate: "2026-03-18", prizepool: 10000, participantsnumber: 16, publishertier: "Tier 2" });
        expect(out[0].basis).toMatchObject({ editions: 5, gapDays: 14, lastPage: cup(4), lastStart: "2026-02-16" });
    });

    it("re-anchors on listed editions and skips a page that already exists", () => {
        const rows = [...editions(cup, "2026-01-05", 14, 5), row(cup(6), "2026-03-17"), row(cup(8), "2025-01-01", { status: "cancelled" })];
        expect(project(rows).map((p) => [p.row.pagename, p.row.startdate])).toEqual([
            ["Cup/2026/Europe/Series_7", "2026-03-31"],
            ["Cup/2026/Europe/Series_9", "2026-04-28"],
        ]);
    });

    it("leaves out dead, cancelled, tier 1, unranked and short series", () => {
        expect(project(editions(cup, "2025-06-02", 14, 5))).toEqual([]);
        expect(project([...editions(cup, "2026-01-05", 14, 5), row(cup(6), "2026-03-16", { status: "cancelled" })])).toEqual([]);
        expect(project(editions(cup, "2026-01-05", 14, 5, { liquipediatier: "1" }))).toEqual([]);
        expect(project(editions(cup, "2026-01-05", 14, 5, { publishertier: "" }))).toEqual([]);
        expect(project(editions(cup, "2026-01-05", 14, 2))).toEqual([]);
        expect(project(editions(cup, "2026-01-05", 14, 5, { participantsnumber: 128 }))).toEqual([]);
    });

    it("pauses after a series' usual run, and keeps last year's winter break", () => {
        const seasons = [...editions(cup, "2025-10-06", 7, 4), ...editions((i) => cup(i + 4), "2025-12-01", 7, 4)];
        expect(project(seasons, "2026-01-01", 60).map((p) => p.row.startdate)).toEqual(["2026-01-26", "2026-02-02", "2026-02-09", "2026-02-16"]);

        const weekly = (from: string, n: number, k0: number) => editions((i) => cup(i + k0), from, 7, n);
        const lastYear = [...weekly("2024-10-07", 11, 0), ...weekly("2025-01-13", 30, 11)];
        const out = project([...lastYear, ...weekly("2025-08-11", 19, 41)], "2025-12-15", 42).map((p) => p.row.startdate);
        expect(out).toEqual(["2026-01-12", "2026-01-19", "2026-01-26"]);
    });
});

describe("backtestProjections", () => {
    it("scores a regular series as always right, and turns precision into a chance per category", () => {
        const rows = editions(cup, "2025-06-02", 7, 70);
        const scores = backtestProjections(rows, countryRegion, { asOf: "2026-09-30", months: 3, window: 30 });
        const online = scores.get("online")!;
        expect(online.projected).toBeGreaterThan(10);
        expect(online.matched).toBe(online.projected);
        expect(online.actualInSeries).toBe(online.actual);
        expect(Math.max(...online.dateErrors)).toBe(0);
        expect(projectionChances(scores)("online")).toBe(1);
        expect(projectionChances(scores)("lan")).toBe(1);
    });
});
