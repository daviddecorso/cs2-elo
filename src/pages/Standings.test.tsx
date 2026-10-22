import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../components/AppShell.tsx";
import { Standings } from "./Standings.tsx";
import type { Standings as StandingsData } from "../vrs/types.ts";

const latestData = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "public/data/vrs/latest.json"), "utf8")
) as StandingsData;

const render = (live: StandingsData | null, url = "/") => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["standings", "latest"], latestData);
    queryClient.setQueryData(["standings", "live"], live);
    return renderToString(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[url]}>
                <Routes>
                    <Route element={<AppShell />}>
                        <Route path="/" element={<Standings />} />
                    </Route>
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    );
};

const liveData: StandingsData = {
    ...latestData,
    source: "model",
    snapshotDate: "2026-10-20",
    asOf: "2026-10-19",
    previousSnapshot: latestData.snapshotDate,
    rosters: latestData.rosters.map((r) => ({
        ...r,
        previousRank: r.teamName === "Spirit" ? 3 : r.globalRank,
    })),
};

describe("Standings Page", () => {
    it("renders region tabs, rows and footer against latest.json", () => {
        const html = render(null);

        // Region tabs
        expect(html).toContain("Global");
        expect(html).toContain("Europe");
        expect(html).toContain("Americas");
        expect(html).toContain("Asia");

        // Top team row
        expect(html).toContain("Spirit");
        expect(html).toContain("2046");
        expect(html).toContain("donk, magixx, sh1ro, tN1R, zont1x");

        // Footer elements
        expect(html).toContain(latestData.snapshotDate);
        expect(html).toContain("Valve Published Standings");
        expect(html).toContain("Event data for Regional Standings provided by HLTV.org");
        expect(html).toContain("CS2 Regional Standings model");
        expect(html).not.toContain("Standings source");
    });

    it("defaults to live standings with rank change when live.json exists", () => {
        const html = render(liveData);
        expect(html).toContain("Standings source");
        expect(html).toContain("Live as of 2026-10-19");
        expect(html).toContain("Model Simulation");
        expect(html).toContain("▲2");
        expect(html).toContain("Liquipedia");
    });

    it("shows the published snapshot when asked", () => {
        const html = render(liveData, "/?view=published");
        expect(html).toContain("Valve Published Standings");
        expect(html).not.toContain("▲2");
    });

    it("filters rosters by query and shows empty state when nothing matches", () => {
        const spiritHtml = render(null, "/?q=donk");
        expect(spiritHtml).toContain("Spirit");
        expect(spiritHtml).toContain("1 of ");

        const emptyHtml = render(null, "/?q=nonexistentteamxyz");
        expect(emptyHtml).toContain("No teams match “nonexistentteamxyz”");
        expect(emptyHtml).toContain("0 of ");
    });
});
