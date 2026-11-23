import { brier, logLoss, mean, pearson } from "./metrics.ts";

/** The planner's two inputs about rivals and itself, checked against real seasons: who plays which event, and what playing it is worth. */

const MIN_SHARED_PLAYERS = 3;

/** Per origin and checkpoint, per cohort roster and event: runs in which the roster played it, and the summed gain at that checkpoint. */
export type SimGains = Map<string, { runs: number; gain: number }>;
export const simGainKey = (origin: string, date: string, i: number, eventId: string) => `${origin}|${date}|${i}|${eventId}`;

export interface RealizedRow {
    date: string;
    eventId: string;
    players: string[];
    gain: number;
    lan: boolean;
}

export interface PlannerCheck {
    attendance: { pairs: number; attended: number; brier: number; base: number; logLoss: number; meanAttended: number; meanOthers: number };
    gain: { pairs: number; predicted: number; realized: number; slope: number; correlation: number; lan: { pairs: number; slope: number }; online: { pairs: number; slope: number } };
}

const slopeOf = (x: number[], y: number[]) => {
    const [mx, my] = [mean(x), mean(y)];
    const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
    return sxx > 0 ? x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx : NaN;
};

/** Every (cohort roster, real simulated event finished before a checkpoint) pair; gains only where the roster really played it and did in 5+ runs. */
export const checkPlanner = (
    origins: Array<{ origin: string; dates: string[]; cohort: Array<{ players: string[] }>; n: number }>,
    sim: SimGains,
    realized: RealizedRow[]
): PlannerCheck => {
    const p: number[] = [];
    const y: number[] = [];
    const predicted: number[] = [];
    const actual: number[] = [];
    const lan: boolean[] = [];
    for (const o of origins) {
        for (const date of o.dates) {
            const real = realized.filter((r) => r.date === date);
            const realEvents = new Set(real.map((r) => r.eventId));
            const simulated = new Set<string>();
            for (const key of sim.keys()) {
                const [origin, d, , eventId] = key.split("|");
                if (origin === o.origin && d === date && realEvents.has(eventId)) simulated.add(eventId);
            }
            o.cohort.forEach((c, i) => {
                const nicks = new Set(c.players);
                const mine = real.filter((r) => r.players.filter((x) => nicks.has(x)).length >= MIN_SHARED_PLAYERS);
                for (const eventId of simulated) {
                    const s = sim.get(simGainKey(o.origin, date, i, eventId));
                    const row = mine.find((r) => r.eventId === eventId);
                    p.push((s?.runs ?? 0) / o.n);
                    y.push(row ? 1 : 0);
                    if (row && s && s.runs >= 5) {
                        predicted.push(s.gain / s.runs);
                        actual.push(row.gain);
                        lan.push(row.lan);
                    }
                }
            });
        }
    }
    const base = mean(y);
    const pick = (keep: boolean) => {
        const idx = lan.flatMap((l, k) => (l === keep ? [k] : []));
        return { pairs: idx.length, slope: slopeOf(idx.map((k) => predicted[k]), idx.map((k) => actual[k])) };
    };
    return {
        attendance: {
            pairs: p.length,
            attended: y.filter(Boolean).length,
            brier: brier(p, y),
            base: base * (1 - base),
            logLoss: logLoss(p, y),
            meanAttended: mean(p.filter((_, k) => y[k] === 1)),
            meanOthers: mean(p.filter((_, k) => y[k] === 0)),
        },
        gain: {
            pairs: predicted.length,
            predicted: mean(predicted),
            realized: mean(actual),
            slope: slopeOf(predicted, actual),
            correlation: predicted.length > 2 ? pearson(predicted, actual) : NaN,
            lan: pick(true),
            online: pick(false),
        },
    };
};
