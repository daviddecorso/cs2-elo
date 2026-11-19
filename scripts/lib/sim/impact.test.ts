import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Matchdata } from "../vrs/buildMatchdata.ts";
import { freeze } from "../vrs/oneTeam.ts";
import { loadWorld, rerun } from "../vrs/valveWorld.ts";
import { eventImpact, impactCheckpoint, mergeImpact, tallyImpact, type ImpactTally } from "./impact.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "fixtures/matchdata.synthetic.json"), "utf8")) as Matchdata;

describe("impactCheckpoint", () => {
    const dates = ["2026-12-07", "2027-01-04", "2027-02-01"];
    it("picks the first checkpoint after the end date", () => {
        expect(impactCheckpoint(dates, "2026-12-06")).toBe(0);
        expect(impactCheckpoint(dates, "2026-12-07")).toBe(1);
        expect(impactCheckpoint(dates, "2027-01-20")).toBe(2);
    });
    it("is null for an event ending after the last checkpoint", () => {
        expect(impactCheckpoint(dates, "2027-02-01")).toBeNull();
    });
});

describe("eventImpact", () => {
    const { state } = rerun(loadWorld(fixture.matches, fixture.events, "2026-10-20", { windowEndsAtPull: true }));
    const world = freeze(state);
    const roster = state.teams.indexOf(state.ranked[2]);
    const eventIds = new Set(world.ledgers[roster].matches.map((m) => m.eventId));
    const someEvent = new Set([[...eventIds][0]]);

    it("is zero for an event the roster didn't play", () => {
        const [s] = eventImpact(world, new Set(["not-an-event"]), [{ team: "x", roster, placement: "1" }]);
        expect(s.delta).toBeCloseTo(0, 9);
        expect(s.start).toBeCloseTo(0, 9);
    });

    it("is nonzero for an event the roster played", () => {
        const [s] = eventImpact(world, someEvent, [{ team: "x", roster, placement: "1" }]);
        expect(s.delta).not.toBeCloseTo(0, 3);
    });
});

describe("tallyImpact and mergeImpact", () => {
    const samples = [
        { team: "A", placement: "1", delta: 30, start: 10 },
        { team: "B", placement: "2", delta: -5, start: 1 },
    ];
    it("merging one-run tallies matches tallying in sequence", () => {
        const sequential: ImpactTally = new Map();
        tallyImpact(sequential, "cup", samples);
        tallyImpact(sequential, "cup", samples.slice(0, 1));

        const merged: ImpactTally = new Map();
        for (const part of [samples, samples.slice(0, 1)]) {
            const one: ImpactTally = new Map();
            tallyImpact(one, "cup", part);
            mergeImpact(merged, one);
        }
        expect(merged).toEqual(sequential);
        expect(merged.get("cup")!.get("A")!.get("1")).toEqual({ count: 2, sumDelta: 60, sumStart: 20 });
    });
});
