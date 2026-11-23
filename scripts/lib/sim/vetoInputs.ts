import type { SeriesPrediction } from "../elo/engine.ts";
import type { TeamMaps, VetoInputParams } from "./veto.ts";

const DAY = 86400;
const POOL_SIZE = 7;

/** Folds Liquipedia's spellings together as `demo_map_name` in `demos/src/cs2demos/liquipedia.py` does. */
const mapKey = (map: string): string => (map === "Dust II" ? "dust2" : map.toLowerCase().replace(/[^a-z0-9]/g, ""));

interface Residual {
    sum: number;
    n: number;
    t: number;
}

interface MapPlay {
    plays: number;
    uniform: number;
    n: number;
}

/** Per-lineage map strength and recent map play from Liquipedia results; mirrors `State.centred_u` and `Play` in `wp/src/cs2wp/`. */
export class VetoInputs {
    private params: VetoInputParams;
    private eloScale: number;
    private residuals = new Map<number, Map<string, Residual>>();
    private play = new Map<number, { t: number; maps: Map<string, MapPlay> }>();

    constructor(params: VetoInputParams, eloScale: number) {
        this.params = params;
        this.eloScale = eloScale;
    }

    /** Takes series in time order. */
    add({ t, lineages, ratings, maps, poolOffsets }: Pick<SeriesPrediction, "t" | "lineages" | "ratings" | "maps" | "poolOffsets">): void {
        // The map model was fit on residuals against ratings without region priors.
        const pBase = 1 / (1 + 10 ** (-(ratings[0] - ratings[1]) / this.eloScale));
        const played = maps.map((m) => mapKey(m.map));
        const pool = Object.keys(poolOffsets[0]).map(mapKey);
        lineages.forEach((lineage, side) => {
            maps.forEach(({ y }, i) => this.addResidual(lineage, played[i], side === 0 ? y - pBase : pBase - y, t));
            this.addPlay(lineage, played, pool, t);
        });
    }

    team(lineage: number, pool: string[], t: number): TeamMaps {
        const residuals = this.residuals.get(lineage);
        const u = pool.map((map) => {
            const r = residuals?.get(mapKey(map));
            if (!r) return 0;
            const d = Math.exp(-(t - r.t) / (this.params.tau * DAY));
            return (r.sum * d) / (r.n * d + this.params.k);
        });
        const mean = u.reduce((sum, v) => sum + v, 0) / pool.length;

        const history = this.play.get(lineage);
        const d = history ? Math.exp(-(t - history.t) / (this.params.playTau * DAY)) : 1;
        const play = pool.map((map) => {
            const p = history?.maps.get(mapKey(map));
            return p ? ((p.plays - p.uniform) * d) / (p.n * d + this.params.playPrior) : 0;
        });
        return { u: u.map((v) => v - mean), play };
    }

    private addResidual(lineage: number, map: string, residual: number, t: number): void {
        let byMap = this.residuals.get(lineage);
        if (!byMap) this.residuals.set(lineage, (byMap = new Map()));
        const r = byMap.get(map);
        if (!r) {
            byMap.set(map, { sum: residual, n: 1, t });
            return;
        }
        const d = Math.exp(-(t - r.t) / (this.params.tau * DAY));
        r.sum = r.sum * d + residual;
        r.n = r.n * d + 1;
        r.t = t;
    }

    private addPlay(lineage: number, played: string[], pool: string[], t: number): void {
        let history = this.play.get(lineage);
        if (!history) this.play.set(lineage, (history = { t, maps: new Map() }));
        const d = Math.exp(-(t - history.t) / (this.params.playTau * DAY));
        history.t = t;
        for (const p of history.maps.values()) {
            p.plays *= d;
            p.uniform *= d;
            p.n *= d;
        }
        // A map's uniform share accrues only while it's in the pool, so one that just entered starts neutral.
        for (const map of new Set([...pool, ...played])) {
            let p = history.maps.get(map);
            if (!p) history.maps.set(map, (p = { plays: 0, uniform: 0, n: 0 }));
            p.plays += played.filter((m) => m === map).length;
            p.uniform += played.length / POOL_SIZE;
            p.n++;
        }
    }
}
