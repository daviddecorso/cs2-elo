import type { BracketSlot, StageBracket } from "../../../src/sim/types.ts";
import type { EventConfig } from "./config.ts";
import type { EventSummary, SlotTally } from "./simulate.ts";

// Enough for a 16-team opening Swiss pool and its 8 matches.
const MAX_TEAMS = 16;
const MAX_MATCHUPS = 8;
const MIN_SHARE = 0.005;

const share = (count: number, n: number) => Math.round((count / n) * 10000) / 10000;

const slotView = (tally: SlotTally, n: number): BracketSlot => {
    const teams = [...tally.here]
        .map(([team, here]) => ({ team, here: share(here, n), win: share(tally.won.get(team) ?? 0, n) }))
        .filter((t) => t.here >= MIN_SHARE)
        .sort((a, b) => b.here - a.here || b.win - a.win)
        .slice(0, MAX_TEAMS);
    const matchups = [...tally.pairs]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_MATCHUPS)
        .map(([key, count]) => ({ teams: key.split("|") as [string, string], p: share(count, n) }))
        .filter((m) => m.p >= MIN_SHARE);
    const { locked } = tally;
    return {
        id: tally.slot,
        round: tally.round,
        lane: tally.lane,
        bestOf: tally.bestOf,
        reach: share(tally.runs, n),
        teams,
        matchups,
        ...(locked && tally.runs === n ? { results: locked.map(({ teams, winner }) => ({ teams, winner })) } : {}),
    };
};

export const stageBrackets = (config: EventConfig, summary: EventSummary): StageBracket[] => {
    const tallies = [...summary.slots.values()];
    return config.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        format: stage.format,
        slots: tallies.filter((t) => t.stage === stage.id).map((t) => slotView(t, summary.n)),
    }));
};
