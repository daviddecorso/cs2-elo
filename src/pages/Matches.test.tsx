import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EloMatchesData } from "../elo/types.ts";
import { Matches } from "./Matches.tsx";

const sampleData: EloMatchesData = {
    generatedAt: "2026-11-22T00:00:00Z",
    asOf: "2026-11-19",
    upcomingFetched: "2026-11-19",
    topRating: 168,
    pool: ["Dust II", "Inferno", "Mirage"],
    upcoming: [
        {
            id: "PGL/2026/Singapore/Stage_1:m1",
            t: Math.floor(Date.parse("2026-11-24T04:00:00Z") / 1000),
            dateExact: true,
            status: "upcoming",
            event: "PGL/2026/Singapore",
            eventName: "PGL Major Singapore 2026",
            eventSlug: "pgl-major-singapore-2026",
            page: "PGL/2026/Singapore/Stage_1",
            section: "Stage 1 · Round 1",
            tier: 1,
            lan: true,
            bestOf: 1,
            sides: [
                { team: "HEROIC", rank: 17, vrsRank: 18, rating: -44, rated: true },
                { team: "Imperial Esports", rank: 46, vrsRank: 35, rating: -136, rated: true },
            ],
            p: 0.69,
            seriesOdds: { bo1: 0.69, bo3: 0.76, bo5: 0.81 },
            maps: [{ map: "Mirage", p: 0.7, offsets: [12, -5] }],
        },
        {
            id: "CCT/2026/Europe:m2",
            t: Math.floor(Date.parse("2026-11-25T15:00:00Z") / 1000),
            dateExact: true,
            status: "upcoming",
            event: "CCT/2026/Europe",
            eventName: "CCT Europe",
            eventSlug: "cct-2026-europe",
            page: "CCT/2026/Europe",
            tier: 4,
            lan: false,
            bestOf: 3,
            sides: [
                { team: "Tier Four A", rank: 180, vrsRank: null, rating: -400, rated: true },
                { team: "Tier Four B", rank: 190, vrsRank: null, rating: -420, rated: true },
            ],
            p: 0.54,
            seriesOdds: { bo1: 0.52, bo3: 0.54, bo5: 0.55 },
            maps: [],
        },
    ],
    recent: [
        {
            id: "Event/Done:m3",
            t: Math.floor(Date.parse("2026-11-18T18:00:00Z") / 1000),
            dateExact: true,
            status: "completed",
            event: "Event/Done",
            eventName: "BLAST Rivals",
            eventSlug: "blast-rivals",
            page: "Event/Done",
            tier: 1,
            lan: true,
            bestOf: 3,
            sides: [
                { team: "Team Vitality", rank: 2, vrsRank: 1, rating: 136, rated: true, score: 1, delta: -14.2 },
                { team: "Underdog Five", rank: 24, vrsRank: 25, rating: -80, rated: true, score: 2, delta: 14.2 },
            ],
            p: 0.86,
            winner: 1,
            maps: [
                { map: "Mirage", p: 0.82, rounds: [13, 8], winner: 0 },
                { map: "Inferno", p: 0.78, rounds: [10, 13], winner: 1 },
                { map: "Dust II", p: 0.79, rounds: [11, 13], winner: 1 },
            ],
        },
    ],
};

const render = (url = "/matches") => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["elo", "matches"], sampleData);
    return renderToString(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[url]}>
                <Routes>
                    <Route path="/matches" element={<Matches />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    );
};

describe("Matches page", () => {
    it("defaults to upcoming Top 30 / Tier 1–2 matches and filters out lower tiers", () => {
        const html = render();
        expect(html).toContain("Matches / Upcoming");
        expect(html).toContain("HEROIC");
        expect(html).toContain("Imperial Esports");
        expect(html).toContain("69%");
        expect(html).toContain("PGL Major Singapore 2026");
        expect(html).not.toContain("Tier Four A");
        expect(html).toContain("Showing 1 of 2 matches");
        expect(html).toContain("Liquipedia");
    });

    it("shows all matches when show=all", () => {
        const html = render("/matches?show=all");
        expect(html).toContain("HEROIC");
        expect(html).toContain("Tier Four A");
        expect(html).toContain("Showing 2 of 2 matches");
    });

    it("renders recent results with scores and biggest upsets", () => {
        const html = render("/matches?view=recent");
        expect(html).toContain("Matches / Recent");
        expect(html).toContain("Biggest upsets");
        expect(html).toContain("Upset");
        expect(html).toContain("Team Vitality");
        expect(html).toContain("Underdog Five");
        expect(html).toContain("Final");
    });

    it("filters by search query and shows reset empty state when nothing matches", () => {
        const html = render("/matches?q=nonexistent");
        expect(html).toContain("No matches fit this filter.");
        expect(html).toContain("Show all matches");
    });
});
