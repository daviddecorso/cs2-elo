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
});
