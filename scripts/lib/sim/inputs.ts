import fs from "node:fs";
import type { ValvePlayer } from "../vrs/buildMatchdata.ts";
import { isCoachRole } from "./vrsProjection.ts";

export const readJson = <T>(file: string, fallback: T): T =>
    fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback;

export interface SquadRow {
    pagename: string;
    link: string;
    role?: string;
    objectname?: string;
}

/** Players of each team's current Liquipedia squad, coaches dropped; empty when the store predates `objectname`. */
export const readSquadRows = (file = "data/raw/squads.json"): SquadRow[] => {
    const stored = readJson<{ rows: SquadRow[] }>(file, { rows: [] }).rows;
    // Without `objectname` the store kept one player per team, which would fail every roster's intact check.
    if (stored.every((r) => r.objectname)) return stored.filter((r) => !isCoachRole(r.role));
    console.warn(`${file} is incomplete; ignoring squads until the next fetch-liquipedia.`);
    return [];
};

/** Liquipedia team page → the team id its lineup is stored under, trying earlier names of a renamed team. */
export const teamIdResolver = (
    teamIdOf: (page: string) => string,
    lineups: Map<string, { name: string; players: ValvePlayer[] }>,
    previousNames: Map<string, string[]>
) => (page: string): string => {
    const direct = teamIdOf(page);
    if (lineups.has(direct)) return direct;
    for (const prev of previousNames.get(page) ?? []) {
        const candidate = teamIdOf(prev);
        if (lineups.has(candidate)) return candidate;
    }
    return direct;
};

/** Team → lower-cased player links and nicks of its current squad, for `makeIntactCheck`. */
export const squadSets = (rows: SquadRow[], nickOf: (link: string) => string | undefined): Map<string, Set<string>> => {
    const squads = new Map<string, Set<string>>();
    for (const { pagename, link } of rows) {
        const team = pagename.replace(/_/g, " ");
        if (!squads.has(team)) squads.set(team, new Set());
        squads.get(team)!.add(link.toLowerCase());
        const nick = nickOf(link);
        if (nick) squads.get(team)!.add(nick.toLowerCase());
    }
    return squads;
};

export const squadsByTeamId =(rows: SquadRow[], resolveTeamId: (page: string) => string): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const { pagename, link } of rows) {
        const id = resolveTeamId(pagename.replace(/_/g, " "));
        out.set(id, [...(out.get(id) ?? []), link]);
    }
    return out;
};
