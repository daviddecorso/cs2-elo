import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Matchdata } from "../vrs/buildMatchdata.ts";
import { readAttendance, readHistoryRows, type FrozenSimMonth } from "./history.ts";

const player = (nick: string) => ({ playerId: nick, nick, countryIso: "de" });

describe("frozen sim history", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sim-history-"));
    const raw = path.join(root, "raw");
    const frozen = path.join(root, "frozen");
    fs.mkdirSync(raw);
    fs.mkdirSync(frozen);
    fs.writeFileSync(path.join(raw, "tournaments.json"), JSON.stringify([{ pagename: "Test/Hot", startdate: "2026-06-01" }]));
    fs.writeFileSync(path.join(raw, "placements.json"), JSON.stringify([{ pagename: "Test/Hot", parent: "Test/Hot", opponentname: "B", placement: "1" }]));
    const month: FrozenSimMonth = {
        month: "2025-01",
        tournaments: [
            { pagename: "Test/Old", startdate: "2025-01-10" },
            { pagename: "Test/Hot", startdate: "2025-01-01" },
        ],
        placements: [
            { pagename: "Test/Old", parent: "Test/Old", opponentname: "A", placement: "1" },
            { pagename: "Test/Hot", parent: "Test/Hot", opponentname: "B", placement: "1" },
        ],
        attendance: [
            { eventId: "Test/Old", teams: [{ teamId: "A", players: [player("a")] }] },
            { eventId: "Test/Hot", teams: [{ teamId: "Z", players: [player("z")] }] },
        ],
    };
    fs.writeFileSync(path.join(frozen, "2025-01.json"), JSON.stringify(month));

    it("fills only pages the stores lack, so no page's rows repeat", () => {
        const { tournamentRows, placementRows } = readHistoryRows(raw, frozen);
        const mine = (rows: Array<Record<string, unknown>>) => rows.filter((r) => String(r.pagename).startsWith("Test/"));
        expect(mine(tournamentRows).map((r) => [r.pagename, r.startdate])).toEqual([
            ["Test/Old", "2025-01-10"],
            ["Test/Hot", "2026-06-01"],
        ]);
        expect(mine(placementRows)).toHaveLength(2);
    });

    it("merges a frozen event's attendance with matchdata's, matchdata's lineups winning", () => {
        const matchdata = {
            matches: [{ matchStartTime: 1, team1Id: "B", team2Id: "C", team1Players: [player("b")], team2Players: [player("c")], eventId: "Test/Hot", winningTeam: 1, valveRanked: true, forfeited: false }],
            events: [],
        } as unknown as Matchdata;
        const attendance = readAttendance(matchdata, frozen);
        expect([...attendance.get("Test/Old")!.keys()]).toEqual(["A"]);
        expect([...attendance.get("Test/Hot")!.keys()]).toEqual(["Z", "B", "C"]);
        expect(attendance.get("Test/Hot")!.get("B")![0].nick).toBe("b");
    });
});
