import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EloRankings } from "./EloRankings.tsx";
import type { EloRankings as EloRankingsData } from "../elo/types.ts";

const eloData: EloRankingsData = {
    generatedAt: "2026-10-20T12:00:00Z",
    asOf: "2026-10-20",
    vrsSnapshot: "2026-10-19",
    pool: ["Team Vitality", "Team Spirit"],
    rosters: [
        {
            rank: 1,
            team: "Team Vitality",
            region: "Europe",
            rating: 1950,
            maps: 45,
            lastMatch: "2026-10-18",
            players: [
                { nick: "ZywOo", page: "ZywOo" },
                { nick: "apEX", page: "apEX" },
            ],
            departed: [],
            mapOffsets: {},
            vrs: { rank: 1, teamName: "Team Vitality", points: 2000 },
        },
        {
            rank: 2,
            team: "Team Spirit",
            region: "Europe",
            rating: 1920,
            maps: 40,
            lastMatch: "2026-10-19",
            players: [
                { nick: "donk", page: "donk" },
                { nick: "sh1ro", page: "sh1ro" },
            ],
            departed: [],
            mapOffsets: {},
            vrs: { rank: 2, teamName: "Team Spirit", points: 1980 },
        },
    ],
};

const render = (url = "/elo") => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["elo", "latest"], eloData);
    return renderToString(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[url]}>
                <Routes>
                    <Route path="/elo" element={<EloRankings />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    );
};

describe("EloRankings Page", () => {
    it("renders rankings table with search input", () => {
        const html = render();
        expect(html).toContain("CS2 Team Elo");
        expect(html).toContain("Team Vitality");
        expect(html).toContain("Team Spirit");
        expect(html).toContain('placeholder="Team or player"');
        expect(html).toContain("2 rosters");
    });

    it("filters rosters by search query", () => {
        const html = render("/elo?q=donk");
        expect(html).toContain("Team Spirit");
        expect(html).not.toContain("Team Vitality");
        expect(html).toContain("1 of 2 rosters");
    });

    it("shows empty state when no rosters match", () => {
        const html = render("/elo?q=nonexistent");
        expect(html).toContain("No rosters match “nonexistent”");
        expect(html).toContain("0 of 2 rosters");
    });
});
