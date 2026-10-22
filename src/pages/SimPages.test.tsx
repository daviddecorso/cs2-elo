import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EventOdds } from "./EventOdds.tsx";
import { MajorInvites } from "./MajorInvites.tsx";
import type { EventOdds as EventOddsData, InviteOdds } from "../sim/types.ts";

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
});
