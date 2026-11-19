import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Rankings } from "./Rankings.tsx";
import { tacticsColumns } from "../war/teamColumns.ts";
import { eloData, tactics, teamDuels, teamStats } from "../test/teamFixtures.ts";

const render = (url = "/rankings") => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["elo", "latest"], eloData);
    queryClient.setQueryData(["war", "team-duels"], teamDuels);
    queryClient.setQueryData(["war", "team-stats"], teamStats);
    queryClient.setQueryData(["war", "tactics"], tactics);
    return renderToString(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[url]}>
                <Routes>
                    <Route path="/rankings" element={<Rankings />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    );
};

describe("Rankings page", () => {
    it("renders the Elo table with search input and team-page links, no expander", () => {
        const html = render();
        expect(html).toContain("CS2 Team Rankings");
        expect(html).toContain('placeholder="Team or player"');
        expect(html).toContain("2 rosters");
        expect(html).toContain('href="/teams/Team_Vitality"');
        expect(html).not.toContain("aria-expanded");
        expect(html).not.toContain("Teams / duel execution");
    });

    it("filters rosters by search query", () => {
        const html = render("/rankings?q=donk");
        expect(html).toContain("Team Spirit");
        expect(html).not.toContain("Team Vitality");
        expect(html).toContain("1 of 2 rosters");
    });

    it("shows empty state when no rosters match", () => {
        const html = render("/rankings?q=nonexistent");
        expect(html).toContain("No rosters match “nonexistent”");
        expect(html).toContain("0 of 2 rosters");
    });

    it("duels tab shows only published stats, sorted by execution, filtered by the search", () => {
        const html = render("/rankings?view=duels");
        const table = html.slice(html.indexOf("Teams / duel execution"));
        expect(html).not.toContain("map-level Elo vs. VRS");
        expect(html).not.toContain('aria-label="Region"');
        expect(table).toContain("Positioning");
        expect(table).not.toContain("Flashes");
        expect(table).toContain("+2.32");
        expect(table).toContain("(FalleN)");
        expect(table).toContain("none improves an Elo prediction");
        expect(table).toContain('href="/teams/Team_Spirit"');
        expect(table.indexOf("Team Spirit")).toBeLessThan(table.indexOf("FURIA"));

        expect(render("/rankings?view=duels&q=fallen")).toContain("1 of 2 stints");
    });

    it("rounds tab shows only published stats, sorted by round wins over economy", () => {
        const html = render("/rankings?view=rounds");
        const table = html.slice(html.indexOf("Teams / round-level stats"));
        expect(table).toContain("RW over econ");
        expect(table).toContain("Adj. CT");
        expect(table).not.toContain("Conversion");
        expect(table).not.toContain("Post-plant T");
        expect(table).toContain("+7.19");
        expect(table.indexOf("Team Vitality")).toBeLessThan(table.indexOf("FURIA"));
    });

    it("tactics tab shows post-plant and contact columns from tactics.json", () => {
        const html = render("/rankings?view=tactics");
        const table = html.slice(html.indexOf("Teams / tactics"));
        expect(table).toContain("Post-plant T");
        expect(table).toContain("Retake CT");
        expect(table).toContain("Numbers at contact");
        expect(table).toContain("+6.60");
        expect(table.indexOf("Team Vitality")).toBeLessThan(table.indexOf("FURIA"));
        expect(tacticsColumns(tactics)[0].tooltip).toContain("Season-to-season r (T side) 0.37");
    });
});
