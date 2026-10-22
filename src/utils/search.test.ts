import { describe, expect, it } from "vitest";
import { compact, normalize, rosterMatches, textMatches } from "./search.ts";

describe("search utils", () => {
    it("normalizes text by lowering case, stripping diacritics and collapsing spaces", () => {
        expect(normalize("  FaZe   Clan  ")).toBe("faze clan");
        expect(normalize("Virtus.pro")).toBe("virtus pro");
        expect(normalize("MOUZ")).toBe("mouz");
    });

    it("compacts text by stripping spaces and punctuation", () => {
        expect(compact("Virtus.pro")).toBe("virtuspro");
        expect(compact("FaZe Clan")).toBe("fazeclan");
    });

    it("matches empty queries on any text", () => {
        expect(textMatches("FaZe Clan", "")).toBe(true);
        expect(textMatches("FaZe Clan", "   ")).toBe(true);
    });

    it("matches team names by prefix, word prefix, or substring", () => {
        expect(textMatches("FaZe Clan", "faze")).toBe(true);
        expect(textMatches("FaZe Clan", "clan")).toBe(true);
        expect(textMatches("Virtus.pro", "virtus")).toBe(true);
        expect(textMatches("Virtus.pro", "pro")).toBe(true);
        expect(textMatches("Virtus.pro", "virtus.pro")).toBe(true);
        expect(textMatches("Virtus.pro", "virtuspro")).toBe(true);
        expect(textMatches("FaZe Clan", "liquid")).toBe(false);
    });

    it("matches acronyms and common team aliases", () => {
        expect(textMatches("Ninjas in Pyjamas", "nip")).toBe(true);
        expect(textMatches("Virtus.pro", "vp")).toBe(true);
        expect(textMatches("Natus Vincere", "navi")).toBe(true);
    });

    it("matches rosters by team name or player nick", () => {
        const players = ["donk", "magixx", "sh1ro", "tN1R", "zont1x"];
        expect(rosterMatches("Team Spirit", players, "spirit")).toBe(true);
        expect(rosterMatches("Team Spirit", players, "donk")).toBe(true);
        expect(rosterMatches("Team Spirit", players, "sh1")).toBe(true);
        expect(rosterMatches("Team Spirit", players, "m0nesy")).toBe(false);
    });
});
