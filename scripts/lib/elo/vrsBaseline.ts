import fs from "node:fs";
import path from "node:path";
import { parseStandingsTable } from "../vrs/publishedStandings.ts";
import type { Overrides } from "../vrs/buildMatchdata.ts";
import type { EloPlayers } from "./types.ts";

export interface VrsRoster {
    rank: number;
    points: number;
    teamName: string;
    players: string[];
}

export interface VrsSnapshot {
    date: string;
    rosters: VrsRoster[];
    byNick: Map<string, VrsRoster[]>;
}

export const DEFAULT_VALVE_ROOT = path.resolve(import.meta.dirname, "../../../vendor/counter-strike_regional_standings");

/** Every published global standings table, oldest first; live and invitation snapshots share one timeline. */
export const readGlobalSnapshots = (valveRoot = DEFAULT_VALVE_ROOT): VrsSnapshot[] => {
    const byDate = new Map<string, string>();
    for (const sub of ["invitation", "live"]) {
        const subDir = path.join(valveRoot, sub);
        if (!fs.existsSync(subDir)) continue;
        for (const year of fs.readdirSync(subDir)) {
            const yearDir = path.join(subDir, year);
            if (!fs.statSync(yearDir).isDirectory()) continue;
            for (const f of fs.readdirSync(yearDir)) {
                const match = /^standings_global_(\d{4})_(\d{2})_(\d{2})\.md$/.exec(f);
                if (match) byDate.set(`${match[1]}-${match[2]}-${match[3]}`, path.join(yearDir, f));
            }
        }
    }
    return [...byDate]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, file]) => {
            const rosters = parseStandingsTable(fs.readFileSync(file, "utf8")).map(({ rank, points, teamName, players }) => ({
                rank,
                points,
                teamName,
                players: players.map((p) => p.toLowerCase()),
            }));
            const byNick = new Map<string, VrsRoster[]>();
            for (const r of rosters) {
                for (const nick of r.players) {
                    if (!byNick.has(nick)) byNick.set(nick, []);
                    byNick.get(nick)!.push(r);
                }
            }
            return { date, rosters, byNick };
        });
};

/** Lowercased names a Liquipedia player may appear under in Valve's tables: page name, display nick, and VRS alias nick. */
export const makeNickLookup = (players: EloPlayers, playerAliases: Overrides["playerAliases"] = {}) => (page: string): string[] => {
    const names = new Set([page.toLowerCase()]);
    const nick = players[page]?.nick;
    if (nick) names.add(nick.toLowerCase());
    const alias = playerAliases[page]?.nick ?? (nick ? playerAliases[nick]?.nick : undefined);
    if (alias) names.add(alias.toLowerCase());
    return [...names];
};

/** The snapshot roster sharing at least 3 players with the lineup (Valve's continuity rule), most overlap then most points. */
export const findVrsRoster = (snapshot: VrsSnapshot, lineup: string[], nicksOf: (page: string) => string[]): VrsRoster | null => {
    const overlap = new Map<VrsRoster, number>();
    for (const page of lineup) {
        const hit = new Set<VrsRoster>();
        for (const nick of nicksOf(page)) for (const r of snapshot.byNick.get(nick) ?? []) hit.add(r);
        for (const r of hit) overlap.set(r, (overlap.get(r) ?? 0) + 1);
    }
    let best: VrsRoster | null = null;
    let bestOverlap = 2;
    for (const [r, n] of overlap) {
        if (n > bestOverlap || (n === bestOverlap && best && r.points > best.points)) {
            best = r;
            bestOverlap = n;
        }
    }
    return best;
};

/** Latest snapshot published strictly before the UTC day of `t`, so the baseline never sees the match it predicts. */
export const snapshotBefore = (snapshots: VrsSnapshot[], t: number): VrsSnapshot | null => {
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    let found: VrsSnapshot | null = null;
    for (const s of snapshots) {
        if (s.date >= day) break;
        found = s;
    }
    return found;
};

export const vrsProbability = (pointsDiff: number, scale: number): number => 1 / (1 + 10 ** (-pointsDiff / scale));
