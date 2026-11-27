import { describe, expect, it } from "vitest";
import { playerBreaks, seriesSinceBreak } from "./breaks.ts";
import type { SeriesPrediction } from "./engine.ts";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("playerBreaks", () => {
    it("keeps long summer and winter tier-1 LAN gaps only", () => {
        const lan = (iso: string, tier = 1) => ({ t: at(iso), tier, lan: true });
        const windows = playerBreaks([
            lan("2026-03-01"),
            lan("2026-04-10"),
            lan("2026-06-21"),
            { t: at("2026-07-10"), tier: 1, lan: false },
            lan("2026-07-15", 2),
            lan("2026-07-30"),
            lan("2026-08-05"),
        ]);
        expect(windows).toEqual([{ start: at("2026-06-21"), end: at("2026-07-30") }]);
    });
});

describe("seriesSinceBreak", () => {
    const window = { start: at("2026-06-21"), end: at("2026-07-30") };
    let seq = 0;
    const series = (iso: string, lineages: [number, number], idle: [number | null, number | null]) =>
        ({ id: `s${seq++}`, t: at(iso), lineages, sideIdleDays: idle }) as unknown as SeriesPrediction;

    it("counts series after a sat-out break and skips sides that kept playing", () => {
        const preds = [
            series("2026-07-01", [2, 3], [5, 5]),
            series("2026-07-20", [1, 2], [29, 19]),
            series("2026-07-31", [1, 3], [11, 30]),
            series("2026-09-15", [1, 3], [40, 40]),
        ];
        const since = seriesSinceBreak(preds, [window]);
        expect(since.get("s0")).toEqual([null, null]);
        expect(since.get("s1")).toEqual([0, null]);
        expect(since.get("s2")).toEqual([1, null]);
        expect(since.get("s3")).toEqual([null, null]);
    });

    it("needs the idle gap on the side's first series in the window", () => {
        const since = seriesSinceBreak([series("2026-07-25", [7, 8], [3, 20])], [window]);
        expect(since.get(`s${seq - 1}`)).toEqual([null, 0]);
    });
});
