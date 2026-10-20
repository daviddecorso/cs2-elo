import { describe, expect, it } from "vitest";
import { mergeRows, planFetchRanges, type StoreMeta } from "./rawStore.ts";

const window = { from: "2026-04-13", to: "2026-10-20" };
const meta: StoreMeta = { from: "2026-04-12", to: "2026-10-19", lastFullRefresh: "2026-10-17" };

describe("planFetchRanges", () => {
    it("refetches the whole window with no store", () => {
        expect(planFetchRanges(window, null, "2026-10-20")).toEqual({ ranges: [window], full: true });
    });

    it("refetches the whole window once the last full refresh is a week old", () => {
        const old = { ...meta, lastFullRefresh: "2026-10-13" };
        expect(planFetchRanges(window, old, "2026-10-20").full).toBe(true);
    });

    it("refetches only the hot tail on a nightly run", () => {
        expect(planFetchRanges(window, meta, "2026-10-20")).toEqual({
            ranges: [{ from: "2026-10-06", to: "2026-10-20" }],
            full: false,
        });
    });

    it("reaches back to the stored end when the store is older than the hot window", () => {
        const behind = { ...meta, to: "2026-09-30" };
        expect(planFetchRanges(window, behind, "2026-10-20").ranges).toEqual([
            { from: "2026-10-01", to: "2026-10-20" },
        ]);
    });

    it("adds the missing range when the window extends backward", () => {
        const wider = { from: "2026-01-01", to: "2026-10-20" };
        expect(planFetchRanges(wider, meta, "2026-10-20").ranges).toEqual([
            { from: "2026-01-01", to: "2026-04-11" },
            { from: "2026-10-06", to: "2026-10-20" },
        ]);
    });
});

describe("mergeRows", () => {
    const row = (match2id: string, date: string, winner = "1") => ({ pagename: "E", match2id, date, winner });

    it("replaces stored rows inside fetched ranges and keeps the rest", () => {
        const stored = [row("a", "2026-10-01 10:00:00"), row("b", "2026-10-10 10:00:00"), row("gone", "2026-10-11 10:00:00")];
        const fetched = [{ range: { from: "2026-10-06", to: "2026-10-20" }, rows: [row("b", "2026-10-10 10:00:00", "2")] }];
        expect(mergeRows(stored, fetched, window)).toEqual([row("a", "2026-10-01 10:00:00"), row("b", "2026-10-10 10:00:00", "2")]);
    });

    it("trims rows outside the window", () => {
        const stored = [row("old", "2026-04-01 10:00:00"), row("a", "2026-05-01 10:00:00")];
        expect(mergeRows(stored, [], window)).toEqual([row("a", "2026-05-01 10:00:00")]);
    });
});
