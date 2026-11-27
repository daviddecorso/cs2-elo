import fs from "node:fs";
import path from "node:path";
import { EloEngine, makeSkillLookup, type LuckLookup, type LuckRow, type PlayerSkill, type SkillLookup } from "./engine.ts";
import type { EloParams } from "./params.ts";
import type { EloPlayers } from "./types.ts";

/** Committed outputs of `cs2wp luck`, refreshed by hand after a PC rerun: the `value` luck variant and the player skill timeline. */
export const LIVE_LUCK_PATH = path.resolve(import.meta.dirname, "../../../data/elo/luck-live.jsonl");
export const PLAYER_SKILL_PATH = path.resolve(import.meta.dirname, "../../../data/elo/player-skill.json");

/** Keyed by match2id, which is the last `:` segment of a series id. */
export const makeLuckLookup = (rows: Map<string, LuckRow>): LuckLookup => (id, index) =>
    rows.get(`${id.slice(id.lastIndexOf(":") + 1)}:${index}`);

let luckCache: LuckLookup | undefined;
let skillCache: PlayerSkill | undefined;
const skillLookups = new Map<number, SkillLookup>();

/** The luck and skill lookups the live `luckWeight` and `skillWeight` read; θ decays with `skillHalfLife` days. */
export function liveAdjustments(skillHalfLife = 0): [LuckLookup, SkillLookup] {
    luckCache ??= loadLuck();
    skillCache ??= JSON.parse(fs.readFileSync(PLAYER_SKILL_PATH, "utf8")) as PlayerSkill;
    let skill = skillLookups.get(skillHalfLife);
    if (!skill) skillLookups.set(skillHalfLife, (skill = makeSkillLookup(skillCache, skillHalfLife)));
    return [luckCache, skill];
}

/** Every production run builds its engine here, so the live params always see their luck and skill data. */
export const liveEngine = (params: EloParams, players: EloPlayers) =>
    new EloEngine(params, players, ...liveAdjustments(params.skillHalfLife));

function loadLuck(): LuckLookup {
    const rows = new Map<string, LuckRow>();
    for (const line of fs.readFileSync(LIVE_LUCK_PATH, "utf8").split("\n")) {
        if (!line) continue;
        const { match2id, index, xMargin, yHat, reliability } = JSON.parse(line) as { match2id: string; index: number } & LuckRow;
        rows.set(`${match2id}:${index}`, { xMargin, yHat, reliability });
    }
    return makeLuckLookup(rows);
}
