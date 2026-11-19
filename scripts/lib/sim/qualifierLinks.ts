import type { Region } from "../../../src/vrs/types.ts";
import type { RawRow } from "../elo/normalize.ts";
import { qualifierList } from "./attendance.ts";

/** One end of a possible link: a catalog event, by Liquipedia page. */
export interface LinkEnd {
    page: string;
    region: Region | null;
    startDate: string;
    endDate: string;
    /** For a qualifier, the page `qualifierTargets` says it sends teams to, and how many. */
    qualifies?: { page: string; slots: number };
    /** Qualifier slot labels of its invite rule (own or learned), without `Unspecified`. */
    labels: Array<{ label: string; count: number }>;
}

/** How a link was found: the target's `qualifierpage`, the source's ancestor matched to a label, or an extra slot of its own. */
export type LinkRule = "page" | "ancestor" | "implicit";

export interface QualifierLink {
    from: string;
    to: string;
    /** `slotKey` of the slot it fills: `qualifier:<label>`, or `qualifier:<source page>` for an implicit one. */
    slotKey: string;
    count: number;
    rule: LinkRule;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const cleanLabel = (q: unknown) => str(q).replace(/\[\[Category:[^\]]*\]\]/g, "").trim();

const labelRegion = (label: string): Region | null => {
    const list = qualifierList(label, null);
    return list === "Global" ? null : list === "North America" || list === "South America" ? "Americas" : list;
};

/** Which events fill which qualifier slots of which others; a source must end before its target starts. */
export const qualifierLinks = (events: LinkEnd[], placementRows: RawRow[]): QualifierLink[] => {
    const byPage = new Map(events.map((e) => [e.page, e]));
    const precedes = (from: LinkEnd, to: LinkEnd) => from.endDate < to.startDate;
    const pagesByLabel = new Map<string, Map<string, Map<string, number>>>();
    for (const r of placementRows) {
        const page = str(r.pagename);
        if (r.parent !== r.pagename || str(r.placement) || r.opponenttype !== "team" || !byPage.has(page)) continue;
        const from = str(r.qualifierpage);
        const label = cleanLabel(r.qualifier);
        if (!from || !label) continue;
        let labels = pagesByLabel.get(page);
        if (!labels) pagesByLabel.set(page, (labels = new Map()));
        let pages = labels.get(label);
        if (!pages) labels.set(label, (pages = new Map()));
        pages.set(from, (pages.get(from) ?? 0) + 1);
    }

    const out: QualifierLink[] = [];
    const linked = new Set<string>();
    for (const to of events) {
        for (const [label, pages] of pagesByLabel.get(to.page) ?? []) {
            for (const [page, count] of pages) {
                const from = byPage.get(page);
                if (!from || !precedes(from, to)) continue;
                out.push({ from: page, to: to.page, slotKey: `qualifier:${label}`, count, rule: "page" });
                linked.add(page);
            }
        }
    }
    for (const to of events) {
        const claimed = pagesByLabel.get(to.page) ?? new Map<string, Map<string, number>>();
        const left = new Map(to.labels.filter((l) => !claimed.has(l.label)).map((l) => [l.label, l.count]));
        const sources = events
            .filter((e) => e.qualifies?.page === to.page && !linked.has(e.page) && precedes(e, to))
            .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.page.localeCompare(b.page));
        for (const from of sources) {
            const open = [...left].filter(([, n]) => n > 0).map(([label]) => label);
            const label = open.find((l) => from.region !== null && labelRegion(l) === from.region) ?? (open.length === 1 ? open[0] : undefined);
            const slots = from.qualifies!.slots;
            if (label === undefined) {
                out.push({ from: from.page, to: to.page, slotKey: `qualifier:${from.page}`, count: slots, rule: "implicit" });
                continue;
            }
            const count = Math.min(slots, left.get(label)!);
            left.set(label, left.get(label)! - count);
            out.push({ from: from.page, to: to.page, slotKey: `qualifier:${label}`, count, rule: "ancestor" });
        }
    }
    return out;
};
