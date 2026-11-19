import type { Matchdata } from "../vrs/buildMatchdata.ts";

export {
    conflicts,
    CROSS_REGION_BUFFER,
    feasibleMasks,
    feasibleSets,
    fits,
    ONLINE_CONCURRENCY,
    SAME_REGION_BUFFER,
    type Caps,
    type EventKind,
    type Stint,
} from "../../../src/sim/schedule.ts";

export interface VolumeBaselines {
    /** LAN events per `horizonDays` at p25 / p50 / p75. */
    low: number;
    average: number;
    high: number;
    horizonDays: number;
    teamsCounted: number;
}

const BASELINE_WINDOW_DAYS = 180;

/** A Major's Stage 1 and Stage 2 pages count as the Major itself. */
const parentEvent = (eventId: string) => eventId.replace(/\/Stage_[12]$/, "");

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

/** LAN events per team over the last 180 days for `teamIds`, at p25 / p50 / p75, scaled to `horizonDays`. */
export const volumeBaselines = (matchdata: Matchdata, teamIds: string[], asOf: string, horizonDays: number): VolumeBaselines => {
    const end = Date.parse(`${asOf}T23:59:59Z`) / 1000;
    const start = end - BASELINE_WINDOW_DAYS * 86400;
    const lan = new Set(matchdata.events.filter((e) => e.lan).map((e) => String(e.eventId)));
    const wanted = new Set(teamIds);
    const events = new Map<string, Set<string>>(teamIds.map((t) => [t, new Set()]));
    for (const m of matchdata.matches) {
        if (m.matchStartTime < start || m.matchStartTime > end || !lan.has(String(m.eventId))) continue;
        for (const id of [String(m.team1Id), String(m.team2Id)]) {
            if (wanted.has(id)) events.get(id)!.add(parentEvent(String(m.eventId)));
        }
    }
    const counts = [...events.values()].map((s) => s.size).sort((a, b) => a - b);
    const scale = horizonDays / BASELINE_WINDOW_DAYS;
    const at = (q: number) => Math.max(1, Math.round(quantile(counts, q) * scale));
    return { low: at(0.25), average: at(0.5), high: at(0.75), horizonDays, teamsCounted: counts.length };
};
