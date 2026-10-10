import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INVITE_CUTOFFS } from "../../../src/vrs/inviteCutoffs.ts";
import { compareStandings } from "./compareStandings.ts";
import { readPublishedSnapshot } from "./publishedStandings.ts";
import { computeStandings } from "./valveModel.ts";

describe("valveFidelity", () => {
    it("matches CLI execution with zero strict mismatches", () => {
        const repoRoot = process.cwd();
        const vendorModelDir = path.resolve(
            repoRoot,
            "vendor/counter-strike_regional_standings/model"
        );
        const fixturePath = path.resolve(repoRoot, "fixtures/matchdata.synthetic.json");
        const rawFixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vrs-fidelity-"));
        try {
            const tempModelDir = path.join(tempDir, "model");
            const tempDataDir = path.join(tempDir, "data");
            fs.mkdirSync(tempDataDir, { recursive: true });

            fs.cpSync(vendorModelDir, tempModelDir, { recursive: true });
            fs.copyFileSync(fixturePath, path.join(tempDataDir, "matchdata.json"));

            execFileSync(
                process.execPath,
                ["main.js", "[0,1,2]", "../data/matchdata.json", "2026_10_05"],
                {
                    cwd: tempModelDir,
                    stdio: "pipe",
                }
            );

            const published = readPublishedSnapshot(tempDir, "2026-10-05");
            const computed = computeStandings(
                rawFixture.matches,
                rawFixture.events,
                "2026-10-05"
            );

            const report = compareStandings(computed, published, INVITE_CUTOFFS);

            expect(report.strictMismatches).toEqual([]);
            expect(report.passed).toBe(true);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
