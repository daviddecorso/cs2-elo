import type { FieldSource } from "../../../src/sim/types.ts";
import type { Region } from "../../../src/vrs/types.ts";
import { slotKey } from "./catalog.ts";
import type { InviteRule, VrsList } from "./config.ts";
import { bandOf, type EventFieldModel } from "./fieldModel.ts";
import { makeRng, subSeed } from "./rng.ts";
import type { TeamId } from "./types.ts";

export type Subregion = "North America" | "South America";

/** One roster on a VRS list, as the team page the simulator plays it under. */
export interface ListEntry {
    team: TeamId;
    globalRank: number | null;
    regionalRank: number | null;
    region: Region;
    subregion: Subregion | null;
}

export interface FieldEvent {
    slug: string;
    region: Region | null;
    tier: number | null;
    /** Valve's tier from Liquipedia's `publishertier`; "" when unknown. */
    publisherTier?: string;
    /** Field size. */
    teams: number;
    announced: TeamId[];
    /** Announced team → `slotKey` of the slot it fills, or `direct`. */
    announcedVia: Record<TeamId, string>;
    invites?: InviteRule;
}

export interface FieldEntry {
    team: TeamId;
    source: FieldSource;
}

export interface ResolvedField {
    /** Seed order. */
    field: FieldEntry[];
    /** Slots left open after every list ran out. */
    short: number;
    /** Per VRS slot (`slotKey`), the list rank of the last team to accept; null when nobody did. */
    cutoffs: Record<string, number | null>;
}

/** Turns the deterministic fill into a draw: invites are accepted by chance, open slots drawn by rank band and region. */
export interface FieldSampler {
    /** Each team's draw comes from its own stream of this seed, so forcing one team in changes no other team's draw. */
    seed: number;
    model: EventFieldModel;
    /** Teams drawable beyond the list: recently active unranked teams. */
    unranked: ListEntry[];
    /** Multiplies a team's chance to accept or be drawn; 1 on habit. */
    pace: (team: TeamId) => number;
    /** For reach: this team accepts any offer that reaches it and takes an open slot when it can. */
    forced?: TeamId;
    /** The only teams offered or drawn; everyone when unset. */
    drawable?: Set<TeamId>;
    /** A team's draw weight relative to others in its rank band and region (`affinityWeight`); 1 for all when unset. */
    affinity?: (team: TeamId) => number;
}

/** Qualifier slots tied to simulated events that feed them (`qualifierLinks`). */
export interface LinkedSlots {
    /** Teams that already qualified → the `slotKey` each fills. */
    filled: Map<TeamId, string>;
    /** Per `slotKey`, places held for feeders that play later in the run; never offered or drawn. */
    reserved: Map<string, number>;
}

/** Tournament Operation Requirements §3.8.4: Valve Tier 2 events may only invite from below this global rank. */
export const LOWER_TIER_TOP_RANK = 12;

/** Share of past open attendees that must be ranked no better than a team for its organizer to plausibly invite it on request. */
export const WELCOME_SHARE = 0.5;

/** Whether teams in `band` or below filled at least `WELCOME_SHARE` of past open slots. */
export const welcomes = (bands: number[], band: number) => {
    const total = bands.reduce((a, b) => a + b, 0);
    return total > 0 && bands.slice(band).reduce((a, b) => a + b, 0) / total >= WELCOME_SHARE;
};

/** Valve's tier when known, else Liquipedia's tier as a stand-in. */
export const isLowerTier = (event: FieldEvent) =>
    event.publisherTier ? /^Tier 2/.test(event.publisherTier) : event.tier !== null && event.tier > 1;

const QUALIFIER_LISTS: Array<[RegExp, VrsList]> = [
    [/south americ/i, "South America"],
    [/north americ/i, "North America"],
    [/europe|\bEU\b|\bCIS\b|\bMENA\b/i, "Europe"],
    [/americ/i, "Americas"],
    [/asia|oceania|pacific|\bChina\b|\bOCE\b/i, "Asia"],
];

/** The list a qualifier draws from: its label's region, else the event's region, else the global list. */
export const qualifierList = (label: string, eventRegion: Region | null): VrsList => {
    for (const [pattern, list] of QUALIFIER_LISTS) if (pattern.test(label)) return list;
    return eventRegion ?? "Global";
};

const onList = (e: ListEntry, list: VrsList) => {
    if (list === "Global") return true;
    if (list === "North America" || list === "South America") return e.region === "Americas" && e.subregion === list;
    return e.region === list;
};

const rankOn = (e: ListEntry, list: VrsList): number | null => (list === "Global" || e.region !== list ? e.globalRank : e.regionalRank);

const ordered = (entries: ListEntry[], list: VrsList, startRank = 1) =>
    entries
        .filter((e) => onList(e, list))
        .map((e) => ({ e, rank: rankOn(e, list) }))
        .filter((x): x is { e: ListEntry; rank: number } => x.rank !== null && x.rank >= startRank)
        .sort((a, b) => a.rank - b.rank)
        .map((x) => x.e);

const sameRegion = (e: ListEntry, model: EventFieldModel) =>
    e.region === model.region && (model.subregion === null || e.subregion === null || e.subregion === model.subregion);

/** Fills open slots: invites walk their list passing down on decline; qualifiers take the best remaining roster, or with a sampler are drawn like unexplained slots. */
export const resolveField = (
    event: FieldEvent,
    listFor: (month: string) => ListEntry[],
    seedList: ListEntry[],
    declines: (team: TeamId) => boolean,
    sampler?: FieldSampler,
    linked?: LinkedSlots
): ResolvedField => {
    const taken = new Map<TeamId, FieldSource>(event.announced.map((t) => [t, "announced"]));
    for (const team of linked?.filled.keys() ?? []) if (!taken.has(team)) taken.set(team, "qualifier");
    const linkedFills = [...(linked?.filled.values() ?? [])];
    const filledVia = (key: string) =>
        Object.values(event.announcedVia).filter((k) => k === key).length + linkedFills.filter((k) => k === key).length + (linked?.reserved.get(key) ?? 0);
    const held = [...(linked?.reserved.values() ?? [])].reduce((a, b) => a + b, 0);
    const lowerTier = isLowerTier(event);
    const room = () => event.teams - taken.size - held;
    const eligible = (e: ListEntry) =>
        !taken.has(e.team) && !(lowerTier && e.globalRank !== null && e.globalRank <= LOWER_TIER_TOP_RANK) && !declines(e.team);
    const cutoffs: Record<string, number | null> = {};
    const uniform = (s: FieldSampler, purpose: string, team: TeamId) => makeRng(subSeed(s.seed, `${purpose}|${team}`))();

    const fill = (entries: ListEntry[], count: number, source: FieldSource) => {
        let left = Math.min(count, room());
        for (const e of entries) {
            if (left <= 0) break;
            if (!eligible(e)) continue;
            taken.set(e.team, source);
            left--;
        }
    };

    const offer = (entries: ListEntry[], list: VrsList, count: number, key: string, s: FieldSampler) => {
        let left = Math.min(count, room());
        let last: number | null = null;
        for (const e of entries) {
            if (left <= 0) break;
            if (!eligible(e) || (s.drawable && !s.drawable.has(e.team))) continue;
            const u = uniform(s, key, e.team);
            if (e.team !== s.forced && u >= Math.min(1, s.model.acceptance[bandOf(e.globalRank)] * s.pace(e.team))) continue;
            taken.set(e.team, "vrs");
            last = rankOn(e, list);
            left--;
        }
        cutoffs[key] = last;
    };

    const draw = (purpose: string, count: number, bands: number[], source: FieldSource, s: FieldSampler, forces: boolean) => {
        const k = Math.min(count, room());
        if (k <= 0) return;
        const seen = new Set<TeamId>();
        const pool = [...seedList, ...s.unranked].filter((e) => !seen.has(e.team) && seen.add(e.team) && (!s.drawable || s.drawable.has(e.team)) && eligible(e));
        const regional = s.model.region !== null && s.model.sameRegion !== null;
        const cell = (e: ListEntry) => bandOf(e.globalRank) * 2 + (regional && sameRegion(e, s.model) ? 1 : 0);
        const affinity = (e: ListEntry) => s.affinity?.(e.team) ?? 1;
        // Affinity moves weight between teams of a cell, not between cells, so band and region shares stay as fitted.
        const sizes = new Map<number, number>();
        for (const e of pool) sizes.set(cell(e), (sizes.get(cell(e)) ?? 0) + affinity(e));
        const regionShare = (e: ListEntry) => (!regional ? 1 : sameRegion(e, s.model) ? s.model.sameRegion! : 1 - s.model.sameRegion!);
        // Efraimidis–Spirakis: the k largest log(u) / w are a weighted sample without replacement.
        const keyed = pool.map((e) => {
            const w = (bands[bandOf(e.globalRank)] * regionShare(e) * s.pace(e.team) * affinity(e)) / sizes.get(cell(e))!;
            const u = uniform(s, purpose, e.team);
            // An open slot takes a welcome team even from a band past editions never drew: those teams didn't ask.
            return { e, key: e.team === s.forced && forces && (w > 0 || source === "open") ? Infinity : w > 0 ? Math.log(u) / w : -Infinity };
        });
        for (const { e } of keyed.filter((x) => x.key > -Infinity).sort((a, b) => b.key - a.key).slice(0, k)) taken.set(e.team, source);
    };

    const rule = event.invites ?? sampler?.model.learnedRule ?? undefined;
    const ruled = [...(rule?.slots ?? []), ...(rule?.qualifiers ?? [])].reduce((n, s) => n + s.count - filledVia(slotKey(s)), 0);
    const forcedEntry = sampler?.forced === undefined ? undefined : [...seedList, ...sampler.unranked].find((e) => e.team === sampler.forced);
    // A team the organizer would invite takes an open slot rather than qualifying for one.
    const invitable = !!sampler && !!forcedEntry && room() - ruled > 0 && welcomes(sampler.model.open, bandOf(forcedEntry.globalRank));
    for (const slot of rule?.slots ?? []) {
        const entries = ordered(listFor(slot.month), slot.list, slot.startRank);
        const count = slot.count - filledVia(slotKey(slot));
        if (sampler) offer(entries, slot.list, count, slotKey(slot), sampler);
        else fill(entries, count, "vrs");
    }
    for (const q of rule?.qualifiers ?? []) {
        const count = q.count - filledVia(slotKey(q));
        if (sampler) draw(slotKey(q), count, sampler.model.qualifier, "qualifier", sampler, !invitable);
        else fill(ordered(seedList, qualifierList(q.label, event.region)), count, "qualifier");
    }
    if (sampler) draw("open", room(), sampler.model.open, "open", sampler, invitable);

    const seedRank = new Map(seedList.map((e) => [e.team, e.globalRank ?? Infinity]));
    const field = [...taken]
        .map(([team, source]) => ({ team, source }))
        .sort((a, b) => (seedRank.get(a.team) ?? Infinity) - (seedRank.get(b.team) ?? Infinity));
    return { field, short: Math.max(room(), 0), cutoffs };
};
