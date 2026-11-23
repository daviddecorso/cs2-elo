import type { Region } from "../../../../src/vrs/types.ts";
import { conflicts, fits, type Caps, type Stint } from "../../../../src/sim/schedule.ts";
import { feedersFor, fieldTeams, hasOpenSlots, isUnderWay, MAX_PATH_DEPTH } from "../optimizer.ts";
import type { SeasonEvent } from "../season.ts";
import type { SeasonSetup } from "../seasonSetup.ts";
import type { TeamId } from "../types.ts";

/** `event` takes a place; `qualify` (no place on offer) plays the event through its linked feeders; `inviteOrQualify` takes a place when offered, else qualifies. */
export type OptionKind = "event" | "qualify" | "inviteOrQualify";

export interface PlanOption {
    kind: OptionKind;
    /** Season event index the option is for; the main event for qualify kinds. */
    event: number;
    /** Season event indices whose dates it holds: the event and every feeder the team may enter. */
    holds: number[];
    /** The held events that count against caps: the event and, for qualify kinds, its first feeder. */
    counts: number[];
}

export interface OptionSet {
    options: PlanOption[];
    /** Not-started events the team is announced for: in every schedule. */
    locked: number[];
    /** Events under way that the team plays: count against caps. */
    committed: number[];
}

/** Feeders the team could enter on the way to `slug`, nearest first, down to `MAX_PATH_DEPTH` levels. */
export const feederChain = (events: SeasonEvent[], slug: string, region: Region, depth = 1): number[] => {
    if (depth > MAX_PATH_DEPTH) return [];
    return feedersFor(events, slug, region).flatMap((f) => [events.indexOf(f), ...feederChain(events, f.config.slug, region, depth + 1)]);
};

/** The team's choices over the season's events; `canEnter` says whether an organizer would plausibly invite it to open slots. */
export const buildOptions = (events: SeasonEvent[], team: TeamId, region: Region, asOf: string, canEnter: (e: SeasonEvent) => boolean): OptionSet => {
    const options: PlanOption[] = [];
    const locked: number[] = [];
    const committed: number[] = [];
    events.forEach((e, i) => {
        if (e.unannounced) return;
        const inField = fieldTeams(e).includes(team);
        if (isUnderWay(e, asOf)) {
            if (inField) committed.push(i);
            return;
        }
        if (inField) {
            locked.push(i);
            return;
        }
        // A feeder only makes sense on the way to the event it feeds.
        if (e.feeds) return;
        const direct = hasOpenSlots(e) && canEnter(e);
        const feeders = [...new Set(feederChain(events, e.config.slug, region))];
        if (direct) options.push({ kind: "event", event: i, holds: [i], counts: [i] });
        if (feeders.length > 0) options.push({ kind: direct ? "inviteOrQualify" : "qualify", event: i, holds: [i, ...feeders], counts: [i, feeders[0]] });
    });
    return { options, locked, committed };
};

/** Each focal team's options in a setup loaded with `focal`, in `opt.teams` order. */
export const focalOptions = (setup: SeasonSetup): OptionSet[] =>
    setup.optimizer.opt.teams.map((team) => buildOptions(setup.input.events, team.team, team.region, setup.asOf, setup.canEnterFor.get(team.team) ?? (() => true)));

/** Whether the chosen options fit together beside the locked and committed events: no shared event, no clash, caps and online concurrency kept. */
export const feasible = (events: SeasonEvent[], set: OptionSet, chosen: number[], caps: Caps): boolean => {
    const stint = (i: number): Stint => events[i].stint;
    const owner = new Map<number, number>();
    for (const o of chosen) {
        for (const i of set.options[o].holds) {
            if (owner.has(i) || set.locked.includes(i)) return false;
            owner.set(i, o);
        }
    }
    const held: Stint[] = [...set.committed, ...set.locked].map(stint);
    const counted: Array<{ i: number; o: number }> = [];
    for (const o of chosen) for (const i of set.options[o].counts) counted.push({ i, o });
    counted.sort((a, b) => events[a.i].config.startDate.localeCompare(events[b.i].config.startDate));
    for (const { i } of counted) {
        if (!fits(held, stint(i), caps)) return false;
        held.push(stint(i));
    }
    const fixed = [...set.committed, ...set.locked];
    for (const o of chosen) {
        const option = set.options[o];
        for (const i of option.holds) {
            if (option.counts.includes(i)) continue;
            if (fixed.some((j) => conflicts(stint(i), stint(j)))) return false;
            if (counted.some((c) => c.o !== o && conflicts(stint(i), stint(c.i)))) return false;
        }
    }
    return true;
};
