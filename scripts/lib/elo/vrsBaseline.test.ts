import { describe, expect, it } from "vitest";
import { findVrsRoster, makeNickLookup, snapshotBefore, type VrsRoster, type VrsSnapshot } from "./vrsBaseline.ts";

const snapshot = (date: string, rosters: VrsRoster[]): VrsSnapshot => {
    const byNick = new Map<string, VrsRoster[]>();
    for (const r of rosters) for (const n of r.players) byNick.set(n, [...(byNick.get(n) ?? []), r]);
    return { date, rosters, byNick };
};

const vitality: VrsRoster = { rank: 1, points: 2000, teamName: "Vitality", players: ["apex", "zywoo", "flamez", "ropz", "mezii"] };
const other: VrsRoster = { rank: 40, points: 900, teamName: "Other", players: ["apex", "zywoo", "a", "b", "c"] };

describe("findVrsRoster", () => {
    const nicksOf = makeNickLookup({ ApEX: { nick: "apEX", country: "fr" }, Device: { nick: "dev1ce", country: "dk" } }, { Device: { nick: "device", reason: "" } });

    it("matches on 3+ shared players, preferring the larger overlap", () => {
        const s = snapshot("2026-10-05", [other, vitality]);
        expect(findVrsRoster(s, ["ApEX", "ZywOo", "FlameZ", "x", "y"], nicksOf)).toBe(vitality);
    });

    it("returns null below 3 shared players", () => {
        const s = snapshot("2026-10-05", [vitality]);
        expect(findVrsRoster(s, ["ApEX", "ZywOo", "x", "y", "z"], nicksOf)).toBeNull();
    });

    it("looks players up by page, display nick and VRS alias", () => {
        expect(nicksOf("Device").sort()).toEqual(["dev1ce", "device"]);
        expect(nicksOf("ApEX")).toEqual(["apex"]);
    });
});

describe("snapshotBefore", () => {
    const snaps = [snapshot("2026-09-07", []), snapshot("2026-10-05", [])];
    const at = (iso: string) => Date.parse(iso) / 1000;

    it("never uses a snapshot published on the match day", () => {
        expect(snapshotBefore(snaps, at("2026-10-05T18:00:00Z"))?.date).toBe("2026-09-07");
        expect(snapshotBefore(snaps, at("2026-10-06T00:00:00Z"))?.date).toBe("2026-10-05");
        expect(snapshotBefore(snaps, at("2026-09-01T00:00:00Z"))).toBeNull();
    });
});
