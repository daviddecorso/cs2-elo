import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeStandings, getSnapshotWindow } from "./valveModel.ts";

describe("valveModel", () => {
    const fixturePath = path.resolve(process.cwd(), "fixtures/matchdata.synthetic.json");
    const rawFixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

    it("gives deep-equal output twice on the same inputs, and inputs are not mutated", () => {
        const matchesOriginal = JSON.parse(JSON.stringify(rawFixture.matches));
        const eventsOriginal = JSON.parse(JSON.stringify(rawFixture.events));

        const matchesInput = JSON.parse(JSON.stringify(rawFixture.matches));
        const eventsInput = JSON.parse(JSON.stringify(rawFixture.events));

        const res1 = computeStandings(matchesInput, eventsInput, "2026-10-05");
        const res2 = computeStandings(matchesInput, eventsInput, "2026-10-05");

        expect(res1.rosters).toEqual(res2.rosters);
        expect(matchesInput).toEqual(matchesOriginal);
        expect(eventsInput).toEqual(eventsOriginal);
    });

    it("changes output when a fake match is appended", () => {
        const matches = JSON.parse(JSON.stringify(rawFixture.matches));
        const events = JSON.parse(JSON.stringify(rawFixture.events));

        const base = computeStandings(matches, events, "2026-10-05");

        // Clone and append a match between top teams just before cutoff
        const fakeMatch = {
            ...matches[0],
            matchStartTime: 1791100000,
            winningTeam: matches[0].winningTeam === 1 ? 2 : 1,
        };
        const modifiedMatches = [...matches, fakeMatch];

        const updated = computeStandings(modifiedMatches, events, "2026-10-05");
        expect(updated.rosters).not.toEqual(base.rosters);
    });

    it("throws when snapshotDate is missing or malformed", () => {
        const matches = rawFixture.matches;
        const events = rawFixture.events;

        expect(() => computeStandings(matches, events, "")).toThrow(/snapshotDate must be YYYY-MM-DD/);
        expect(() => computeStandings(matches, events, "invalid")).toThrow(/snapshotDate must be YYYY-MM-DD/);
        expect(() => computeStandings(matches, events, "2026_10_05")).toThrow(/snapshotDate must be YYYY-MM-DD/);
        expect(() => computeStandings(matches, events, "2026/10/05")).toThrow(/snapshotDate must be YYYY-MM-DD/);
        expect(() => computeStandings(matches, events, "2026-02-31")).toThrow(/Invalid calendar date/);
        expect(() => computeStandings(matches, events, "2026-04-31")).toThrow(/Invalid calendar date/);
        expect(() => computeStandings(matches, events, "2026-13-01")).toThrow(/Invalid calendar date/);
    });

    it("changes output when snapshot date changes", () => {
        const matches = rawFixture.matches;
        const events = rawFixture.events;

        const late = computeStandings(matches, events, "2026-10-05");
        const early = computeStandings(matches, events, "2026-06-01");

        expect(early.rosters).not.toEqual(late.rosters);
    });

    it("derives finished: false for events with endDate after snapshotDate", () => {
        const matches = JSON.parse(JSON.stringify(rawFixture.matches));
        const events = JSON.parse(JSON.stringify(rawFixture.events));

        // Mark event 101 as having an endDate after the snapshot
        events[0].endDate = "2026-10-10";
        events[0].finished = true;

        const beforeEnd = computeStandings(matches, events, "2026-10-05");
        const afterEnd = computeStandings(matches, events, "2026-10-15");

        expect(beforeEnd.rosters).not.toEqual(afterEnd.rosters);
        expect(events[0].finished).toBe(true);
    });

    it("uses the calibrated window end for published snapshots and 07:00 LA otherwise", () => {
        expect(getSnapshotWindow("2026-10-05")).toEqual({
            pullTime: 1791208800,
            versionTimestamp: 1791208800,
        });
        expect(getSnapshotWindow("2026-11-02")).toEqual({
            pullTime: Date.UTC(2026, 10, 2, 15) / 1000,
            versionTimestamp: -1,
        });
    });

    it("treats an event with a match after the data pull as unfinished", () => {
        const matches = JSON.parse(JSON.stringify(rawFixture.matches));
        const events = JSON.parse(JSON.stringify(rawFixture.events));
        const lateMatch = { ...matches[0], matchStartTime: Date.UTC(2026, 9, 4, 20) / 1000 };

        const base = computeStandings(matches, events, "2026-10-04");
        const withLate = computeStandings([...matches, lateMatch], events, "2026-10-04");

        const markedUnfinished = events.map((e: { eventId: unknown }) =>
            e.eventId === lateMatch.eventId ? { ...e, finished: false } : e
        );
        expect(withLate.rosters).not.toEqual(base.rosters);
        expect(computeStandings(matches, markedUnfinished, "2026-10-04").rosters).toEqual(withLate.rosters);
    });
});
