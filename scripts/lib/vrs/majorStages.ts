import type { ValveEvent } from "./buildMatchdata.ts";

// HLTV, Valve's source, lists a Major as Stage 1, Stage 2, and Stage 3 with the playoffs, each pooling its own payout.
const SPLIT_STAGE_PAGE = /\/Stage_[12]$/;

export const isMajorTier = (publisherTier: unknown): boolean => publisherTier === "Major Championship";

export const isSplitStagePage = (page: string): boolean => SPLIT_STAGE_PAGE.test(page);

const parsePool = (pool: string): number => Number(pool.replace(/[$,]/g, "")) || 0;

const formatPool = (amount: number): string => `$${Math.round(amount).toLocaleString("en-US")}`;

export interface StageEvent {
    eventId: string;
    eventName: string;
    finished: boolean;
}

/** Moves each team's prize to its exit stage (`stages` in play order) and links each stage to the next. */
export const splitMajorStages = (
    parent: ValveEvent,
    stages: StageEvent[],
    stageOf: (teamId: string) => string | null
): ValveEvent[] => {
    const stageEvents = stages.map(
        (s): ValveEvent => ({
            eventId: s.eventId,
            eventName: s.eventName,
            prizePool: "$0",
            lan: parent.lan,
            finished: s.finished,
            prizeDistribution: [],
        })
    );
    const byId = new Map(stageEvents.map((e) => [String(e.eventId), e]));
    const nextId = (i: number) => String(i + 1 < stages.length ? stages[i + 1].eventId : parent.eventId);

    let moved = 0;
    const kept = [];
    for (const entry of parent.prizeDistribution) {
        const stage = byId.get(stageOf(String(entry.teamId)) ?? "");
        if (!stage) {
            kept.push(entry);
            continue;
        }
        const i = stageEvents.indexOf(stage);
        stage.prizeDistribution.push({ ...entry, qualifiedEvents: [nextId(i)] });
        stage.prizePool = formatPool(parsePool(stage.prizePool) + entry.prize + entry.clubShare);
        moved += entry.prize + entry.clubShare;
    }

    return [
        ...stageEvents,
        {
            ...parent,
            prizePool: formatPool(Math.max(parsePool(parent.prizePool) - moved, 0)),
            prizeDistribution: kept,
        },
    ];
};
