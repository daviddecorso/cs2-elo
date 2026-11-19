import { describe, expect, it } from "vitest";
import type { Region } from "../../../src/vrs/types.ts";
import { qualifierList, resolveField, welcomes, type FieldEvent, type FieldSampler, type ListEntry } from "./attendance.ts";
import { BANDS, bandOf, type EventFieldModel } from "./fieldModel.ts";

const entry = (team: string, globalRank: number, region: Region = "Europe", regionalRank = globalRank, subregion: ListEntry["subregion"] = null): ListEntry => ({
    team,
    globalRank,
    regionalRank,
    region,
    subregion,
});
const list: ListEntry[] = Array.from({ length: 20 }, (_, i) => entry(`T${i + 1}`, i + 1));

const event = (overrides: Partial<FieldEvent>): FieldEvent => ({
    slug: "e",
    region: "Europe",
    tier: 1,
    teams: 4,
    announced: [],
    announcedVia: {},
    invites: { slots: [{ list: "Global", month: "2026-12", count: 4 }], qualifiers: [], verified: false },
    ...overrides,
});

const teams = (e: FieldEvent, declines: (t: string) => boolean = () => false, entries = list) =>
    resolveField(e, () => entries, entries, declines).field.map((f) => `${f.team}:${f.source}`);

describe("resolveField", () => {
    it("invites in rank order and seeds by rank", () => {
        expect(teams(event({}))).toEqual(["T1:vrs", "T2:vrs", "T3:vrs", "T4:vrs"]);
    });

    it("passes a declined slot down to the next rank", () => {
        expect(teams(event({}), (t) => t === "T2" || t === "T3")).toEqual(["T1:vrs", "T4:vrs", "T5:vrs", "T6:vrs"]);
    });

    it("starts at startRank", () => {
        const e = event({ invites: { slots: [{ list: "Global", month: "2026-12", count: 2, startRank: 5 }], qualifiers: [], verified: false }, teams: 2 });
        expect(teams(e)).toEqual(["T5:vrs", "T6:vrs"]);
    });

    it("keeps announced teams and only fills slots still open", () => {
        const e = event({ announced: ["T9"], announcedVia: { T9: "vrs:Global|2026-12" } });
        expect(teams(e)).toEqual(["T1:vrs", "T2:vrs", "T3:vrs", "T9:announced"]);
    });

    it("holds reserved qualifier places open and counts teams that already qualified against their slot", () => {
        const e = event({
            teams: 5,
            invites: { slots: [{ list: "Global", month: "2026-12", count: 2 }], qualifiers: [{ label: "Closed Qualifier", count: 3 }], verified: false },
        });
        const linked = { filled: new Map([["T9", "qualifier:Closed Qualifier"]]), reserved: new Map([["qualifier:Closed Qualifier", 1]]) };
        const r = resolveField(e, () => list, list, () => false, undefined, linked);
        expect(r.field.map((f) => `${f.team}:${f.source}`)).toEqual(["T1:vrs", "T2:vrs", "T3:qualifier", "T9:qualifier"]);
        expect(r.short).toBe(0);
    });

    it("lets events below tier 1 invite only from below global rank 12", () => {
        expect(teams(event({ tier: 2 }))).toEqual(["T13:vrs", "T14:vrs", "T15:vrs", "T16:vrs"]);
    });

    it("takes the top-12 rule from Valve's tier when it's known, not Liquipedia's", () => {
        expect(teams(event({ tier: 3, publisherTier: "Tier 2" }))).toEqual(["T13:vrs", "T14:vrs", "T15:vrs", "T16:vrs"]);
        expect(teams(event({ tier: 2, publisherTier: "Tier 1" }))).toEqual(["T1:vrs", "T2:vrs", "T3:vrs", "T4:vrs"]);
        expect(teams(event({ tier: 1, publisherTier: "Wildcard" }))).toEqual(["T1:vrs", "T2:vrs", "T3:vrs", "T4:vrs"]);
    });

    it("walks a regional list by regional rank and fills qualifiers with the region's best remaining roster", () => {
        const mixed = [entry("EU1", 1), entry("AM1", 2, "Americas", 1, "North America"), entry("EU2", 3, "Europe", 2), entry("AS1", 4, "Asia", 1), entry("BR1", 5, "Americas", 2, "South America")];
        const e = event({
            teams: 3,
            invites: {
                slots: [{ list: "Europe", month: "2026-12", count: 1 }],
                qualifiers: [
                    { label: "South American Qualifier", count: 1 },
                    { label: "Asian Qualifier", count: 1 },
                ],
                verified: false,
            },
        });
        expect(teams(e, () => false, mixed)).toEqual(["EU1:vrs", "AS1:qualifier", "BR1:qualifier"]);
    });

    it("reports slots no list can fill", () => {
        expect(resolveField(event({ teams: 4 }), () => list.slice(0, 2), list.slice(0, 2), () => false).short).toBe(2);
    });
});

describe("resolveField with a sampler", () => {
    const flat = new Array<number>(BANDS).fill(1 / BANDS);
    const model = (overrides: Partial<EventFieldModel> = {}): EventFieldModel => ({
        open: flat,
        qualifier: flat,
        region: null,
        subregion: null,
        sameRegion: null,
        acceptance: new Array<number>(BANDS).fill(1),
        learnedRule: null,
        seriesWeight: 0,
        ...overrides,
    });
    const sampler = (m: EventFieldModel, extra: Partial<FieldSampler> = {}): FieldSampler => ({ seed: 7, model: m, unranked: [], pace: () => 1, ...extra });
    const resolve = (e: FieldEvent, s: FieldSampler, entries = list) => resolveField(e, () => entries, entries, () => false, s);

    it("walks the list like the deterministic fill when every team accepts, and reports the cutoff", () => {
        const r = resolve(event({}), sampler(model()));
        expect(r.field.map((f) => f.team)).toEqual(["T1", "T2", "T3", "T4"]);
        expect(r.cutoffs).toEqual({ "vrs:Global|2026-12": 4 });
    });

    it("passes an invite down by chance: a band that never accepts is skipped", () => {
        const acceptance = new Array<number>(BANDS).fill(1);
        acceptance[0] = 0;
        expect(resolve(event({}), sampler(model({ acceptance }))).field.map((f) => f.team)).toEqual(["T11", "T12", "T13", "T14"]);
    });

    it("lets a forced team take an offer that reaches it even if its band declines", () => {
        const acceptance = new Array<number>(BANDS).fill(1);
        acceptance[0] = 0;
        const r = resolve(event({}), sampler(model({ acceptance }), { forced: "T3" }));
        expect(r.field.map((f) => f.team)).toEqual(["T3", "T11", "T12", "T13"]);
    });

    it("draws a field without a rule from the band histogram, by region, and only from drawable teams", () => {
        const wide = [...Array.from({ length: 40 }, (_, i) => entry(`E${i + 1}`, i + 1)), ...Array.from({ length: 40 }, (_, i) => entry(`A${i + 1}`, 41 + i, "Asia", i + 1))];
        const open = new Array<number>(BANDS).fill(0);
        open[bandOf(25)] = 1;
        const e = event({ invites: undefined, teams: 6 });
        const r = resolve(e, sampler(model({ open, region: "Europe", sameRegion: 1 })), wide);
        expect(r.field).toHaveLength(6);
        expect(r.field.every((f) => f.source === "open" && /^E(2[1-9]|3[0-5])$/.test(f.team))).toBe(true);
        const only = new Set(["E21", "E22", "E23"]);
        expect(resolve(e, sampler(model({ open, region: "Europe", sameRegion: 1 }), { drawable: only }), wide).field.map((f) => f.team).sort()).toEqual([...only]);
    });

    it("draws qualifier slots from the qualifier histogram and takes unranked teams into the last band", () => {
        const qualifier = new Array<number>(BANDS).fill(0);
        qualifier[BANDS - 1] = 1;
        const unranked = [{ team: "U1", globalRank: null, regionalRank: null, region: "Europe" as const, subregion: null }];
        const e = event({ teams: 5, invites: { slots: [{ list: "Global", month: "2026-12", count: 4 }], qualifiers: [{ label: "Closed Qualifier", count: 1 }], verified: false } });
        expect(resolve(e, sampler(model({ qualifier }), { unranked })).field.map((f) => `${f.team}:${f.source}`)).toEqual(["T1:vrs", "T2:vrs", "T3:vrs", "T4:vrs", "U1:qualifier"]);
    });

    it("repeats a draw from the same seed", () => {
        const e = event({ invites: undefined, teams: 6 });
        const draw = () => resolve(e, sampler(model())).field.map((f) => f.team);
        expect(draw()).toEqual(draw());
    });

    it("changes only the forced team and the one it displaces, even when the team had declined for its cap", () => {
        const wide = Array.from({ length: 60 }, (_, i) => entry(`T${i + 1}`, i + 1));
        const acceptance = new Array<number>(BANDS).fill(0.5);
        const e = event({ teams: 10, invites: { slots: [{ list: "Global", month: "2026-12", count: 4 }], qualifiers: [{ label: "Closed Qualifier", count: 2 }], verified: false } });
        const capped = "T7";
        const actual = resolveField(e, () => wide, wide, (t) => t === capped, sampler(model({ acceptance }))).field.map((f) => f.team);
        expect(actual).not.toContain(capped);
        const reach = resolveField(e, () => wide, wide, () => false, sampler(model({ acceptance }), { forced: capped })).field.map((f) => f.team);
        expect(reach).toContain(capped);
        expect(reach.filter((t) => !actual.includes(t))).toEqual([capped]);
        expect(actual.filter((t) => !reach.includes(t))).toHaveLength(1);
    });

    it("draws a team with affinity more often than its cell-mates", () => {
        const wide = Array.from({ length: 40 }, (_, i) => entry(`T${i + 1}`, 21 + (i % 10)));
        const e = event({ invites: undefined, teams: 4 });
        const share = (affinity?: (t: string) => number) =>
            Array.from({ length: 400 }, (_, seed) => resolve(e, sampler(model(), { seed, affinity }), wide).field.some((f) => f.team === "T5")).filter(Boolean).length / 400;
        expect(share()).toBeLessThan(0.2);
        expect(share((t) => (t === "T5" ? 5 : 1))).toBeGreaterThan(0.25);
    });

    it("forces a team into an open slot only when teams ranked like it filled past ones, else through a qualifier", () => {
        const wide = Array.from({ length: 120 }, (_, i) => entry(`T${i + 1}`, i + 1));
        const lower = new Array<number>(BANDS).fill(0);
        lower[bandOf(80)] = 1;
        const e = event({ invites: { slots: [], qualifiers: [{ label: "Closed Qualifier", count: 2 }], verified: false }, teams: 8, tier: 3 });
        const sourceOf = (forced: string, open: number[]) =>
            resolve(e, sampler(model({ open }), { forced }), wide).field.find((f) => f.team === forced)?.source;
        expect(sourceOf("T30", lower)).toBe("open");
        expect(sourceOf("T110", lower)).toBe("qualifier");
        expect(welcomes(lower, bandOf(30))).toBe(true);
        expect(welcomes(lower, bandOf(110))).toBe(false);
        const full = event({ invites: { slots: [], qualifiers: [{ label: "Closed Qualifier", count: 8 }], verified: false }, teams: 8, tier: 3 });
        expect(resolve(full, sampler(model({ open: lower }), { forced: "T30" }), wide).field.find((f) => f.team === "T30")?.source).toBe("qualifier");
    });
});

describe("qualifierList", () => {
    it("reads the region from the label, else the event's region, else global", () => {
        expect(qualifierList("ECL S52 North America", "Europe")).toBe("North America");
        expect(qualifierList("ECL S52 Asia-Pacific", "Europe")).toBe("Asia");
        expect(qualifierList("European Qualifier", "Asia")).toBe("Europe");
        expect(qualifierList("Closed Qualifier", "Asia")).toBe("Asia");
        expect(qualifierList("Closed Qualifier", null)).toBe("Global");
    });
});
