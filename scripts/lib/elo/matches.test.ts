import { describe, expect, it } from "vitest";
import type { EloRoster } from "../../../src/elo/types.ts";
import { EloEngine } from "./engine.ts";
import type { VetoForecastArgs } from "../sim/vetoForecast.ts";
import { buildMatches } from "./matches.ts";
import { STARTING_PARAMS, type EloParams } from "./params.ts";
import { publishRating } from "./publish.ts";
import type { EloMatch, EloPlayers } from "./types.ts";

const DAY = 86400;
const BASE_T = Math.floor(Date.parse("2026-11-18T12:00:00Z") / 1000);

const players: EloPlayers = {};
const roster = (prefix: string, country = "se") =>
    [1, 2, 3, 4, 5].map((i) => {
        const page = `${prefix}${i}`;
        players[page] = { nick: page, country };
        return page;
    });

const params: EloParams = { ...STARTING_PARAMS, provisionalK: 0, regress: 0, newRosterRegress: 0, tierGap: 100 };

describe("buildMatches", () => {
    it("predicts upcoming matches, resolves renamed teams, drops TBD placeholders, and includes recent results", () => {
        const alpha = roster("a");
        const beta = roster("b");
        const history: EloMatch[] = [
            {
                id: "Event/Old:m0",
                t: BASE_T - 30 * DAY,
                event: "Event/Old",
                tier: 1,
                lan: true,
                prizePool: 100000,
                bestOf: 1,
                teams: ["PARIVISION", "Team Beta"],
                lineups: [alpha, beta],
                winner: 0,
                forfeit: false,
                maps: [{ map: "Mirage", rounds: [13, 5] }],
            },
            {
                id: "Event/Past:m1",
                t: BASE_T - 2 * DAY,
                event: "Event/Past",
                tier: 1,
                lan: true,
                prizePool: 100000,
                bestOf: 3,
                teams: ["PARIVISION", "Team Beta"],
                lineups: [alpha, beta],
                winner: 0,
                forfeit: false,
                maps: [
                    { map: "Mirage", rounds: [13, 6] },
                    { map: "Inferno", rounds: [13, 9] },
                ],
            },
        ];

        const engine = new EloEngine(params, players);
        const predictions = engine.run(history);
        const lastT = history.at(-1)!.t;
        const rosters: EloRoster[] = [
            {
                rank: 1,
                team: "PARIVISION",
                players: alpha.map((p) => ({ page: p, nick: p })),
                rating: engine.teamLineageOf("PARIVISION")!.rating,
                mapOffsets: {},
                maps: 20,
                lastMatch: "2026-11-16",
                region: "Europe",
                vrs: { rank: 5, points: 1800, teamName: "PARIVISION" },
                departed: [],
            },
            {
                rank: 2,
                team: "Team Beta",
                players: beta.map((p) => ({ page: p, nick: p })),
                rating: engine.teamLineageOf("Team Beta")!.rating,
                mapOffsets: {},
                maps: 20,
                lastMatch: "2026-11-16",
                region: "Europe",
                vrs: { rank: 12, points: 1600, teamName: "Team Beta" },
                departed: [],
            },
        ];

        const asked: VetoForecastArgs[] = [];
        const out = buildMatches({
            engine,
            predictions,
            matchById: new Map(history.map((m) => [m.id, m])),
            players,
            rosters,
            lastT,
            asOf: "2026-11-16",
            upcoming: {
                fetched: "2026-11-19",
                tournaments: [{ pagename: "PGL/2026/Singapore", name: "PGL Major Singapore 2026", type: "Offline", liquipediatier: "1" }],
                placements: [
                    {
                        parent: "PGL/2026/Singapore",
                        opponenttype: "team",
                        opponenttemplate: "pvision",
                        opponentname: "PARIVISION",
                        extradata: { opponentaliases: { 1: "parivision" } },
                    },
                ],
                matches: [
                    // Valid upcoming match with renamed team (resolved via players + aliases)
                    {
                        game: "cs2",
                        pagename: "PGL/2026/Singapore/Stage_1",
                        parent: "PGL/2026/Singapore",
                        tournament: "PGL Major Singapore 2026: Stage 1",
                        section: "Round 1",
                        match2id: "r1_m1",
                        finished: 0,
                        bestof: 1,
                        type: "Offline",
                        liquipediatier: "1",
                        date: "2026-11-24 06:00:00",
                        dateexact: 1,
                        match2opponents: [
                            {
                                type: "team",
                                template: "pvision",
                                teamtemplate: { page: "PVISION", template: "pvision" },
                                match2players: alpha.map((name) => ({ name, displayname: name })),
                            },
                            {
                                type: "team",
                                template: "team beta",
                                teamtemplate: { page: "Team Beta", template: "team beta" },
                                match2players: beta.map((name) => ({ name, displayname: name })),
                            },
                        ],
                    },
                    // Placeholder TBD opponent should be dropped
                    {
                        game: "cs2",
                        pagename: "PGL/2026/Singapore/Stage_1",
                        parent: "PGL/2026/Singapore",
                        match2id: "r1_tbd",
                        finished: 0,
                        bestof: 3,
                        date: "0000-01-01 00:00:00",
                        dateexact: 0,
                        match2opponents: [
                            { type: "team", template: "tbd", name: "Group A 1st Place" },
                            { type: "team", template: "tbd", name: "Group B 2nd Place" },
                        ],
                    },
                    // Unrated team vs rated team
                    {
                        game: "cs2",
                        pagename: "Local/LAN",
                        parent: "Local/LAN",
                        tournament: "Local LAN",
                        match2id: "m_unrated",
                        finished: 0,
                        bestof: 3,
                        type: "Offline",
                        liquipediatier: "3",
                        date: "2026-11-25 12:00:00",
                        dateexact: 1,
                        match2opponents: [
                            { type: "team", template: "team beta", teamtemplate: { page: "Team Beta", template: "team beta" } },
                            { type: "team", template: "new org", teamtemplate: { page: "New Org", template: "new org" } },
                        ],
                    },
                ],
            },
            tournamentRows: [
                { pagename: "Event/Past", name: "Past Event" },
                { pagename: "PGL/2026/Singapore", name: "PGL Major Singapore 2026", type: "Offline", liquipediatier: "1" },
            ],
            placementRows: [],
            finishedRawRows: [],
            configuredEvents: [
                {
                    slug: "pgl-major-singapore-2026",
                    name: "PGL Major Singapore 2026",
                    liquipedia: "PGL/2026/Singapore",
                    vetoOrder: { 1: "FSFSFS" },
                },
            ],
            forecastVeto: (args) => {
                asked.push(args);
                return { kind: "shortlist", maps: ["Mirage"] };
            },
        });

        expect(out.upcoming).toHaveLength(2);
        const major = out.upcoming[0];
        expect(major.eventName).toBe("PGL Major Singapore 2026");
        expect(major.eventSlug).toBe("pgl-major-singapore-2026");
        expect(major.section).toBe("Stage 1 · Round 1");
        expect(major.sides[0].team).toBe("PVISION");
        expect(major.sides[0].profileTeam).toBe("PARIVISION");
        expect(major.sides[0].rated).toBe(true);
        expect(major.sides[0].rank).toBe(1);
        expect(major.sides[0].vrsRank).toBe(5);
        expect(major.p).toBeGreaterThan(0.5);
        expect(major.seriesOdds?.bo3).toBeGreaterThan(major.seriesOdds!.bo1);
        expect(major.maps.length).toBeGreaterThan(0);

        const unrated = out.upcoming[1];
        expect(unrated.sides[1].team).toBe("New Org");
        expect(unrated.sides[1].rated).toBe(false);
        expect(unrated.sides[1].rating).toBeNull();

        // Only the match with two rated sides gets a veto, in its event's order.
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ bestOf: 1, order: "FSFSFS" });
        expect(major.veto).toEqual({ kind: "shortlist", maps: ["Mirage"] });
        expect(unrated.veto).toBeUndefined();

        const rawRatings = [rosters[0].rating, rosters[1].rating];
        expect(asked[0].ratings).toEqual(rawRatings);
        expect(major.sides.map((s) => s.rating)).toEqual(rawRatings.map(publishRating));
        const lastPlayed = predictions.at(-1)!;
        expect(out.recent[0].sides.map((s) => s.rating)).toEqual(lastPlayed.ratings.map(publishRating));

        // Only the match within 14 days appears in recent (not the 30-day-old one)
        expect(out.recent).toHaveLength(1);
        expect(out.recent[0].sides[0].score).toBe(2);
        expect(out.recent[0].sides[1].score).toBe(0);
        expect(out.recent[0].winner).toBe(0);
        expect(out.recent[0].maps).toHaveLength(2);
    });
});
