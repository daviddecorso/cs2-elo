import { describe, expect, it } from "vitest";
import { checkPlanner, simGainKey, type SimGains } from "./plannerCheck.ts";

describe("checkPlanner", () => {
    const cohort = [{ players: ["a1", "a2", "a3", "a4", "a5"] }, { players: ["b1", "b2", "b3", "b4", "b5"] }];
    const origins = [{ origin: "2026-06-01", dates: ["2026-07-06"], cohort, n: 10 }];
    const realized = [
        { date: "2026-07-06", eventId: "Cup", players: ["a1", "a2", "a3", "x", "y"], gain: 50, lan: true },
        { date: "2026-07-06", eventId: "Other", players: ["z1", "z2", "z3", "z4", "z5"], gain: 10, lan: false },
    ];

    it("scores attendance odds over every cohort roster and simulated real event", () => {
        const sim: SimGains = new Map([
            [simGainKey("2026-06-01", "2026-07-06", 0, "Cup"), { runs: 8, gain: 8 * 40 }],
            [simGainKey("2026-06-01", "2026-07-06", 1, "Cup"), { runs: 2, gain: 2 * 30 }],
            [simGainKey("2026-06-01", "2026-07-06", 1, "Stand-in"), { runs: 5, gain: 100 }],
        ]);
        const check = checkPlanner(origins, sim, realized);
        expect(check.attendance.pairs).toBe(2);
        expect(check.attendance.attended).toBe(1);
        expect(check.attendance.brier).toBeCloseTo(((0.8 - 1) ** 2 + 0.2 ** 2) / 2, 12);
        expect(check.gain.pairs).toBe(1);
        expect(check.gain.predicted).toBe(40);
        expect(check.gain.realized).toBe(50);
    });
});
