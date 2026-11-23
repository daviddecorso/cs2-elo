import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Region, Roster } from "../../../src/vrs/types.ts";
import type { RawRow } from "../elo/normalize.ts";
import type { EventConfig, StageConfig } from "./config.ts";
import type { InviteConfig } from "./invites.ts";
import { drawSeeds, previousNames, resolveParticipants, vrsStages } from "./participants.ts";

const opp = (page: string) => ({ template: page.toLowerCase(), teamtemplate: { template: page.toLowerCase(), page } });
const match = (id: string, a: string, b: string, page = "Ev", section = "Group A"): RawRow => ({
    pagename: page,
    section,
    match2id: `x_${id}`,
    match2opponents: [opp(a), opp(b)],
});

const group: StageConfig = {
    id: "groupA",
    name: "Group A",
    page: "Ev",
    sections: ["Group A"],
    format: "bracket",
    bestOf: { default: 3 },
    invited: [],
    matches: [
        { id: "u1", teams: ["s1", "s2"] },
        { id: "u2", teams: ["s3", "s4"] },
        { id: "uf", teams: ["w:u1", "w:u2"] },
    ],
    advance: 1,
    exits: {},
};

describe("drawSeeds", () => {
    it("fills seeds from round 1 in match2id order", () => {
        const rows = [match("R01-M002", "C", "D"), match("R01-M001", "A", "B"), match("R01-M003", "A", "C"), match("R01-M001", "X", "Y", "Ev", "Group B")];
        expect(drawSeeds(group, rows)).toEqual(["A", "B", "C", "D"]);
    });

    it("waits while opponents are TBD", () => {
        const tbd = { ...match("R01-M002", "C", "D"), match2opponents: [{ template: "tbd" }, { template: "tbd" }] };
        expect(drawSeeds(group, [match("R01-M001", "A", "B"), tbd])).toBe("draw not posted");
    });

    it("falls back to matchlist opening IDs when bracket round-1 IDs are absent", () => {
        const rows = [
            match("0002", "C", "D"),
            match("0001", "A", "B"),
            match("0003", "A", "C"),
            match("0004", "B", "D"),
        ];
        expect(drawSeeds(group, rows)).toEqual(["A", "B", "C", "D"]);
    });
});

const roster = (rank: number, region: Region, players: string[]): Roster =>
    ({ rosterKey: players.join(","), teamName: `T${rank}`, region, regionalRank: rank, globalRank: rank, points: 0, players }) as unknown as Roster;
const players = (prefix: string) => [1, 2, 3, 4, 5].map((i) => `${prefix}${i}`);
const participant = (team: string, region: Region, prefix: string): RawRow => ({
    parent: "Major",
    pagename: "Major",
    opponentname: team,
    opponenttype: "team",
    opponenttemplate: team.toLowerCase(),
    qualifier: `VRS ${region} (Nov. 2026)`,
    opponentplayers: Object.fromEntries(players(prefix).map((p, i) => [`p${i + 1}`, p.toUpperCase()])),
});

const invite: InviteConfig = {
    slug: "inv",
    name: "Major",
    liquipedia: "Major",
    snapshotDate: "2026-11-02",
    snapshotEstimated: false,
    previousMajor: { event: "prev", slots: { stage3: { Europe: 1, Americas: 0, Asia: 0 }, stage2: { Europe: 0, Americas: 1, Asia: 0 } } },
    stage1: { Europe: 1, Americas: 0, Asia: 1 },
    minRetained: 3,
    source: "",
    verified: false,
};

// a: rank 1 EU declined; b, c EU; d Am; e Asia.
const standings = [roster(1, "Europe", players("a")), roster(2, "Americas", players("d")), roster(3, "Europe", players("b")), roster(4, "Europe", players("c")), roster(5, "Asia", players("e"))];
const rows = [participant("C", "Europe", "c"), participant("B", "Europe", "b"), participant("D", "Americas", "d"), participant("E", "Asia", "e")];

describe("vrsStages", () => {
    it("fills each region's slots in global order from Liquipedia's participants", () => {
        expect(vrsStages(invite, rows, standings, new Map())).toEqual({ 3: ["B"], 2: ["D"], 1: ["C", "E"] });
    });

    it("stays pending when a participant has no ranked roster", () => {
        const stray = { ...participant("Z", "Asia", "z") };
        expect(vrsStages(invite, [...rows.slice(0, 3), stray], standings, new Map())).toBe("Z matches no ranked roster");
    });

    it("stays pending when a region's count doesn't match its slots", () => {
        expect(vrsStages(invite, rows.slice(1), standings, new Map())).toBe("1 Europe participants for 2 slots");
    });
});

describe("previousNames", () => {
    it("maps a renamed template's page to its earlier pages", () => {
        const row = { ...participant("PARIVISION", "Europe", "p"), opponenttemplate: "pvision 2026", extradata: { opponentaliases: { 1: "pvision 2026", 2: "parivision orig" } } };
        const pages = new Map([["pvision 2026", "PVISION"], ["parivision orig", "PARIVISION"]]);
        expect(previousNames([row], "Major", pages)).toEqual(new Map([["PVISION", ["PARIVISION"]]]));
    });
});

describe("resolveParticipants", () => {
    it("keeps a config list and leaves Major stages pending without a snapshot", () => {
        const config: EventConfig = {
            slug: "m",
            name: "M",
            liquipedia: "Major",
            startDate: "",
            endDate: "",
            lan: true,
            stages: [
                { ...group, id: "s1", name: "Stage 1", format: "swiss", vrsStage: 1, matches: undefined },
                { ...group, id: "g", invited: ["P", "Q", "R", "S"] },
            ],
        };
        const out = resolveParticipants(config, { matchRows: [], placementRows: rows, invites: [invite], snapshot: () => null });
        expect(out.sources).toEqual({ g: "config" });
        expect(out.unresolved).toEqual(["Stage 1: Valve snapshot 2026-11-02 not published locally"]);
    });

    it("reproduces IEM Beijing 2026's hand-keyed groups from its draw", () => {
        const beijing = JSON.parse(fs.readFileSync(path.resolve("data/events/iem-beijing-2026.json"), "utf8")) as EventConfig;
        const draw = (section: string, pairs: [string, string][]) =>
            pairs.map(([a, b], i) => match(`R01-M00${i + 1}`, a, b, beijing.liquipedia, section));
        const matchRows = [
            ...draw("Group A", [["Legacy", "The MongolZ"], ["HEROIC", "B8"], ["FURIA", "FaZe Clan"], ["Natus Vincere", "Team Falcons"], ["Legacy", "B8"], ["FaZe Clan", "Team Falcons"]]),
            ...draw("Group B", [["MOUZ", "TYLOO"], ["9z Team", "BetBoom Team"], ["Aurora Gaming", "Team Liquid"], ["PARIVISION", "G2 Esports"], ["TYLOO", "9z Team"], ["Aurora Gaming", "G2 Esports"]]),
        ];
        const blank = { ...beijing, stages: beijing.stages.map((s) => (s.invited ? { ...s, invited: [] } : s)) };
        const out = resolveParticipants(blank, { matchRows, placementRows: [], invites: [], snapshot: () => null });
        expect(out.unresolved).toEqual([]);
        expect(out.config.stages.map((s) => s.invited)).toEqual(beijing.stages.map((s) => s.invited));
    });
});
