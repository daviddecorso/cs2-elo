import type { Region } from "../../../src/vrs/types.ts";
import type { RawRow } from "../elo/normalize.ts";
import type { Matchdata, Overrides, ValveEvent, ValveMatch, ValvePlayer } from "../vrs/buildMatchdata.ts";
import { isSplitStagePage, splitMajorStages } from "../vrs/majorStages.ts";
import type { EventConfig } from "./config.ts";
import type { EventOutcome } from "./simulate.ts";
import type { TeamId } from "./types.ts";

export interface ProjectionEvent {
    config: EventConfig;
    /** The event id `buildMatchdata` gives this event's matches. */
    eventId: string;
    prizePool: string;
    /** Placement label → USD. */
    prizes: Map<string, number>;
    major?: boolean;
}

export interface ProjectedRoster {
    rosterKey: string;
    teamName: string;
    region: Region;
    regionalRank: number | null;
    points: number;
    players: string[];
}

/** Placement label → prize from the event's Liquipedia prize table; null when no row carries prize money yet. */
export const prizeTable = (placements: RawRow[], page: string): Map<string, number> | null => {
    const table = new Map<string, number>();
    for (const row of placements) {
        if (row.pagename !== page || typeof row.placement !== "string") continue;
        const prize = Number(row.prizemoney) || 0;
        table.set(row.placement, Math.max(table.get(row.placement) ?? 0, prize));
    }
    return [...table.values()].some((p) => p > 0) ? table : null;
};

/** Labels the config can produce that the prize table doesn't list. */
export const missingPrizeLabels = (config: EventConfig, prizes: Map<string, number>): string[] => [
    ...new Set(config.stages.flatMap((s) => Object.values(s.exits)).filter((label) => !prizes.has(label))),
];

export const canonicalTeamId = (overrides: Overrides) => (page: TeamId): string =>
    overrides.teamAliases?.[page]?.targetTeamId ?? page;

export const canonicalEventId = (overrides: Overrides, page: string): string =>
    overrides.eventRollups?.[page]?.parentEventId ?? page;

/** Each team's most recent lineup in the model input, so simulated matches continue the same Valve roster. */
export const latestLineups = (
    matchdata: Matchdata,
    before = Infinity
): Map<string, { name: string; players: ValvePlayer[] }> => {
    const latest = new Map<string, { t: number; name: string; players: ValvePlayer[] }>();
    for (const m of matchdata.matches) {
        if (m.matchStartTime >= before) continue;
        for (const [id, name, players] of [
            [m.team1Id, m.team1Name, m.team1Players],
            [m.team2Id, m.team2Name, m.team2Players],
        ] as const) {
            const prev = latest.get(String(id));
            if (!prev || m.matchStartTime >= prev.t) latest.set(String(id), { t: m.matchStartTime, name, players });
        }
    }
    return new Map([...latest].map(([id, { name, players }]) => [id, { name, players }]));
};

const playerKey = (id: string | number) => String(id).replace(/ /g, "_").toLowerCase();

/** Teams often change a player just before an event, so a complete current squad keeping 3+ of the last lineup replaces it. */
export const preferSquads = (
    matchdata: Matchdata,
    lineups: Map<string, { name: string; players: ValvePlayer[] }>,
    squads: Map<string, string[]>
): number => {
    const players = new Map<string, ValvePlayer>();
    for (const m of matchdata.matches) for (const p of [...m.team1Players, ...m.team2Players]) players.set(playerKey(p.playerId), p);
    let swapped = 0;
    for (const [teamId, squad] of squads) {
        const lineup = lineups.get(teamId);
        const resolved = squad.map((link) => players.get(playerKey(link)));
        if (!lineup || resolved.length !== 5 || resolved.some((p) => !p)) continue;
        const kept = resolved.filter((p) => lineup.players.some((q) => q.playerId === p!.playerId)).length;
        if (kept < 3 || kept === 5) continue;
        lineups.set(teamId, { name: lineup.name, players: resolved as ValvePlayer[] });
        swapped++;
    }
    return swapped;
};

const dayStart =(date: string) => Date.parse(`${date}T12:00:00Z`) / 1000;

/** One simulation's matches and prize table for each event; played matches are already in the model input unless `includeLocked`. */
export const simulationDelta = (
    events: ProjectionEvent[],
    outcomes: EventOutcome[],
    lineups: Map<string, { name: string; players: ValvePlayer[] }>,
    teamIdOf: (page: TeamId) => string,
    includeLocked = false
): { matches: ValveMatch[]; events: ValveEvent[] } => {
    const matches: ValveMatch[] = [];
    const valveEvents: ValveEvent[] = [];
    events.forEach((ev, i) => {
        const outcome = outcomes[i];
        const { config } = ev;
        const start = dayStart(config.startDate);
        const span = Math.max(dayStart(config.endDate) - start, 0);
        const splitStages = ev.major ? config.stages.filter((s) => isSplitStagePage(s.page)) : [];
        const stageEventId = (stage: (typeof config.stages)[number]) =>
            splitStages.includes(stage) ? stage.page : ev.eventId;
        config.stages.forEach((stage, s) => {
            const stageMatches = outcome.matches.filter((m) => m.stage === stage.id);
            stageMatches.forEach((m, k) => {
                if (m.locked && !includeLocked) return;
                const [a, b] = m.teams.map(teamIdOf);
                const la = lineups.get(a);
                const lb = lineups.get(b);
                if (!la || !lb) throw new Error(`${config.slug}: no lineup for ${la ? b : a}`);
                matches.push({
                    matchStartTime: m.t ?? Math.round(start + ((s + k / stageMatches.length) / config.stages.length) * span),
                    team1Id: a,
                    team2Id: b,
                    team1Name: la.name,
                    team2Name: lb.name,
                    team1Players: la.players,
                    team2Players: lb.players,
                    eventId: stageEventId(stage),
                    winningTeam: m.winner === 0 ? 1 : 2,
                    valveRanked: true,
                    forfeited: false,
                });
            });
        });
        const parent: ValveEvent = {
            eventId: ev.eventId,
            eventName: config.name,
            prizePool: ev.prizePool,
            lan: config.lan,
            finished: true,
            endDate: config.endDate,
            prizeDistribution: [...outcome.placements].map(([team, label]) => ({
                teamId: teamIdOf(team),
                placement: Number(/^\d+/.exec(label)?.[0] ?? 99),
                prize: ev.prizes.get(label) ?? 0,
                clubShare: 0,
                qualifiedEvents: [],
            })),
        };
        if (splitStages.length === 0) {
            valveEvents.push(parent);
            return;
        }
        const exitStage = new Map<string, string>();
        for (const [team, label] of outcome.placements) {
            const stage = splitStages.find((s) => Object.values(s.exits).includes(label));
            if (stage) exitStage.set(teamIdOf(team), stage.page);
        }
        valveEvents.push(
            ...splitMajorStages(
                parent,
                splitStages.map((s) => ({ eventId: s.page, eventName: `${config.name}: ${s.name}`, finished: true })),
                (teamId) => exitStage.get(teamId) ?? null
            )
        );
    });
    return { matches, events: valveEvents };
};

/** The model input with simulated events replacing any partial entries for the same event ids. */
export const applyDelta = (base: Matchdata, delta: { matches: ValveMatch[]; events: ValveEvent[] }): Matchdata => {
    const replaced = new Set(delta.events.map((e) => String(e.eventId)));
    return {
        matches: delta.matches.length ? [...base.matches, ...delta.matches] : base.matches,
        events: [...base.events.filter((e) => !replaced.has(String(e.eventId))), ...delta.events],
    };
};
