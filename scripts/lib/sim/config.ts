import fs from "node:fs";
import path from "node:path";

import type { StageFormat } from "../../../src/sim/types.ts";

export type { StageFormat };

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
    /** `decider` applies to Swiss advancement and elimination matches; `final` to the last match of an elimination bracket. */
    bestOf: { default: number; decider?: number; final?: number };
    /** Team pages entering this stage directly, in seed order. */
    invited?: string[];
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
    /** Format exit key (see each format) → placement label in the parent event's prize table. */
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
    stages: StageConfig[];
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
