import type { Region, Roster } from "../../../src/vrs/types.ts";
import { teamPage, type RawRow } from "../elo/normalize.ts";
import type { EventConfig, StageConfig } from "./config.ts";
import { REGIONS, type InviteConfig, type InviteStage } from "./invites.ts";

export interface ResolveContext {
    matchRows: RawRow[];
    placementRows: RawRow[];
    invites: InviteConfig[];
    /** Valve's published standings at a snapshot date, or null when it isn't in the vendored repo. */
    snapshot: (date: string) => Roster[] | null;
}

export interface ResolvedEvent {
    config: EventConfig;
    /** Stage id → `config`, `draw` or `vrs <date>`. */
    sources: Record<string, string>;
    /** Why stages left pending couldn't be filled. */
    unresolved: string[];
    /** Participant's current team page → its earlier pages, from Liquipedia's `opponentaliases`. */
    previousNames: Map<string, string[]>;
}

/** Earlier pages per participant of `parent`, so a renamed team keeps the rating built under its old page. */
export const previousNames = (placementRows: RawRow[], parent: string, pages: Map<string, string>): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const row of placementRows) {
        if (row.parent !== parent || row.opponenttype !== "team" || !row.opponenttemplate) continue;
        const current = pages.get(String(row.opponenttemplate).toLowerCase()) ?? String(row.opponentname);
        const aliases = Object.values(((row.extradata ?? {}) as RawRow).opponentaliases ?? {}).map((t) => String(t).toLowerCase());
        const earlier = [String(row.opponentname), ...aliases.map((t) => pages.get(t)).filter((p): p is string => !!p)];
        const names = [...new Set(earlier)].filter((n) => n && n !== current && n !== "TBD");
        if (names.length) out.set(current, names);
    }
    return out;
};

const opponents = (m: RawRow): RawRow[] => (Array.isArray(m.match2opponents) ? (m.match2opponents as RawRow[]) : []);
const isSeed = (ref: string) => /^s\d+$/.test(ref);

/** Liquipedia team template → team page, as the Elo feed keys teams. */
export const templatePages = (matchRows: RawRow[]): Map<string, string> => {
    const pages = new Map<string, string>();
    for (const m of matchRows) {
        for (const o of opponents(m)) {
            const tt = o.teamtemplate as RawRow | undefined;
            if (tt?.template && tt.page) pages.set(String(tt.template).toLowerCase(), String(tt.page));
        }
    }
    return pages;
};

/** Seeds from round 1 of a posted bracket: the config's all-seed matches, in order, against Liquipedia's first round-1 matches (or matchlist opening rows) by `match2id`. */
export const drawSeeds = (stage: StageConfig, matchRows: RawRow[]): string[] | string => {
    const seedMatches = (stage.matches ?? []).filter((m) => m.teams.every(isSeed));
    if (seedMatches.length === 0) return "no all-seed matches in config";
    const bracketById = new Map<string, RawRow>();
    const matchlistById = new Map<string, RawRow>();
    for (const m of matchRows) {
        if (m.pagename !== stage.page) continue;
        if (stage.sections && !stage.sections.includes(String(m.section ?? ""))) continue;
        const id = String(m.match2id ?? "");
        if (/_R0*1-M\d+$/.test(id)) bracketById.set(id, m);
        else if (/_\d+$/.test(id)) matchlistById.set(id, m);
    }
    const source = bracketById.size > 0 ? bracketById : matchlistById;
    const round1 = [...source.values()].sort((a, b) => String(a.match2id).localeCompare(String(b.match2id)));
    if (round1.length < seedMatches.length) return "draw not posted";

    const seeds: string[] = [];
    for (let i = 0; i < seedMatches.length; i++) {
        const opps = opponents(round1[i]);
        if (opps.length !== 2 || opps.some((o) => String(o.template ?? "").toLowerCase() === "tbd")) return "draw not posted";
        seedMatches[i].teams.forEach((ref, side) => {
            seeds[Number(ref.slice(1)) - 1] = teamPage(opps[side]);
        });
    }
    if (seeds.some((t) => !t || t === "TBD")) return "draw not posted";
    if (seeds.length !== seedMatches.length * 2 || new Set(seeds).size !== seeds.length) return "draw doesn't fill every seed once";
    return seeds;
};

const regionOf = (qualifier: unknown): Region | null => {
    const m = /VRS (Europe|Americas|Asia)\b/.exec(String(qualifier ?? ""));
    return m ? (m[1] as Region) : null;
};

const playersOf = (row: RawRow): Set<string> => {
    const out = new Set<string>();
    const players = (row.opponentplayers ?? {}) as Record<string, unknown>;
    for (let i = 1; i <= 5; i++) {
        for (const key of [`p${i}`, `p${i}dn`]) if (players[key]) out.add(String(players[key]).toLowerCase());
    }
    return out;
};

/** Major stage lists from Liquipedia's participants, ordered by Valve's published standings at the invite snapshot. */
export const vrsStages = (
    invite: InviteConfig,
    placementRows: RawRow[],
    standings: Roster[],
    pages: Map<string, string>
): Record<InviteStage, string[]> | string => {
    const previous = invite.previousMajor;
    if (!("slots" in previous)) return `${previous.event} slots not fixed yet`;
    const slots: Record<InviteStage, Record<Region, number>> = { 3: previous.slots.stage3, 2: previous.slots.stage2, 1: invite.stage1 };

    const seen = new Set<string>();
    const participants: Array<{ team: string; region: Region; rank: number }> = [];
    const problems: string[] = [];
    for (const row of placementRows) {
        if (row.parent !== invite.liquipedia || row.pagename !== invite.liquipedia) continue;
        if (!row.opponentname || row.opponentname === "TBD" || row.opponenttype !== "team") continue;
        const team = pages.get(String(row.opponenttemplate ?? "").toLowerCase()) ?? String(row.opponentname);
        if (seen.has(team)) continue;
        seen.add(team);
        const region = regionOf(row.qualifier);
        if (!region) {
            problems.push(`${team} has no VRS qualifier`);
            continue;
        }
        const players = playersOf(row);
        const roster = standings
            .filter((r): r is Roster & { globalRank: number } => r.globalRank !== null)
            .filter((r) => r.players.filter((p) => players.has(p.toLowerCase())).length >= invite.minRetained)
            .sort((a, b) => a.globalRank - b.globalRank)[0];
        if (!roster) {
            problems.push(`${team} matches no ranked roster`);
            continue;
        }
        participants.push({ team, region, rank: roster.globalRank });
    }
    if (problems.length) return problems.join("; ");

    const stages: Record<InviteStage, Array<{ team: string; rank: number }>> = { 3: [], 2: [], 1: [] };
    for (const region of REGIONS) {
        const list = participants.filter((p) => p.region === region).sort((a, b) => a.rank - b.rank);
        const order: InviteStage[] = [3, 2, 1];
        const expected = order.reduce((n, s) => n + slots[s][region], 0);
        if (list.length !== expected) return `${list.length} ${region} participants for ${expected} slots`;
        let next = 0;
        for (const s of order) for (let i = 0; i < slots[s][region]; i++) stages[s].push(list[next++]);
    }
    const ordered = (s: InviteStage) => stages[s].sort((a, b) => a.rank - b.rank).map((p) => p.team);
    return { 3: ordered(3), 2: ordered(2), 1: ordered(1) };
};

/** Fills each stage whose `invited` is `[]` from a posted draw or, for Major stages, Valve's invite snapshot; a non-empty list in the config wins. */
export const resolveParticipants = (config: EventConfig, ctx: ResolveContext): ResolvedEvent => {
    const sources: Record<string, string> = {};
    const unresolved: string[] = [];
    const pages = templatePages(ctx.matchRows);
    const invite = ctx.invites.find((i) => i.liquipedia === config.liquipedia);
    let vrs: Record<InviteStage, string[]> | string | undefined;
    const vrsFor = (inv: InviteConfig) => {
        if (vrs === undefined) {
            const standings = ctx.snapshot(inv.snapshotDate);
            vrs = standings ? vrsStages(inv, ctx.placementRows, standings, pages) : `Valve snapshot ${inv.snapshotDate} not published locally`;
        }
        return vrs;
    };

    const stages = config.stages.map((stage) => {
        if (stage.invited === undefined) return stage;
        if (stage.invited.length) {
            sources[stage.id] = "config";
            return stage;
        }
        if (stage.format === "bracket") {
            const seeds = drawSeeds(stage, ctx.matchRows);
            if (typeof seeds !== "string") {
                sources[stage.id] = "draw";
                return { ...stage, invited: seeds };
            }
            unresolved.push(`${stage.name}: ${seeds}`);
            return stage;
        }
        if (stage.vrsStage && invite) {
            const result = vrsFor(invite);
            if (typeof result !== "string") {
                sources[stage.id] = `vrs ${invite.snapshotDate}`;
                return { ...stage, invited: result[stage.vrsStage] };
            }
            unresolved.push(`${stage.name}: ${result}`);
            return stage;
        }
        unresolved.push(`${stage.name}: no draw or invite source for ${stage.format}`);
        return stage;
    });
    return { config: { ...config, stages }, sources, unresolved, previousNames: previousNames(ctx.placementRows, config.liquipedia, pages) };
};
