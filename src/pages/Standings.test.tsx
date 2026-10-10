import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../components/AppShell.tsx";
import { Standings } from "./Standings.tsx";
import type { Standings as StandingsData } from "../vrs/types.ts";

describe("Standings Page", () => {
    it("renders region tabs, rows and footer against latest.json", () => {
        const latestJsonPath = path.resolve(process.cwd(), "public/data/vrs/latest.json");
        const raw = fs.readFileSync(latestJsonPath, "utf8");
        const latestData = JSON.parse(raw) as StandingsData;

        const queryClient = new QueryClient({
            defaultOptions: {
                queries: {
                    retry: false,
                },
            },
        });
        queryClient.setQueryData(["standings", "latest"], latestData);

        const html = renderToString(
            <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/"]}>
                    <Routes>
                        <Route element={<AppShell />}>
                            <Route path="/" element={<Standings />} />
                        </Route>
                    </Routes>
                </MemoryRouter>
            </QueryClientProvider>
        );

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
    });
});
