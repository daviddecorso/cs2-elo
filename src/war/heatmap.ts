import type { GrenadeType, SparseGrid } from "./heatmapTypes.ts";

export const GRID_SIZE = 64;

export const GRENADE_COLOR: Record<GrenadeType, string> = {
    smoke: "#e4e4e7",
    flash: "#fde047",
    he: "#f87171",
    molotov: "#fb923c",
};

/** Decode delta-coded sparse grid into a dense row-major Float32Array of length `size * size`. */
export const decodeGrid = (grid: SparseGrid | undefined, size = GRID_SIZE): Float32Array => {
    const out = new Float32Array(size * size);
    if (!grid?.cells?.length) return out;
    let idx = 0;
    const { cells } = grid;
    for (let i = 0; i < cells.length; i += 2) {
        idx += cells[i];
        if (idx >= 0 && idx < out.length) {
            out[idx] = cells[i + 1];
        }
    }
    return out;
};

/** Divide every cell by `denom` (rounds for a player grid, or `scale` for an average baseline). */
export const perRound = (grid: Float32Array, denom: number): Float32Array => {
    const out = new Float32Array(grid.length);
    if (denom <= 0) return out;
    const inv = 1 / denom;
    for (let i = 0; i < grid.length; i++) {
        out[i] = grid[i] * inv;
    }
    return out;
};

const gaussianKernel = (sigma: number): Float32Array => {
    const radius = Math.max(1, Math.ceil(3 * sigma));
    const kernel = new Float32Array(radius * 2 + 1);
    const inv2s2 = 1 / (2 * sigma * sigma);
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
        const w = Math.exp(-k * k * inv2s2);
        kernel[k + radius] = w;
        sum += w;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    return kernel;
};

/** Separable 2D Gaussian blur (zero-padded outside radar bounds). */
export const gaussianBlur = (grid: Float32Array, size = GRID_SIZE, sigma = 1.0): Float32Array => {
    if (sigma <= 0) return new Float32Array(grid);
    const kernel = gaussianKernel(sigma);
    const radius = (kernel.length - 1) >> 1;
    const tmp = new Float32Array(size * size);
    const out = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
        const row = y * size;
        for (let x = 0; x < size; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const nx = x + k;
                if (nx >= 0 && nx < size) acc += grid[row + nx] * kernel[k + radius];
            }
            tmp[row + x] = acc;
        }
    }

    for (let y = 0; y < size; y++) {
        const row = y * size;
        for (let x = 0; x < size; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const ny = y + k;
                if (ny >= 0 && ny < size) acc += tmp[ny * size + x] * kernel[k + radius];
            }
            out[row + x] = acc;
        }
    }
    return out;
};

/** Elementwise difference `player - baseline`. */
export const diffGrid = (player: Float32Array, baseline: Float32Array): Float32Array => {
    const out = new Float32Array(player.length);
    for (let i = 0; i < player.length; i++) {
        out[i] = player[i] - (baseline[i] ?? 0);
    }
    return out;
};

type Rgb = readonly [number, number, number];

// Perceptually uniform sequential ramp (Inferno-inspired) for high contrast on dark charcoal radars.
const HEAT_STOPS: ReadonlyArray<{ t: number; rgb: Rgb }> = [
    { t: 0.0, rgb: [38, 16, 92] },
    { t: 0.25, rgb: [122, 28, 114] },
    { t: 0.5, rgb: [212, 66, 66] },
    { t: 0.78, rgb: [249, 155, 30] },
    { t: 1.0, rgb: [252, 255, 168] },
];

// Colorblind-safe diverging ramp: blue (below avg) <-> transparent (avg) <-> orange-amber (above avg).
const NEG_STOPS: ReadonlyArray<{ t: number; rgb: Rgb }> = [
    { t: 0.0, rgb: [37, 99, 235] },
    { t: 0.55, rgb: [56, 189, 248] },
    { t: 1.0, rgb: [186, 230, 253] },
];

const POS_STOPS: ReadonlyArray<{ t: number; rgb: Rgb }> = [
    { t: 0.0, rgb: [234, 88, 12] },
    { t: 0.55, rgb: [251, 146, 60] },
    { t: 1.0, rgb: [254, 240, 138] },
];

const sampleRamp = (stops: ReadonlyArray<{ t: number; rgb: Rgb }>, t: number): Rgb => {
    const c = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) {
        if (c <= stops[i].t) {
            const a = stops[i - 1];
            const b = stops[i];
            const f = (c - a.t) / (b.t - a.t);
            return [
                Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
                Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
                Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
            ];
        }
    }
    return stops[stops.length - 1].rgb;
};

/** Map non-negative intensities to RGBA bytes (alpha 0 below noise floor so radar geometry stays crisp). */
export const colorizeHeat = (values: Float32Array, maxVal?: number): Uint8ClampedArray => {
    const rgba = new Uint8ClampedArray(values.length * 4);
    let peak = maxVal ?? 0;
    if (maxVal === undefined) {
        for (let i = 0; i < values.length; i++) {
            if (values[i] > peak) peak = values[i];
        }
    }
    if (peak <= 0) return rgba;

    const inv = 1 / peak;
    for (let i = 0; i < values.length; i++) {
        const t = Math.min(1, Math.max(0, values[i] * inv));
        if (t < 0.03) continue;
        const [r, g, b] = sampleRamp(HEAT_STOPS, t);
        const alpha = Math.round(Math.pow(t, 0.72) * 226);
        const o = i * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = alpha;
    }
    return rgba;
};

/** Map signed differences to RGBA bytes using the blue-orange diverging ramp. */
export const colorizeDiverging = (diff: Float32Array, maxAbs?: number): Uint8ClampedArray => {
    const rgba = new Uint8ClampedArray(diff.length * 4);
    let peak = maxAbs ?? 0;
    if (maxAbs === undefined) {
        for (let i = 0; i < diff.length; i++) {
            const a = Math.abs(diff[i]);
            if (a > peak) peak = a;
        }
    }
    if (peak <= 0) return rgba;

    const inv = 1 / peak;
    for (let i = 0; i < diff.length; i++) {
        const v = diff[i] * inv;
        const mag = Math.min(1, Math.abs(v));
        if (mag < 0.04) continue;
        const [r, g, b] = sampleRamp(v >= 0 ? POS_STOPS : NEG_STOPS, mag);
        const alpha = Math.round(Math.pow(mag, 0.75) * 224);
        const o = i * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = alpha;
    }
    return rgba;
};

/** Composite two non-negative layers (e.g. opening kills in teal-green and opening deaths in rose-red). */
export const colorizeOverlay = (
    kills: Float32Array,
    deaths: Float32Array,
    maxVal?: number
): Uint8ClampedArray => {
    const rgba = new Uint8ClampedArray(kills.length * 4);
    let peak = maxVal ?? 0;
    if (maxVal === undefined) {
        for (let i = 0; i < kills.length; i++) {
            if (kills[i] > peak) peak = kills[i];
            if (deaths[i] > peak) peak = deaths[i];
        }
    }
    if (peak <= 0) return rgba;

    const inv = 1 / peak;
    for (let i = 0; i < kills.length; i++) {
        const tk = Math.min(1, Math.max(0, kills[i] * inv));
        const td = Math.min(1, Math.max(0, deaths[i] * inv));
        const mag = Math.max(tk, td);
        if (mag < 0.04) continue;
        const sum = tk + td;
        const wk = tk / sum;
        const wd = td / sum;
        // Emerald (#22c55e -> #86efac) vs Rose (#f43f5e -> #fda4af)
        const kr = 34 + 100 * tk;
        const kg = 197 + 42 * tk;
        const kb = 94 + 78 * tk;
        const dr = 244 + 9 * td;
        const dg = 63 + 101 * td;
        const db = 94 + 81 * td;
        const o = i * 4;
        rgba[o] = Math.round(kr * wk + dr * wd);
        rgba[o + 1] = Math.round(kg * wk + dg * wd);
        rgba[o + 2] = Math.round(kb * wk + db * wd);
        rgba[o + 3] = Math.round(Math.pow(mag, 0.72) * 230);
    }
    return rgba;
};

const MAP_LABELS: Record<string, string> = {
    dust2: "Dust2",
    mirage: "Mirage",
    inferno: "Inferno",
    nuke: "Nuke",
    ancient: "Ancient",
    anubis: "Anubis",
    overpass: "Overpass",
    train: "Train",
    vertigo: "Vertigo",
    cache: "Cache",
};

export const formatMapName = (slug: string): string =>
    MAP_LABELS[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);

/** Split CS2 nav callouts like `PalaceInterior` or `TopofMid` into readable labels. */
export const formatCallout = (raw: string): string =>
    raw
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/^(CT|T)([A-Z][a-z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/\bTopof\b/g, "Top of")
        .replace(/\bBackof\b/g, "Back of")
        .replace(/\bSideof\b/g, "Side of")
        .trim();
