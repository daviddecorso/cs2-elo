export type Rng = () => number;

/** mulberry32: a seeded uniform [0, 1) generator, so runs are reproducible. */
export const makeRng = (seed: number): Rng => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/** Seed for run `run` of a seeded batch, so any one run can be regenerated alone. */
export const runSeed = (seed: number, run: number): number => {
    let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(run + 1, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
};

/** Seed for a named side stream of `seed`, so drawing from it never shifts the main stream. */
export const subSeed = (seed: number, key: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
    return runSeed(seed, h >>> 0);
};

export const normal =(rng: Rng): number => {
    const u = 1 - rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};

export const shuffle = <T>(items: T[], rng: Rng): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};
