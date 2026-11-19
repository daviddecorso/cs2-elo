import { describe, expect, it } from "vitest";
import { defaultSchedule, scheduleRows, stale, timeline } from "./plan.ts";
import { testPlan } from "./testPlan.ts";
import type { SeasonIndex } from "./types.ts";

describe("plan view model", () => {
    it("lists the baselines, then schedules from the lowest volume they're best for", () => {
        const rows = scheduleRows(testPlan());
        expect(rows.map((r) => (r.kind === "baseline" ? r.label : r.index))).toEqual(["Season rules", "Announced only", 1, 0]);
    });

    it("defaults to the best average-volume schedule", () => {
        expect(defaultSchedule(testPlan())).toBe(1);
        const plan = testPlan();
        plan.schedules[1].bestFor = ["low"];
        expect(defaultSchedule(plan)).toBe(0);
    });

    it("merges locked events and chosen options in date order, with routes and worth", () => {
        const plan = testPlan();
        const entries = timeline(plan, plan.schedules[0]);
        expect(entries.map((e) => e.event.slug)).toEqual(["major", "roman", "cluj", "epl", "blast-open"]);
        expect(entries[0]).toMatchObject({ status: "locked", worth: null, route: null });

        const byslug = new Map(entries.map((e) => [e.event.slug, e]));
        expect(byslug.get("cluj")!.route).toBe("via PGL Cluj-Napoca 2027 Closed Qualifier: enters 100%, qualifies 81% of those");
        expect(byslug.get("epl")!.route).toBe("place in 81% of runs, otherwise via ECL S52 Europe: enters 19%, qualifies 32% of those");
        expect(byslug.get("blast-open")).toMatchObject({ route: null, worth: 0.13, noise: false });
        expect(byslug.get("roman")).toMatchObject({ worth: -0.003, noise: true });
    });

    it("is stale when the season simulation is over a week newer or targets another Major", () => {
        const plan = testPlan();
        const season = (asOf: string, slug: string) => ({ asOf, target: { ...plan.target, slug } }) as SeasonIndex;
        expect(stale(plan, season("2026-11-12", plan.target.slug))).toBe(false);
        expect(stale(plan, season("2026-11-20", plan.target.slug))).toBe(false);
        expect(stale(plan, season("2026-11-21", plan.target.slug))).toBe(true);
        expect(stale(plan, season("2026-11-12", "other-major"))).toBe(true);
        expect(stale(plan, null)).toBe(false);
    });
});
