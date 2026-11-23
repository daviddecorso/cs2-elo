import { describe, expect, it } from "vitest";
import { VetoInputs } from "./vetoInputs.ts";

const DAY = 86400;

const series = (t: number, pool: string, played: string, y: 0 | 1 = 1) => {
    const offsets = Object.fromEntries([...pool].map((m) => [m, 0]));
    return {
        t,
        lineages: [0, 1] as [number, number],
        ratings: [0, 0] as [number, number],
        poolOffsets: [offsets, offsets] as [Record<string, number>, Record<string, number>],
        maps: [...played].map((map) => ({ map, p: 0.5, y, margin: 3, ratings: [0, 0] as [number, number] })),
    };
};

describe("VetoInputs", () => {
    const inputs = () => new VetoInputs({ k: 5, tau: Infinity, playPrior: 10, playTau: 90 }, 400);

    // Same values as `test_play_decays_and_a_new_map_starts_neutral` in wp/tests/test_veto.py.
    it("decays play and starts a new pool map neutral", () => {
        const model = inputs();
        model.add(series(0, "abcdefg", "ab"));
        expect(model.team(0, ["h"], 30 * DAY).play[0]).toBe(0);
        model.add(series(90 * DAY, "abcdefh", "h"));
        const d = Math.exp(-1);
        const [a, h] = model.team(0, ["a", "h"], 90 * DAY).play;
        expect(a).toBeCloseTo((d - (2 / 7) * d - 1 / 7) / (d + 1 + 10), 12);
        expect(h).toBeCloseTo((1 - 1 / 7) / (1 + 10), 12);
        expect(model.team(0, ["g"], 180 * DAY).play[0]).toBeCloseTo((-(2 / 7) * d * d) / (d * d + 10), 12);
    });

    it("centres map strength on the pool and mirrors it between opponents", () => {
        const model = inputs();
        model.add(series(0, "abc", "a"));
        const a = model.team(0, ["a", "b", "c"], 0).u;
        expect(a[0]).toBeCloseTo((0.5 / 6) * (2 / 3), 12);
        expect(a.reduce((x, y) => x + y, 0)).toBeCloseTo(0, 12);
        model.team(1, ["a", "b", "c"], 0).u.forEach((v, i) => expect(v).toBeCloseTo(-a[i], 12));
    });

    it.each(["Dust 2", "Dust2"])("counts %s as Dust II", (spelling) => {
        const played = (map: string) => {
            const model = inputs();
            const s = series(0, "abc", "a");
            model.add({ ...s, maps: [{ ...s.maps[0], map }] });
            return model.team(0, ["Dust II", "b", "c"], 0);
        };
        expect(played(spelling)).toEqual(played("Dust II"));
    });
});
