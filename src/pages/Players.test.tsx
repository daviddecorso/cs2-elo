import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Players } from "./Players.tsx";
import { PlayerPage } from "./PlayerPage.tsx";
import type { ClutchData, PlayerWarData, StyleData } from "../war/types.ts";

const warData: PlayerWarData = {
    generatedAt: "2026-11-05T23:00:00Z",
    model: "dryrun-regularized",
    provisional: true,
    gate: { passed: false, log_loss: 0.451 },
    metric: "WAA",
    replacementRate: 0,
    minRounds: 300,
    roundsPerWin: 5.38,
    shrinkRounds: { wpa_opp: 984, wpa: 1854, nwpa_mancount: 1476, nwpa_event: 1237 },
    leagueMeanPer100: { wpa_opp: 0, wpa: 0, nwpa_mancount: 0, nwpa_event: 0 },
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
        splitHalf: { wpa_opp_waa_r: { r: 0.54, spearman_brown: 0.701, players: 194 }, wpa_waa_r: { r: 0.52, spearman_brown: 0.684, players: 194 }, nwpa_mancount_waa_r: { r: 0.55, spearman_brown: 0.71, players: 194 }, nwpa_event_waa_r: { r: 0.56, spearman_brown: 0.718, players: 194 } },
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
                wpa_opp: { waa: 11.35, waaP5: 8.2, waaP95: 14.6, per100: 2.19, per100Shrunk: 1.6175, per100P5: 1.58, per100P95: 2.82 },
                wpa: { waa: 9.42, waaP5: 6.1, waaP95: 12.74, per100: 1.82, per100Shrunk: 1.1, per100P5: 1.18, per100P95: 2.46 },
                nwpa_mancount: { waa: 8.1, waaP5: 5.5, waaP95: 10.7, per100: 1.57, per100Shrunk: 1.03, per100P5: 1.06, per100P95: 2.07 },
                nwpa_event: { waa: 7.9, waaP5: 5.4, waaP95: 10.4, per100: 1.53, per100Shrunk: 1.06, per100P5: 1.04, per100P95: 2.01 },
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
                wpa_opp: { waa: 3.05, waaP5: 0.1, waaP95: 6.0, per100: 0.51, per100Shrunk: 0.3895, per100P5: 0.02, per100P95: 1.01 },
                wpa: { waa: 2.15, waaP5: -0.9, waaP95: 5.2, per100: 0.36, per100Shrunk: 0.23, per100P5: -0.15, per100P95: 0.88 },
                nwpa_mancount: { waa: 2.8, waaP5: 0.1, waaP95: 5.5, per100: 0.47, per100Shrunk: 0.32, per100P5: 0.02, per100P95: 0.93 },
                nwpa_event: { waa: 2.4, waaP5: -0.2, waaP95: 5.0, per100: 0.41, per100Shrunk: 0.29, per100P5: -0.03, per100P95: 0.85 },
            },
        },
    ],
};

const clutchData: ClutchData = {
    generated_at: "2026-11-15T00:00:00Z",
    min_entries: { stint: 60, player: 30 },
    team_stats: {},
    player_stats: {
        clutch: {
            label: "Clutch",
            year_r: 0.152,
            year_r_ci: [0.034, 0.274],
            split_half_r: 0.009,
            split_half_r_ci: [-0.2, 0.2],
            r_elo: null,
            entries: 5000,
        },
    },
    source: { demos: "HLTV", attribution: "Liquipedia", liquipedia: "https://liquipedia.net/counterstrike/" },
    teams: [],
    players: [{ steamid: "1", name: "donk", entries: 73, clutch: { per100: 8.05, p5: 0.69, p95: 16.01 } }],
};

const styleData: StyleData = {
    generatedAt: "2026-11-21T00:00:00Z",
    minRounds: 300,
    window: { from: "2025-01-23", to: "2026-10-31", maps: 3112, events: 53 },
    splitGate: 0.5,
    compSize: 5,
    agreement: 0.61,
    metrics: {
        firepower: { label: "Firepower", group: "production", unit: "duel wins above expected per 100 duels", pool: "all", splitHalfR: 0.51 },
        rating: { label: "Rating", group: "overall", unit: "WAA per 100 rounds", pool: "all", splitHalfR: null },
        isolation: { label: "Isolation", group: "style", unit: "T side, units to nearest teammate 20 s in", pool: "role", splitHalfR: 0.85 },
    },
    archetypes: {
        starEntry: { label: "Star Entry", description: "Opens rounds and wins the opening duel", roles: ["Entry"] },
        spacetaker: { label: "Spacetaker", description: "First through the door", roles: ["Entry", "Rifler"] },
    },
    source: { demos: "HLTV", attribution: "Liquipedia", liquipedia: "https://liquipedia.net/counterstrike/" },
    players: [
        {
            steamid: "1",
            archetype: "starEntry",
            runnerUp: "spacetaker",
            fit: 9.2,
            values: { firepower: { value: 4.1, pct: 99 }, rating: { value: 2.19, pct: 97 }, isolation: { value: 312, pct: 12 } },
            comps: {
                production: [
                    { steamid: "2", similarity: 81 },
                    { steamid: "999", similarity: 73 },
                ],
                style: [{ steamid: "2", similarity: 78 }],
            },
        },
    ],
};

const renderWith = (data: PlayerWarData, url = "/players", clutch?: ClutchData, style?: StyleData) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["war", "players"], data);
    if (clutch) queryClient.setQueryData(["war", "clutch"], clutch);
    if (style) queryClient.setQueryData(["war", "style"], style);
    return renderToString(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[url]}>
                <Routes>
                    <Route path="/players" element={<Players />} />
                    <Route path="/players/:player" element={<PlayerPage />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    );
};

const render = (url = "/players") => renderWith(warData, url);

describe("Players page", () => {
    it("renders player WAA rankings, bootstrap intervals, provisional notice, and Liquipedia credit", () => {
        const html = render();
        expect(html).toContain("CS2 Player Rankings");
        expect(html).toContain("Provisional:");
        expect(html).toContain("donk");
        expect(html).toContain("+11.35");
        expect(html).toContain("(+8.20, +14.60)");
        expect(html).toContain("apEX");
        expect(html).toContain("IGL");
        expect(html).toContain("Liquipedia");
    });

    it("sorts by rate rather than total map wins by default", () => {
        const html = renderWith({
            ...warData,
            players: [
                {
                    ...warData.players[0],
                    metrics: {
                        ...warData.players[0].metrics,
                        wpa_opp: { waa: 12.0, waaP5: 9.0, waaP95: 15.0, per100: 1.1, per100Shrunk: 0.8, per100P5: 0.8, per100P95: 1.4 },
                    },
                },
                {
                    ...warData.players[1],
                    isIgl: false,
                    metrics: {
                        ...warData.players[1].metrics,
                        wpa_opp: { waa: 4.0, waaP5: 1.0, waaP95: 7.0, per100: 2.5, per100Shrunk: 1.5, per100P5: 1.0, per100P95: 4.0 },
                    },
                },
            ],
        });
        expect(html.indexOf("apEX")).toBeLessThan(html.indexOf("donk"));
    });

    it("separates IGLs into their own leaderboard and filters by role and search query", () => {
        const html = render();
        const iglHeadingIdx = html.indexOf("IGLs / separate leaderboard");
        expect(iglHeadingIdx).toBeGreaterThan(-1);
        expect(html.indexOf("donk")).toBeLessThan(iglHeadingIdx);
        expect(html.indexOf("apEX")).toBeGreaterThan(iglHeadingIdx);

        const awpHtml = render("/players?role=awp");
        expect(awpHtml).not.toContain("donk");
        expect(awpHtml).toContain("0 of 1 players");
        expect(awpHtml).toContain("apEX");

        const searchHtml = render("/players?q=spirit");
        expect(searchHtml).toContain("donk");
        expect(searchHtml).not.toContain("apEX");
        expect(searchHtml).toContain("No IGLs match “spirit”");
    });

    it("ranks and shows the published shrunk rate, not the raw one", () => {
        const at = (steamid: string, name: string, rounds: number, per100: number, per100Shrunk: number) => ({
            ...warData.players[0],
            steamid,
            name,
            rounds,
            metrics: { ...warData.players[0].metrics, wpa_opp: { ...warData.players[0].metrics.wpa_opp, per100, per100Shrunk } },
        });
        const html = renderWith({ ...warData, players: [at("5", "hotStreak", 425, 2.65, 0.8), at("6", "veteran", 6000, 2, 1.72)] });
        expect(html.indexOf("veteran")).toBeLessThan(html.indexOf("hotStreak"));
        expect(html).toContain("+0.80");
        expect(html).toContain("+1.72");
    });

    it("states the published k in the subtitle", () => {
        expect(renderWith({ ...warData, shrinkRounds: { ...warData.shrinkRounds, wpa_opp: 1234 } })).toContain("a player with 1,234 rounds keeps half");
    });

    it("lists one rating, ignoring the retired credit parameter", () => {
        const html = render("/players?credit=wpa");
        expect(html).toBe(render());
        expect(html).toContain("+1.62");
        expect(html).not.toContain("Credit version");
        expect(html).not.toContain("(+6.10, +12.74)");
    });

    it("shows empty state when unmatched", () => {
        expect(render("/players?q=nobody")).toContain("No players match “nobody”");
    });

    it("shows usage and conversion, and a dash where they're missing", () => {
        const withUsage: PlayerWarData = {
            ...warData,
            players: [
                {
                    ...warData.players[0],
                    metrics: {
                        ...warData.players[0].metrics,
                        wpa_opp: {
                            ...warData.players[0].metrics.wpa_opp,
                            context: -0.09,
                            usage: { per100: 0.33, per100P5: 0.31, per100P95: 0.35 },
                            conversion: { per100: 1.95, per100P5: 1.4, per100P95: 2.5 },
                        },
                    },
                },
                warData.players[1],
            ],
        };
        const html = renderWith(withUsage);
        expect(html).toContain("Conversion");
        expect(html).toContain("(+0.31, +0.35)");
        expect(html).toContain("(+1.40, +2.50)");
    });

    it("renders vs HLTV gap, handles nulls, and sorts with nulls last", () => {
        const withGap: PlayerWarData = {
            ...warData,
            players: [
                {
                    ...warData.players[0],
                    metrics: {
                        ...warData.players[0].metrics,
                        wpa_opp: { ...warData.players[0].metrics.wpa_opp, hltvGap: { z: -0.45, zP5: -0.92, zP95: 0.02 } },
                    },
                },
                {
                    ...warData.players[1],
                    isIgl: false,
                    metrics: {
                        ...warData.players[1].metrics,
                        wpa_opp: { ...warData.players[1].metrics.wpa_opp, hltvGap: { z: 0.88, zP5: 0.25, zP95: 1.51 } },
                    },
                },
                {
                    ...warData.players[1],
                    steamid: "3",
                    name: "noRating",
                    lpPlayer: "NoRating",
                    isIgl: false,
                    rating3: null,
                    metrics: {
                        ...warData.players[1].metrics,
                        wpa_opp: { ...warData.players[1].metrics.wpa_opp, hltvGap: null },
                    },
                },
            ],
        };

        const html = renderWith(withGap);
        expect(html).toContain("vs HLTV");
        expect(html).toContain("-0.45");
        expect(html).toContain("+0.88");

        const descHtml = renderWith(withGap, "/players?sort=hltvGap");
        expect(descHtml.indexOf("apEX")).toBeLessThan(descHtml.indexOf("donk"));
        expect(descHtml.indexOf("donk")).toBeLessThan(descHtml.indexOf("noRating"));

        const ascHtml = renderWith(withGap, "/players?sort=hltvGap&rev=1");
        expect(ascHtml.indexOf("donk")).toBeLessThan(ascHtml.indexOf("apEX"));
        expect(ascHtml.indexOf("apEX")).toBeLessThan(ascHtml.indexOf("noRating"));
    });

    it("links players to their pages and teams to team pages, and leaves team tables to Rankings", () => {
        const html = render();
        expect(html).toContain('href="/players/donk"');
        expect(html).toContain('href="/teams/Team_Spirit"');
        expect(html).not.toContain("Teams / duel execution");
    });

    it("splits WAA, clutch and validation into views", () => {
        expect(render()).not.toContain("Validation diagnostics");

        const validation = render("/players?view=validation");
        expect(validation).toContain("Validation diagnostics");
        expect(validation).toContain("0.701");
        expect(validation).not.toContain("IGLs / separate leaderboard");

        const clutch = renderWith(warData, "/players?view=clutch", clutchData);
        expect(clutch).toContain("Players / clutch conversion");
        expect(clutch).toContain('href="/players/donk"');
        expect(clutch).toContain('href="/teams/Team_Spirit"');
        expect(clutch).not.toContain("IGLs / separate leaderboard");
    });

    it("renders live generated public/data/war/players.json without errors", () => {
        const filePath = path.resolve(__dirname, "../../public/data/war/players.json");
        if (!fs.existsSync(filePath)) return;
        const liveData = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PlayerWarData;
        const html = renderWith(liveData);
        expect(html).toContain("CS2 Player Rankings");
        expect(html).toContain("donk");
        expect(html).toContain("ZywOo");
        expect(html).toContain("karrigan");
        expect(renderWith(liveData, "/players/ZywOo")).toContain("Profile");
    });
});

describe("Player page", () => {
    it("shows one WAA rating with its rank, the profile, clutch, teammates and view toggle", () => {
        const html = renderWith(
            { ...warData, players: [...warData.players, { ...warData.players[1], steamid: "4", name: "zont1x", lpTeam: "Team Spirit", isIgl: false }] },
            "/players/donk",
            clutchData
        );
        expect(html).toContain("donk");
        expect(html).toContain("Overview");
        expect(html).toContain("Style");
        expect(html).toContain("Map tendencies");
        expect(html).toContain("+1.62");
        expect(html).toContain("(+1.58, +2.82)");
        expect(html).toContain("(+8.20, +14.60)");
        expect(html).not.toContain("Neutral (event)");
        expect(html).not.toContain("(+5.40, +10.40)");
        expect(html).toContain("1 / 2");
        expect(html).toContain("Profile");
        expect(html).toContain("Mirage");
        expect(html).toContain("(28m)");
        expect(html).toContain("Clutch conversion");
        expect(html).toContain("Teammates");
        expect(html).toContain('href="/players/zont1x"');
        expect(html).toContain('href="/teams/Team_Spirit"');
        expect(html).toContain("Liquipedia");
    });

    it("shows archetype summary on overview and full percentile bars and comps on the style view", () => {
        const overview = renderWith(warData, "/players/donk", undefined, styleData);
        expect(overview).toContain("Archetype");
        expect(overview).toContain("Star Entry");
        expect(overview).not.toContain("Production comps");

        const html = renderWith(warData, "/players/donk?view=style", undefined, styleData);
        expect(html).toContain("Style");
        expect(html).toContain("Star Entry");
        expect(html).toContain("Next closest");
        expect(html).toContain("Spacetaker");
        expect(html).toContain("Isolation: 12th percentile");
        expect(html).toContain("Firepower: 99th percentile");
        expect(html).not.toContain("Rating: 97th percentile");
        expect(html).toContain("Style bars compare non-AWPers only");
        expect(html).toContain("Production comps");
        expect(html).toContain("Style comps");
        expect(html).toContain('href="/players/apEX"');
        expect(html).toContain("Similarity is 100 minus the RMS percentile gap; a random pair scores about 59.");
        expect(html).not.toContain(">73<");
        expect(html).not.toContain("Profile");

        expect(renderWith(warData, "/players/apEX", undefined, styleData)).not.toContain("Archetype");
        expect(render("/players/donk")).not.toContain("Archetype");
        expect(renderWith(warData, "/players/apEX?view=style", undefined, styleData)).toContain("No style profile available for apEX.");
    });

    it("switches to the map tendencies view and omits overview sections", () => {
        const html = renderWith(warData, "/players/donk?view=maps");
        expect(html).not.toContain("Profile");
        expect(html).not.toContain("WAA breakdown");
    });

    it("renders live generated public/data/war/style.json", () => {
        const filePath = path.resolve(__dirname, "../../public/data/war/style.json");
        const playersPath = path.resolve(__dirname, "../../public/data/war/players.json");
        if (!fs.existsSync(filePath) || !fs.existsSync(playersPath)) return;
        const live = JSON.parse(fs.readFileSync(playersPath, "utf-8")) as PlayerWarData;
        const style = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StyleData;
        expect(renderWith(live, "/players/ZywOo", undefined, style)).toContain("Archetype");
        expect(renderWith(live, "/players/ZywOo?view=style", undefined, style)).toContain("Production comps");
        const byId = new Map(live.players.map((p) => [p.steamid, p]));
        const zywoo = live.players.find((p) => p.name === "ZywOo")!;
        const zywooStyle = style.players.find((p) => p.steamid === zywoo.steamid)!;
        expect(zywooStyle.comps.style.length).toBeGreaterThan(0);
        expect(zywooStyle.comps.style.every((c) => byId.get(c.steamid)?.tRole === "AWPer")).toBe(true);
    });

    it("matches names case-insensitively and reports unknown players", () => {
        expect(render("/players/DONK")).toContain("Profile");
        expect(render("/players/nobody")).toContain("No rated data for “nobody”");
    });
});
