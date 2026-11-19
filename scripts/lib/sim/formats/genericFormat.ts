import type { StageConfig } from "../config.ts";

export type EventRole = "main" | "qualifier";

const GROUP_SIZE = 4;
const ADVANCE_PER_GROUP = 2;

const nextPowerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(n, 1)));
const range = (from: number, to: number) => (from === to ? `${from}` : `${from}-${to}`);

/** Exit labels of a single-elimination bracket of `teams` (byes for the top seeds) played down to `advance` teams. */
const eliminationExits = (teams: number, advance: number, offset = 0): Record<string, string> => {
    const size = nextPowerOfTwo(teams);
    const exits: Record<string, string> = {};
    for (let round = 1, alive = size; alive > Math.max(advance, 1); round++, alive /= 2) {
        const last = round === 1 ? teams : alive;
        exits[`r${round}`] = range(offset + alive / 2 + 1, offset + last);
    }
    if (advance === 0) exits.champion = range(offset + 1, offset + 1);
    else exits.advance = range(offset + 1, offset + advance);
    return exits;
};

/** Labels for round-robin `pos<p>` exits once `advance` per group go through; groups are the snake draw's sizes. */
const groupExits = (teams: number, groups: number): Record<string, string> => {
    const sizes = Array.from({ length: groups }, (_, k) => Math.floor(teams / groups) + (k < teams % groups ? 1 : 0));
    const exits: Record<string, string> = {};
    let next = groups * ADVANCE_PER_GROUP + 1;
    for (let pos = ADVANCE_PER_GROUP + 1; pos <= Math.max(...sizes); pos++) {
        const count = sizes.filter((s) => s >= pos).length;
        exits[`pos${pos}`] = range(next, next + count - 1);
        next += count;
    }
    return exits;
};

/** Bo3 stages for an event with no hand-written format; a qualifier's slots round down to a power of two. */
export const genericStages = (page: string, teams: number, role: EventRole, qualifying = 1): StageConfig[] => {
    const base = { page, invited: [] as string[] };
    if (teams < 2) return [];
    if (teams <= 3) {
        const exits = Object.fromEntries(Array.from({ length: teams }, (_, k) => [`pos${k + 1}`, `${k + 1}`]));
        return [{ ...base, id: "main", name: "Round robin", format: "round_robin", bestOf: { default: 3 }, advance: 0, exits }];
    }
    if (role === "qualifier") {
        const slots = 2 ** Math.floor(Math.log2(Math.max(1, Math.min(qualifying, teams - 1))));
        return [
            {
                ...base,
                id: "main",
                name: "Single elimination",
                format: "single_elim",
                bestOf: { default: 3, largeRound: 1 },
                advance: slots,
                exits: eliminationExits(teams, slots),
            },
        ];
    }
    const groups = Math.max(1, Math.round(teams / GROUP_SIZE));
    const playoffTeams = groups * ADVANCE_PER_GROUP;
    return [
        { ...base, id: "groups", name: "Group stage", format: "round_robin", bestOf: { default: 3 }, groups, advance: playoffTeams, exits: groupExits(teams, groups) },
        {
            page,
            id: "playoffs",
            name: "Playoffs",
            format: "single_elim",
            bestOf: { default: 3 },
            from: "groups",
            advance: 0,
            exits: eliminationExits(playoffTeams, 0),
        },
    ];
};
