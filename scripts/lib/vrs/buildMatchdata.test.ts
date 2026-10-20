import { describe, expect, it } from "vitest";
import {
    buildAndValidateMatchdata,
    buildMatchdata,
    resolveLineups,
    type ValveMatch,
    type ValvePlayer,
} from "./buildMatchdata.ts";

describe("buildMatchdata", () => {
    const rawMatches = [
        {
            pagename: "EventA",
            match2id: "m1",
            match2opponents: [
                {
                    name: "Team A",
                    match2players: [
                        { name: "p1", flag: "se" },
                        { name: "p2", flag: "se" },
                        { name: "p3", flag: "se" },
                        { name: "p4", flag: "se" },
                        { name: "p5", flag: "se" },
                    ],
                },
                {
                    name: "Team B",
                    match2players: [
                        { name: "p6", flag: "de" },
                        { name: "p7", flag: "de" },
                        { name: "p8", flag: "de" },
                        { name: "p9", flag: "de" },
                        { name: "p10", flag: "de" },
                    ],
                },
            ],
            winner: "1",
            date: "2026-09-01 12:00:00",
        },
    ];

    const rawTournaments = [
        {
            pagename: "EventA",
            name: "Event Alpha",
            prizepool: "$50,000",
            enddate: "2026-10-15",
            status: "",
        },
    ];

    it("carries endDate on built ValveEvent", () => {
        const result = buildMatchdata(rawMatches, rawTournaments, [], []);
        expect(result.events.length).toBe(1);
        expect(result.events[0].endDate).toBe("2026-10-15");
        expect(result.matches.length).toBe(1);
    });

    it("drops match when a player has missing or invalid countryIso", () => {
        const matchesWithInvalid = [
            {
                ...rawMatches[0],
                match2id: "m2",
                match2opponents: [
                    {
                        name: "Team A",
                        match2players: [
                            { name: "p1", flag: "unknown-flag-xyz" },
                            { name: "p2", flag: "se" },
                            { name: "p3", flag: "se" },
                            { name: "p4", flag: "se" },
                            { name: "p5", flag: "se" },
                        ],
                    },
                    rawMatches[0].match2opponents[1],
                ],
            },
        ];

        const { matchdata, validation } = buildAndValidateMatchdata(
            matchesWithInvalid,
            rawTournaments,
            [],
            []
        );

        expect(matchdata.matches.length).toBe(0);
        expect(validation.errors).toEqual([]);
    });

    it("keeps match when invalid player country is resolved via playerAliases", () => {
        const matchesWithInvalid = [
            {
                ...rawMatches[0],
                match2id: "m3",
                match2opponents: [
                    {
                        name: "Team A",
                        match2players: [
                            { name: "p_unknown", flag: "" },
                            { name: "p2", flag: "se" },
                            { name: "p3", flag: "se" },
                            { name: "p4", flag: "se" },
                            { name: "p5", flag: "se" },
                        ],
                    },
                    rawMatches[0].match2opponents[1],
                ],
            },
        ];

        const overrides = {
            playerAliases: {
                p_unknown: {
                    countryIso: "dk",
                    reason: "Manual country fix",
                },
            },
        };

        const { matchdata, validation } = buildAndValidateMatchdata(
            matchesWithInvalid,
            rawTournaments,
            [],
            [],
            overrides
        );

        expect(matchdata.matches.length).toBe(1);
        expect(matchdata.matches[0].team1Players[0].countryIso).toBe("dk");
        expect(validation.errors).toEqual([]);
    });

    const bracketMatch = (id: string, bestof: number, publishertier: string) => ({
        ...rawMatches[0],
        match2id: `BRK_${id}`,
        match2bracketid: "BRK",
        match2bracketdata: { type: "bracket" },
        bestof,
        publishertier,
    });

    it("unranks Bo1 bracket rounds with more than 8 matches", () => {
        const round = Array.from({ length: 9 }, (_, i) => bracketMatch(`R01-M${i + 1}`, 1, "Tier 1 Qualifier"));
        const result = buildMatchdata([...round, bracketMatch("R02-M1", 1, "Tier 1 Qualifier")], [], [], []);
        expect(result.matches.filter((m) => m.valveRanked).length).toBe(1);
    });

    it("unranks Tier 2 qualifier Bo1 brackets but keeps Bo3 ones", () => {
        const result = buildMatchdata(
            [bracketMatch("R01-M1", 1, "Tier 2 Qualifier"), bracketMatch("R01-M2", 3, "Tier 2 Qualifier")],
            [],
            [],
            []
        );
        expect(result.matches.map((m) => m.valveRanked)).toEqual([false, true]);
    });
});

describe("resolveLineups", () => {
    const player = (id: string): ValvePlayer => ({ playerId: id, nick: id, countryIso: "se" });
    const regulars = ["a", "b", "c", "d", "e"].map(player);
    const opponents = ["v", "w", "x", "y", "z"].map(player);
    const match = (t: number, team1Players: ValvePlayer[]): ValveMatch => ({
        matchStartTime: t,
        team1Id: "Team A",
        team2Id: "Team B",
        team1Name: "Team A",
        team2Name: "Team B",
        team1Players,
        team2Players: opponents,
        eventId: "EventA",
        winningTeam: 1,
        valveRanked: true,
    });
    const day = 24 * 3600;

    it("drops the substitute from a 6-player side", () => {
        const sixListed = [player("sub"), ...regulars];
        const [, resolved] = resolveLineups([match(0, regulars), match(day, sixListed)]);
        expect(resolved.team1Players.map((p) => p.playerId)).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("fills a short side from nearby lineups and drops sides it cannot fill", () => {
        const resolved = resolveLineups([
            match(0, regulars),
            match(day, regulars.slice(0, 4)),
            match(day, []),
            match(60 * day, regulars.slice(0, 4)),
        ]);
        expect(resolved.length).toBe(2);
        expect(resolved[1].team1Players.map((p) => p.playerId).sort()).toEqual(["a", "b", "c", "d", "e"]);
    });
});
