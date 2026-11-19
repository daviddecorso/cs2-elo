import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EventOdds } from "./EventOdds.tsx";
import { MajorInvites } from "./MajorInvites.tsx";
import { VrsSim } from "./VrsSim.tsx";
import { testPlan } from "../sim/testPlan.ts";
import type { EventOdds as EventOddsData, InviteOdds, PlanIndex, SeasonImpact, SeasonIndex, SeasonStandings, SeasonTeamSchedule } from "../sim/types.ts";

const render = (path: string, route: string, element: React.ReactNode, ...entries: Array<[unknown[], unknown]>) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const [key, data] of entries) queryClient.setQueryData(key, data);
    return renderToString(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path={route} element={element} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    );
};

describe("simulator pages", () => {
    it("renders event odds with stage, final and win columns", () => {
        const event: EventOddsData = {
            slug: "test",
            name: "Test Major",
            liquipedia: "Test/Major",
            startDate: "2026-11-25",
            endDate: "2026-12-13",
            generatedAt: "",
            asOf: "2026-10-19",
            n: 10000,
            stages: [{ id: "po", name: "Playoffs" }],
            placements: ["1", "2", "3-4"],
            prizes: null,
            playedMatches: 0,
            teams: [{ team: "Team Vitality", rating: 1900, reach: { po: 0.8 }, placements: { "1": 0.31, "2": 0.2, "3-4": 0.005 } }],
        };
        const html = render("/events/test", "/events/:slug", <EventOdds />, [["sim", "event", "test"], event]);
        expect(html).toContain("Test Major");
        expect(html).toContain("Playoffs");
        expect(html).toContain("80%");
        expect(html).toContain("51%");
        expect(html).toContain("Liquipedia");
        expect(html).not.toContain(">Bracket<");
        expect(html).not.toContain("VRS impact");

        const impact: SeasonImpact = {
            generatedAt: "",
            asOf: "2026-10-19",
            slug: "test",
            name: "Test Major",
            liquipedia: "Test/Major",
            checkpoint: "2027-01-04",
            n: 300,
            minRuns: 20,
            check: { n: 20, mean: 0.4, p95: 1.2, max: 2 },
            teams: [
                {
                    team: "Team Vitality",
                    attend: 1,
                    expected: 42.3,
                    placements: [
                        { placement: "1", p: 0.31, runs: 93, delta: 88.4, start: 30.1, h2h: 58.3 },
                        { placement: "3-4", p: 0.02, runs: 6, delta: -12.5, start: 1, h2h: -13.5 },
                    ],
                },
            ],
        };
        const withImpact = render("/events/test", "/events/:slug", <EventOdds />, [["sim", "event", "test"], event], [["sim", "season", "impact", "test"], impact]);
        expect(withImpact).toContain("VRS impact");
        expect(withImpact).toContain("2027-01-04");
        expect(withImpact).toContain("+42.3");
        expect(withImpact).toContain("+88.4");
        expect(withImpact).toContain("Only 6 runs");
    });

    it("renders the bracket's played results and likeliest matchups", () => {
        const event: EventOddsData = {
            slug: "test",
            name: "Test Cup",
            liquipedia: "Test/Cup",
            startDate: "2026-11-25",
            endDate: "2026-11-30",
            generatedAt: "",
            asOf: "2026-10-19",
            n: 10000,
            stages: [],
            placements: ["1", "2", "3-4"],
            prizes: null,
            playedMatches: 1,
            teams: [],
            bracket: [
                {
                    id: "po",
                    name: "Playoffs",
                    format: "single_elim",
                    slots: [
                        {
                            id: "r1-m1",
                            round: 1,
                            lane: "upper",
                            bestOf: 3,
                            reach: 1,
                            teams: [],
                            matchups: [],
                            results: [{ teams: ["Team Vitality", "MOUZ"], winner: 1 }],
                        },
                        {
                            id: "r2-m1",
                            round: 2,
                            lane: "upper",
                            bestOf: 5,
                            reach: 1,
                            teams: [
                                { team: "MOUZ", here: 1, win: 0.55 },
                                { team: "FURIA", here: 0.62, win: 0.3 },
                            ],
                            matchups: [{ teams: ["FURIA", "MOUZ"], p: 0.62 }],
                        },
                    ],
                },
            ],
        };
        const html = render("/events/test", "/events/:slug", <EventOdds />, [["sim", "event", "test"], event]);
        expect(html).toContain(">Bracket<");
        expect(html).toContain("Team Vitality");
        expect(html).toContain("FURIA v MOUZ");
        expect(html).toContain("62%");
        expect(html).toMatch(/Bo(<!-- -->)?5/);
    });

    it("renders Swiss stage with most likely destinations and status cards", () => {
        const event: EventOddsData = {
            slug: "test-swiss",
            name: "Test Swiss Major",
            liquipedia: "Test/Swiss",
            startDate: "2026-11-25",
            endDate: "2026-11-30",
            generatedAt: "",
            asOf: "2026-10-19",
            n: 1000,
            stages: [],
            placements: ["1", "2"],
            prizes: null,
            playedMatches: 0,
            teams: [],
            bracket: [
                {
                    id: "swiss",
                    name: "Swiss stage",
                    format: "swiss",
                    slots: [
                        {
                            id: "r1:0-0",
                            round: 1,
                            lane: "upper",
                            bestOf: 1,
                            reach: 1,
                            teams: [
                                { team: "Team Vitality", here: 1, win: 0.8 },
                                { team: "9z Team", here: 1, win: 0.2 },
                            ],
                            matchups: [],
                        },
                        {
                            id: "r2:1-0",
                            round: 2,
                            lane: "upper",
                            bestOf: 1,
                            reach: 1,
                            teams: [
                                { team: "Team Vitality", here: 0.8, win: 0.6 },
                                { team: "9z Team", here: 0.2, win: 0.05 },
                            ],
                            matchups: [],
                        },
                        {
                            id: "r2:0-1",
                            round: 2,
                            lane: "upper",
                            bestOf: 1,
                            reach: 1,
                            teams: [
                                { team: "9z Team", here: 0.8, win: 0.4 },
                                { team: "Team Vitality", here: 0.2, win: 0.15 },
                            ],
                            matchups: [],
                        },
                    ],
                },
            ],
        };
        const html = render("/events/test-swiss", "/events/:slug", <EventOdds />, [["sim", "event", "test-swiss"], event]);
        expect(html).toContain(">Bracket<");
        expect(html).toMatch(/Round (<!-- -->)?1/);
        expect(html).toMatch(/Round (<!-- -->)?2/);
        expect(html).toContain("0-0");
        expect(html).toContain("1-0");
        expect(html).toContain("0-1");
    });

    it("renders upper/lower brackets with candidates assigned to their likeliest slot", () => {
        const event: EventOddsData = {
            slug: "test-gsl",
            name: "Test GSL Event",
            liquipedia: "Test/GSL",
            startDate: "2026-11-25",
            endDate: "2026-11-30",
            generatedAt: "",
            asOf: "2026-10-19",
            n: 1000,
            stages: [],
            placements: ["1", "2"],
            prizes: null,
            playedMatches: 0,
            teams: [],
            bracket: [
                {
                    id: "g1",
                    name: "Group A",
                    format: "bracket",
                    slots: [
                        {
                            id: "u1",
                            round: 1,
                            lane: "upper",
                            bestOf: 3,
                            reach: 1,
                            teams: [
                                { team: "HEROIC", here: 1, win: 0.65 },
                                { team: "B8", here: 1, win: 0.35 },
                            ],
                            matchups: [{ teams: ["HEROIC", "B8"], p: 1 }],
                        },
                        {
                            id: "u5",
                            round: 2,
                            lane: "upper",
                            bestOf: 3,
                            reach: 1,
                            teams: [
                                { team: "HEROIC", here: 0.65, win: 0.38 },
                                { team: "B8", here: 0.35, win: 0.16 },
                            ],
                            matchups: [],
                        },
                        {
                            id: "l1",
                            round: 2,
                            lane: "lower",
                            bestOf: 3,
                            reach: 1,
                            teams: [
                                { team: "B8", here: 0.65, win: 0.31 },
                                { team: "HEROIC", here: 0.35, win: 0.22 },
                            ],
                            matchups: [],
                        },
                        {
                            id: "l2",
                            round: 2,
                            lane: "lower",
                            bestOf: 3,
                            reach: 1,
                            teams: [
                                { team: "B8", here: 0.1, win: 0.05 },
                            ],
                            matchups: [],
                        },
                    ],
                },
            ],
        };
        const html = render("/events/test-gsl", "/events/:slug", <EventOdds />, [["sim", "event", "test-gsl"], event]);
        expect(html).toContain("Upper bracket");
        expect(html).toContain("Lower bracket");
        expect(html).toContain("HEROIC");
        expect(html).toContain("B8");
    });

    it("renders invite odds with the announced-events caveat and unverified slots", () => {
        const invites: InviteOdds = {
            slug: "ba",
            name: "FiRe Major Buenos Aires 2027",
            liquipedia: "FiRe/2027/Buenos_Aires",
            snapshotDate: "2027-04-05",
            snapshotEstimated: true,
            generatedAt: "",
            asOf: "2026-10-19",
            n: 1000,
            events: [{ slug: "x", name: "Small LAN", liquipedia: "X", included: false, reason: "No prize distribution on Liquipedia yet" }],
            slots: {
                stage3: { Europe: 6, Americas: 1.5, Asia: 0.5 },
                stage2: { Europe: 5, Americas: 2, Asia: 1 },
                stage1: { Europe: 6, Americas: 6, Asia: 4 },
                source: "Cologne 2026",
                verified: false,
            },
            rosters: [
                {
                    rosterKey: "a",
                    teamName: "Vitality",
                    region: "Europe",
                    players: ["ZywOo"],
                    stage3: 0.9,
                    stage2: 0.1,
                    stage1: 0,
                    miss: 0,
                    rank: { p10: 1, p50: 1, p90: 3 },
                    intact: false,
                    regionLocked: true,
                },
            ],
        };
        const index = [
            { slug: "sg", name: "PGL Major Singapore 2026", snapshotDate: "2026-11-02" },
            { slug: "ba", name: invites.name, snapshotDate: invites.snapshotDate },
        ];
        const html = render(
            "/major-invites?major=ba",
            "/major-invites",
            <MajorInvites />,
            [["sim", "invites"], index],
            [["sim", "invites", "ba"], invites]
        );
        expect(html).toContain("PGL Major Singapore 2026");
        expect(html).toContain("Announced events only");
        expect(html).toContain("(estimated)");
        expect(html).toContain("not yet checked against");
        expect(html).toContain("No prize distribution on Liquipedia yet");
        expect(html).toContain("not intact");
        expect(html).toContain("region locked");
        expect(html).toContain("90%");
    });

    it("filters event odds teams by search query", () => {
        const event: EventOddsData = {
            slug: "test",
            name: "Test Major",
            liquipedia: "Test/Major",
            startDate: "2026-11-25",
            endDate: "2026-12-13",
            generatedAt: "",
            asOf: "2026-10-19",
            n: 10000,
            stages: [{ id: "po", name: "Playoffs" }],
            placements: ["1", "2"],
            prizes: null,
            playedMatches: 0,
            teams: [
                { team: "Team Vitality", rating: 1900, reach: { po: 0.8 }, placements: { "1": 0.5, "2": 0.5 } },
                { team: "FaZe Clan", rating: 1850, reach: { po: 0.6 }, placements: { "1": 0.3, "2": 0.3 } },
            ],
        };
        const vitHtml = render("/events/test?q=vitality", "/events/:slug", <EventOdds />, [["sim", "event", "test"], event]);
        expect(vitHtml).toContain("Team Vitality");
        expect(vitHtml).not.toContain("FaZe Clan");
        expect(vitHtml).toContain("1 of 2 teams");

        const emptyHtml = render("/events/test?q=nonexistent", "/events/:slug", <EventOdds />, [["sim", "event", "test"], event]);
        expect(emptyHtml).toContain("No teams match “nonexistent”");
        expect(emptyHtml).toContain("0 of 2 teams");
    });

    it("filters major invite rosters by search query", () => {
        const invites: InviteOdds = {
            slug: "ba",
            name: "FiRe Major Buenos Aires 2027",
            liquipedia: "FiRe/2027/Buenos_Aires",
            snapshotDate: "2027-04-05",
            snapshotEstimated: true,
            generatedAt: "",
            asOf: "2026-10-19",
            n: 1000,
            events: [],
            slots: {
                stage3: { Europe: 6, Americas: 1.5, Asia: 0.5 },
                stage2: { Europe: 5, Americas: 2, Asia: 1 },
                stage1: { Europe: 6, Americas: 6, Asia: 4 },
                source: "Cologne 2026",
                verified: false,
            },
            rosters: [
                {
                    rosterKey: "a",
                    teamName: "Vitality",
                    region: "Europe",
                    players: ["ZywOo"],
                    stage3: 0.9,
                    stage2: 0.1,
                    stage1: 0,
                    miss: 0,
                    rank: { p10: 1, p50: 1, p90: 3 },
                    intact: true,
                },
                {
                    rosterKey: "b",
                    teamName: "FaZe Clan",
                    region: "Europe",
                    players: ["karrigan"],
                    stage3: 0.8,
                    stage2: 0.2,
                    stage1: 0,
                    miss: 0,
                    rank: { p10: 2, p50: 2, p90: 4 },
                    intact: true,
                },
            ],
        };
        const index = [{ slug: "ba", name: invites.name, snapshotDate: invites.snapshotDate }];

        const vitHtml = render(
            "/major-invites?major=ba&q=ZywOo",
            "/major-invites",
            <MajorInvites />,
            [["sim", "invites"], index],
            [["sim", "invites", "ba"], invites]
        );
        expect(vitHtml).toContain("Vitality");
        expect(vitHtml).not.toContain("FaZe Clan");
        expect(vitHtml).toContain("1 of 2 rosters");

        const emptyHtml = render(
            "/major-invites?major=ba&q=nonexistent",
            "/major-invites",
            <MajorInvites />,
            [["sim", "invites"], index],
            [["sim", "invites", "ba"], invites]
        );
        expect(emptyHtml).toContain("No rosters match “nonexistent”");
        expect(emptyHtml).toContain("0 of 2 rosters");
    });

    const seasonIndex: SeasonIndex = {
        generatedAt: "",
        asOf: "2026-11-12",
        target: { slug: "ba", name: "FiRe Major Buenos Aires 2027", date: "2027-04-05", estimated: true },
        n: 300,
        seed: 1,
        checkpoints: ["2026-12-07", "2027-04-05"],
        inexactReruns: 0,
        volume: { low: 6, average: 6, high: 7, horizonDays: 144, teamsCounted: 40 },
        unmatchedRosters: [],
        events: [
            {
                slug: "lodz",
                name: "PGL Łódź 2027",
                liquipedia: "PGL/2027/Łódź",
                startDate: "2027-03-18",
                endDate: "2027-03-28",
                location: { region: "Europe", country: "pl" },
                tier: 1,
                prizePool: 1000000,
                prizeSource: "table",
                generic: false,
                kind: "lan",
                assumed: ["field"],
                simulated: true,
                shortRuns: 0,
                field: [
                    { team: "MOUZ", attend: 1, source: "vrs", win: 0.3 },
                    { team: "HEROIC", attend: 0.4, source: "qualifier", win: 0.02 },
                ],
            },
            {
                slug: "iem-us",
                name: "IEM United States 2027",
                liquipedia: "Intel_Extreme_Masters/2027/United_States",
                startDate: "2027-04-05",
                endDate: "2027-04-11",
                location: { region: "Americas", country: "us" },
                tier: 1,
                prizePool: 1000000,
                prizeSource: "estimate",
                generic: true,
                kind: "lan",
                assumed: ["format", "prizes"],
                simulated: false,
                reason: "field unknown: 16 of 16 slots have no invite rule",
                shortRuns: 0,
                field: [],
            },
            {
                slug: "cct-europe-series-17",
                name: "CCT Europe 2026 Series #17",
                liquipedia: "CCT/2026/Europe/Series_17",
                startDate: "2026-12-25",
                endDate: "2027-01-04",
                location: { region: "Europe", country: "" },
                tier: 3,
                prizePool: 25000,
                prizeSource: "estimate",
                generic: true,
                kind: "online",
                projection: { editions: 16, gapDays: 15, lastPage: "CCT/2026/Europe/Series_16", lastStart: "2026-12-01", chance: 0.58 },
                assumed: ["format", "prizes", "field", "dates"],
                simulated: true,
                shortRuns: 0,
                field: [{ team: "Sashi", attend: 0.3, source: "open", win: 0.05 }],
                fedBy: [{ slug: "cct-play-in", name: "CCT Series #17 Play-In", slots: 1 }],
            },
        ],
    };
    const seasonStandings: SeasonStandings = {
        generatedAt: "",
        asOf: "2026-11-12",
        todayDate: "2026-11-17",
        n: 300,
        checkpoints: ["2026-12-07", "2027-04-05"],
        rosters: [
            {
                rosterKey: "mouz",
                teamName: "MOUZ",
                region: "Europe",
                players: ["torzsi"],
                today: { points: 1988.9, globalRank: 1, regionalRank: 1 },
                checkpoints: [
                    { points: { p10: 1900, p50: 1960, p90: 2000 }, globalRank: { p10: 1, p50: 1, p90: 3 }, regionalRank: { p10: 1, p50: 1, p90: 3 }, ranked: 1 },
                    { points: { p10: 1850, p50: 1940, p90: 1990 }, globalRank: { p10: 1, p50: 2, p90: 5 }, regionalRank: { p10: 1, p50: 2, p90: 4 }, ranked: 1 },
                ],
            },
            {
                rosterKey: "furia",
                teamName: "FURIA",
                region: "Americas",
                players: ["yuurih"],
                today: null,
                checkpoints: [
                    { points: { p10: 1800, p50: 1880, p90: 1900 }, globalRank: { p10: 2, p50: 3, p90: 6 }, regionalRank: { p10: 1, p50: 1, p90: 1 }, ranked: 1 },
                    { points: { p10: 1700, p50: 1800, p90: 1900 }, globalRank: { p10: 3, p50: 6, p90: null }, regionalRank: { p10: 1, p50: 1, p90: 2 }, ranked: 0.95 },
                ],
            },
        ],
    };

    it("renders the season calendar with assumed-data badges and unsimulated reasons", () => {
        const html = render("/vrs-sim", "/vrs-sim", <VrsSim />, [["sim", "season", "index"], seasonIndex]);
        expect(html).toContain("PGL Łódź 2027");
        expect(html).toContain("assumed field");
        expect(html).toContain("HEROIC");
        expect(html).toContain('/teams/MOUZ"');
        expect(html).toContain("40%");
        expect(html).toMatch(/Not simulated: (<!-- -->)?field unknown/);
        expect(html).not.toContain("CCT Europe 2026 Series #17");
    });

    it("shows projected editions under the Projected filter, with their chance and no link to a page that doesn't exist", () => {
        const html = render("/vrs-sim?kind=projected", "/vrs-sim", <VrsSim />, [["sim", "season", "index"], seasonIndex]);
        expect(html).toContain("CCT Europe 2026 Series #17");
        expect(html).toMatch(/projected (<!-- -->)?58%/);
        expect(html).toContain("1 slot from CCT Series #17 Play-In");
        expect(html).toContain("Europe%2FSeries_16");
        expect(html).not.toContain("Series_17");
        expect(html).not.toContain("PGL Łódź 2027");
    });

    it("renders season projections at the target checkpoint, filtered by region", () => {
        const html = render(
            "/vrs-sim?view=projections&region=Americas",
            "/vrs-sim",
            <VrsSim />,
            [["sim", "season", "index"], seasonIndex],
            [["sim", "season", "standings"], seasonStandings]
        );
        expect(html).toContain("Americas standings at 2027-04-05");
        expect(html).toContain("FURIA");
        expect(html).not.toContain("torzsi");
        expect(html).toContain("95%");
    });

    it("renders a team's recommended schedules beside the season rules, and the picker at the average pick", () => {
        const summary = (mean: number, invite: number | null) => ({ mean, p10: mean - 100, p90: mean + 100, invite });
        const schedule: SeasonTeamSchedule = {
            generatedAt: "",
            team: "MOUZ",
            teamName: "MOUZ",
            rosterKey: "mouz",
            region: "Europe",
            asOf: "2026-11-12",
            target: seasonIndex.target,
            n: 300,
            rescoreN: 50,
            volume: seasonIndex.volume,
            committed: [],
            candidates: [
                { slug: "lodz", name: "PGL Łódź 2027", startDate: "2027-03-18", endDate: "2027-03-28", region: "Europe", announced: true, reach: 1, attend: 1, generic: false, assumedInvite: false },
                { slug: "iem-us", name: "IEM United States 2027", startDate: "2027-04-05", endDate: "2027-04-11", region: "Americas", announced: false, reach: 0.4, attend: 0.3, generic: false, assumedInvite: false },
                { slug: "cup-9", name: "Cup 9", startDate: "2027-04-20", endDate: "2027-04-23", region: "Europe", announced: false, reach: 0.5, attend: 0.1, generic: true, projected: 0.6, assumedInvite: true },
            ],
            requiresQualifying: [
                { slug: "q", name: "Qualifier Cup", startDate: "2027-02-01", endDate: "2027-02-05", reach: 0.2 },
                {
                    slug: "epl",
                    name: "ESL Pro League Season 25",
                    startDate: "2027-03-06",
                    endDate: "2027-03-14",
                    reach: 0.9,
                    via: [{ slug: "ecl-eu", name: "ECL S52 Europe" }],
                    qualified: 0.18,
                },
            ],
            rules: summary(1900, 1),
            recommended: [
                { volumes: ["low", "average", "high"], goals: ["points"], mask: 2, dropsAnnounced: ["lodz"], exact: summary(1937, 0.98), estimate: summary(1941, 0.97) },
            ],
            subsets: [
                [0, 1800, 1700, 1900, 0.9],
                [2, 1941, 1841, 2041, 0.97],
            ],
        };
        const html = render(
            "/vrs-sim?view=schedules&team=MOUZ",
            "/vrs-sim",
            <VrsSim />,
            [["sim", "season", "index"], { ...seasonIndex, schedules: [{ team: "MOUZ", teamName: "MOUZ", rosterKey: "mouz", region: "Europe", file: "MOUZ.json" }] }],
            [["sim", "season", "team", "MOUZ.json"], schedule]
        );
        expect(html).toContain("MOUZ: recommended schedules");
        expect(html).toContain("Season rules");
        expect(html).toContain("1937");
        expect(html).toContain("98%");
        expect(html).toMatch(/Drops announced: (<!-- -->)?PGL Łódź 2027/);
        expect(html).toContain("One-team estimate");
        expect(html).toContain("Qualifier Cup");
        expect(html.replaceAll("<!-- -->", "")).toContain("ESL Pro League Season 25 via ECL S52 Europe: qualifies in 18% of runs when entered");
        expect(html).toMatch(/projected (<!-- -->)?60%/);
        expect(html).toContain("assumed invite");
        expect(html).not.toContain("Full plan for");

        const planIndex: PlanIndex = { generatedAt: "", teams: [{ team: "MOUZ", teamName: "MOUZ", file: "MOUZ.json", asOf: "2026-11-12", target: seasonIndex.target, generatedAt: "" }] };
        const withPlan = render(
            "/vrs-sim?view=schedules&team=MOUZ",
            "/vrs-sim",
            <VrsSim />,
            [["sim", "season", "index"], { ...seasonIndex, schedules: [{ team: "MOUZ", teamName: "MOUZ", rosterKey: "mouz", region: "Europe", file: "MOUZ.json" }] }],
            [["sim", "season", "team", "MOUZ.json"], schedule],
            [["sim", "plan", "index"], planIndex]
        );
        expect(withPlan.replaceAll("<!-- -->", "")).toContain("Full plan for MOUZ");
    });

    it("renders a team's plan: schedules against the season rules, and the average route with qualifier branches", () => {
        const plan = testPlan();
        const planIndex: PlanIndex = {
            generatedAt: "",
            teams: [{ team: plan.team, teamName: plan.teamName, file: "100_Thieves.json", asOf: plan.asOf, target: plan.target, generatedAt: "" }],
        };
        const html = render(
            "/vrs-sim?view=plan&team=100_Thieves",
            "/vrs-sim",
            <VrsSim />,
            [["sim", "season", "index"], { ...seasonIndex, asOf: "2026-11-21" }],
            [["sim", "plan", "index"], planIndex],
            [["sim", "plan", "team", "100_Thieves.json"], plan]
        ).replaceAll("<!-- -->", "");
        expect(html).toContain("100 Thieves: route to the FiRe Major Buenos Aires 2027 invite");
        expect(html).toContain("Season rules");
        expect(html).toContain("Announced only");
        expect(html).toMatch(/\+26<span[^>]*> \(21 to 31\)/);
        expect(html).toContain("83%");
        expect(html).toContain("older than the season simulation (2026-11-21)");
        expect(html).toContain("Best for low volume, average volume");
        expect(html).toContain("via PGL Cluj-Napoca 2027 Closed Qualifier: enters 100%, qualifies 81% of those");
        expect(html).toContain("worth +14.3");
        expect(html).not.toContain("no measurable gain");

        const high = render(
            "/vrs-sim?view=plan&team=100_Thieves&plan=0",
            "/vrs-sim",
            <VrsSim />,
            [["sim", "season", "index"], seasonIndex],
            [["sim", "plan", "index"], planIndex],
            [["sim", "plan", "team", "100_Thieves.json"], plan]
        );
        expect(high).toContain("no measurable gain");
    });

    it("renders every published plan", () => {
        const dir = path.resolve(__dirname, "../../public/data/sim");
        const read = (file: string) => (fs.existsSync(path.join(dir, file)) ? JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) : undefined);
        const index: PlanIndex | undefined = read("plan/index.json");
        const season: SeasonIndex | undefined = read("season/index.json");
        if (!index || !season) return;
        for (const entry of index.teams) {
            const plan = read(`plan/${entry.file}`);
            const html = render(
                `/vrs-sim?view=plan&team=${entry.team.replace(/ /g, "_")}`,
                "/vrs-sim",
                <VrsSim />,
                [["sim", "season", "index"], season],
                [["sim", "plan", "index"], index],
                [["sim", "plan", "team", entry.file], plan]
            ).replaceAll("<!-- -->", "");
            expect(html).toContain(`${entry.teamName}: route to the`);
            expect(html).toContain("Season rules");
        }
    });

    it("says when no team plans are published", () => {
        const html = render("/vrs-sim?view=plan", "/vrs-sim", <VrsSim />, [["sim", "season", "index"], seasonIndex], [["sim", "plan", "index"], null]);
        expect(html).toContain("No team plans published yet.");
    });
});
