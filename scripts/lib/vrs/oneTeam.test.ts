import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Matchdata } from "./buildMatchdata.ts";
import { freeze, scoreTeam, slimFrozen, withEvent, withoutEvents } from "./oneTeam.ts";
import { loadWorld, rerun } from "./valveWorld.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "fixtures/matchdata.synthetic.json"), "utf8")) as Matchdata;

const frozenFixture = () => {
    const { state } = rerun(loadWorld(fixture.matches, fixture.events, "2026-10-20", { windowEndsAtPull: true }));
    return { state, world: freeze(state) };
};

describe("scoreTeam", () => {
    it("reproduces every roster's points, starting value and global rank from an unchanged ledger", () => {
        const { state, world } = frozenFixture();
        state.teams.forEach((team, i) => {
            const score = scoreTeam(world, world.ledgers[i]);
            expect(score.points).toBeCloseTo(team.rankValue, 6);
            expect(score.seedRating).toBeCloseTo(team.rankValueSeed, 6);
            const ranked = team.satisfiesRankingCriteria && team.distinctTeamsDefeated > 0;
            expect(score.globalRank).toBe(ranked ? team.globalRank : null);
        });
    });

    it("scores the kept roster identically on a slimmed world, with an added event too", () => {
        const { state, world } = frozenFixture();
        const opponents = [0, 1, 2].map((k) => state.teams.indexOf(state.ranked[k]));
        const t = world.decayEnd + 10 * 86400;
        for (const k of [0, 3, 8]) {
            const roster = state.teams.indexOf(state.ranked[k]);
            const slim = slimFrozen(world, roster);
            const added = withEvent(world, world.ledgers[roster], {
                eventId: "added",
                lan: true,
                prizePool: 500000,
                lastMatchTime: t + 3 * 3600,
                prize: 50000,
                matches: opponents.filter((o) => o !== roster).map((opponent, j) => ({ t: t + j * 3600, opponent, won: j % 2 === 0 })),
            });
            for (const ledger of [world.ledgers[roster], added]) {
                expect(scoreTeam(slim, ledger, { rank: false })).toEqual(scoreTeam(world, ledger, { rank: false }));
            }
        }
    });

    it("scores more for winning an added event than for losing it, and removing it restores the original", () => {
        const { state, world } = frozenFixture();
        const roster = state.teams.indexOf(state.ranked[3]);
        const opponents = [0, 1, 2].map((k) => state.teams.indexOf(state.ranked[k]));
        const t = world.decayEnd + 10 * 86400;
        const event = (won: boolean) => ({
            eventId: "added",
            lan: true,
            prizePool: 500000,
            lastMatchTime: t + 3 * 3600,
            prize: won ? 200000 : 10000,
            matches: opponents.map((opponent, k) => ({ t: t + k * 3600, opponent, won })),
        });
        const base = scoreTeam(world, world.ledgers[roster]).points;
        const winning = withEvent(world, world.ledgers[roster], event(true));
        const losing = withEvent(world, world.ledgers[roster], event(false));
        expect(scoreTeam(world, winning).points).toBeGreaterThan(base);
        expect(scoreTeam(world, losing).points).toBeLessThan(scoreTeam(world, winning).points);
        expect(scoreTeam(world, withoutEvents(winning, new Set(["added"]))).points).toBeCloseTo(base, 9);
    });

    it("handles worlds with fewer than 5 rosters", () => {
        const base = frozenFixture().world;
        const keep = [0, 1].map((k) => base.seedHigh[k][1]);
        const remap = new Map(keep.map((r, i) => [r, i]));
        const small = {
            ...base,
            rosters: keep.map((r) => base.rosters[r]),
            ledgers: keep.map((r, i) => ({
                roster: i,
                events: base.ledgers[r].events,
                matches: base.ledgers[r].matches.filter((m) => remap.has(m.opponent)).map((m) => ({ ...m, opponent: remap.get(m.opponent)! })),
            })),
            winnings: { top: keep.map((r, i) => [base.rosters[r].scaledWinnings, i] as [number, number]).sort((a, b) => b[0] - a[0]) },
            opponents: { top: keep.map((r, i) => [base.rosters[r].distinctTeamsDefeated, i] as [number, number]).sort((a, b) => b[0] - a[0]) },
            lanWins: { top: keep.map((_, i) => [1, i] as [number, number]) },
            seedLow: keep.map((r, i) => [base.rosters[r].seedValue, i] as [number, number]).sort((a, b) => a[0] - b[0]),
            seedHigh: keep.map((r, i) => [base.rosters[r].seedValue, i] as [number, number]).sort((a, b) => b[0] - a[0]),
        };
        expect(Number.isFinite(scoreTeam(small, small.ledgers[0]).points)).toBe(true);
    });
});
