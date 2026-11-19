import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TeamPage } from "./TeamPage.tsx";
import { eloData, tactics, teamDuels, teamStats, warPlayers } from "../test/teamFixtures.ts";
import type { EventOdds, InviteOdds } from "../sim/types.ts";

const event: EventOdds = {
    slug: "iem-test-2026",
    name: "IEM Test 2026",
    liquipedia: "IEM/Test",
    startDate: "2026-12-01",
    endDate: "2026-12-07",
    generatedAt: "2026-11-14T00:00:00Z",
    asOf: "2026-11-13",
    n: 10000,
    stages: [{ id: "playoffs", name: "Playoffs" }],
    placements: ["1", "2", "3-4"],
    prizes: null,
    playedMatches: 0,
    teams: [{ team: "Team Vitality", rating: 1950, reach: { playoffs: 0.81 }, placements: { "1": 0.34, "2": 0.2, "3-4": 0.27 } }],
};

const invite: InviteOdds = {
    slug: "test-major-2027",
    name: "Test Major 2027",
    liquipedia: "Test/Major",
    snapshotDate: "2027-04-05",
    snapshotEstimated: true,
    generatedAt: "2026-11-14T00:00:00Z",
    asOf: "2026-11-13",
    n: 10000,
    events: [],
    slots: {
        stage3: { Europe: 8, Americas: 4, Asia: 4 },
        stage2: { Europe: 8, Americas: 4, Asia: 4 },
        stage1: { Europe: 8, Americas: 4, Asia: 4 },
        source: "test",
        verified: false,
    },
    rosters: [
        {
            rosterKey: "apex,zywoo",
            teamName: "Vitality",
            region: "Europe",
            players: ["ZywOo", "apEX"],
            stage3: 0.92,
            stage2: 0.08,
            stage1: 0,
            miss: 0,
            rank: { p10: 1, p50: 1, p90: 2 },
            intact: true,
        },
    ],
};

const render = (url: string) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["elo", "latest"], eloData);
    queryClient.setQueryData(["war", "team-duels"], teamDuels);
    queryClient.setQueryData(["war", "team-stats"], teamStats);
    queryClient.setQueryData(["war", "tactics"], tactics);
    queryClient.setQueryData(["war", "players"], warPlayers);
    queryClient.setQueryData(["sim", "events"], [{ slug: event.slug, name: event.name, startDate: event.startDate, endDate: event.endDate }]);
    queryClient.setQueryData(["sim", "event", event.slug], event);
    queryClient.setQueryData(["sim", "invites"], [{ slug: invite.slug, name: invite.name, snapshotDate: invite.snapshotDate }]);
    queryClient.setQueryData(["sim", "invites", invite.slug], invite);
    queryClient.setQueryData(["sim", "plan", "index"], {
        generatedAt: "",
        teams: [{ team: "Team Vitality", teamName: "Team Vitality", file: "Team_Vitality.json", asOf: "", target: { slug: "", name: "", date: "", estimated: false }, generatedAt: "" }],
    });
    return renderToString(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[url]}>
                <Routes>
                    <Route path="/teams/:team" element={<TeamPage />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>
    );
};

describe("TeamPage", () => {
    it("gathers rosters, event and invite odds, stints and players for one team", () => {
        const html = render("/teams/Team_Vitality");
        expect(html).toContain("Team Vitality");
        expect(html).toContain("Elo #1 (1950)");
        expect(html).toContain("VRS #1 (2000 pts)");
        expect(html).toContain("ZywOo");
        expect(html).toContain("+12");
        expect(html).toContain("IEM Test 2026");
        expect(html).toContain("81%");
        expect(html).toContain("34%");
        expect(html).toContain("Test Major 2027");
        expect(html).toContain("92%");
        expect(html).toContain("RW over econ");
        expect(html).toContain("+7.19");
        expect(html).toContain("Post-plant T");
        expect(html).toContain("+6.60");
        expect(html).toContain("+3.21");
        expect(html).toContain("IGL");
        expect(html).not.toContain("FURIA");
        expect(html).not.toContain("donk");
        expect(html).toContain("https://liquipedia.net/counterstrike/Team_Vitality");
        expect(html).toContain('href="/vrs-sim?view=plan&amp;team=Team_Vitality"');
    });

    it("omits sections the team has no data for", () => {
        const html = render("/teams/Team_Spirit");
        expect(html).not.toContain("Major invite plan");
        expect(html).toContain("Execution");
        expect(html).not.toContain("RW over econ");
        expect(html).not.toContain("IEM Test 2026");
        expect(html).not.toContain("Test Major 2027");
    });

    it("shows an empty state for an unknown team", () => {
        expect(render("/teams/Nobody")).toContain("No rated data for “Nobody”");
    });

    it("renders live generated public data for a team with several rosters and one with stints only", () => {
        const read = (file: string) => {
            const p = path.resolve(__dirname, "../../public/data", file);
            return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : undefined;
        };
        const elo = read("elo/latest.json");
        if (!elo) return;
        const renderLive = (url: string) => {
            const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
            queryClient.setQueryData(["elo", "latest"], elo);
            queryClient.setQueryData(["war", "team-duels"], read("war/team-duels.json") ?? null);
            queryClient.setQueryData(["war", "team-stats"], read("war/team-stats.json") ?? null);
            queryClient.setQueryData(["war", "tactics"], read("war/tactics.json") ?? null);
            queryClient.setQueryData(["war", "players"], read("war/players.json"));
            queryClient.setQueryData(["sim", "events"], []);
            queryClient.setQueryData(["sim", "invites"], []);
            return renderToString(
                <QueryClientProvider client={queryClient}>
                    <MemoryRouter initialEntries={[url]}>
                        <Routes>
                            <Route path="/teams/:team" element={<TeamPage />} />
                        </Routes>
                    </MemoryRouter>
                </QueryClientProvider>
            );
        };
        expect(renderLive("/teams/OG")).toContain("Elo rosters");
        const falcons = renderLive("/teams/Team_Falcons");
        expect(falcons).toContain("Team Falcons");
        expect(falcons).not.toContain("No rated data");
    });
});
