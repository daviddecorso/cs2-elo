import { describe, expect, it } from "vitest";
import type { Region, Roster } from "../../../src/vrs/types.ts";
import { bandOf, fitFieldModel } from "./fieldModel.ts";
import type { PastAttendee, PastEdition } from "./history.ts";
import { seriesKey } from "./series.ts";

const roster = (globalRank: number, region: Region = "Europe", regionalRank = globalRank): Roster => ({
    rosterKey: `r${globalRank}`,
    teamName: `R${globalRank}`,
    region,
    regionalRank,
    globalRank,
    points: 2000 - globalRank,
    factors: { bountyOffered: 0, bountyCollected: 0, opponentNetwork: 0, lanFactor: 0 },
    startingValue: 0,
    h2hAdjustment: 0,
    players: [],
});
const LIST_DATE = "2026-01-05";
const lists = [{ date: LIST_DATE, rosters: Array.from({ length: 200 }, (_, i) => roster(i + 1)) }];

const attendee = (globalRank: number | null, extra: Partial<PastAttendee> = {}): PastAttendee => ({
    teamId: `t${globalRank}`,
    globalRank,
    regionalRank: globalRank,
    region: "Europe",
    ...extra,
});
const edition = (page: string, startDate: string, attendees: PastAttendee[], extra: Partial<PastEdition> = {}): PastEdition => ({
    page,
    name: page,
    series: seriesKey(page),
    kind: "online",
    role: "main",
    tier: 3,
    publisherTier: "Tier 2",
    category: "online",
    region: "Europe",
    prizePool: 20000,
    teams: attendees.length,
    startDate,
    endDate: startDate,
    listDate: LIST_DATE,
    attendees,
    labeled: attendees.some((a) => a.label),
    ...extra,
});
const event = (page: string) => ({ page, name: page, category: "online" as const, region: "Europe" as const, prizePool: 20000, publisherTier: "Tier 2", startDate: "2026-03-01" });

describe("bandOf", () => {
    it("puts unranked teams and those past rank 250 in the last band", () => {
        expect(bandOf(1)).toBe(0);
        expect(bandOf(10)).toBe(0);
        expect(bandOf(11)).toBe(1);
        expect(bandOf(251)).toBe(bandOf(null));
    });
});

describe("fitFieldModel", () => {
    // A series of mid-table teams, and another category of top teams the fallback could otherwise drift toward.
    const cup = Array.from({ length: 6 }, (_, k) =>
        edition(`Cup/Season_${k + 1}`, `2026-01-${String(10 + k).padStart(2, "0")}`, [70, 75, 80, 85, 90, 95, 101, 110].map((r) => attendee(r)))
    );
    const lan = edition("Big/2026", "2026-01-20", [1, 2, 3, 4].map((r) => attendee(r)), { kind: "lan", category: "lan1", tier: 1, publisherTier: "Tier 1", prizePool: 1e6 });
    const model = fitFieldModel([...cup, lan], lists, { asOf: "2026-02-01" });

    it("learns a series' bands, and leans on the series over its category", () => {
        const m = model.forEvent(event("Cup/Season_7"), 8);
        const mid = m.open[bandOf(80)] + m.open[bandOf(101)];
        expect(mid).toBeGreaterThan(0.8);
        expect(m.seriesWeight).toBeGreaterThan(40);
        expect(model.forEvent(event("Other/Thing"), 8).seriesWeight).toBe(0);
    });

    it("shrinks a new event toward its category, not toward events of another category", () => {
        const m = model.forEvent(event("Other/Thing"), 8);
        expect(m.open[bandOf(1)]).toBeLessThan(0.1);
        expect(m.open[bandOf(80)]).toBeGreaterThan(m.open[bandOf(1)]);
    });

    it("takes a series' region from its attendees when its pages don't say", () => {
        const regionless = cup.map((e) => ({ ...e, region: null }));
        const m = fitFieldModel(regionless, lists, { asOf: "2026-02-01" });
        expect(m.seriesRegion("Cup/Season_9")).toBe("Europe");
        expect(m.forEvent({ ...event("Cup/Season_9"), region: null }, 8).region).toBe("Europe");
    });

    it("learns acceptance from who took a VRS invite and who above them didn't", () => {
        // Each edition invites from the Europe list down to rank 60; ranks 13–35 never come, 36–60 always do.
        const vrs = (r: number) => attendee(r, { label: "vrs", vrs: { list: "Europe", month: "2026-01" } });
        const invited = Array.from({ length: 4 }, (_, k) =>
            edition(`Inv/Series_${k + 1}`, `2026-01-${String(10 + k).padStart(2, "0")}`, Array.from({ length: 25 }, (_, i) => vrs(36 + i)))
        );
        const m = fitFieldModel(invited, lists, { asOf: "2026-02-01" }).forEvent(event("Inv/Series_5"), 25);
        expect(m.acceptance[bandOf(25)]).toBeLessThan(0.1);
        expect(m.acceptance[bandOf(50)]).toBeGreaterThan(0.9);
        // Ranks 1–12 can't be invited to a Valve Tier 2 event, so they teach nothing.
        expect(m.acceptance[bandOf(5)]).toBeCloseTo(0.5, 1);
        expect(m.learnedRule).toEqual({ slots: [{ list: "Europe", month: "2026-03", count: 25 }], qualifiers: [], verified: false });
    });

    it("sizes the learned slot mix to the event and keeps its qualifier share", () => {
        const mixed = edition("Mix/1", "2026-01-12", [
            ...Array.from({ length: 6 }, (_, i) => attendee(30 + i, { label: "vrs", vrs: { list: "Europe", month: null } })),
            attendee(150, { label: "qualifier" }),
            attendee(160, { label: "qualifier" }),
        ]);
        const rule = fitFieldModel([mixed], lists, { asOf: "2026-02-01" }).forEvent(event("Mix/2"), 16).learnedRule!;
        expect(rule.slots).toEqual([{ list: "Europe", month: "2026-03", count: 12 }]);
        expect(rule.qualifiers).toEqual([{ label: "Qualifier", count: 4 }]);
    });
});
