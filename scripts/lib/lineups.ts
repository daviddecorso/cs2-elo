const LINEUP_WINDOW_SECONDS = 21 * 24 * 3600;

export interface ListedLineup<P> {
    team: string;
    /** Unix seconds. */
    t: number;
    players: P[];
}

/** Liquipedia lists everyone who appeared in a series (6+ after a substitution, sometimes under 5); this trims or fills from the team's 5-player lineups within ±21 days. */
export const makeLineupResolver = <P>(lineups: Iterable<ListedLineup<P>>, idOf: (p: P) => string) => {
    const fullLineups = new Map<string, Array<{ t: number; players: P[] }>>();
    for (const l of lineups) {
        if (l.players.length !== 5) continue;
        if (!fullLineups.has(l.team)) fullLineups.set(l.team, []);
        fullLineups.get(l.team)!.push({ t: l.t, players: l.players });
    }

    return (team: string, t: number, listed: P[]): P[] | null => {
        if (listed.length === 5) return listed;
        if (listed.length === 0) return null;

        const counts = new Map<string, { player: P; n: number }>();
        for (const lineup of fullLineups.get(team) ?? []) {
            if (Math.abs(lineup.t - t) > LINEUP_WINDOW_SECONDS) continue;
            for (const p of lineup.players) {
                const entry = counts.get(idOf(p)) ?? { player: p, n: 0 };
                entry.n++;
                counts.set(idOf(p), entry);
            }
        }
        const frequency = (p: P) => counts.get(idOf(p))?.n ?? 0;

        if (listed.length > 5) {
            return listed
                .map((p, idx) => ({ p, idx }))
                .sort((a, b) => frequency(b.p) - frequency(a.p) || a.idx - b.idx)
                .slice(0, 5)
                .sort((a, b) => a.idx - b.idx)
                .map(({ p }) => p);
        }

        const listedIds = new Set(listed.map(idOf));
        const fillers = [...counts.values()]
            .filter(({ player }) => !listedIds.has(idOf(player)))
            .sort((a, b) => b.n - a.n)
            .slice(0, 5 - listed.length)
            .map(({ player }) => player);
        return listed.length + fillers.length === 5 ? [...listed, ...fillers] : null;
    };
};
