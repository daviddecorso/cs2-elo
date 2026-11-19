import type { PlanEventRef, PlanOdds, PlanTeamFile } from "./types.ts";

const ref = (slug: string, name: string, startDate: string, kind: "lan" | "online" = "lan"): PlanEventRef => ({
    slug,
    name,
    liquipedia: name.replace(/ /g, "_"),
    startDate,
    endDate: startDate,
    kind,
    tier: 2,
    projected: null,
    generic: false,
});

const odds = (invite: number): PlanOdds => ({ smooth: invite, invite, points: { mean: 1500, p10: 1300, p50: 1500, p90: 1700 } });
const diff = (mean: number) => ({ mean, low: mean - 0.05, high: mean + 0.05 });

export const testPlan = (): PlanTeamFile => ({
    generatedAt: "",
    team: "100 Thieves",
    teamName: "100 Thieves",
    rosterKey: "device,gizmy,poiii,rain,sirah",
    region: "Europe",
    asOf: "2026-11-12",
    target: { slug: "fire-major-buenos-aires-2027", name: "FiRe Major Buenos Aires 2027", date: "2027-04-05", estimated: true },
    seed: 1,
    runs: { search: 300, holdout: 300, exact: 100 },
    caps: { low: { lan: 4, online: 6 }, average: { lan: 6, online: 7 }, high: { lan: 7, online: 9 } },
    locked: [ref("major", "PGL Major Singapore 2026", "2026-11-25")],
    committed: [],
    options: [
        { id: 0, kind: "event", event: ref("blast-open", "BLAST Open Spring 2027", "2027-03-01"), feeders: [], reached: 0.9, entered: 0, qualified: null },
        {
            id: 1,
            kind: "inviteOrQualify",
            event: ref("epl", "ESL Pro League Season 25", "2027-02-20"),
            feeders: [ref("ecl", "ECL S52 Europe", "2027-01-10", "online")],
            reached: 0.8,
            entered: 0.2,
            qualified: 0.3,
        },
        {
            id: 2,
            kind: "qualify",
            event: ref("cluj", "PGL Cluj-Napoca 2027", "2027-02-10"),
            feeders: [ref("cluj-cq", "PGL Cluj-Napoca 2027 Closed Qualifier", "2027-01-05", "online")],
            reached: 0,
            entered: 1,
            qualified: 0.8,
        },
        { id: 3, kind: "event", event: ref("roman", "Roman Imperium Cup IX", "2027-01-20"), feeders: [], reached: 0.5, entered: 0, qualified: null },
    ],
    minReach: 0.1,
    searched: [0, 1, 2, 3],
    baselines: { habitual: odds(0.54), lockedOnly: odds(0.4) },
    schedules: [
        {
            options: [0, 1, 2, 3],
            bestFor: ["high"],
            fits: "high",
            search: { smooth: 0.82, invite: 0.82 },
            holdout: odds(0.797),
            vsHabitual: { invite: diff(0.257), smooth: diff(0.26) },
            exact: { n: 100, invite: 0.81, points: 1577, estimatePoints: 1576 },
            marginal: [
                { option: 0, smooth: 0.11, invite: 0.13 },
                { option: 1, smooth: 0.04, invite: 0.047 },
                { option: 2, smooth: 0.02, invite: 0.023 },
                { option: 3, smooth: 0.002, invite: -0.003 },
            ],
            branches: [
                { option: 1, invited: 0.81, entered: 0.19, qualified: 0.316 },
                { option: 2, invited: 0, entered: 1, qualified: 0.807 },
            ],
        },
        {
            options: [0, 1, 2],
            bestFor: ["low", "average"],
            fits: "low",
            search: { smooth: 0.8, invite: 0.8 },
            holdout: odds(0.8),
            vsHabitual: { invite: diff(0.26), smooth: diff(0.26) },
            exact: { n: 100, invite: 0.83, points: 1580, estimatePoints: 1579 },
            marginal: [
                { option: 0, smooth: 0.12, invite: 0.143 },
                { option: 1, smooth: 0.05, invite: 0.05 },
                { option: 2, smooth: 0.03, invite: 0.037 },
            ],
            branches: [
                { option: 1, invited: 0.81, entered: 0.19, qualified: 0.316 },
                { option: 2, invited: 0, entered: 1, qualified: 0.807 },
            ],
        },
    ],
    check: {
        estimateError: { mean: 0.79, p95: 1.18, max: 1.3, n: 8 },
        exhaustiveRegret: null,
        evaluated: 5760,
        inexactExact: 0,
        skippedOptions: 255,
        noSlot: 2,
        seconds: { setup: 8, runs: 439, search: 78, holdout: 1, exact: 78 },
    },
});
