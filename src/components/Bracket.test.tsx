import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StageBracket } from "../sim/types.ts";
import { swissRoundModel } from "./bracketModel.ts";

const file = path.resolve(process.env.SIM_DIR ?? "public/data/sim", "events/pgl-major-singapore-2026.json");
const stages = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { bracket: StageBracket[] }).bracket : [];
const exportsSize = stages.some((s) => s.slots.some((slot) => slot.size !== undefined));

describe("swissRoundModel", () => {
    it.skipIf(!exportsSize)("fills every 16-team Major Swiss pool to its exact size", () => {
        const swiss = stages.filter((s) => s.format === "swiss");
        expect(swiss).toHaveLength(3);
        for (const stage of swiss) {
            const last = new Map<string, string>();
            for (const [round, teams] of swissRoundModel(stage)) {
                for (const [team, { bestKey }] of teams) {
                    const before = last.get(team);
                    if (before === "adv" || before === "elim") expect(bestKey, `${team} round ${round}`).toBe(before);
                    if (bestKey) last.set(team, bestKey);
                }
                const counts: Record<string, number> = {};
                for (const { bestKey } of teams.values()) if (bestKey) counts[bestKey] = (counts[bestKey] ?? 0) + 1;
                const expected: Record<string, number> = Object.fromEntries(
                    stage.slots.filter((s) => s.round === round).map((s) => [s.id, Math.round(s.size!)])
                );
                if (round === 4) Object.assign(expected, { adv: 2, elim: 2 });
                if (round === 5) Object.assign(expected, { adv: 5, elim: 5 });
                expect(counts, `${stage.id} round ${round}`).toEqual(expected);
            }
        }
    });
});
