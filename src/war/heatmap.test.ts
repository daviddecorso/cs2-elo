import { describe, expect, it } from "vitest";
import {
    GRID_SIZE,
    colorizeDiverging,
    colorizeHeat,
    colorizeOverlay,
    decodeGrid,
    diffGrid,
    formatCallout,
    gaussianBlur,
    perRound,
} from "./heatmap.ts";

describe("heatmap math", () => {
    it("decodes delta-coded sparse grids", () => {
        const dense = decodeGrid({ max: 12, n: 18, cells: [0, 2, 15, 12, 64, 4] });
        expect(dense.length).toBe(GRID_SIZE * GRID_SIZE);
        expect(dense[0]).toBe(2);
        expect(dense[15]).toBe(12);
        expect(dense[79]).toBe(4);
        expect(dense[1]).toBe(0);

        const empty = decodeGrid(undefined);
        expect(empty.reduce((a, b) => a + b, 0)).toBe(0);
    });

    it("normalizes per round and handles zero denominator", () => {
        const raw = new Float32Array([0, 10, 25]);
        const norm = perRound(raw, 50);
        expect(norm[0]).toBeCloseTo(0);
        expect(norm[1]).toBeCloseTo(0.2);
        expect(norm[2]).toBeCloseTo(0.5);

        const zero = perRound(raw, 0);
        expect(Array.from(zero)).toEqual([0, 0, 0]);
    });

    it("applies symmetric separable Gaussian blur and preserves interior mass", () => {
        const size = 11;
        const grid = new Float32Array(size * size);
        const center = 5 * size + 5;
        grid[center] = 100;

        const blurred = gaussianBlur(grid, size, 1.0);
        const total = blurred.reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(100, 1);
        expect(blurred[center]).toBeLessThan(100);
        expect(blurred[center]).toBeGreaterThan(blurred[center + 1]);
        // 4-way symmetry around center
        expect(blurred[5 * size + 4]).toBeCloseTo(blurred[5 * size + 6], 5);
        expect(blurred[4 * size + 5]).toBeCloseTo(blurred[6 * size + 5], 5);
        expect(blurred[5 * size + 4]).toBeCloseTo(blurred[4 * size + 5], 5);
    });

    it("computes signed diff against baseline", () => {
        const player = new Float32Array([0.5, 0.1, 0.0]);
        const base = new Float32Array([0.2, 0.4, 0.0]);
        const diff = diffGrid(player, base);
        expect(diff[0]).toBeCloseTo(0.3);
        expect(diff[1]).toBeCloseTo(-0.3);
        expect(diff[2]).toBeCloseTo(0);
    });

    it("colorizes sequential heat, diverging diffs, and opening overlays to RGBA", () => {
        const heat = colorizeHeat(new Float32Array([0, 0.5, 1.0]));
        expect(heat.length).toBe(12);
        // Zero stays transparent
        expect(heat[3]).toBe(0);
        // Peak is bright and opaque
        expect(heat[8]).toBeGreaterThan(240);
        expect(heat[9]).toBeGreaterThan(240);
        expect(heat[11]).toBeGreaterThan(200);

        const div = colorizeDiverging(new Float32Array([-1, 0, 1]));
        // Negative is blue-dominant (B > R)
        expect(div[2]).toBeGreaterThan(div[0]);
        expect(div[3]).toBeGreaterThan(200);
        // Zero is transparent
        expect(div[7]).toBe(0);
        // Positive is warm orange/yellow (R > B)
        expect(div[8]).toBeGreaterThan(div[10]);
        expect(div[11]).toBeGreaterThan(200);

        const ov = colorizeOverlay(new Float32Array([1, 0]), new Float32Array([0, 1]));
        // First pixel is emerald-green (G > R), second is rose-red (R > G)
        expect(ov[1]).toBeGreaterThan(ov[0]);
        expect(ov[4]).toBeGreaterThan(ov[5]);
    });

    it("formats CS2 nav callout names", () => {
        expect(formatCallout("PalaceInterior")).toBe("Palace Interior");
        expect(formatCallout("TRamp")).toBe("T Ramp");
        expect(formatCallout("CTSpawn")).toBe("CT Spawn");
        expect(formatCallout("TopofMid")).toBe("Top of Mid");
        expect(formatCallout("BombsiteA")).toBe("Bombsite A");
    });
});
