import { formatCallout } from "./heatmap.ts";
import type { GrenadeType, HeatmapSide } from "./heatmapTypes.ts";
import type {
    ProtocolClass,
    ProtocolLeagueMap,
    ProtocolLeagueZone,
    ProtocolTeam,
    ProtocolTeamSide,
    ProtocolThrower,
} from "./protocolTypes.ts";

export const GRENADE_LABEL: Record<GrenadeType, string> = {
    smoke: "Smoke",
    flash: "Flash",
    he: "HE",
    molotov: "Molotov",
};

/** Rows under this team rate are hidden unless the team clearly differs from the league or "Show all" is on. */
export const MIN_SHOWN_RATE = 0.1;

export interface ProtocolRow {
    zone: ProtocolLeagueZone;
    label: string;
    rate: number;
    hits: number;
    league: number;
    diff: number | null;
    lo: number | null;
    hi: number | null;
    /** The 90% interval excludes zero. */
    differs: boolean;
    tMed: number | null;
    leagueTMed: number | null;
    bins: number[];
    throwers: ProtocolThrower[];
}

export const zoneLabel = (zone: Pick<ProtocolLeagueZone, "type" | "place" | "name">): string =>
    zone.name ?? `${GRENADE_LABEL[zone.type]} ${zone.place ? formatCallout(zone.place) : "(no callout)"}`;

export const zoneTooltip = (zone: Pick<ProtocolLeagueZone, "place" | "description">): string | null => {
    const place = zone.place ? `Callout: ${formatCallout(zone.place)}` : null;
    if (zone.description && place) return `${zone.description} (${place})`;
    return zone.description ?? place;
};

/** Team zones joined to the league's, ordered like a timeline: by the team's median first throw, else the league's. */
export const protocolRows = (
    teamSide: ProtocolTeamSide | undefined,
    league: ProtocolLeagueMap,
    side: HeatmapSide,
    cls: ProtocolClass
): ProtocolRow[] => {
    const teamClass = teamSide?.classes[cls];
    if (!teamClass) return [];
    const byId = new Map(league.zones.filter((z) => z.side === side).map((z) => [z.id, z]));
    const rows: ProtocolRow[] = [];
    for (const tz of teamClass.zones) {
        const zone = byId.get(tz.id);
        if (!zone) continue;
        const lc = zone.league[cls];
        rows.push({
            zone,
            label: zoneLabel(zone),
            rate: tz.rate,
            hits: tz.hits,
            league: lc?.rate ?? 0,
            diff: tz.diff,
            lo: tz.lo,
            hi: tz.hi,
            differs: tz.lo !== null && tz.hi !== null && (tz.lo > 0 || tz.hi < 0),
            tMed: tz.tMed ?? null,
            leagueTMed: lc?.tMed ?? null,
            bins: tz.bins ?? [],
            throwers: tz.throwers ?? [],
        });
    }
    const order = (r: ProtocolRow) => r.tMed ?? r.leagueTMed ?? Infinity;
    return rows.sort((a, b) => order(a) - order(b) || a.zone.id - b.zone.id);
};

/** A player's own rate on gun rounds at or above this makes the zone part of their protocol. */
export const MIN_PLAYER_RATE = 0.2;

export interface PlayerProtocolZone {
    map: string;
    side: HeatmapSide;
    id: number;
    /** Share of the player's own gun rounds with a throw into the zone. */
    rate: number;
    /** Share of the team's rounds in the zone the player threw into it. */
    share: number;
    teamTMed: number | null;
}

/** Gun-round zones the player throws into on `MIN_PLAYER_RATE` of their rounds, by map order, side, then rate. */
export const playerProtocolZones = (team: ProtocolTeam, steamid: string): PlayerProtocolZone[] => {
    const out: PlayerProtocolZone[] = [];
    for (const m of team.maps) {
        for (const side of ["t", "ct"] as const) {
            const zones = m.sides[side]?.classes.gun?.zones ?? [];
            const mine: PlayerProtocolZone[] = [];
            for (const z of zones) {
                const t = z.throwers?.find(([sid]) => sid === steamid);
                if (t && t[2] >= MIN_PLAYER_RATE) {
                    mine.push({ map: m.map, side, id: z.id, rate: t[2], share: t[1], teamTMed: z.tMed ?? null });
                }
            }
            out.push(...mine.sort((a, b) => b.rate - a.rate));
        }
    }
    return out;
};

export const visibleRows = (rows: ProtocolRow[], showAll: boolean): ProtocolRow[] =>
    showAll ? rows : rows.filter((r) => r.rate >= MIN_SHOWN_RATE || (r.differs && r.league >= MIN_SHOWN_RATE));

/** Outliers need this many of the team's rounds in the class, so a few maps can't flag a zone. */
export const MIN_OUTLIER_ROUNDS = 30;
/** Smallest difference from the league worth calling out, as a share of rounds. */
export const MIN_OUTLIER_DIFF = 0.1;

export type Outlier = "more" | "less";

/** The team clearly over- or under-uses the zone: the interval excludes zero, the gap is large and the sample is big enough. */
export const outlier = (row: ProtocolRow, classRounds: number): Outlier | null => {
    if (!row.differs || row.diff === null || classRounds < MIN_OUTLIER_ROUNDS) return null;
    if (Math.abs(row.diff) < MIN_OUTLIER_DIFF || Math.max(row.rate, row.league) < MIN_SHOWN_RATE) return null;
    return row.diff > 0 ? "more" : "less";
};

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** Percentage points with a sign, e.g. `+4.9`. */
export const pp = (v: number): string => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v * 100).toFixed(1)}`;

export const seconds = (v: number | null): string => (v === null ? "—" : `${v < 10 ? v.toFixed(1) : Math.round(v)}s`);

export const binLabels = (edges: number[]): string[] => [
    ...edges.map((e, i) => `${i === 0 ? 0 : edges[i - 1]}–${e}s`),
    `${edges[edges.length - 1]}s+`,
];
