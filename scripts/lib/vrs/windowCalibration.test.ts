import { describe, expect, it } from "vitest";
import { bestCoverage } from "./windowCalibration.ts";

describe("bestCoverage", () => {
    it("finds the range most intervals agree on and ignores outliers", () => {
        expect(
            bestCoverage([
                { lo: 0, hi: 10 },
                { lo: 5, hi: 15 },
                { lo: 8, hi: 20 },
                { lo: 100, hi: 110 },
            ])
        ).toEqual({ lo: 8, hi: 10, count: 3 });
    });

    it("counts intervals that only touch as overlapping", () => {
        expect(
            bestCoverage([
                { lo: 0, hi: 5 },
                { lo: 5, hi: 9 },
            ])
        ).toEqual({ lo: 5, hi: 5, count: 2 });
    });
});
