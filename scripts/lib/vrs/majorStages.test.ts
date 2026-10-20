import { describe, expect, it } from "vitest";
import type { ValveEvent } from "./buildMatchdata.ts";
import { isSplitStagePage, splitMajorStages } from "./majorStages.ts";

const entry = (teamId: string, placement: number, prize: number) => ({
    teamId,
    placement,
    prize,
    clubShare: 0,
    qualifiedEvents: [],
});

describe("splitMajorStages", () => {
    const parent: ValveEvent = {
        eventId: "Major",
        eventName: "Major",
        prizePool: "$1,250,000",
        lan: true,
        finished: true,
        prizeDistribution: [entry("Out1", 25, 0), entry("Out2", 17, 10000), entry("Out2b", 17, 10000), entry("Champ", 1, 500000)],
    };
    const exits: Record<string, string> = { Out1: "Major/Stage_1", Out2: "Major/Stage_2", Out2b: "Major/Stage_2" };

    it("moves prizes to the exit stage, pools each stage's payout and links stages onward", () => {
        const [s1, s2, main] = splitMajorStages(
            parent,
            [
                { eventId: "Major/Stage_1", eventName: "Major: Stage 1", finished: true },
                { eventId: "Major/Stage_2", eventName: "Major: Stage 2", finished: true },
            ],
            (team) => exits[team] ?? null
        );

        expect(s1).toMatchObject({ eventId: "Major/Stage_1", prizePool: "$0", lan: true });
        expect(s1.prizeDistribution).toEqual([{ ...entry("Out1", 25, 0), qualifiedEvents: ["Major/Stage_2"] }]);
        expect(s2.prizePool).toBe("$20,000");
        expect(s2.prizeDistribution.map((p) => p.qualifiedEvents)).toEqual([["Major"], ["Major"]]);
        expect(main.prizePool).toBe("$1,230,000");
        expect(main.prizeDistribution.map((p) => p.teamId)).toEqual(["Champ"]);
    });

    it("splits only Stage 1 and Stage 2 pages", () => {
        expect(isSplitStagePage("PGL/2026/Singapore/Stage_1")).toBe(true);
        expect(isSplitStagePage("PGL/2026/Singapore/Stage_2")).toBe(true);
        expect(isSplitStagePage("PGL/2026/Singapore/Stage_3")).toBe(false);
        expect(isSplitStagePage("PGL/2026/Singapore/Playoffs")).toBe(false);
    });
});
