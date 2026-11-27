import type { SeriesPrediction } from "./engine.ts";

const DAY = 86400;

/** Unix seconds: the last tier-1 LAN series before the gap and the first after it. */
export interface BreakWindow {
    start: number;
    end: number;
}

export function lanGaps(matches: Array<{ t: number; tier: number | null; lan: boolean }>, minDays: number): BreakWindow[] {
    const times = matches.filter((m) => m.tier === 1 && m.lan).map((m) => m.t).sort((a, b) => a - b);
    const out: BreakWindow[] = [];
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] >= minDays * DAY) out.push({ start: times[i - 1], end: times[i] });
    return out;
}

/** The summer and winter player breaks: tier-1 LAN gaps of 25+ days starting in June, July or December (checked against the 2026 calendar). */
export const playerBreaks = (matches: Array<{ t: number; tier: number | null; lan: boolean }>): BreakWindow[] =>
    lanGaps(matches, 25).filter((w) => [5, 6, 11].includes(new Date(w.start * 1000).getUTCMonth()));

/** Series each side has played since its return (first series after `start` + `margin` days, following `minIdle`+ idle days), or null. */
export function seriesSinceBreak(
    predictions: SeriesPrediction[],
    windows: BreakWindow[],
    { withinDays = 30, margin = 2, minIdle = 14 } = {},
): Map<string, [number | null, number | null]> {
    const state = new Map<number, { window: number; count: number }>();
    const out = new Map<string, [number | null, number | null]>();
    let w = 0;
    for (const p of predictions) {
        while (w < windows.length && windows[w].end + withinDays * DAY < p.t) w++;
        const win = windows[w];
        const pair: [number | null, number | null] = [null, null];
        if (win && p.t >= win.start + margin * DAY) {
            for (const s of [0, 1] as const) {
                const l = p.lineages[s];
                let st = state.get(l);
                if (!st || st.window !== w) {
                    const idle = p.sideIdleDays[s];
                    st = { window: w, count: idle !== null && idle >= minIdle ? 0 : -1 };
                    state.set(l, st);
                }
                if (st.count >= 0) pair[s] = st.count++;
            }
        }
        out.set(p.id, pair);
    }
    return out;
}
