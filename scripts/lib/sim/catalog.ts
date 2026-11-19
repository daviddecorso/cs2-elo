import type { Region } from "../../../src/vrs/types.ts";
import type { RawRow } from "../elo/normalize.ts";
import type { EventKind } from "../../../src/sim/schedule.ts";
import type { Assumption, EventConfig, InviteRule, StageConfig, VrsList } from "./config.ts";
import { genericStages, type EventRole } from "./formats/genericFormat.ts";
import type { ProjectedEdition, ProjectionBasis } from "./series.ts";
import type { UnannouncedEvent } from "./unannounced.ts";

export interface CatalogEvent {
    config: EventConfig;
    /** Built from a template rather than a hand-written config. */
    generic: boolean;
    tier: number | null;
    prizePool: number;
    /** Placement label → USD per team. */
    prizes: Map<string, number>;
    prizeSource: "table" | "config" | "estimate";
    /** Team pages Liquipedia already lists as participants. */
    announced: string[];
    /** Announced team → the slot it fills (`slotKey`), or `direct`. */
    announcedVia: Record<string, string>;
    /** Field size; 0 when unknown. */
    teams: number;
    /** Liquipedia's `publishertier`: Valve's tier for the event ("Tier 1", "Tier 2", "Wildcard"), "" when unregistered. */
    publisherTier: string;
    /** Valve ranks its matches: an override, else a `publishertier`. */
    ranked: boolean;
    kind: EventKind;
    role: EventRole;
    /** For a qualifier, the page of the event it sends teams to, and how many. */
    qualifies?: { page: string; slots: number };
    /** Liquipedia's `seriespage`, when set. */
    series?: string;
    /** Liquipedia's first organizer, when set. */
    organizer?: string;
    /** An edition the catalog expects but Liquipedia doesn't list yet. */
    projection?: ProjectionBasis & { chance: number };
    /** A stand-in for events of its kind Liquipedia will list later (`unannouncedEvents`): rivals play it, no team can choose it. */
    unannounced?: { chance: number };
    simulated: boolean;
    reason?: string;
}

/** Valve's ranked rule for whole events, as `buildMatchdata` applies it: an override, else a `publishertier`. */
export interface RankedRules {
    ranked: Set<string>;
    unranked: Set<string>;
}

export const NO_RANKED_RULES: RankedRules = { ranked: new Set(), unranked: new Set() };

type EventIdOverride = string | { eventId: string };
const eventIds = (list: EventIdOverride[] | undefined) => new Set((list ?? []).map((e) => (typeof e === "string" ? e : e.eventId)));

export const rankedRules = (overrides: { rankedEvents?: EventIdOverride[]; unrankedEvents?: EventIdOverride[] }): RankedRules => ({
    ranked: eventIds(overrides.rankedEvents),
    unranked: eventIds(overrides.unrankedEvents),
});

const DROPPED_STATUSES = new Set(["cancelled", "postponed"]);

/** Series no club can enter, matched against the page and its `seriespage`. */
export const EXCLUDED_SERIES: Array<{ match: RegExp; reason: string }> = [
    { match: /^Esports_Nations_Cup(\/|$)/, reason: "national teams" },
];

export const isRanked = (row: RawRow, rules: RankedRules): boolean => {
    const page = str(row.pagename);
    return rules.ranked.has(page) || (!rules.unranked.has(page) && Boolean(str(row.publishertier)));
};

/** Why an otherwise eligible event is left out of the catalog, or null to keep it. */
export const exclusionReason = (row: RawRow, rules: RankedRules): string | null => {
    const page = str(row.pagename);
    const status = str(row.status).toLowerCase();
    if (DROPPED_STATUSES.has(status)) return status;
    const series = EXCLUDED_SERIES.find((s) => s.match.test(page) || s.match.test(str(row.seriespage)));
    if (series) return series.reason;
    return isRanked(row, rules) ? null : "not ranked by Valve";
};

/** Which events the catalog lists: LANs only, or online events and qualifiers too. */
export type CatalogScope = "lan" | "all";

export const kindOf = (row: RawRow): EventKind => (/Offline/.test(str(row.type)) ? "lan" : "online");

export const roleOf = (row: RawRow): EventRole =>
    str(row.liquipediatiertype) === "Qualifier" || /Qualifier$/.test(str(row.publishertier)) ? "qualifier" : "main";

/** Valve's `getCountryRegion`: 0 Europe, 1 Americas, 2 Asia, -1 Africa; throws on an unknown code. */
export type CountryRegion = (country: string) => number;

const VALVE_REGIONS: Region[] = ["Europe", "Americas", "Asia"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const VRS_SLOT = /^VRS (Global|Europe|Americas|Asia|North America|South America) \(([A-Za-z]+)\.? (\d{4})\)/;
const EXCLUDED_TIER_TYPES = new Set(["Showmatch"]);

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Liquipedia's first organizer, "" when unset. */
export const organizerOf = (row: RawRow): string => {
    try {
        return str((JSON.parse(str(row.organizers) || "{}") as Record<string, unknown>).organizer1);
    } catch {
        return "";
    }
};
const isTbd = (row: RawRow) => !row.opponentname || str(row.opponentname).toUpperCase() === "TBD";
const cleanQualifier = (q: unknown) => str(q).replace(/\[\[Category:[^\]]*\]\]/g, "").trim();

/** Rows listing who takes part: on the parent's own page, before any placement is decided. */
const participantRows = (rows: RawRow[], parent: string): RawRow[] =>
    rows.filter((r) => r.parent === parent && r.pagename === parent && !str(r.placement) && r.opponenttype === "team");

export const slotKey = (slot: { list: VrsList; month: string } | { label: string }): string =>
    "label" in slot ? `qualifier:${slot.label}` : `vrs:${slot.list}|${slot.month}`;

const VRS_LABEL = /^VRS ([A-Za-z -]+?)\s*(?:\(([A-Za-z]+)\.? (\d{4})\))?$/;
const VRS_LABEL_LISTS: Record<string, VrsList> = {
    global: "Global",
    europe: "Europe",
    cis: "Europe",
    americas: "Americas",
    "north america": "North America",
    "north am": "North America",
    "south america": "South America",
    asia: "Asia",
    oceania: "Asia",
};

/** Any "VRS …" participant label: its list when it's one Valve publishes (Oceania counts as Asia), and its month when given. */
export const parseVrsLabel = (label: string): { list: VrsList | null; month: string | null } | null => {
    const m = VRS_LABEL.exec(cleanQualifier(label));
    if (!m) return null;
    const month = m[2] ? MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) : -1;
    return { list: VRS_LABEL_LISTS[m[1].toLowerCase()] ?? null, month: month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, "0")}` : null };
};

/** A participant row's slot; null for a named team with no source, which was invited directly. */
const rowSlot = (row: RawRow): { list: VrsList; month: string } | { label: string } | null => {
    const q = cleanQualifier(row.qualifier);
    const m = VRS_SLOT.exec(q);
    const month = m ? MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) : -1;
    if (m && month >= 0) return { list: m[1] as VrsList, month: `${m[3]}-${String(month + 1).padStart(2, "0")}` };
    // Only an empty TBD slot is unexplained.
    if (!q && !isTbd(row)) return null;
    return { label: q || "Unspecified" };
};

/** Invite rule from Liquipedia's `qualifier` strings; slot counts include slots already filled. Null without participant rows. */
export const inviteRuleFromPlacements = (rows: RawRow[], parent: string): InviteRule | null => {
    const participants = participantRows(rows, parent);
    if (participants.length === 0) return null;
    const slots = new Map<string, InviteRule["slots"][number]>();
    const qualifiers = new Map<string, number>();
    for (const row of participants) {
        const s = rowSlot(row);
        if (!s) continue;
        if ("label" in s) {
            qualifiers.set(s.label, (qualifiers.get(s.label) ?? 0) + 1);
            continue;
        }
        const key = slotKey(s);
        const slot = slots.get(key) ?? { ...s, count: 0 };
        slot.count++;
        slots.set(key, slot);
    }
    return {
        slots: [...slots.values()],
        qualifiers: [...qualifiers].map(([label, count]) => ({ label, count })),
        verified: false,
    };
};

export const announcedTeams = (rows: RawRow[], parent: string, pages: Map<string, string>): string[] => [
    ...new Set(
        participantRows(rows, parent)
            .filter((r) => !isTbd(r))
            .map((r) => pages.get(str(r.opponenttemplate).toLowerCase()) ?? str(r.opponentname))
    ),
];

export const announcedSlots = (rows: RawRow[], parent: string, pages: Map<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of participantRows(rows, parent)) {
        if (isTbd(r)) continue;
        const team = pages.get(str(r.opponenttemplate).toLowerCase()) ?? str(r.opponentname);
        const s = rowSlot(r);
        out[team] ??= s ? slotKey(s) : "direct";
    }
    return out;
};

const NAME_REGIONS: Array<[RegExp, Region]> = [
    [/south[_ ]america|north[_ ]america|americas|\bLATAM\b|\bNA\b|\bSA\b/i, "Americas"],
    [/europe|\bEU\b|\bCIS\b|nordics|adria/i, "Europe"],
    [/asia|oceania|pacific|china|\bOCE\b/i, "Asia"],
];

/** An online event's region from its page or name ("CCT/2026/Europe/Series_14"), else null. */
export const regionFromName = (...names: string[]): Region | null => {
    for (const [pattern, region] of NAME_REGIONS) if (names.some((n) => pattern.test(n))) return region;
    return null;
};

/** An event's Valve region from its venue's country; an online event without one takes it from its name. */
export const locationOf = (row: RawRow, countryRegion: CountryRegion): EventConfig["location"] => {
    const country = str((row.locations as RawRow | undefined)?.country1).toLowerCase();
    let region: Region | null = null;
    if (country) {
        try {
            region = VALVE_REGIONS[countryRegion(country)] ?? null;
        } catch {
            region = null;
        }
    }
    if (!region && kindOf(row) === "online") region = regionFromName(str(row.pagename), str(row.name));
    return { region, country };
};

/** Positions a label covers: "5-8" → 5..8, "3" → 3. */
export const labelPositions = (label: string): number[] => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(label.trim());
    if (!m) return [];
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    return Array.from({ length: Math.max(to - from + 1, 0) }, (_, i) => from + i);
};

/** Placement label → per-team share of the prize pool. */
export type PrizeSplit = (label: string) => number;

/** Each finished offline event's per-position share of its total prize money, keyed by tier and field size. */
const finishedShares = (placementRows: RawRow[]): Array<{ tier: number; teams: number; shares: number[] }> => {
    const byEvent = new Map<string, RawRow[]>();
    for (const r of placementRows) {
        if (r.pagename !== r.parent || !str(r.placement) || !/Offline/.test(str(r.type))) continue;
        byEvent.set(str(r.parent), [...(byEvent.get(str(r.parent)) ?? []), r]);
    }
    const out: Array<{ tier: number; teams: number; shares: number[] }> = [];
    for (const rows of byEvent.values()) {
        const total = rows.reduce((s, r) => s + (Number(r.prizemoney) || 0), 0);
        if (total <= 0) continue;
        const shares: Array<number | undefined> = new Array(rows.length).fill(undefined);
        for (const r of rows) {
            // Each row is one team; it sits at the first free position its label covers.
            const at = labelPositions(str(r.placement)).find((p) => p <= rows.length && shares[p - 1] === undefined);
            if (at !== undefined) shares[at - 1] = (Number(r.prizemoney) || 0) / total;
        }
        if (shares.some((s) => s === undefined)) continue;
        out.push({ tier: Number(rows[0].liquipediatier), teams: rows.length, shares: shares as number[] });
    }
    return out;
};

const fallbackShares = (teams: number): number[] => {
    const weights = Array.from({ length: teams }, (_, i) => 1 / (i + 1));
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map((w) => w / sum);
};

const meanShares = (events: Array<{ shares: number[] }>, teams: number): number[] =>
    Array.from({ length: teams }, (_, i) => events.reduce((s, e) => s + e.shares[i], 0) / events.length);

/** Fits per-position shares once from finished events: same tier and size, then any tier of that size, then a 1/position split. */
export const fitPrizeSplits = (placementRows: RawRow[]) => {
    const finished = finishedShares(placementRows);
    const cache = new Map<string, { split: PrizeSplit; source: string }>();
    return (tier: number | null, teams: number): { split: PrizeSplit; source: string } => {
        const key = `${tier}/${teams}`;
        const hit = cache.get(key);
        if (hit) return hit;
        const sameTier = finished.filter((e) => e.teams === teams && e.tier === tier);
        const sameSize = finished.filter((e) => e.teams === teams);
        const [shares, source] =
            sameTier.length > 0
                ? [meanShares(sameTier, teams), `${sameTier.length} tier ${tier} events`]
                : sameSize.length > 0
                  ? [meanShares(sameSize, teams), `${sameSize.length} events of any tier`]
                  : [fallbackShares(teams), "1/position fallback"];
        const split: PrizeSplit = (label) => {
            const positions = labelPositions(label).filter((p) => p <= teams);
            return positions.length ? positions.reduce((s, p) => s + shares[p - 1], 0) / positions.length : 0;
        };
        const fit = { split, source };
        cache.set(key, fit);
        return fit;
    };
};

/** Per-team prize for each label, from a prize table whose labels may be cut differently ("5-8" vs "5-6", "7-8"). */
const relabel = (table: Map<string, number>, labels: string[]): Map<string, number> | null => {
    const byPosition = new Map<number, number>();
    for (const [label, prize] of table) for (const p of labelPositions(label)) byPosition.set(p, prize);
    const out = new Map<string, number>();
    for (const label of labels) {
        const prizes = labelPositions(label).map((p) => byPosition.get(p));
        if (prizes.length === 0 || prizes.some((p) => p === undefined)) return null;
        out.set(label, (prizes as number[]).reduce((a, b) => a + b, 0) / prizes.length);
    }
    return out;
};

const tableFor = (placementRows: RawRow[], page: string): Map<string, number> | null => {
    const table = new Map<string, number>();
    for (const row of placementRows) {
        if (row.pagename !== page || !str(row.placement)) continue;
        table.set(str(row.placement), Math.max(table.get(str(row.placement)) ?? 0, Number(row.prizemoney) || 0));
    }
    return [...table.values()].some((p) => p > 0) ? table : null;
};

const exitLabels = (config: EventConfig): string[] => [...new Set(config.stages.flatMap((s) => Object.values(s.exits)))];

const TEMPLATES: Record<number, Pick<StageConfig, "format" | "exits">> = {
    4: { format: "single_elim", exits: { r1: "3-4", r2: "2", champion: "1" } },
    8: { format: "single_elim", exits: { r1: "5-8", r2: "3-4", r3: "2", champion: "1" } },
    16: {
        format: "double_elim",
        exits: { "lb-r1": "13-16", "lb-r2": "9-12", "lb-r3": "7-8", "lb-r4": "5-6", "lb-r5": "4", "lb-r6": "3", gf: "2", champion: "1" },
    },
};

export const slugOf = (page: string): string =>
    page
        .replace(/[łŁ]/g, "l")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

export const tierOf = (row: RawRow | undefined): number | null => {
    const t = Number(row?.liquipediatier);
    return Number.isFinite(t) && t > 0 ? t : null;
};

export interface CatalogContext {
    placementRows: RawRow[];
    /** Liquipedia team template → team page. */
    pages: Map<string, string>;
    countryRegion: CountryRegion;
    prizeSplits: ReturnType<typeof fitPrizeSplits>;
    rankedRules?: RankedRules;
    /** A field model fills slots no rule explains, so those events are simulated with an assumed field. */
    learnsFields?: boolean;
}

/** Prizes from the Liquipedia table when it covers every label, else the config's estimate, else the fitted split of the pool. */
const resolvePrizes = (
    config: EventConfig,
    tier: number | null,
    prizePool: number,
    teams: number,
    ctx: CatalogContext
): Pick<CatalogEvent, "prizes" | "prizeSource"> & { estimated?: Record<string, number> } => {
    const labels = exitLabels(config);
    const table = tableFor(ctx.placementRows, config.liquipedia);
    const fromTable = table && relabel(table, labels);
    if (fromTable) return { prizes: fromTable, prizeSource: "table" };
    if (config.prizeEstimate) return { prizes: new Map(Object.entries(config.prizeEstimate)), prizeSource: "config" };
    const { split } = ctx.prizeSplits(tier, teams);
    const estimated = Object.fromEntries(labels.map((l) => [l, Math.round(prizePool * split(l))]));
    return { prizes: new Map(Object.entries(estimated)), prizeSource: "estimate", estimated };
};

/** Where a generic event's team count, and a qualifier's target, came from when its own row doesn't say. */
export interface GenericInfo {
    /** Median team count of past editions or similar events, for a row without one. */
    pastTeams?: number;
    qualifies?: { page: string; slots: number };
}

/** The 4/8/16 templates for tier 1–2 LAN main events, else `genericStages`. */
const genericFormat = (page: string, teams: number, tier: number | null, kind: EventKind, role: EventRole, slots?: number): StageConfig[] => {
    const template = kind === "lan" && role === "main" && tier !== null && tier <= 2 ? TEMPLATES[teams] : undefined;
    if (!template) return genericStages(page, teams, role, slots);
    return [
        {
            id: "main",
            name: template.format === "single_elim" ? "Single elimination" : "Double elimination",
            page,
            format: template.format,
            bestOf: { default: 3 },
            invited: [],
            advance: 0,
            exits: template.exits,
        },
    ];
};

/** Config for an unconfigured event from its team count: a template or generic format, all Bo3. */
export const genericEvent = (row: RawRow, ctx: CatalogContext, info: GenericInfo = {}): CatalogEvent => {
    const page = str(row.pagename);
    const listedTeams = Number(row.participantsnumber);
    const teams = listedTeams > 0 ? listedTeams : (info.pastTeams ?? 0);
    const tier = tierOf(row);
    const kind = kindOf(row);
    const role = roleOf(row);
    const prizePool = Number(row.prizepool) || 0;
    const invites = inviteRuleFromPlacements(ctx.placementRows, page) ?? undefined;
    const announced = announcedTeams(ctx.placementRows, page, ctx.pages);
    const stages = genericFormat(page, teams, tier, kind, role, info.qualifies?.slots);
    const assumed: Assumption[] = listedTeams > 0 || teams === 0 ? ["format"] : ["format", "teams"];
    const config: EventConfig = {
        slug: slugOf(page),
        name: str(row.name) || page,
        liquipedia: page,
        startDate: str(row.startdate),
        endDate: str(row.enddate),
        lan: kind === "lan",
        ...(tier !== null ? { tier } : {}),
        location: locationOf(row, ctx.countryRegion),
        ...(invites ? { invites } : {}),
        assumed,
        stages,
    };
    const announcedVia = announcedSlots(ctx.placementRows, page, ctx.pages);
    const publisherTier = str(row.publishertier);
    const base = {
        config,
        generic: true,
        tier,
        prizePool,
        announced,
        announcedVia,
        teams,
        publisherTier,
        ranked: isRanked(row, ctx.rankedRules ?? NO_RANKED_RULES),
        kind,
        role,
        ...(info.qualifies ? { qualifies: info.qualifies } : {}),
        ...(str(row.seriespage) ? { series: str(row.seriespage) } : {}),
        ...(organizerOf(row) ? { organizer: organizerOf(row) } : {}),
    };
    if (stages.length === 0) {
        return { ...base, prizes: new Map(), prizeSource: "estimate", simulated: false, reason: teams > 0 ? `no format for ${teams} teams` : "team count unknown" };
    }

    const { prizes, prizeSource, estimated } = resolvePrizes(config, tier, prizePool, teams, ctx);
    if (estimated) {
        config.prizeEstimate = estimated;
        assumed.push("prizes");
    }
    const open = teams - announced.length;
    const unexplained = invites?.qualifiers.find((q) => q.label === "Unspecified")?.count ?? 0;
    const explained = invites ? invites.slots.reduce((n, s) => n + s.count, 0) + invites.qualifiers.reduce((n, q) => n + q.count, 0) - unexplained : 0;
    if (open > 0 && (!invites || unexplained > 0 || explained < teams)) {
        if (!ctx.learnsFields) return { ...base, prizes, prizeSource, simulated: false, reason: `field unknown: ${open} of ${teams} slots have no invite rule` };
        assumed.push("field");
        return { ...base, prizes, prizeSource, simulated: true };
    }
    if (invites?.qualifiers.length) assumed.push("field");
    return { ...base, prizes, prizeSource, simulated: true };
};

const isCandidate = (row: RawRow, today: string, until: string, scope: CatalogScope) =>
    (scope === "all" || (kindOf(row) === "lan" && str(row.liquipediatiertype) !== "Qualifier")) &&
    !EXCLUDED_TIER_TYPES.has(str(row.liquipediatiertype)) &&
    str(row.enddate) >= today &&
    str(row.startdate) < until;

const isUnder = (page: string, parent: string) => page.startsWith(`${parent}/`);

/** Unconfigured events not yet over, minus non-qualifier subpages of listed events; the last row per page wins, so callers put `upcoming.tournaments` last. */
const topLevelEvents = (tournamentRows: RawRow[], configuredPages: string[], today: string, until: string, scope: CatalogScope): RawRow[] => {
    const latest = new Map<string, RawRow>();
    for (const r of tournamentRows) latest.set(str(r.pagename), r);
    const byPage = new Map([...latest].filter(([, r]) => isCandidate(r, today, until, scope)));
    const configured = new Set(configuredPages);
    const parents = [...byPage.keys(), ...configured];
    return [...byPage.values()]
        .filter((r) => {
            const page = str(r.pagename);
            if (configured.has(page)) return false;
            if (r.parent && str(r.parent) !== page) return false;
            return roleOf(r) === "qualifier" || !parents.some((other) => other !== page && isUnder(page, other));
        })
        .sort((a, b) => str(a.startdate).localeCompare(str(b.startdate)) || str(a.pagename).localeCompare(str(b.pagename)));
};

/** Catalog events without a config: `topLevelEvents` minus cancelled, postponed, national-team and unranked events. */
export const genericRows = (
    tournamentRows: RawRow[],
    configuredPages: string[],
    today: string,
    until: string,
    rules: RankedRules = NO_RANKED_RULES,
    scope: CatalogScope = "lan"
): RawRow[] => topLevelEvents(tournamentRows, configuredPages, today, until, scope).filter((r) => exclusionReason(r, rules) === null);

/** Events `genericRows` leaves out, with the reason. */
export const catalogExclusions = (
    tournamentRows: RawRow[],
    configuredPages: string[],
    today: string,
    until: string,
    rules: RankedRules = NO_RANKED_RULES,
    scope: CatalogScope = "lan"
): Array<{ page: string; reason: string }> =>
    topLevelEvents(tournamentRows, configuredPages, today, until, scope).flatMap((r) => {
        const reason = exclusionReason(r, rules);
        return reason ? [{ page: str(r.pagename), reason }] : [];
    });

/** Pages whose `/match` and `/placement` rows `fetchUpcoming` requests: configured first, then generic LANs by start date, then the rest of the scope. */
export const catalogParents = (
    configuredPages: string[],
    tournamentRows: RawRow[],
    today: string,
    until: string,
    cap = 100,
    rules: RankedRules = NO_RANKED_RULES,
    scope: CatalogScope = "lan"
): { parents: string[]; dropped: number } => {
    const generic = genericRows(tournamentRows, configuredPages, today, until, rules, scope);
    const lans = generic.filter((r) => kindOf(r) === "lan");
    const rest = generic.filter((r) => !lans.includes(r));
    const all = [...new Set([...configuredPages, ...[...lans, ...rest].map((r) => str(r.pagename))])];
    return { parents: all.slice(0, cap), dropped: Math.max(all.length - cap, 0) };
};

/** Qualifier page → the event its teams go to and how many, from the target's participant rows (`qualifierpage`), else the nearest listed ancestor page. */
export const qualifierTargets = (placementRows: RawRow[], tournamentPages: Set<string>): ((page: string) => { page: string; slots: number } | undefined) => {
    const linked = new Map<string, { page: string; slots: number }>();
    for (const r of placementRows) {
        const from = str(r.qualifierpage);
        if (!from || r.pagename !== r.parent || str(r.placement)) continue;
        const to = str(r.parent);
        const prev = linked.get(from);
        if (prev && prev.page !== to) continue;
        linked.set(from, { page: to, slots: (prev?.slots ?? 0) + 1 });
    }
    return (page) => {
        const hit = linked.get(page);
        if (hit) return hit;
        const parts = page.split("/");
        for (let i = parts.length - 1; i >= 1; i--) {
            const ancestor = parts.slice(0, i).join("/");
            if (tournamentPages.has(ancestor)) return { page: ancestor, slots: 1 };
        }
        return undefined;
    };
};

/** Median listed team count for a row without one: its series' finished editions, else finished events of the same tier, kind and role. */
export const pastTeamCounts = (tournamentRows: RawRow[], today: string): ((row: RawRow) => number | undefined) => {
    const finished = tournamentRows.filter((r) => str(r.enddate) < today && Number(r.participantsnumber) > 0);
    const median = (rows: RawRow[]) => {
        const xs = rows.map((r) => Number(r.participantsnumber)).sort((a, b) => a - b);
        return xs.length ? xs[Math.floor(xs.length / 2)] : undefined;
    };
    const group = (key: (r: RawRow) => string) => {
        const by = new Map<string, RawRow[]>();
        for (const r of finished) by.set(key(r), [...(by.get(key(r)) ?? []), r]);
        return new Map([...by].map(([k, rows]) => [k, median(rows)]));
    };
    const bySeries = group((r) => str(r.seriespage));
    const byShape = group((r) => `${tierOf(r)}|${kindOf(r)}|${roleOf(r)}`);
    return (row) => (str(row.seriespage) ? bySeries.get(str(row.seriespage)) : undefined) ?? byShape.get(`${tierOf(row)}|${kindOf(row)}|${roleOf(row)}`);
};

export interface CatalogInput {
    configs: EventConfig[];
    tournamentRows: RawRow[];
    today: string;
    until: string;
    ctx: CatalogContext;
    /** Defaults to LANs only. */
    scope?: CatalogScope;
    /** Editions of live series Liquipedia doesn't list yet (`projectEditions`), each with the chance a run plays it. */
    projected?: Array<ProjectedEdition & { chance: number }>;
    unannounced?: UnannouncedEvent[];
}

/** Every upcoming event in scope: hand-written configs with their location and invite rule filled in, plus a generic config per other event. */
export const buildCatalog = ({ configs, tournamentRows, today, until, ctx, scope = "lan", projected = [], unannounced = [] }: CatalogInput): CatalogEvent[] => {
    const rowByPage = new Map<string, RawRow>();
    for (const r of tournamentRows) rowByPage.set(str(r.pagename), r);

    const configured = configs
        .filter((c) => c.endDate >= today)
        .filter((c) => {
            const status = str(rowByPage.get(c.liquipedia)?.status).toLowerCase();
            if (!DROPPED_STATUSES.has(status)) return true;
            console.warn(`Warning: ${c.liquipedia} is ${status} on Liquipedia; its config in data/events/ is skipped.`);
            return false;
        })
        .map((c): CatalogEvent => {
            const row = rowByPage.get(c.liquipedia);
            const invites = c.invites ?? inviteRuleFromPlacements(ctx.placementRows, c.liquipedia) ?? undefined;
            const tier = tierOf(row);
            const config: EventConfig = {
                ...c,
                ...(tier !== null && c.tier === undefined ? { tier } : {}),
                location: c.location ?? (row ? locationOf(row, ctx.countryRegion) : undefined),
                ...(invites ? { invites } : {}),
            };
            const prizePool = Number(row?.prizepool) || 0;
            const teams = Number(row?.participantsnumber) || exitLabels(c).flatMap(labelPositions).reduce((a, b) => Math.max(a, b), 0);
            const { prizes, prizeSource, estimated } = resolvePrizes(config, tier, prizePool, teams, ctx);
            if (estimated) {
                config.prizeEstimate = estimated;
                config.assumed = [...new Set([...(c.assumed ?? []), "prizes" as const])];
            }
            const announced = announcedTeams(ctx.placementRows, c.liquipedia, ctx.pages);
            const announcedVia = announcedSlots(ctx.placementRows, c.liquipedia, ctx.pages);
            const publisherTier = str(row?.publishertier);
            const ranked = row ? isRanked(row, ctx.rankedRules ?? NO_RANKED_RULES) : true;
            const kind: EventKind = c.lan ? "lan" : "online";
            const role = row ? roleOf(row) : "main";
            const series = str(row?.seriespage);
            return {
                config,
                generic: false,
                tier,
                prizePool,
                prizes,
                prizeSource,
                announced,
                announcedVia,
                teams,
                publisherTier,
                ranked,
                kind,
                role,
                ...(series ? { series } : {}),
                ...(row && organizerOf(row) ? { organizer: organizerOf(row) } : {}),
                simulated: true,
            };
        });

    const configuredPages = configs.map((c) => c.liquipedia);
    const pastTeams = pastTeamCounts(tournamentRows, today);
    const targetOf = qualifierTargets(ctx.placementRows, new Set([...rowByPage.keys(), ...projected.map((p) => str(p.row.pagename))]));
    const info = (r: RawRow): GenericInfo => ({ pastTeams: pastTeams(r), ...(roleOf(r) === "qualifier" ? { qualifies: targetOf(str(r.pagename)) } : {}) });
    const generic = genericRows(tournamentRows, configuredPages, today, until, ctx.rankedRules, scope).map((r) => genericEvent(r, ctx, info(r)));
    const projections = projected
        .filter((p) => scope === "all" || (kindOf(p.row) === "lan" && roleOf(p.row) === "main"))
        .map(({ row, basis, chance }): CatalogEvent => {
            const e = genericEvent(row, ctx, info(row));
            return { ...e, config: { ...e.config, assumed: [...(e.config.assumed ?? []), "dates"] }, projection: { ...basis, chance } };
        });
    const standIns = unannounced
        .filter((u) => scope === "all" || (kindOf(u.row) === "lan" && roleOf(u.row) === "main"))
        .map(({ row, chance }): CatalogEvent => {
            const e = genericEvent(row, ctx, info(row));
            return { ...e, config: { ...e.config, assumed: [...(e.config.assumed ?? []), "dates"] }, unannounced: { chance } };
        });
    const all = [...configured, ...generic, ...projections, ...standIns].sort(
        (a, b) => a.config.startDate.localeCompare(b.config.startDate) || a.config.slug.localeCompare(b.config.slug)
    );
    const used = new Set<string>();
    for (const e of all) {
        let slug = e.config.slug;
        for (let k = 2; used.has(slug); k++) slug = `${e.config.slug}-${k}`;
        used.add(slug);
        if (slug !== e.config.slug) e.config = { ...e.config, slug };
    }
    return all;
};
