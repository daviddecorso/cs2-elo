import fs from "node:fs";
import type { PickemSet } from "../../../src/sim/types.ts";
import type { Tally } from "./backtest.ts";
import type { StageConfig } from "./config.ts";
import type { TeamId } from "./types.ts";

/** Percent rows: Swiss `[advance, 3-0, 3-1, 3-2, 0-3 | null]`, 8-team playoffs `[reach semifinal, reach final, title]`. */
export interface ExternalForecasts {
    source: string;
    /** Public name and link for the site's credit line. */
    name?: string;
    url?: string;
    majors: Record<
        string,
        {
            stages: Record<string, Record<TeamId, Array<number | null>>>;
            /** The source's published picks, with the correct count it reported. */
            picks?: Record<string, PickemSet & { published?: number }>;
        }
    >;
}

export const readExternalForecasts = (file: string): ExternalForecasts | null =>
    fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as ExternalForecasts) : null;

/** Pseudo-count behind each share; shares are rounded to 1/N. */
const N = 10000;
/** Percentage points a column sum may miss by, from rounding to 0.1% over up to 16 teams. */
const SUM_SLACK = 1;

const sumOf = (rows: Array<Array<number | null>>, col: number) => rows.reduce((s, r) => s + (r[col] ?? 0), 0);

const check = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message);
};

/** One stage's marginals as a `Tally` for `scoreStage`; `buckets` is false when only P(advance) is scorable. */
export const externalTally = (
    stage: StageConfig,
    next: string | undefined,
    entrants: TeamId[],
    rows: Record<TeamId, Array<number | null>>
): { tally: Tally; buckets: boolean } => {
    const missing = entrants.filter((t) => !rows[t]);
    const extra = Object.keys(rows).filter((t) => !entrants.includes(t));
    check(!missing.length && !extra.length, `${stage.id}: missing ${missing.join(", ") || "none"}; not entrants ${extra.join(", ") || "none"}`);

    const tally: Tally = { n: N, placements: new Map(), reached: new Map(), stages: new Map([[stage.id, new Map()]]) };
    const counts = (shares: Record<string, number>) => new Map(Object.entries(shares).map(([k, p]) => [k, Math.round(Math.max(0, p) * N)]));
    const values = Object.values(rows);

    if (stage.format === "swiss") {
        const buckets = values.every((r) => r[4] !== null && r[4] !== undefined);
        check(Math.abs(sumOf(values, 0) - 100 * stage.advance) <= SUM_SLACK, `${stage.id}: advance sums to ${sumOf(values, 0)}`);
        if (buckets) check(Math.abs(sumOf(values, 4) - sumOf(values, 1)) <= SUM_SLACK, `${stage.id}: 0-3 sums to ${sumOf(values, 4)}, 3-0 to ${sumOf(values, 1)}`);
        for (const [team, r] of Object.entries(rows)) {
            const [adv, z3, x31, x32, o3] = r as number[];
            check(Math.abs(z3 + x31 + x32 - adv) <= 0.25, `${stage.id}: ${team}'s 3-0, 3-1 and 3-2 don't add up to advance`);
            const shares: Record<string, number> = { "3-0": z3 / 100, "3-X": (adv - z3) / 100 };
            if (buckets) Object.assign(shares, { "0-3": o3 / 100, out: (100 - adv - o3) / 100 });
            tally.stages.get(stage.id)!.set(team, counts(shares));
            if (next) tally.reached.set(team, counts({ [next]: adv / 100 }));
        }
        return { tally, buckets };
    }

    check(stage.format === "single_elim" && entrants.length === 8, `${stage.id}: only 8-team single elimination is supported`);
    const { r1, r2, r3, champion } = stage.exits;
    for (const [col, total] of [
        [0, 400],
        [1, 200],
        [2, 100],
    ])
        check(Math.abs(sumOf(values, col) - total) <= SUM_SLACK, `${stage.id}: column ${col} sums to ${sumOf(values, col)}, not ${total}`);
    for (const [team, r] of Object.entries(rows)) {
        const [sf, final, title] = (r as number[]).map((x) => x / 100);
        const placements = counts({ [r1]: 1 - sf, [r2]: sf - final, [r3]: final - title, [champion]: title });
        tally.placements.set(team, placements);
        tally.stages.get(stage.id)!.set(team, placements);
    }
    return { tally, buckets: true };
};
