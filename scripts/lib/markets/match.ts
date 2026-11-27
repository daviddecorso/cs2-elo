const DROP_TOKENS = new Set(["team", "esports", "esport", "gaming", "clan", "club", "gg"]);

/** Comparable team key: accents, parentheticals, punctuation and org filler words removed. */
export const normalizeTeam = (name: string): string =>
    name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/\([^)]*\)/g, " ")
        .replace(/e-sports?/g, "esports")
        .split(/[^a-z0-9]+/)
        .filter((w) => w && !DROP_TOKENS.has(w))
        .join("");

export interface FeedSeries {
    id: string;
    /** Unix seconds. */
    t: number;
    teams: [string, string];
}

export interface MarketSide {
    marketId: string;
    outcomes: [string, string];
    /** Unix seconds. */
    start: number;
}

export interface MarketMatch {
    marketId: string;
    seriesId: string;
    /** True when the market's outcome 0 is the feed's teams[1]. */
    swapped: boolean;
}

export const MATCH_WINDOW = 36 * 3600;
/** Two candidate series this close to each other make the market ambiguous. */
export const AMBIGUOUS_GAP = 6 * 3600;

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** `names`: Liquipedia team page → extra names (e.g. Valve's). `aliases`: Polymarket outcome name → page. */
export function matchMarkets(
    series: FeedSeries[],
    markets: MarketSide[],
    names: Map<string, string[]> = new Map(),
    aliases: Record<string, string> = {},
): { matches: MarketMatch[]; unmatched: MarketSide[]; ambiguous: MarketSide[] } {
    const keysOf = (team: string) => [...new Set([team, ...(names.get(team) ?? [])].map(normalizeTeam).filter(Boolean))];
    const byPair = new Map<string, FeedSeries[]>();
    for (const s of series) {
        for (const a of keysOf(s.teams[0])) {
            for (const b of keysOf(s.teams[1])) {
                const key = pairKey(a, b);
                const list = byPair.get(key) ?? [];
                if (!list.includes(s)) list.push(s);
                byPair.set(key, list);
            }
        }
    }
    const outcomeKey = (name: string) => normalizeTeam(aliases[name] ?? name);

    const matches: MarketMatch[] = [];
    const unmatched: MarketSide[] = [];
    const ambiguous: MarketSide[] = [];
    for (const m of markets) {
        const [ka, kb] = m.outcomes.map(outcomeKey);
        const candidates = (byPair.get(pairKey(ka, kb)) ?? [])
            .filter((s) => Math.abs(s.t - m.start) <= MATCH_WINDOW)
            .sort((x, y) => Math.abs(x.t - m.start) - Math.abs(y.t - m.start));
        if (!candidates.length) {
            unmatched.push(m);
            continue;
        }
        if (candidates.length > 1 && Math.abs(candidates[1].t - candidates[0].t) < AMBIGUOUS_GAP) {
            ambiguous.push(m);
            continue;
        }
        const s = candidates[0];
        matches.push({ marketId: m.marketId, seriesId: s.id, swapped: !keysOf(s.teams[0]).includes(ka) });
    }
    return { matches, unmatched, ambiguous };
}

/** Polymarket lists a match at this price before anyone trades it. */
const SEED_PRICE = 0.5;

/** `close` is the last point before `start`; `open` is the price `leadSeconds` before it, null if the market wasn't trading yet or still sat at the seed. */
export function closeAndOpen(history: Array<{ t: number; p: number }>, start: number, leadSeconds = 24 * 3600) {
    const pre = history.filter((h) => h.t < start).sort((a, b) => a.t - b.t);
    if (!pre.length) return null;
    const open = pre.filter((h) => h.t <= start - leadSeconds).at(-1) ?? null;
    return { close: pre.at(-1)!, open: open && Math.abs(open.p - SEED_PRICE) > 0.005 ? open : null };
}
