import type { Region } from "../vrs/types.ts";

export interface EventOddsTeam {
    team: string;
    /** Elo rating as of `asOf`; null for teams with no rated history. */
    rating: number | null;
    /** Stage id → probability of playing in it. */
    reach: Record<string, number>;
    /** Placement label → probability. */
    placements: Record<string, number>;
}

export type StageFormat = "swiss" | "single_elim" | "double_elim" | "gsl" | "round_robin" | "bracket";

export interface BracketSlot {
    /** Config match id for `bracket` stages; `r<round>:<w>-<l>` for a Swiss pool. */
    id: string;
    /** Column order within the lane; not consecutive (double elimination's lower rounds start at 101). */
    round: number;
    lane: "upper" | "lower";
    bestOf: number;
    /** Share of simulations that played this slot. */
    reach: number;
    /** Average number of teams here per simulation, counting those cut from `teams`; a Swiss pool's is its exact size. */
    size?: number;
    /** Most likely teams here; both shares are of all simulations. */
    teams: Array<{ team: string; here: number; win: number }>;
    /** Most likely pairings, as a share of all simulations. */
    matchups: Array<{ teams: [string, string]; p: number }>;
    /** Set once every match here is played; a Swiss pool has several. */
    results?: Array<{ teams: [string, string]; winner: 0 | 1 }>;
}

export interface StageBracket {
    id: string;
    name: string;
    format: StageFormat;
    /** In play order. */
    slots: BracketSlot[];
}

export interface EventOdds {
    slug: string;
    name: string;
    liquipedia: string;
    startDate: string;
    endDate: string;
    generatedAt: string;
    /** Date of the latest match in the ratings. */
    asOf: string;
    n: number;
    /** Stages teams advance into, so reaching one means something. */
    stages: Array<{ id: string; name: string }>;
    /** Best first. */
    placements: string[];
    /** Placement label → USD, when Liquipedia has the prize table. */
    prizes: Record<string, number> | null;
    playedMatches: number;
    teams: EventOddsTeam[];
    /** Missing from files written before the bracket view. */
    bracket?: StageBracket[];
    /** Majors only. */
    pickem?: PickemData;
}

export interface PlayedSeries {
    /** Swiss round from Liquipedia's match section; null when unknown. */
    round: number | null;
    teams: [string, string];
    winner: 0 | 1;
}

export interface PickemBracketMatch {
    id: string;
    /** Seed (`s1`, 1-based) or an earlier match's winner or loser (`w:<id>`, `l:<id>`). */
    teams: [string, string];
    bestOf?: number;
}

export type PickemStage =
    | {
          id: string;
          name: string;
          format: "swiss";
          /** Invited teams in seed order; the `from` stage's advancers are seeded after them. */
          seeds: string[];
          from?: string;
          bestOf: { default: number; decider?: number };
          played: PlayedSeries[];
      }
    | {
          id: string;
          name: string;
          format: "bracket";
          seeds: string[];
          from?: string;
          matches: PickemBracketMatch[];
          bestOf: { default: number; final?: number };
          played: PlayedSeries[];
      };

export interface PickemSet {
    threeZero: string[];
    advance: string[];
    zeroThree: string[];
}

/** A Swiss stage's model Pick'em, frozen once the stage has a played result. */
export interface PickemModel {
    /** Ratings date the model was computed with. */
    asOf: string;
    seeds: string[];
    picks: PickemSet;
    n: number;
    /** Held-out pre-stage simulations: base64, 2 bits per seed per simulation (see `PickemBucket`). */
    sample: string;
}

export interface PickemData {
    stages: PickemStage[];
    /** `bo1[i][j]`: P(`teams[i]` beats `teams[j]`) from today's Elo, without the simulator's rating drift. */
    odds: { teams: string[]; bo1: number[][]; bo3: number[][]; bo5: number[][] };
    /** Swiss stage id → model, for stages whose seeds are known. */
    model?: Record<string, PickemModel>;
}

export type EventIndexEntry = Pick<EventOdds, "slug" | "name" | "startDate" | "endDate"> & { major?: boolean };

export interface InviteOddsRoster {
    rosterKey: string;
    teamName: string;
    region: Region;
    players: string[];
    stage3: number;
    stage2: number;
    stage1: number;
    miss: number;
    /** Projected regional rank percentiles across simulations. */
    rank: { p10: number; p50: number; p90: number };
    /** Whether a current squad still holds the roster; null without squad data. */
    intact: boolean | null;
    /** True when the roster appeared on another region's VRS list within the preceding 3 calendar months without an exception. */
    regionLocked?: boolean;
}

export interface InviteOdds {
    slug: string;
    name: string;
    liquipedia: string;
    snapshotDate: string;
    snapshotEstimated: boolean;
    generatedAt: string;
    asOf: string;
    n: number;
    events: Array<{ slug: string; name: string; liquipedia: string; included: boolean; reason?: string }>;
    /** Stage 3 and 2 are mean slots per region over simulations of the previous Major; Stage 1 is fixed. */
    slots: {
        stage3: Record<Region, number>;
        stage2: Record<Region, number>;
        stage1: Record<Region, number>;
        source: string;
        verified: boolean;
    };
    rosters: InviteOddsRoster[];
}

export type InviteIndexEntry = Pick<InviteOdds, "slug" | "name" | "snapshotDate">;

export type FieldSource = "announced" | "vrs" | "qualifier" | "open";

export interface SeasonFieldTeam {
    team: string;
    /** Share of runs it attends. */
    attend: number;
    /** How it most often got in. */
    source: FieldSource;
    /** Share of runs it wins the event; null for events not simulated. */
    win: number | null;
}

export interface SeasonEvent {
    slug: string;
    name: string;
    liquipedia: string;
    startDate: string;
    endDate: string;
    location: { region: Region | null; country: string } | null;
    tier: number | null;
    /** USD. */
    prizePool: number;
    prizeSource: "table" | "config" | "estimate";
    generic: boolean;
    kind: "lan" | "online";
    /** An edition Liquipedia doesn't list yet, expected from its series' cadence. */
    projection?: {
        editions: number;
        gapDays: number;
        /** The series' latest edition by as-of, which the projection steps from. */
        lastPage: string;
        lastStart: string;
        /** Share of runs that play it: how often past projections of this kind came true. */
        chance: number;
    };
    assumed: Array<"format" | "prizes" | "field" | "teams" | "dates">;
    simulated: boolean;
    reason?: string;
    /** Runs whose lists couldn't fill every slot, so the event wasn't played. */
    shortRuns: number;
    field: SeasonFieldTeam[];
    /** Simulated events whose finishers fill its qualifier slots. */
    fedBy?: Array<{ slug: string; name: string; slots: number }>;
}

export interface SeasonIndex {
    generatedAt: string;
    /** Date of the latest match in the ratings. */
    asOf: string;
    target: { slug: string; name: string; date: string; estimated: boolean };
    n: number;
    seed: number;
    checkpoints: string[];
    /** Checkpoint reruns that would relink rosters and fell back to a full run. */
    inexactReruns: number;
    /** LAN events per horizon at p25 / p50 / p75 among top-40 rosters; `average` caps attendance. */
    volume: { low: number; average: number; high: number; horizonDays: number; teamsCounted: number };
    /** Top-80 rosters with no team page, so no event can invite them. */
    unmatchedRosters: string[];
    events: SeasonEvent[];
    /** Expected stand-ins per run for events Liquipedia will list later, by habit category (`lan2`, `lan34`, `online`, `qualifier`); not in `events`. */
    unannounced?: Array<{ category: string; expected: number }>;
    /** Absent before the optimizer ran. */
    optimizer?: SeasonOptimizerStats;
    /** Teams with a `teams/<file>` schedule. */
    schedules?: SeasonScheduleEntry[];
    impact?: SeasonImpactStats;
}

export interface SeasonImpactStats {
    events: Array<{ slug: string; checkpoint: string }>;
    /** |exact − one-team| points change on sampled (run, event, team) triples. */
    check: ErrorStats;
    /** Checkpoint-runs whose rerun relinked rosters, so impact froze a freshly loaded world. */
    fullLoads: number;
}

export interface SeasonImpactPlacement {
    placement: string;
    /** Share of the team's runs at the event that end in this placement. */
    p: number;
    runs: number;
    /** Mean points change at the checkpoint; `start` is the part from the starting rating, `h2h` the rest. */
    delta: number;
    start: number;
    h2h: number;
}

export interface SeasonImpactTeam {
    team: string;
    /** Share of season runs it attends. */
    attend: number;
    /** Mean points change over the runs it attends. */
    expected: number;
    placements: SeasonImpactPlacement[];
}

export interface SeasonImpact {
    generatedAt: string;
    asOf: string;
    slug: string;
    name: string;
    liquipedia: string;
    /** The VRS publication the change is measured at: the first after the event ends. */
    checkpoint: string;
    n: number;
    /** Placements reached in fewer runs are low-confidence. */
    minRuns: number;
    check: ErrorStats;
    teams: SeasonImpactTeam[];
}

export interface ErrorStats {
    n: number;
    mean: number;
    p95: number;
    max: number;
}

export interface SeasonOptimizerStats {
    teams: number;
    /** Most optional events per team. */
    universeCap: number;
    /** Share of runs an event must be reachable in to be a candidate. */
    minReach: number;
    rescoreN: number;
    /** |exact − one-team| in a recommended schedule's mean points, over the re-scored runs. */
    estimateError: ErrorStats;
    /** Per team and volume: best exact mean among its re-scored schedules within the cap, minus the recommended one's. */
    regret: ErrorStats;
    inexactTargets: number;
    inexactRescores: number;
    replays: number;
    skippedReplays: number;
    /** Qualifier replays for `requiresQualifying` odds; absent in files written before them. */
    pathReplays?: number;
    /** Team-runs whose roster wasn't found in the target world. */
    missingRosters: number;
    scores: number;
    seconds: { season: number; rescore: number };
}

export interface SeasonScheduleEntry {
    team: string;
    teamName: string;
    rosterKey: string;
    region: Region;
    /** Under `teams/`. */
    file: string;
}

export interface ScheduleSummary {
    mean: number;
    p10: number;
    p90: number;
    /** Share of runs with a Major invite; null when the previous Major's results aren't simulated. */
    invite: number | null;
}

export interface ScheduleCandidate {
    slug: string;
    name: string;
    startDate: string;
    endDate: string;
    region: Region | null;
    announced: boolean;
    /** Share of runs the team could get a slot. */
    reach: number;
    /** Share of runs it attends under the season's attendance rules. */
    attend: number;
    /** Format assumed from its team count, not configured. */
    generic: boolean;
    /** For an edition Liquipedia doesn't list yet, the share of runs that play it. */
    projected?: number;
    /** Mostly reached through an open slot: an invitation the model assumes its organizer would give, not one a rule does. */
    assumedInvite: boolean;
}

export type ScheduleVolume = "low" | "average" | "high";
export type ScheduleGoal = "points" | "invite";

export interface RecommendedSchedule {
    volumes: ScheduleVolume[];
    goals: ScheduleGoal[];
    /** Candidate bitmask. */
    mask: number;
    /** Announced events it leaves out. */
    dropsAnnounced: string[];
    /** Exact reruns of Valve's model over the first `rescoreN` runs. */
    exact: ScheduleSummary;
    /** One-team model over every run, as in `subsets`. */
    estimate: ScheduleSummary;
}

export interface SeasonTeamSchedule {
    generatedAt: string;
    team: string;
    teamName: string;
    rosterKey: string;
    region: Region;
    asOf: string;
    target: SeasonIndex["target"];
    n: number;
    rescoreN: number;
    volume: SeasonIndex["volume"];
    /** Events under way it already plays, in every schedule and counted against the cap. */
    committed: Array<{ slug: string; name: string }>;
    /** Bit i of a mask is candidate i. */
    candidates: ScheduleCandidate[];
    /** Reachable only through a qualifier, so left out of the search. */
    requiresQualifying: Array<
        Pick<ScheduleCandidate, "slug" | "name" | "startDate" | "endDate" | "reach"> & {
            /** Simulated events that qualify teams for it; with them, `reach` is the share of runs the team could enter one. */
            via?: Array<{ slug: string; name: string }>;
            /** Share of entered runs the team qualified, by replaying the qualifier with it. */
            qualified?: number;
        }
    >;
    /** Under the season's own attendance rules, which take whatever invites come; exact, over the same runs as `recommended[].exact`. */
    rules: ScheduleSummary;
    recommended: RecommendedSchedule[];
    /** One-team estimates: [mask, mean, p10, p90, invite share or null], every feasible subset within the high cap. */
    subsets: Array<[number, number, number, number, number | null]>;
}

export interface SeasonRange {
    p10: number | null;
    p50: number | null;
    p90: number | null;
}

export interface SeasonRosterCheckpoint {
    points: SeasonRange;
    /** A null percentile falls where the roster is unranked. */
    globalRank: SeasonRange;
    regionalRank: SeasonRange;
    /** Share of runs it's ranked. */
    ranked: number;
}

export interface SeasonRoster {
    rosterKey: string;
    teamName: string;
    region: Region;
    players: string[];
    today: { points: number; globalRank: number | null; regionalRank: number | null } | null;
    /** One per `checkpoints` entry. */
    checkpoints: SeasonRosterCheckpoint[];
}

export interface SeasonStandings {
    generatedAt: string;
    asOf: string;
    /** Date of the standings `today` comes from. */
    todayDate: string;
    n: number;
    checkpoints: string[];
    rosters: SeasonRoster[];
}

export type PlanVolume = "low" | "average" | "high";
/** `event` takes a place; `qualify` plays the event only through its linked feeders; `inviteOrQualify` takes a place when offered, else qualifies. */
export type PlanOptionKind = "event" | "qualify" | "inviteOrQualify";

export interface PlanEventRef {
    slug: string;
    name: string;
    liquipedia: string;
    startDate: string;
    endDate: string;
    kind: "lan" | "online";
    tier: number | null;
    /** Share of runs a projected edition plays in; null for listed events. */
    projected: number | null;
    /** The format was assumed, not read. */
    generic: boolean;
}

export interface PlanOption {
    id: number;
    kind: PlanOptionKind;
    event: PlanEventRef;
    /** Linked feeders the team may enter, nearest first. */
    feeders: PlanEventRef[];
    /** Shares of search runs: a place (or played), entered a feeder; `qualified` is a share of entered runs. */
    reached: number;
    entered: number;
    qualified: number | null;
}

export interface PlanOdds {
    /** Mean of σ((points − cutoff) / 10) over runs with known slots. */
    smooth: number;
    invite: number;
    points: { mean: number; p10: number; p50: number; p90: number };
}

/** Paired difference against the habitual schedule over hold-out runs, with a 95% interval. */
export interface PlanDiff {
    mean: number;
    low: number;
    high: number;
}

export interface PlanSchedule {
    options: number[];
    /** Volume caps it's the best hold-out schedule within. */
    bestFor: PlanVolume[];
    /** Smallest volume whose caps it fits. */
    fits: PlanVolume;
    /** On the search runs it was chosen on: optimistic. */
    search: { smooth: number; invite: number };
    holdout: PlanOdds;
    vsHabitual: { invite: PlanDiff; smooth: PlanDiff };
    /** Exact reruns of Valve's model on the first hold-out runs; `estimatePoints` is the one-team mean on the same runs. */
    exact: { n: number; invite: number; points: number; estimatePoints: number } | null;
    /** Hold-out loss from dropping each option. */
    marginal: Array<{ option: number; smooth: number; invite: number }>;
    /** Per qualify option, hold-out shares: runs with a place outright, runs it entered a feeder, and of those, runs it qualified. */
    branches: Array<{ option: number; invited: number; entered: number; qualified: number }>;
}

export interface PlanTeamFile {
    generatedAt: string;
    team: string;
    teamName: string;
    rosterKey: string;
    region: Region;
    asOf: string;
    target: SeasonIndex["target"];
    seed: number;
    runs: { search: number; holdout: number; exact: number };
    caps: Record<PlanVolume, { lan: number; online: number }>;
    /** Announced events, in every schedule. */
    locked: PlanEventRef[];
    /** Events under way it plays. */
    committed: PlanEventRef[];
    options: PlanOption[];
    /** Options seen in under this share of search runs are left out of the search. */
    minReach: number;
    /** Option ids searched: reached often enough, and among the best gains alone. */
    searched: number[];
    baselines: { habitual: PlanOdds; lockedOnly: PlanOdds };
    schedules: PlanSchedule[];
    check: {
        /** Over schedules: |exact − one-team| mean points on the exact runs. */
        estimateError: ErrorStats;
        /** Per volume, the exhaustive best minus the search's best on search runs; null when not run. */
        exhaustiveRegret: Record<PlanVolume, number> | null;
        evaluated: number;
        inexactExact: number;
        skippedOptions: number;
        noSlot: number;
        seconds: { setup: number; runs: number; search: number; holdout: number; exact: number };
    };
}

export interface PlanIndex {
    generatedAt: string;
    teams: Array<{ team: string; teamName: string; file: string; asOf: string; target: SeasonIndex["target"]; generatedAt: string }>;
}
