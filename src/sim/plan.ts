import { percent } from "../utils/format.ts";
import type { PlanEventRef, PlanOdds, PlanOption, PlanSchedule, PlanTeamFile, PlanVolume, SeasonIndex } from "./types.ts";

const VOLUME_ORDER: PlanVolume[] = ["low", "average", "high"];
/** Hold-out invite share below which an option's worth is indistinguishable from simulation noise. */
export const NOISE_WORTH = 0.005;

export type PlanRow =
    | { kind: "baseline"; label: string; odds: PlanOdds }
    | { kind: "schedule"; index: number; schedule: PlanSchedule };

const volumeRank = (s: PlanSchedule) => Math.min(...s.bestFor.map((v) => VOLUME_ORDER.indexOf(v)), VOLUME_ORDER.length);

/** `index` is the schedule's position in the file, which `?plan=` refers to. */
export const scheduleRows = (file: PlanTeamFile): PlanRow[] => [
    { kind: "baseline", label: "Season rules", odds: file.baselines.habitual },
    { kind: "baseline", label: "Announced only", odds: file.baselines.lockedOnly },
    ...file.schedules
        .map((schedule, index) => ({ kind: "schedule" as const, index, schedule }))
        .sort((a, b) => volumeRank(a.schedule) - volumeRank(b.schedule) || b.schedule.holdout.invite - a.schedule.holdout.invite),
];

export const defaultSchedule = (file: PlanTeamFile): number => {
    const average = file.schedules.findIndex((s) => s.bestFor.includes("average"));
    return average >= 0 ? average : 0;
};

export interface TimelineEntry {
    event: PlanEventRef;
    status: "locked" | "committed" | "chosen";
    option: PlanOption | null;
    route: string | null;
    /** Hold-out invite share lost by dropping it; null for locked and committed events. */
    worth: number | null;
    noise: boolean;
}

const routeOf = (option: PlanOption, schedule: PlanSchedule): string | null => {
    if (option.kind === "event") return null;
    const branch = schedule.branches.find((b) => b.option === option.id);
    if (!branch) return null;
    const via = option.feeders.map((f) => f.name).join(" or ");
    const qualifying = `via ${via}: enters ${percent(branch.entered)}, qualifies ${percent(branch.qualified)} of those`;
    if (option.kind === "qualify" || branch.invited < NOISE_WORTH) return qualifying;
    return `place in ${percent(branch.invited)} of runs, otherwise ${qualifying}`;
};

export const timeline = (file: PlanTeamFile, schedule: PlanSchedule): TimelineEntry[] => {
    const options = new Map(file.options.map((o) => [o.id, o]));
    const fixed = (status: "locked" | "committed") => (event: PlanEventRef): TimelineEntry => ({ event, status, option: null, route: null, worth: null, noise: false });
    const chosen = schedule.options.flatMap((id): TimelineEntry[] => {
        const option = options.get(id);
        if (!option) return [];
        const worth = schedule.marginal.find((m) => m.option === id)?.invite ?? null;
        return [{ event: option.event, status: "chosen", option, route: routeOf(option, schedule), worth, noise: worth !== null && Math.abs(worth) < NOISE_WORTH }];
    });
    return [...file.locked.map(fixed("locked")), ...file.committed.map(fixed("committed")), ...chosen].sort(
        (a, b) => a.event.startDate.localeCompare(b.event.startDate) || a.event.name.localeCompare(b.event.name)
    );
};

/** Plans are rebuilt weekly while the season simulation runs nightly, so a plan up to this many days older isn't stale. */
export const PLAN_MAX_AGE_DAYS = 8;
const DAY_MS = 86_400_000;

export const stale = (file: PlanTeamFile, season: SeasonIndex | null | undefined): boolean =>
    !!season && (Date.parse(season.asOf) - Date.parse(file.asOf) > PLAN_MAX_AGE_DAYS * DAY_MS || file.target.slug !== season.target.slug);
