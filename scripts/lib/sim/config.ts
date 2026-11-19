import fs from "node:fs";
import path from "node:path";

import type { StageFormat } from "../../../src/sim/types.ts";
import type { Region } from "../../../src/vrs/types.ts";

export type { StageFormat };

/** Valve standings list a slot invites from; the two sub-regions walk the Americas list. */
export type VrsList = "Global" | Region | "North America" | "South America";

export interface InviteRule {
    /** `month` is the list's publication month, `YYYY-MM`; `startRank` is the first global rank the organizer may invite. */
    slots: { list: VrsList; month: string; count: number; startRank?: number }[];
    qualifiers: { label: string; count: number }[];
    /** True when hand-keyed from the organizer's announcement, false when parsed from Liquipedia's `qualifier` strings. */
    verified: boolean;
}

export type Assumption = "format" | "prizes" | "field" | "teams" | "dates";

export interface BracketMatch {
    id: string;
    /** Seed (`s1`, 1-based) or an earlier match's winner or loser (`w:<id>`, `l:<id>`). */
    teams: [string, string];
    bestOf?: number;
}

export interface StageConfig {
    id: string;
    name: string;
    /** Liquipedia page holding this stage's matches. */
    page: string;
    /** Liquipedia match `section`s that belong to this stage, when several stages share a page. */
    sections?: string[];
    format: StageFormat;
    /** `decider` applies to Swiss advancement and elimination matches; `final` to the last match of an elimination bracket; `largeRound` to single-elimination rounds of more than `LARGE_ROUND` matches. */
    bestOf: { default: number; decider?: number; final?: number; largeRound?: number };
    /** Team pages entering this stage directly, in seed order. */
    invited?: string[];
    /** Major stage this one is (1–3) in the matching `invites-*.json` slot split; fills an empty `invited` from Valve's snapshot. */
    vrsStage?: 1 | 2 | 3;
    /** Stages whose advancing teams enter this one, seeded after `invited` in the order given. */
    from?: string | string[];
    /** Teams advancing out of this stage; 0 for the stage that decides the winner. */
    advance: number;
    wins?: number;
    losses?: number;
    groups?: number;
    /** Explicit group draw (team pages, seed order within each group); otherwise seeds snake across `groups`. */
    groupTeams?: string[][];
    /** `bracket` format: every match in play order. */
    matches?: BracketMatch[];
    /** `bracket` format: results that advance, in seed order for the next stage. */
    qualify?: string[];
    /** Format exit key (see each format) → placement label in the parent event's prize table; `advance` labels the teams that advance. */
    exits: Record<string, string>;
}

export interface EventConfig {
    slug: string;
    name: string;
    /** Parent Liquipedia page: the prize table, and the VRS event id after rollups. */
    liquipedia: string;
    startDate: string;
    endDate: string;
    lan: boolean;
    /** Liquipedia tier, from the tournament row; sets the predictor's tier temperature. */
    tier?: number;
    /** Best-of → who acts at each veto step before the decider (`F` bans first, the lower seed); defaults in the veto model. */
    vetoOrder?: Record<number, string>;
    stages: StageConfig[];
    /** `region` is null when the country is unknown or outside Valve's three regions. */
    location?: { region: Region | null; country: string };
    /** Hand-keyed rule; otherwise the catalog parses one from Liquipedia's participant rows. */
    invites?: InviteRule;
    /** Placement label → USD per team, for events with no Liquipedia prize table. */
    prizeEstimate?: Record<string, number>;
    /** What the season simulation guessed rather than read. */
    assumed?: Assumption[];
}

export const EVENTS_DIR = path.resolve("data/events");

export const loadEventConfigs = (dir = EVENTS_DIR): EventConfig[] =>
    fs.existsSync(dir)
        ? fs
              .readdirSync(dir)
              .filter((f) => f.endsWith(".json") && !f.startsWith("invites-"))
              .sort()
              .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EventConfig)
        : [];
