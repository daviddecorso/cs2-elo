import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Standings } from "../../../src/vrs/types.ts";
import { applyDelta } from "../sim/vrsProjection.ts";
import type { Matchdata, ValveEvent, ValveMatch, ValvePlayer } from "./buildMatchdata.ts";
import { computeStandings } from "./valveModel.ts";
import { lineupKeepsLinks, loadWorld, rerun } from "./valveWorld.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "fixtures/matchdata.synthetic.json"), "utf8")) as Matchdata;
const DATE = "2026-10-20";
const day = 86400;
const lastMatch = Math.max(...fixture.matches.map((m) => m.matchStartTime));

const expectSame = (a: Standings, b: Standings) => {
    const strip = (s: Standings) => s.rosters;
    expect(strip(a)).toEqual(strip(b));
};

const full = (data: Matchdata, date = DATE) => computeStandings(data.matches, data.events, date, { windowEndsAtPull: true });

/** The fixture's last 12 matches replayed as a new LAN a few days after the last match. */
const replayDelta = (players?: (side: ValvePlayer[], i: number) => ValvePlayer[]): { matches: ValveMatch[]; events: ValveEvent[] } => {
    const source = [...fixture.matches].sort((a, b) => b.matchStartTime - a.matchStartTime).slice(0, 12);
    const matches = source.map((m, i) => ({
        ...m,
        eventId: "900",
        matchStartTime: lastMatch + 3 * day + i * 3600,
        team1Players: players ? players(m.team1Players, i) : m.team1Players,
    }));
    const teamIds = [...new Set(matches.flatMap((m) => [m.team1Id, m.team2Id]))];
    return {
        matches,
        events: [
            {
                eventId: "900",
                eventName: "Replayed Invitational",
                prizePool: "$300,000",
                lan: true,
                finished: true,
                endDate: "2026-10-12",
                prizeDistribution: teamIds.map((teamId, i) => ({ teamId, placement: i + 1, prize: Math.max(0, 100000 - i * 20000), clubShare: 0, qualifiedEvents: [] })),
            },
        ],
    };
};

describe("rerun", () => {
    it("matches the full model with no delta, with and without a fixed window", () => {
        expectSame(rerun(loadWorld(fixture.matches, fixture.events, DATE, { windowEndsAtPull: true })).standings, full(fixture));
        const calibrated = computeStandings(fixture.matches, fixture.events, "2026-10-05");
        expectSame(rerun(loadWorld(fixture.matches, fixture.events, "2026-10-05")).standings, calibrated);
    });

    it("matches the full model after adding an event, and again after the same world is reused", () => {
        const world = loadWorld(fixture.matches, fixture.events, DATE, { windowEndsAtPull: true });
        const delta = replayDelta();
        const result = rerun(world, delta);
        expect(result.exact).toBe(true);
        expectSame(result.standings, full(applyDelta(fixture, delta)));
        expectSame(rerun(world).standings, full(fixture));
    });

    it("matches the full model after excluding one roster's matches at an event", () => {
        const world = loadWorld(fixture.matches, fixture.events, DATE, { windowEndsAtPull: true });
        const target = fixture.matches.find((m) => m.eventId === "103")!.team1Id;
        const drop = (m: ValveMatch) => m.eventId === "103" && (m.team1Id === target || m.team2Id === target);
        const result = rerun(world, { excludeMatch: drop });
        expect(result.exact).toBe(true);
        expectSame(result.standings, full({ matches: fixture.matches.filter((m) => !drop(m)), events: fixture.events }));
    });

    it("brings back an in-progress event's played matches once a delta finishes it", () => {
        const base: Matchdata = { matches: fixture.matches, events: fixture.events.map((e) => (e.eventId === "105" ? { ...e, finished: false } : e)) };
        const world = loadWorld(base.matches, base.events, DATE, { windowEndsAtPull: true });
        const delta = { matches: [], events: [fixture.events.find((e) => e.eventId === "105")!] };
        const result = rerun(world, delta);
        expect(result.exact).toBe(true);
        expectSame(result.standings, full(applyDelta(base, delta)));
        expect(result.standings.rosters).not.toEqual(rerun(world).standings.rosters);
    });

    it("stays identical to the full model when delta lineups mix two rosters' players", () => {
        const pool = [...new Map(fixture.matches.flatMap((m) => [...m.team1Players, ...m.team2Players]).map((p) => [p.playerId, p])).values()];
        for (let k = 0; k < 8; k++) {
            const delta = replayDelta((side, i) => (i % 3 === 0 ? [...side.slice(0, 3), pool[(k * 7 + i) % pool.length], pool[(k * 11 + i + 50) % pool.length]] : side));
            if (delta.matches.some((m) => new Set(m.team1Players.map((p) => p.playerId)).size < 5)) continue;
            const result = rerun(loadWorld(fixture.matches, fixture.events, DATE, { windowEndsAtPull: true }), delta);
            if (result.exact) expectSame(result.standings, full(applyDelta(fixture, delta)));
        }
    });

    it("flags a new lineup that would split a roster's older matches off", () => {
        const newest = [...fixture.matches].sort((a, b) => b.matchStartTime - a.matchStartTime)[0];
        const core = newest.team1Players;
        const outsider = (id: string): ValvePlayer => ({ playerId: id, nick: `player_${id}`, countryIso: core[0].countryIso });
        // An older match with two stand-ins still links to the roster, through its first three players.
        const standIns: ValveMatch = { ...newest, matchStartTime: newest.matchStartTime - 20 * day, team1Players: [...core.slice(0, 3), outsider("9001"), outsider("9002")] };
        const base: Matchdata = { matches: [...fixture.matches, standIns], events: fixture.events };
        // The new lineup keeps only one of those three, so Valve would give the stand-in match its own roster.
        const delta = replayDelta((side, i) => (i === 0 ? [core[0], core[3], core[4], outsider("9003"), outsider("9004")] : side));
        delta.matches[0] = { ...delta.matches[0], team1Id: newest.team1Id, team1Name: newest.team1Name, matchStartTime: lastMatch + 8 * day };

        const world = loadWorld(base.matches, base.events, DATE, { windowEndsAtPull: true });
        const result = rerun(world, delta);
        expect(result.exact).toBe(false);
        expect(result.inexact).toContain("would link to");
        expect(result.standings.rosters).not.toEqual(full(applyDelta(base, delta)).rosters);
        expect(lineupKeepsLinks(world, delta.matches[0].team1Players)).toBe(false);
        expect(lineupKeepsLinks(world, core)).toBe(true);
    });
});

describe("lineupKeepsLinks", () => {
    it("passes every lineup of a delta that reruns exactly", () => {
        const world = loadWorld(fixture.matches, fixture.events, DATE, { windowEndsAtPull: true });
        const delta = replayDelta();
        expect(rerun(world, delta).exact).toBe(true);
        for (const m of delta.matches) for (const side of [m.team1Players, m.team2Players]) expect(lineupKeepsLinks(world, side)).toBe(true);
    });

    it("fails a lineup that shares 3 players with two rosters, since it would merge their matches", () => {
        const world = loadWorld(fixture.matches, fixture.events, DATE, { windowEndsAtPull: true });
        const newest = [...fixture.matches].sort((x, y) => y.matchStartTime - x.matchStartTime)[0];
        expect(lineupKeepsLinks(world, [...newest.team1Players.slice(0, 3), ...newest.team2Players.slice(0, 3)])).toBe(false);
    });
});
