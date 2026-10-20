export interface WindowInterval {
    lo: number;
    hi: number;
}

/** Narrowest range covered by the most intervals, and how many cover it. */
export const bestCoverage = (intervals: WindowInterval[]): WindowInterval & { count: number } => {
    const edges = intervals.flatMap((iv) => [
        { at: iv.lo, delta: 1 },
        { at: iv.hi, delta: -1 },
    ]);
    // Opens sort before closes at the same instant, so touching intervals overlap.
    edges.sort((a, b) => a.at - b.at || b.delta - a.delta);
    let count = 0;
    let best = { lo: 0, hi: 0, count: 0 };
    for (let i = 0; i < edges.length; i++) {
        count += edges[i].delta;
        if (edges[i].delta === 1 && count > best.count) {
            best = { lo: edges[i].at, hi: edges[i + 1].at, count };
        }
    }
    return best;
};
