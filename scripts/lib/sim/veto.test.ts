import { describe, expect, it } from "vitest";
import { makeRng } from "./rng.ts";
import { VetoModel, type VetoModelFile } from "./veto.ts";

// Same fixture as `test_matches_the_simulator_fixture` in wp/tests/test_veto.py.
const file: VetoModelFile = {
    asOf: "2026-11-15",
    pool: ["m0", "m1", "m2", "m3", "m4", "m5", "m6"],
    actions: { "1": "bbbbbb", "3": "bbppbb", "5": "bbpppp" },
    orders: { "1": "FFSSSF", "3": "FSFSFS", "5": "FSFSFS" },
    modes: {
        hltv: { map: { du: 2.0, pick: 0.1, ban_rate: -0.4, pick_rate: 0.3 }, choice: { ban: { rate: 1.5, play: 0.8, edge: 1.2 }, pick: { rate: 1.5, play: 0.8, edge: 1.2 } } },
        liquipedia: { map: { du: 2.0 }, choice: { ban: { play: 0.8, edge: 1.2 }, pick: { play: 0.8, edge: 1.2 } } },
    },
    teams: {
        A: {
            u: [0.05, -0.02, 0.1, 0, -0.08, 0.03, 0.01],
            play: [0.3, -0.2, 0.1, -0.4, 0.2, 0, 0.05],
            ban: [-0.1, 0.3, -0.05, 0.4, -0.2, 0, 0.02],
            pick: [0.2, -0.1, 0.3, -0.2, 0, 0.05, -0.1],
        },
        B: {
            u: [-0.03, 0.06, -0.04, 0.02, 0.07, -0.01, 0],
            play: [-0.1, 0.25, 0, 0.3, -0.3, 0.1, 0],
            ban: [0.25, -0.1, 0.2, -0.15, 0, 0.05, -0.05],
            pick: [-0.1, 0.2, -0.2, 0.25, 0.1, 0, 0],
        },
    },
};

describe("VetoModel", () => {
    it("matches the Python model's exact series probability", () => {
        expect(new VetoModel(file, "hltv").probability("A", "B", 0.2, 3, 0.8, "FSFSSF")).toBeCloseTo(0.5596216069460083, 12);
        expect(new VetoModel(file, "liquipedia").probability("A", "B", -0.1, 1, 0.8)).toBeCloseTo(0.47812098580749307, 12);
    });

    it("plays the right maps for each format, with no repeats", () => {
        const model = new VetoModel(file, "hltv");
        const rng = makeRng(3);
        for (const [bestOf, picks] of [
            [1, 0],
            [3, 2],
            [5, 4],
        ]) {
            const veto = model.sample("A", "B", bestOf, rng);
            expect(veto.maps).toHaveLength(bestOf);
            expect(new Set(veto.maps).size).toBe(bestOf);
            expect(veto.pickers.filter((p) => p !== null)).toHaveLength(picks);
            expect(veto.pickers.at(-1)).toBeNull();
        }
    });

    it("samples vetoes whose series results match the exact probability", () => {
        const model = new VetoModel(file, "hltv");
        const rng = makeRng(7);
        const n = 100_000;
        let wins = 0;
        for (let i = 0; i < n; i++) {
            const veto = model.sample("A", "B", 3, rng, "FSFSSF");
            const p = model.logits(veto, 0.2).map((l) => 1 / (1 + Math.exp(-l * 0.8)));
            let a = 0;
            let b = 0;
            for (const q of p) {
                if (rng() < q) a++;
                else b++;
                if (a === 2 || b === 2) break;
            }
            if (a === 2) wins++;
        }
        expect(wins / n).toBeCloseTo(model.probability("A", "B", 0.2, 3, 0.8, "FSFSSF"), 2);
    });

    const split: VetoModelFile = {
        ...file,
        modes: { liquipedia: { map: { du: 2.0 }, choice: { ban: { play: 0.9, edge: 0.4 }, pick: { play: 1.6, edge: 1.1 } } } },
    };

    it("weights bans and picks separately, as the Python model does", () => {
        const model = new VetoModel(split, "liquipedia");
        expect(model.probability("A", "B", 0.2, 3, 0.8)).toBeCloseTo(0.5643720223043276, 12);
        const [m0, , , m3] = model.distribution("A", "B", 3, 0.7);
        [0.19758813094763902, 0.3238315488697666, 0.24518404907363311, 0.09218141966933549, 0.14121485143962584].forEach((v, i) =>
            expect([...m0.bans, ...m0.picks, m0.decider][i]).toBeCloseTo(v, 12)
        );
        expect(m3.picks[1]).toBeCloseTo(0.20716186203481465, 12);
    });

    it.each([1, 3, 5])("places every map once and plays %i in all", (bestOf) => {
        const out = new VetoModel(split, "liquipedia").distribution("A", "B", bestOf, 0.7);
        for (const o of out) expect(o.bans[0] + o.bans[1] + o.picks[0] + o.picks[1] + o.decider).toBeCloseTo(1, 12);
        expect(out.reduce((sum, o) => sum + o.picks[0] + o.picks[1] + o.decider, 0)).toBeCloseTo(bestOf, 12);
    });

    it("samples the same outcomes as the exact distribution, for a custom order", () => {
        const model = new VetoModel(split, "liquipedia");
        const exact = model.distribution("A", "B", 3, 1, "FSFSSF");
        const rng = makeRng(11);
        const n = 100_000;
        const picks = [new Array<number>(7).fill(0), new Array<number>(7).fill(0)];
        const deciders = new Array<number>(7).fill(0);
        for (let i = 0; i < n; i++) {
            const { maps, pickers } = model.sample("A", "B", 3, rng, "FSFSSF");
            maps.forEach((m, j) => {
                const picker = pickers[j];
                if (picker === null) deciders[m]++;
                else picks[picker][m]++;
            });
        }
        exact.forEach((o, m) => {
            expect(picks[0][m] / n).toBeCloseTo(o.picks[0], 2);
            expect(picks[1][m] / n).toBeCloseTo(o.picks[1], 2);
            expect(deciders[m] / n).toBeCloseTo(o.decider, 2);
        });
    });

    it("treats unknown teams as having no map preferences", () => {
        const model = new VetoModel(file, "hltv");
        expect(model.probability("X", "Y", 0, 3, 0.8)).toBeCloseTo(0.5, 12);
    });
});
