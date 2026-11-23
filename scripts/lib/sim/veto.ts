import fs from "node:fs";
import type { Rng } from "./rng.ts";
import type { TeamId } from "./types.ts";

/** `liquipedia` drops the HLTV ban and pick rates, so nothing HLTV-derived reaches published odds except fitted weights. */
export type VetoMode = "hltv" | "liquipedia";

export interface TeamMaps {
    u: number[];
    play: number[];
    ban?: number[];
    pick?: number[];
}

export type ChoiceWeights = Record<"ban" | "pick", Record<string, number>>;

/** `cs2wp sim-veto --write`; per-team arrays follow `pool`. */
export interface VetoModelFile {
    asOf: string;
    pool: string[];
    /** Per format, the actions before the decider: `b` ban, `p` pick. */
    actions: Record<string, string>;
    /** Per format, who acts at each step: `F` the team that bans first, `S` the other. */
    orders: Record<string, string>;
    modes: Partial<Record<VetoMode, { map: Record<string, number>; choice: ChoiceWeights }>>;
    teams: Record<string, TeamMaps>;
}

export interface VetoInputParams {
    /** Map strength shrinkage, in maps. */
    k: number;
    /** Map strength decay, in days. */
    tau: number;
    /** Map play shrinkage, in series. */
    playPrior: number;
    /** Map play decay, in days. */
    playTau: number;
}

/** The committed part of the model: fitted weights only, no team values and no HLTV rates. */
export interface VetoWeightsFile {
    asOf: string;
    actions: Record<string, string>;
    orders: Record<string, string>;
    inputs: VetoInputParams;
    /** Share of vetoes in which the higher-rated team bans second. */
    favouriteSecond: number;
    forecast: {
        /** Multiplier on choice scores when forecasting a whole veto. */
        shrink: number;
        /** Lower bounds on P(picked or decider). */
        bands: { likely: number; possible: number };
        bo1Shown: number;
    };
    map: Record<string, number>;
    choice: ChoiceWeights;
}

export const VETO_MODEL = "data/sim/veto-model.json";

export const loadVetoModel = (file = VETO_MODEL): VetoModelFile | null =>
    fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as VetoModelFile) : null;

export const VETO_WEIGHTS = "data/sim/veto-weights.json";

export const loadVetoWeights = (file = VETO_WEIGHTS): VetoWeightsFile | null =>
    fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as VetoWeightsFile) : null;

/** 0 = the first team passed in, 1 = the second. */
type Side = 0 | 1;

export interface Veto {
    /** Pool indexes in play order: picks, then the decider. */
    maps: number[];
    /** Who picked each map; null for the decider. */
    pickers: Array<Side | null>;
}

/** Where one pool map ends up; the five probabilities sum to 1. */
export interface MapOutcome {
    bans: [number, number];
    picks: [number, number];
    decider: number;
}

interface Step {
    actor: Side;
    pick: boolean;
}

const softmax = (scores: number[]): number[] => {
    const top = Math.max(...scores);
    const w = scores.map((s) => Math.exp(s - top));
    const total = w.reduce((a, b) => a + b, 0);
    return w.map((x) => x / total);
};

const softmaxDraw = (scores: number[], rng: Rng): number => {
    const p = softmax(scores);
    let r = rng();
    for (let i = 0; i < p.length; i++) if ((r -= p[i]) < 0) return i;
    return p.length - 1;
};

/** The map model and veto choice model from `wp/src/cs2wp/simveto.py`; keep the two in step. */
export class VetoModel {
    readonly pool: string[];
    private file: VetoModelFile;
    private mode: VetoMode;
    private coefs: { map: Record<string, number>; choice: ChoiceWeights };
    private zeros: number[];

    constructor(file: VetoModelFile, mode: VetoMode) {
        this.file = file;
        this.mode = mode;
        const coefs = file.modes[mode];
        if (!coefs) throw new Error(`Veto model has no ${mode} weights`);
        this.coefs = coefs;
        this.pool = file.pool;
        this.zeros = file.pool.map(() => 0);
    }

    has(team: TeamId): boolean {
        return team in this.file.teams;
    }

    get gamma(): number {
        return this.coefs.map.pick ?? 0;
    }

    private team(id: TeamId) {
        const t = this.file.teams[id];
        const hltv = this.mode === "hltv";
        return {
            u: t?.u ?? this.zeros,
            play: t?.play ?? this.zeros,
            ban: (hltv && t?.ban) || this.zeros,
            pick: (hltv && t?.pick) || this.zeros,
        };
    }

    /** A's map logit on each pool map, without the Elo base and the pick term. */
    edges(a: TeamId, b: TeamId): number[] {
        const c = this.coefs.map;
        const ta = this.team(a);
        const tb = this.team(b);
        return this.pool.map(
            (_, m) =>
                c.du * (ta.u[m] - tb.u[m]) + (c.ban_rate ?? 0) * (ta.ban[m] - tb.ban[m]) + (c.pick_rate ?? 0) * (ta.pick[m] - tb.pick[m])
        );
    }

    /** Steps before the decider; by default `b` bans first, so `a` is the higher seed. `order` overrides the format's default. */
    steps(bestOf: number, order?: string, first: Side = 1): Step[] {
        const actions = this.file.actions[bestOf];
        const who = order ?? this.file.orders[bestOf];
        if (!actions || !who || who.length !== actions.length) throw new Error(`No veto order for Bo${bestOf}`);
        return [...actions].map((act, i) => ({ actor: who[i] === "F" ? first : first === 1 ? 0 : 1, pick: act === "p" }));
    }

    /** Choice scores of every pool map for `actor` at a ban and at a pick. */
    private scores(a: TeamId, b: TeamId, edges: number[]): Record<Side, { ban: number[]; pick: number[] }> {
        const weights = this.coefs.choice;
        const forActor = (actor: Side) => {
            const t = this.team(actor === 0 ? a : b);
            const side = actor === 0 ? 1 : -1;
            const score = (beta: Record<string, number>, sign: number, rate: number[]) =>
                this.pool.map(
                    (_, m) => (beta.rate ?? 0) * rate[m] + (beta.play ?? 0) * sign * t.play[m] + (beta.edge ?? 0) * sign * side * edges[m]
                );
            return { ban: score(weights.ban, -1, t.ban), pick: score(weights.pick, 1, t.pick) };
        };
        return { 0: forActor(0), 1: forActor(1) };
    }

    sample(a: TeamId, b: TeamId, bestOf: number, rng: Rng, order?: string): Veto & { edges: number[] } {
        const edges = this.edges(a, b);
        const scores = this.scores(a, b, edges);
        const remaining = this.pool.map((_, i) => i);
        const maps: number[] = [];
        const pickers: Array<Side | null> = [];
        for (const { actor, pick } of this.steps(bestOf, order)) {
            const s = scores[actor][pick ? "pick" : "ban"];
            const [m] = remaining.splice(softmaxDraw(remaining.map((i) => s[i]), rng), 1);
            if (pick) {
                maps.push(m);
                pickers.push(actor);
            }
        }
        maps.push(remaining[0]);
        pickers.push(null);
        return { maps, pickers, edges };
    }

    /** Every pool map's exact outcome, mixing who bans first; `aSecond` is the chance that `a` bans second. */
    distribution(a: TeamId, b: TeamId, bestOf: number, aSecond: number, order?: string): MapOutcome[] {
        const scores = this.scores(a, b, this.edges(a, b));
        const out = this.pool.map((): MapOutcome => ({ bans: [0, 0], picks: [0, 0], decider: 0 }));
        for (const first of [1, 0] as const) {
            // Keyed by the bitmask of maps left: a choice depends on nothing else.
            let reach = new Map([[(1 << this.pool.length) - 1, first === 1 ? aSecond : 1 - aSecond]]);
            for (const { actor, pick } of this.steps(bestOf, order, first)) {
                const s = scores[actor][pick ? "pick" : "ban"];
                const next = new Map<number, number>();
                for (const [left, pLeft] of reach) {
                    const options = this.pool.flatMap((_, m) => (left & (1 << m) ? [m] : []));
                    const p = softmax(options.map((m) => s[m]));
                    options.forEach((m, j) => {
                        out[m][pick ? "picks" : "bans"][actor] += pLeft * p[j];
                        const rest = left & ~(1 << m);
                        next.set(rest, (next.get(rest) ?? 0) + pLeft * p[j]);
                    });
                }
                reach = next;
            }
            for (const [left, pLeft] of reach) out[Math.log2(left)].decider += pLeft;
        }
        return out;
    }

    /** A's map logits for a veto, `base` being the Elo logit, before the series temperature. */
    logits(veto: Veto & { edges: number[] }, base: number): number[] {
        return veto.maps.map((m, i) => {
            const picker = veto.pickers[i];
            return base + veto.edges[m] + (picker === null ? 0 : picker === 0 ? this.gamma : -this.gamma);
        });
    }

    /** A's exact series probability over every veto path. */
    probability(a: TeamId, b: TeamId, base: number, bestOf: number, temp: number, order?: string): number {
        const edges = this.edges(a, b);
        const scores = this.scores(a, b, edges);
        const steps = this.steps(bestOf, order);
        const t = bestOf > 1 ? temp : 1;
        const memo = new Map<string, number>();
        const value = (i: number, remaining: number[], picks: Array<[number, Side]>): number => {
            if (i === steps.length) {
                const logits = [...picks.map(([m, who]) => base + edges[m] + (who === 0 ? this.gamma : -this.gamma)), base + edges[remaining[0]]];
                return seriesFromLogits(logits.map((l) => l * t));
            }
            const key = `${i}|${remaining.join(",")}|${[...picks].sort((x, y) => x[0] - y[0]).join(";")}`;
            const hit = memo.get(key);
            if (hit !== undefined) return hit;
            const { actor, pick } = steps[i];
            const s = remaining.map((m) => scores[actor][pick ? "pick" : "ban"][m]);
            const p = softmax(s);
            let v = 0;
            remaining.forEach((m, j) => {
                const rest = remaining.filter((x) => x !== m);
                v += p[j] * value(i + 1, rest, pick ? [...picks, [m, actor]] : picks);
            });
            memo.set(key, v);
            return v;
        };
        return value(0, this.pool.map((_, i) => i), []);
    }
}

/** P(A wins) when every map is played, maps independent; matches `series_prob` in `veto.py`. */
export const seriesFromLogits = (logits: number[]): number => {
    const need = Math.floor(logits.length / 2) + 1;
    let dist = [1];
    for (const l of logits) {
        const p = 1 / (1 + Math.exp(-l));
        const next = Array<number>(dist.length + 1).fill(0);
        dist.forEach((q, w) => {
            next[w] += q * (1 - p);
            next[w + 1] += q * p;
        });
        dist = next;
    }
    return dist.slice(need).reduce((a, b) => a + b, 0);
};
