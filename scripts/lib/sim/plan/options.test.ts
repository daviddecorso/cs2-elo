import { describe, expect, it } from "vitest";
import type { EventKind } from "../../../../src/sim/schedule.ts";
import type { SeasonEvent } from "../season.ts";
import { buildOptions, feasible } from "./options.ts";

const AS_OF = "2027-01-01";
const date = (d: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

const event = (slug: string, start: number, days: number, opts: { kind?: EventKind; announced?: string[]; teams?: number; feeds?: string } = {}): SeasonEvent =>
    ({
        config: { slug, startDate: date(start), endDate: date(start + days - 1), stages: [] },
        stint: { startDate: date(start), endDate: date(start + days - 1), region: "Europe", kind: opts.kind ?? "lan" },
        field: { announced: opts.announced ?? [], teams: opts.teams ?? 8, region: null },
        fixed: false,
        ...(opts.feeds ? { feeds: { slug: opts.feeds, slotKey: "q", count: 1 } } : {}),
    }) as unknown as SeasonEvent;

const caps = { lan: 3, online: 3 };
const yes = () => true;

describe("buildOptions", () => {
    const events = [
        event("under-way", -2, 5, { announced: ["T"] }),
        event("announced", 10, 3, { announced: ["T"] }),
        event("open", 20, 3),
        event("main", 40, 3),
        event("main-q", 30, 2, { kind: "online", feeds: "main" }),
        event("full", 50, 3, { announced: ["A", "B"], teams: 2 }),
    ];
    const set = buildOptions(events, "T", "Europe", AS_OF, yes);

    it("locks announced events and commits under-way ones", () => {
        expect(set.locked).toEqual([1]);
        expect(set.committed).toEqual([0]);
    });

    it("gives an enterable fed event a place or invite-or-qualify, and no option for its feeder alone or a full field", () => {
        expect(set.options.map((o) => `${o.kind}:${events[o.event].config.slug}`)).toEqual(["event:open", "event:main", "inviteOrQualify:main"]);
        const q = set.options.find((o) => o.kind === "inviteOrQualify")!;
        expect(q.holds).toEqual([3, 4]);
        expect(q.counts).toEqual([3, 4]);
    });

    it("offers only qualifying where the team can't plausibly be invited", () => {
        const none = buildOptions(events, "T", "Europe", AS_OF, () => false);
        expect(none.options.map((o) => `${o.kind}:${events[o.event].config.slug}`)).toEqual(["qualify:main"]);
    });
});

describe("feasible", () => {
    const events = [event("a", 10, 3), event("b", 12, 3), event("c", 30, 3), event("m", 40, 3), event("m-q", 20, 2, { kind: "online", feeds: "m" })];
    const set = buildOptions(events, "T", "Europe", AS_OF, yes);
    const idx = (kind: string, slug: string) => set.options.findIndex((o) => o.kind === kind && events[o.event].config.slug === slug);

    it("rejects clashing LANs and options sharing an event", () => {
        expect(feasible(events, set, [idx("event", "a"), idx("event", "c")], caps)).toBe(true);
        expect(feasible(events, set, [idx("event", "a"), idx("event", "b")], caps)).toBe(false);
        expect(feasible(events, set, [idx("event", "m"), idx("inviteOrQualify", "m")], caps)).toBe(false);
    });

    it("counts a qualify option's main event and feeder against caps", () => {
        const q = idx("inviteOrQualify", "m");
        expect(feasible(events, set, [idx("event", "a"), idx("event", "c"), q], caps)).toBe(true);
        expect(feasible(events, set, [idx("event", "a"), idx("event", "c"), q], { lan: 2, online: 3 })).toBe(false);
        expect(feasible(events, set, [q], { lan: 3, online: 0 })).toBe(false);
    });

    it("reserves the main event's dates even though the team may not qualify", () => {
        const clash = [...events, event("x", 41, 3)];
        const s = buildOptions(clash, "T", "Europe", AS_OF, yes);
        const q = s.options.findIndex((o) => o.kind === "inviteOrQualify");
        const x = s.options.findIndex((o) => o.kind === "event" && clash[o.event].config.slug === "x");
        expect(feasible(clash, s, [q, x], caps)).toBe(false);
    });

    it("rejects a feeder held beyond the counted one when it clashes with another option", () => {
        const two = [event("m", 40, 3), event("q1", 20, 2, { feeds: "m" }), event("q2", 25, 2, { feeds: "m" }), event("y", 26, 2)];
        const s = buildOptions(two, "T", "Europe", AS_OF, yes);
        const q = s.options.findIndex((o) => o.kind === "inviteOrQualify");
        const y = s.options.findIndex((o) => o.kind === "event" && two[o.event].config.slug === "y");
        expect(s.options[q].counts).toEqual([0, 1]);
        expect(feasible(two, s, [q, y], { lan: 5, online: 5 })).toBe(false);
    });
});
