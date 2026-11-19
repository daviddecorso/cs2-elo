import { describe, expect, it, vi } from "vitest";
import type { RawRow } from "../elo/normalize.ts";
import {
    buildCatalog,
    catalogExclusions,
    catalogParents,
    fitPrizeSplits,
    genericEvent,
    genericRows,
    inviteRuleFromPlacements,
    locationOf,
    parseVrsLabel,
    pastTeamCounts,
    qualifierTargets,
    rankedRules,
    regionFromName,
    slugOf,
    type CatalogContext,
} from "./catalog.ts";
import type { EventConfig } from "./config.ts";
import type { SeriesModel } from "./predict.ts";
import { makeRng } from "./rng.ts";
import { runEvent } from "./simulate.ts";

const slot = (parent: string, qualifier: string, team = "TBD"): RawRow => ({
    parent,
    pagename: parent,
    placement: "",
    opponenttype: "team",
    opponentname: team,
    opponenttemplate: team.toLowerCase(),
    qualifier,
});
const prizeRow = (parent: string, placement: string, prizemoney: number, extra: RawRow = {}): RawRow => ({
    parent,
    pagename: parent,
    placement,
    prizemoney,
    opponenttype: "team",
    opponentname: "TBD",
    qualifier: "",
    ...extra,
});
const repeat = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

// Valve's region.js: EU/MENA 0, NA/SA 1, Africa -1, else 2; unknown codes throw.
const countryRegion = (c: string) => {
    const map: Record<string, number> = { pl: 0, sa: 0, us: 1, br: 1, cn: 2, sg: 2, za: -1 };
    if (!(c in map)) throw new Error(`unknown ${c}`);
    return map[c];
};

const ctxOf = (placementRows: RawRow[], finished: RawRow[] = []): CatalogContext => ({
    placementRows,
    pages: new Map(),
    countryRegion,
    prizeSplits: fitPrizeSplits(finished),
});

const tournament = (pagename: string, extra: RawRow = {}): RawRow => ({
    pagename,
    name: pagename.replace(/_/g, " "),
    type: "Offline",
    liquipediatier: "1",
    liquipediatiertype: "",
    publishertier: "Tier 1",
    status: "",
    startdate: "2027-01-10",
    enddate: "2027-01-15",
    participantsnumber: 8,
    prizepool: 100000,
    locations: { country1: "pl", region1: "Europe" },
    parent: "",
    ...extra,
});

describe("inviteRuleFromPlacements", () => {
    it("parses PGL Łódź: Global list slots with a category suffix, closed qualifier slots, prize rows ignored", () => {
        const p = "PGL/2027/Łódź";
        const rows = [
            slot(p, "VRS Global (Dec. 2026)[[Category:VRS Invite Dec 2026]]"),
            ...repeat(13, () => slot(p, "VRS Global (Dec. 2026)")),
            ...repeat(2, () => slot(p, "Closed Qualifier")),
            prizeRow(p, "1", 280000),
            prizeRow(p, "5-8", 64000),
        ];
        expect(inviteRuleFromPlacements(rows, p)).toEqual({
            slots: [{ list: "Global", month: "2026-12", count: 14 }],
            qualifiers: [{ label: "Closed Qualifier", count: 2 }],
            verified: false,
        });
    });

    it("parses regional lists, full month names and other qualifier labels", () => {
        const p = "Intel_Extreme_Masters/2026/Beijing";
        const rows = [
            slot(p, "VRS South America (Aug. 2026)[[Category:VRS Invite Aug 2026]]", "FURIA"),
            ...repeat(10, (i) => slot(p, "VRS Global (July 2026)", `T${i}`)),
            slot(p, "VRS North America (Aug. 2026)", "NRG"),
            slot(p, "VRS Asia (Sept. 2026)", "TYLOO"),
            ...repeat(2, () => slot(p, "Global Qualifier")),
            slot(p, "ECL S52 Asia-Pacific"),
        ];
        const rule = inviteRuleFromPlacements(rows, p)!;
        expect(rule.slots).toEqual([
            { list: "South America", month: "2026-08", count: 1 },
            { list: "Global", month: "2026-07", count: 10 },
            { list: "North America", month: "2026-08", count: 1 },
            { list: "Asia", month: "2026-09", count: 1 },
        ]);
        expect(rule.qualifiers).toEqual([
            { label: "Global Qualifier", count: 2 },
            { label: "ECL S52 Asia-Pacific", count: 1 },
        ]);
    });

    it("treats a named team without a source as invited, an empty TBD slot as unspecified, and no rows as no rule", () => {
        const p = "Some/Cup";
        const rule = inviteRuleFromPlacements([slot(p, "", "Astralis"), slot(p, "")], p)!;
        expect(rule.qualifiers).toEqual([{ label: "Unspecified", count: 1 }]);
        expect(inviteRuleFromPlacements([prizeRow(p, "1", 100)], p)).toBeNull();
    });
});

describe("locationOf", () => {
    it("maps countries through Valve's regions, with Africa and unknown or missing countries as null", () => {
        expect(locationOf(tournament("A", { locations: { country1: "sa" } }), countryRegion)).toEqual({ region: "Europe", country: "sa" });
        expect(locationOf(tournament("A", { locations: { country1: "us" } }), countryRegion)?.region).toBe("Americas");
        expect(locationOf(tournament("A", { locations: { country1: "cn" } }), countryRegion)?.region).toBe("Asia");
        expect(locationOf(tournament("A", { locations: { country1: "za" } }), countryRegion)?.region).toBeNull();
        expect(locationOf(tournament("A", { locations: { region1: "World" } }), countryRegion)).toEqual({ region: null, country: "" });
    });

    it("reads an online event's region from its page when it has no country", () => {
        const online = (pagename: string) => locationOf(tournament(pagename, { type: "Online", locations: {} }), countryRegion)?.region;
        expect(online("CCT/2026/Europe/Series_15")).toBe("Europe");
        expect(online("CCT/2026/South_America/Challengers_4")).toBe("Americas");
        expect(online("ESL/Challenger_League/Season_52/Asia-Pacific")).toBe("Asia");
        expect(online("Fiesta_Series/4")).toBeNull();
        expect(regionFromName("Some Cup", "RES Showdown Nordics")).toBe("Europe");
    });
});

describe("parseVrsLabel", () => {
    it("reads every VRS label, with Oceania as Asia, a month when given, and unknown lists as null", () => {
        expect(parseVrsLabel("VRS Europe (Apr. 2026)[[Category:VRS Invite Apr 2026]]")).toEqual({ list: "Europe", month: "2026-04" });
        expect(parseVrsLabel("VRS Oceania (Mar. 2026)")).toEqual({ list: "Asia", month: "2026-03" });
        expect(parseVrsLabel("VRS North AM (July 2026)")).toEqual({ list: "North America", month: "2026-07" });
        expect(parseVrsLabel("VRS Global")).toEqual({ list: "Global", month: null });
        expect(parseVrsLabel("VRS Finland (Feb. 2026)")).toEqual({ list: null, month: "2026-02" });
        expect(parseVrsLabel("Closed Qualifier")).toBeNull();
    });
});

describe("fitPrizeSplits", () => {
    const finished = [
        ...["A", "B"].flatMap((p) => [
            prizeRow(p, "1", 50, { liquipediatier: "4", type: "Offline" }),
            prizeRow(p, "2", 30, { liquipediatier: "4", type: "Offline" }),
            prizeRow(p, "3-4", 10, { liquipediatier: "4", type: "Offline" }),
            prizeRow(p, "3-4", 10, { liquipediatier: "4", type: "Offline" }),
        ]),
        prizeRow("Online", "1", 100, { liquipediatier: "4", type: "Online" }),
    ];

    it("averages per-position shares of finished offline events of the same tier and size", () => {
        const { split, source } = fitPrizeSplits(finished)(4, 4);
        expect(source).toBe("2 tier 4 events");
        expect(split("1")).toBeCloseTo(0.5);
        expect(split("3-4")).toBeCloseTo(0.1);
        expect(split("1") + split("2") + 2 * split("3-4")).toBeCloseTo(1);
    });

    it("falls back to any tier, then to a decreasing 1/position split", () => {
        expect(fitPrizeSplits(finished)(1, 4).source).toBe("2 events of any tier");
        const { split, source } = fitPrizeSplits(finished)(1, 8);
        expect(source).toBe("1/position fallback");
        const shares = ["1", "2", "3-4", "5-8"].map(split);
        expect(shares).toEqual([...shares].sort((a, b) => b - a));
        expect(split("1") + split("2") + 2 * split("3-4") + 4 * split("5-8")).toBeCloseTo(1);
    });
});

const coinFlips: SeriesModel = { resample: () => {}, setHorizon: () => {}, seriesProbability: () => 0.5 };

describe("genericEvent", () => {
    for (const teams of [4, 8, 16]) {
        it(`builds a ${teams}-team event that places every team once with a prize for every label`, () => {
            const page = `Cup/${teams}`;
            const names = repeat(teams, (i) => `T${i + 1}`);
            const rows = names.map((n) => slot(page, "VRS Global (Dec. 2026)", n));
            const event = genericEvent(tournament(page, { participantsnumber: teams }), ctxOf(rows));
            expect(event.simulated).toBe(true);
            expect(event.config.assumed).toEqual(["format", "prizes"]);
            expect(event.announced).toEqual(names);

            const config: EventConfig = { ...event.config, stages: event.config.stages.map((s) => ({ ...s, invited: names })) };
            for (let seed = 0; seed < 20; seed++) {
                const { placements } = runEvent({ config, known: new Map(), horizon: 0 }, coinFlips, makeRng(seed));
                expect(placements.size).toBe(teams);
                for (const label of placements.values()) expect(event.prizes.has(label)).toBe(true);
            }
            const paid = [...placements(config)].reduce((s, label) => s + event.prizes.get(label)!, 0);
            expect(paid).toBeGreaterThan(0.99 * 100000);
            expect(paid).toBeLessThan(1.01 * 100000);
        });
    }

    it("lists events it can't simulate, with the reason", () => {
        expect(genericEvent(tournament("X", { participantsnumber: 1 }), ctxOf([])).reason).toBe("no format for 1 teams");
        expect(genericEvent(tournament("X", { participantsnumber: -1 }), ctxOf([])).reason).toBe("team count unknown");
        const unknown = genericEvent(tournament("X"), ctxOf([slot("X", "", "Astralis")]));
        expect(unknown).toMatchObject({ simulated: false, reason: "field unknown: 7 of 8 slots have no invite rule" });
    });

    it("simulates an unknown field with an assumed field when a field model fills it", () => {
        const learned = genericEvent(tournament("X"), { ...ctxOf([slot("X", "", "Astralis")]), learnsFields: true });
        expect(learned).toMatchObject({ simulated: true });
        expect(learned.config.assumed).toContain("field");
    });

    it("simulates a zero prize pool with zero prizes and marks qualifier slots as an assumed field", () => {
        const rows = [...repeat(6, () => slot("X", "VRS Global (Dec. 2026)")), ...repeat(2, () => slot("X", "Closed Qualifier"))];
        const event = genericEvent(tournament("X", { prizepool: 0 }), ctxOf(rows));
        expect(event.simulated).toBe(true);
        expect([...event.prizes.values()].every((p) => p === 0)).toBe(true);
        expect(event.config.assumed).toEqual(["format", "prizes", "field"]);
    });

    it("prefers Liquipedia's prize table, re-cut to the template's labels", () => {
        const rows = [
            ...repeat(8, (i) => slot("X", "", `T${i}`)),
            prizeRow("X", "1", 50000),
            prizeRow("X", "2", 20000),
            prizeRow("X", "3", 10000),
            prizeRow("X", "4", 6000),
            ...repeat(4, () => prizeRow("X", "5-8", 3500)),
        ];
        const event = genericEvent(tournament("X"), ctxOf(rows));
        expect(event.prizeSource).toBe("table");
        expect(event.prizes.get("3-4")).toBe(8000);
        expect(event.config.assumed).toEqual(["format"]);
    });
});

describe("generic formats and metadata", () => {
    it("keeps the 4/8/16 templates for tier 1–2 LANs and uses groups then playoffs below that and online", () => {
        const formats = (row: RawRow) => genericEvent(row, ctxOf([])).config.stages.map((s) => s.format);
        expect(formats(tournament("X", { liquipediatier: "2" }))).toEqual(["single_elim"]);
        expect(formats(tournament("X", { liquipediatier: "1", participantsnumber: 24 }))).toEqual(["round_robin", "single_elim"]);
        expect(formats(tournament("X", { liquipediatier: "3" }))).toEqual(["round_robin", "single_elim"]);
        expect(formats(tournament("X", { type: "Online" }))).toEqual(["round_robin", "single_elim"]);
    });

    it("tags kind, role, ranking, series and a qualifier's target", () => {
        const q = genericEvent(tournament("Cup/Qualifier", { type: "Online", liquipediatiertype: "Qualifier", publishertier: "Tier 1 Qualifier", participantsnumber: 32, seriespage: "Cup_Series" }), ctxOf([]), {
            qualifies: { page: "Cup", slots: 2 },
        });
        expect(q).toMatchObject({ kind: "online", role: "qualifier", ranked: true, series: "Cup_Series", qualifies: { page: "Cup", slots: 2 } });
        expect(q.config.lan).toBe(false);
        expect(q.config.stages[0]).toMatchObject({ format: "single_elim", advance: 2, bestOf: { default: 3, largeRound: 1 } });
        expect(q.config.stages[0].exits.advance).toBe("1-2");
    });

    it("assumes a missing team count from past editions of the series, else from similar events", () => {
        const past = [
            tournament("S/1", { seriespage: "S", participantsnumber: 12, enddate: "2026-01-01" }),
            tournament("S/2", { seriespage: "S", participantsnumber: 16, enddate: "2026-02-01" }),
            tournament("S/3", { seriespage: "S", participantsnumber: 16, enddate: "2026-03-01" }),
            tournament("Other", { liquipediatier: "3", participantsnumber: 6, enddate: "2026-03-01" }),
        ];
        const counts = pastTeamCounts(past, "2026-11-17");
        expect(counts(tournament("S/4", { seriespage: "S", participantsnumber: -1 }))).toBe(16);
        expect(counts(tournament("New", { liquipediatier: "3", participantsnumber: -1 }))).toBe(6);
        expect(counts(tournament("New", { liquipediatier: "4", participantsnumber: -1 }))).toBeUndefined();
        const event = genericEvent(tournament("S/4", { participantsnumber: -1 }), ctxOf([]), { pastTeams: 16 });
        expect(event.teams).toBe(16);
        expect(event.config.assumed).toContain("teams");
    });

    it("links a qualifier through its target's participant rows, else to the nearest listed ancestor", () => {
        const rows = [slot("Main", "Closed Qualifier"), slot("Main", "Closed Qualifier")].map((r) => ({ ...r, qualifierpage: "Elsewhere/Quali" }));
        const targetOf = qualifierTargets(rows, new Set(["Main", "Main/Qualifier"]));
        expect(targetOf("Elsewhere/Quali")).toEqual({ page: "Main", slots: 2 });
        expect(targetOf("Main/Qualifier/Open/1")).toEqual({ page: "Main/Qualifier", slots: 1 });
        expect(targetOf("Lonely")).toBeUndefined();
    });
});

/** One deterministic run's placement labels for every team. */
const placements = (config: EventConfig) => runEvent({ config, known: new Map(), horizon: 0 }, coinFlips, makeRng(1)).placements.values();

describe("catalogParents and buildCatalog", () => {
    const today = "2026-11-17";
    const until = "2027-06-05";
    const rows = [
        tournament("Configured"),
        tournament("Configured/Stage_1"),
        tournament("Late", { startdate: "2027-03-01", enddate: "2027-03-05" }),
        tournament("Early", { startdate: "2026-12-01", enddate: "2026-12-03" }),
        tournament("Early/Playoffs", { startdate: "2026-12-02", enddate: "2026-12-03" }),
        tournament("Running", { startdate: "2026-11-10", enddate: "2026-11-20" }),
        tournament("Over", { startdate: "2026-11-01", enddate: "2026-11-05" }),
        tournament("Online", { type: "Online" }),
        tournament("Quali", { liquipediatiertype: "Qualifier" }),
        tournament("Show", { liquipediatiertype: "Showmatch" }),
        tournament("TooFar", { startdate: "2027-07-01", enddate: "2027-07-03" }),
    ];

    it("puts configured pages first, then unconfigured LANs by start date, deduped and capped", () => {
        expect(catalogParents(["Configured"], [...rows, ...rows], today, until)).toEqual({
            parents: ["Configured", "Running", "Early", "Late"],
            dropped: 0,
        });
        expect(catalogParents(["Configured"], rows, today, until, 2)).toEqual({ parents: ["Configured", "Running"], dropped: 2 });
    });

    it("keeps hand-keyed fields, fills location and invites, and sorts by start date", () => {
        const configured: EventConfig = {
            slug: "configured",
            name: "Configured",
            liquipedia: "Configured",
            startDate: "2027-01-10",
            endDate: "2027-01-15",
            lan: true,
            prizeEstimate: { "1": 1 },
            stages: [],
        };
        const catalog = buildCatalog({
            configs: [configured],
            tournamentRows: rows,
            today,
            until,
            ctx: ctxOf([slot("Configured", "VRS Global (Dec. 2026)")]),
        });
        expect(catalog.map((e) => e.config.liquipedia)).toEqual(["Running", "Early", "Configured", "Late"]);
        const c = catalog.find((e) => !e.generic)!;
        expect(c.config.location).toEqual({ region: "Europe", country: "pl" });
        expect(c.config.invites?.slots).toEqual([{ list: "Global", month: "2026-12", count: 1 }]);
        expect(c.prizeSource).toBe("config");
    });

    it("leaves out cancelled, postponed, national-team and unranked events, with the reason", () => {
        const rules = rankedRules({ rankedEvents: [{ eventId: "Verified" }], unrankedEvents: ["Delisted"] });
        const rows = [
            tournament("Cancelled", { status: "cancelled" }),
            tournament("Postponed", { status: "postponed" }),
            tournament("Esports_Nations_Cup/2027"),
            tournament("Nations_Finals", { seriespage: "Esports_Nations_Cup" }),
            tournament("Unregistered", { publishertier: "" }),
            tournament("Verified", { publishertier: "" }),
            tournament("Delisted", { publishertier: "Tier 2" }),
            tournament("Kept", { publishertier: "Tier 2" }),
        ];
        expect(genericRows(rows, [], today, until, rules).map((r) => r.pagename)).toEqual(["Kept", "Verified"]);
        expect(catalogExclusions(rows, [], today, until, rules)).toEqual([
            { page: "Cancelled", reason: "cancelled" },
            { page: "Delisted", reason: "not ranked by Valve" },
            { page: "Esports_Nations_Cup/2027", reason: "national teams" },
            { page: "Nations_Finals", reason: "national teams" },
            { page: "Postponed", reason: "postponed" },
            { page: "Unregistered", reason: "not ranked by Valve" },
        ]);
        expect(catalogParents([], rows, today, until, 100, rules).parents).toEqual(["Kept", "Verified"]);
    });

    it("judges a page by its last row, so a fresh cancellation beats a stale stored row", () => {
        const stale = tournament("Cup");
        const fresh = tournament("Cup", { status: "cancelled" });
        expect(genericRows([stale, fresh], [], today, until)).toEqual([]);
        expect(genericRows([fresh, stale], [], today, until)).toHaveLength(1);
    });

    it("skips a hand-written config whose event is cancelled", () => {
        const config: EventConfig = {
            slug: "configured",
            name: "Configured",
            liquipedia: "Configured",
            startDate: "2027-01-10",
            endDate: "2027-01-15",
            lan: true,
            stages: [],
        };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const catalog = buildCatalog({
            configs: [config],
            tournamentRows: [tournament("Configured", { status: "cancelled" })],
            today,
            until,
            ctx: ctxOf([]),
        });
        expect(catalog).toEqual([]);
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });

    it("adds online events and qualifiers, subpages included, under scope all; LANs still fetch first", () => {
        const all = [...rows, tournament("Early/Qualifier", { type: "Online", liquipediatiertype: "Qualifier", startdate: "2026-11-20", enddate: "2026-11-22" })];
        expect(catalogParents(["Configured"], all, today, until, 100, undefined, "all").parents).toEqual([
            "Configured",
            "Running",
            "Early",
            "Quali",
            "Late",
            "Early/Qualifier",
            "Online",
        ]);
        const catalog = buildCatalog({ configs: [], tournamentRows: all, today, until, ctx: ctxOf([]), scope: "all" });
        expect(catalog.find((e) => e.config.liquipedia === "Early/Qualifier")).toMatchObject({ role: "qualifier", kind: "online", qualifies: { page: "Early", slots: 1 } });
        expect(catalog.some((e) => e.config.liquipedia === "Early/Playoffs")).toBe(false);
    });

    it("disambiguates colliding slugs across catalog events", () => {
        const catalog = buildCatalog({
            configs: [],
            tournamentRows: [
                tournament("Cup_A", { startdate: "2027-01-10", enddate: "2027-01-12" }),
                tournament("Cup-A", { startdate: "2027-02-10", enddate: "2027-02-12" }),
            ],
            today,
            until,
            ctx: ctxOf([]),
        });
        expect(catalog.map((e) => e.config.slug)).toEqual(["cup-a", "cup-a-2"]);
    });
});

describe("slugOf", () => {
    it("strips diacritics and separators", () => {
        expect(slugOf("PGL/2027/Łódź")).toBe("pgl-2027-lodz");
        expect(slugOf("E-sporta_Virslīga/Season_7")).toBe("e-sporta-virsliga-season-7");
    });
});
