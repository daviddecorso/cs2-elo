import { describe, expect, it } from "vitest";
import { qualifierLinks, type LinkEnd } from "./qualifierLinks.ts";

const end = (page: string, start: string, over: Partial<LinkEnd> = {}): LinkEnd => ({ page, region: null, startDate: start, endDate: start, labels: [], ...over });
const row = (parent: string, qualifier: string, qualifierpage = "") => ({ pagename: parent, parent, opponenttype: "team", opponentname: "TBD", placement: "", qualifier, qualifierpage });

describe("qualifierLinks", () => {
    it("takes the target's qualifierpage first, whatever the source's role", () => {
        const events = [
            end("ECL/Europe", "2026-12-14"),
            end("EPL", "2027-03-06", { labels: [{ label: "ECL S52 Europe", count: 1 }] }),
        ];
        expect(qualifierLinks(events, [row("EPL", "ECL S52 Europe", "ECL/Europe"), row("EPL", "VRS Global (Jan. 2027)")])).toEqual([
            { from: "ECL/Europe", to: "EPL", slotKey: "qualifier:ECL S52 Europe", count: 1, rule: "page" },
        ]);
    });

    it("matches a subpage qualifier to its target's label by region, else the only label left", () => {
        const labels = [
            { label: "European Qualifier", count: 1 },
            { label: "Asian Qualifier", count: 1 },
        ];
        const events = [
            end("Open/Asia", "2027-02-01", { region: "Asia", qualifies: { page: "Open", slots: 1 } }),
            end("Open/Europe", "2027-02-02", { region: null, qualifies: { page: "Open", slots: 1 } }),
            end("Open", "2027-03-19", { labels }),
        ];
        expect(qualifierLinks(events, []).map((l) => [l.from, l.slotKey, l.rule])).toEqual([
            ["Open/Asia", "qualifier:Asian Qualifier", "ancestor"],
            ["Open/Europe", "qualifier:European Qualifier", "ancestor"],
        ]);
    });

    it("gives a source with no label its own slot, and drops one that doesn't end before the target", () => {
        const events = [
            end("Q/Open/1", "2027-01-04", { qualifies: { page: "Q", slots: 1 } }),
            end("Q/Late", "2027-01-09", { qualifies: { page: "Q", slots: 1 } }),
            end("Q", "2027-01-09"),
        ];
        expect(qualifierLinks(events, [])).toEqual([{ from: "Q/Open/1", to: "Q", slotKey: "qualifier:Q/Open/1", count: 1, rule: "implicit" }]);
    });

    it("leaves a label claimed by a page that isn't listed alone", () => {
        const events = [end("Q/Open", "2027-01-04", { qualifies: { page: "M", slots: 1 } }), end("M", "2027-03-18", { labels: [{ label: "Closed Qualifier", count: 2 }] })];
        expect(qualifierLinks(events, [row("M", "Closed Qualifier", "M/Qualifier")]).map((l) => l.slotKey)).toEqual(["qualifier:Q/Open"]);
    });
});
