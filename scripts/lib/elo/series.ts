/** Probability of winning a best-of-`bestOf` series of independent maps won with `p`, its logit first scaled by `mapTemp` for Bo3/Bo5. */
export const seriesWinProbability = (p: number, bestOf: number, mapTemp = 1): number => {
    const need = Math.floor(seriesLength(bestOf) / 2) + 1;
    if (need > 1 && mapTemp !== 1 && p > 0 && p < 1) p = 1 / (1 + (p / (1 - p)) ** -mapTemp);
    let total = 0;
    let binom = 1;
    for (let losses = 0; losses < need; losses++) {
        if (losses > 0) binom = (binom * (need - 1 + losses)) / losses;
        total += binom * p ** need * (1 - p) ** losses;
    }
    return total;
};

/** Bo2 series that produced a winner are scored as Bo3; anything longer than Bo3 as Bo5. */
export const seriesLength = (bestOf: number): 1 | 3 | 5 => (bestOf <= 1 ? 1 : bestOf <= 3 ? 3 : 5);

const POOL_WINDOW_SECONDS = 60 * 24 * 3600;
const POOL_MIN_SHARE = 0.03;

/** Maps holding at least 3% of maps played in the trailing 60 days (as of the start of the UTC day), which tracks Valve's pool rotations. */
export class ActivePool {
    private played: Array<{ t: number; map: string }> = [];
    private head = 0;
    private counts = new Map<string, number>();
    private cached = { day: -1, pool: [] as string[] };

    record(t: number, map: string): void {
        this.played.push({ t, map });
        this.counts.set(map, (this.counts.get(map) ?? 0) + 1);
    }

    at(t: number): string[] {
        const day = Math.floor(t / 86400);
        if (day !== this.cached.day) this.cached = { day, pool: this.compute(day * 86400) };
        return this.cached.pool;
    }

    private compute(t: number): string[] {
        while (this.head < this.played.length && this.played[this.head].t < t - POOL_WINDOW_SECONDS) {
            const { map } = this.played[this.head++];
            this.counts.set(map, this.counts.get(map)! - 1);
        }
        const total = this.played.length - this.head;
        return [...this.counts]
            .filter(([map, n]) => n > 0 && n >= total * POOL_MIN_SHARE && map !== "Unknown" && map !== "Default")
            .map(([map]) => map)
            .sort();
    }
}
