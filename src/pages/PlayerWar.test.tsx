import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlayerWar } from "./PlayerWar.tsx";
import type { PlayerWarData } from "../war/types.ts";

const warData: PlayerWarData = {
    generatedAt: "2026-11-05T23:00:00Z",
    model: "dryrun-regularized",
    provisional: true,
    gate: { passed: false, log_loss: 0.451 },
    metric: "WAA",
    replacementRate: 0,
    minRounds: 300,
    roundsPerWin: 5.38,
    iglAdjustmentPer100: {
        wpa_opp: { ct: 0.85, t: 0.66, nonIglCt: -0.2, nonIglT: -0.19 },
        wpa: { ct: 0.9, t: 0.69, nonIglCt: -0.21, nonIglT: -0.2 },
        nwpa_mancount: { ct: 0.76, t: 0.63, nonIglCt: -0.19, nonIglT: -0.18 },
        nwpa_event: { ct: 0.63, t: 0.7, nonIglCt: -0.17, nonIglT: -0.19 },
    },
    window: { from: "2025-11-24", to: "2026-10-18", maps: 1312, events: 23 },
    validation: {
        monthToMonth100: { wpa_waa_r: { r: 0.24, pairs: 598 }, nwpa_mancount_waa_r: { r: 0.304, pairs: 598 }, nwpa_event_waa_r: { r: 0.34, pairs: 598 } },
        monthToMonth200: { wpa_waa_r: { r: 0.375, pairs: 297 }, nwpa_mancount_waa_r: { r: 0.409, pairs: 297 }, nwpa_event_waa_r: { r: 0.409, pairs: 297 } },
        monthToMonth300: { wpa_waa_r: { r: 0.55, pairs: 104 }, nwpa_mancount_waa_r: { r: 0.532, pairs: 104 }, nwpa_event_waa_r: { r: 0.461, pairs: 104 } },
        splitHalf: { wpa_waa_r: { r: 0.52, spearman_brown: 0.684, players: 194 }, nwpa_mancount_waa_r: { r: 0.55, spearman_brown: 0.71, players: 194 }, nwpa_event_waa_r: { r: 0.56, spearman_brown: 0.718, players: 194 } },
        withKd: { wpa_waa_r: { r: 0.601, players: 194 }, nwpa_mancount_waa_r: { r: 0.676, players: 194 }, nwpa_event_waa_r: { r: 0.736, players: 194 }, rating3: { r: 0.888, players: 194 } },
    },
    source: {
        demos: "HLTV.org match demos, parsed with awpy",
        attribution: "Events, rosters and player pages from Liquipedia (CC-BY-SA 3.0)",
        liquipedia: "https://liquipedia.net/counterstrike/",
    },
    players: [
        {
            steamid: "1",
            lpPlayer: "Donk",
            name: "donk",
            lpTeam: "Team Spirit",
            maps: 129,
            rounds: 2780,
            isIgl: false,
            iglShare: 0,
            tRole: "Entry",
            ctRole: "Rotator",
            awpShare: 0.01,
            entryShare: 0.34,
            ctByMap: [{ map: "mirage", role: "Connector", maps: 28 }],
            duels: 2400,
            killsAbove: 68.4,
            killsAbovePer100: 2.46,
            kd: 1.42,
            adr: 96.5,
            rating2Approx: 1.38,
            rating3: 1.41,
            swing: 3.1,
            metrics: {
                wpa_opp: { waa: 11.35, waaP5: 8.2, waaP95: 14.6, per100: 2.19, per100P5: 1.58, per100P95: 2.82 },
                wpa: { waa: 9.42, waaP5: 6.1, waaP95: 12.74, per100: 1.82, per100P5: 1.18, per100P95: 2.46 },
                nwpa_mancount: { waa: 8.1, waaP5: 5.5, waaP95: 10.7, per100: 1.57, per100P5: 1.06, per100P95: 2.07 },
                nwpa_event: { waa: 7.9, waaP5: 5.4, waaP95: 10.4, per100: 1.53, per100P5: 1.04, per100P95: 2.01 },
            },
        },
        {
            steamid: "2",
            lpPlayer: "ApEX",
            name: "apEX",
            lpTeam: "Team Vitality",
            maps: 149,
            rounds: 3180,
            isIgl: true,
            iglShare: 1,
            tRole: "Entry",
            ctRole: "Rotator",
            awpShare: 0,
            entryShare: 0.24,
            ctByMap: [{ map: "mirage", role: "Connector", maps: 31 }],
            duels: 2100,
            killsAbove: 11.2,
            killsAbovePer100: 0.35,
            kd: 0.96,
            adr: 74.2,
            rating2Approx: 1.04,
            rating3: 1.05,
            swing: 0.6,
            metrics: {
                wpa_opp: { waa: 3.05, waaP5: 0.1, waaP95: 6.0, per100: 0.51, per100P5: 0.02, per100P95: 1.01 },
                wpa: { waa: 2.15, waaP5: -0.9, waaP95: 5.2, per100: 0.36, per100P5: -0.15, per100P95: 0.88 },
                nwpa_mancount: { waa: 2.8, waaP5: 0.1, waaP95: 5.5, per100: 0.47, per100P5: 0.02, per100P95: 0.93 },
                nwpa_event: { waa: 2.4, waaP5: -0.2, waaP95: 5.0, per100: 0.41, per100P5: -0.03, per100P95: 0.85 },
            },
        },
    ],
};

const render = (url = "/war") => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["war", "players"], warData);
    return renderToString(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[url]}>
                <Routes>
                    <Route path="/war" element={<PlayerWar />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    );
};

describe("PlayerWar Page", () => {
    it("renders player WAA rankings, bootstrap intervals, provisional notice, and Liquipedia credit", () => {
        const html = render();
        expect(html).toContain("CS2 Player WAA");
        expect(html).toContain("Provisional:");
        expect(html).toContain("donk");
        expect(html).toContain("+11.35");
        expect(html).toContain("(+8.20, +14.60)");
        expect(html).toContain("apEX");
        expect(html).toContain("IGL");
        expect(html).toContain("Liquipedia");
    });

    it("sorts by per100 descending by default", () => {
        const flippedData: PlayerWarData = {
            ...warData,
            players: [
                {
                    ...warData.players[0],
                    metrics: {
                        ...warData.players[0].metrics,
                        wpa_opp: { waa: 12.0, waaP5: 9.0, waaP95: 15.0, per100: 1.1, per100P5: 0.8, per100P95: 1.4 },
                    },
                },
                {
                    ...warData.players[1],
                    isIgl: false,
                    metrics: {
                        ...warData.players[1].metrics,
                        wpa_opp: { waa: 4.0, waaP5: 1.0, waaP95: 7.0, per100: 2.5, per100P5: 1.0, per100P95: 4.0 },
                    },
                },
            ],
        };
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(["war", "players"], flippedData);
        const html = renderToString(
            <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/war"]}>
                    <Routes>
                        <Route path="/war" element={<PlayerWar />} />
                    </Routes>
                </MemoryRouter>
            </QueryClientProvider>
        );
        expect(html.indexOf("apEX")).toBeLessThan(html.indexOf("donk"));
    });

    it("separates IGLs into their own leaderboard and filters by role and search query", () => {
        const html = render();
        const iglHeadingIdx = html.indexOf("IGLs / separate leaderboard");
        expect(iglHeadingIdx).toBeGreaterThan(-1);
        expect(html.indexOf("donk")).toBeLessThan(iglHeadingIdx);
        expect(html.indexOf("apEX")).toBeGreaterThan(iglHeadingIdx);

        const awpHtml = render("/war?role=awp");
        expect(awpHtml).not.toContain("donk");
        expect(awpHtml).toContain("0 of 1 players");
        expect(awpHtml).toContain("apEX");

        const searchHtml = render("/war?q=spirit");
        expect(searchHtml).toContain("donk");
        expect(searchHtml).not.toContain("apEX");
        expect(searchHtml).toContain("No IGLs match “spirit”");
    });

    it("switches credit version and shows empty state when unmatched", () => {
        const neutralHtml = render("/war?credit=nwpa_mancount");
        expect(neutralHtml).toContain("+8.10");
        expect(neutralHtml).toContain("(+5.50, +10.70)");

        const rawHtml = render("/war?credit=wpa");
        expect(rawHtml).toContain("(+6.10, +12.74)");

        const emptyHtml = render("/war?q=nobody");
        expect(emptyHtml).toContain("No players match “nobody”");
    });

    it("renders live generated public/data/war/players.json without errors", () => {
        const filePath = path.resolve(__dirname, "../../public/data/war/players.json");
        if (!fs.existsSync(filePath)) return;
        const liveData = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PlayerWarData;
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(["war", "players"], liveData);
        const html = renderToString(
            <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/war"]}>
                    <Routes>
                        <Route path="/war" element={<PlayerWar />} />
                    </Routes>
                </MemoryRouter>
            </QueryClientProvider>
        );
        expect(html).toContain("CS2 Player WAA");
        expect(html).toContain("donk");
        expect(html).toContain("ZywOo");
        expect(html).toContain("karrigan");
    });
});
