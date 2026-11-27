import fs from "node:fs";
import path from "node:path";

export const POLYMARKET_DIR = path.resolve(import.meta.dirname, "../../../data/markets/polymarket");
export const EVENTS_PATH = path.join(POLYMARKET_DIR, "events.json");
export const PRICES_DIR = path.join(POLYMARKET_DIR, "prices");

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const CS2_SERIES_ID = 10310;

/** Seconds of price history kept on each side of the scheduled start. */
export const PRICE_WINDOW = { before: 48 * 3600, after: 3600 };

export interface PmMarket {
    id: string;
    /** `moneyline` (series winner), `child_moneyline` (map winner), `map_handicap`, `totals`. */
    type: string;
    question: string;
    outcomes: [string, string];
    /** Final prices; "1" marks the winning outcome once resolved. */
    outcomePrices: [string, string];
    /** CLOB token per outcome, same order as `outcomes`. */
    tokens: [string, string];
    gameStartTime: string | null;
    volume: number;
}

export interface PmEvent {
    id: string;
    title: string;
    slug: string;
    startTime: string | null;
    endDate: string | null;
    teams: string[];
    markets: PmMarket[];
}

/** One price point for outcome 0's token; `t` is Unix seconds. */
export interface PricePoint {
    t: number;
    p: number;
}

export interface PriceFile {
    marketId: string;
    token: string;
    startTs: number;
    endTs: number;
    history: PricePoint[];
}

export class RateLimited extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const getJson = async (url: string): Promise<unknown> => {
    const res = await fetch(url, { headers: { "accept-encoding": "gzip" } });
    if (res.status === 429) throw new RateLimited(`429 from ${new URL(url).host}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json();
};

const parseList = (raw: unknown): string[] => (typeof raw === "string" ? (JSON.parse(raw) as string[]) : ((raw as string[]) ?? []));

const toMarket = (m: Record<string, unknown>): PmMarket | null => {
    const outcomes = parseList(m.outcomes);
    const tokens = parseList(m.clobTokenIds);
    if (outcomes.length !== 2 || tokens.length !== 2) return null;
    return {
        id: String(m.id),
        type: String(m.sportsMarketType ?? ""),
        question: String(m.question ?? ""),
        outcomes: outcomes as [string, string],
        outcomePrices: parseList(m.outcomePrices) as [string, string],
        tokens: tokens as [string, string],
        gameStartTime: (m.gameStartTime as string | undefined) ?? null,
        volume: Number(m.volumeNum ?? m.volume ?? 0),
    };
};

const toEvent = (e: Record<string, unknown>): PmEvent => ({
    id: String(e.id),
    title: String(e.title ?? ""),
    slug: String(e.slug ?? ""),
    startTime: (e.startTime as string | undefined) ?? null,
    endDate: (e.endDate as string | undefined) ?? null,
    teams: ((e.teams as Array<{ name?: string }> | undefined) ?? []).map((t) => t.name ?? ""),
    markets: ((e.markets as Array<Record<string, unknown>> | undefined) ?? []).map(toMarket).filter((m): m is PmMarket => m !== null),
});

export const readEvents = (): PmEvent[] => (fs.existsSync(EVENTS_PATH) ? (JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8")) as PmEvent[]) : []);

/** Gamma rejects offsets past about 2,000 (422). */
const MAX_OFFSET = 1900;

/** Closed CS2 match events ending on or after `endDateMin` (ISO), oldest first. */
export async function fetchClosedEvents(endDateMin: string | null, pageSize = 100, delayMs = 250): Promise<PmEvent[]> {
    const out = new Map<string, PmEvent>();
    let startDateMin: string | null = null;
    for (let offset = 0; ; offset += pageSize) {
        const params = new URLSearchParams({
            series_id: String(CS2_SERIES_ID),
            closed: "true",
            limit: String(pageSize),
            offset: String(offset),
            order: "startDate",
            ascending: "true",
        });
        if (endDateMin) params.set("end_date_min", endDateMin);
        if (startDateMin) params.set("start_date_min", startDateMin);
        const page = (await getJson(`${GAMMA}/events?${params}`)) as Array<Record<string, unknown>>;
        for (const e of page) out.set(String(e.id), toEvent(e));
        process.stdout.write(`\r  events: ${out.size}`);
        if (page.length < pageSize) break;
        if (offset >= MAX_OFFSET) {
            const last = String(page.at(-1)!.startDate);
            if (last === startDateMin) throw new Error(`More than ${MAX_OFFSET + pageSize} events share startDate ${last}`);
            startDateMin = last;
            offset = -pageSize;
        }
        await sleep(delayMs);
    }
    process.stdout.write("\n");
    return [...out.values()];
}

export const pricePath = (marketId: string) => path.join(PRICES_DIR, `${marketId}.json`);

export const readPrices = (marketId: string): PriceFile | null => {
    const file = pricePath(marketId);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as PriceFile) : null;
};

/** Outcome 0's price history around `startTs`, at `fidelity`-minute resolution. */
export async function fetchPrices(market: PmMarket, startTs: number, fidelity = 5): Promise<PriceFile> {
    const from = startTs - PRICE_WINDOW.before;
    const to = startTs + PRICE_WINDOW.after;
    const params = new URLSearchParams({ market: market.tokens[0], startTs: String(from), endTs: String(to), fidelity: String(fidelity) });
    const body = (await getJson(`${CLOB}/prices-history?${params}`)) as { history?: PricePoint[] };
    return { marketId: market.id, token: market.tokens[0], startTs: from, endTs: to, history: body.history ?? [] };
}

/** Gamma's `gameStartTime` ("2026-11-22 16:30:00+00") as Unix seconds. */
export const parseStart = (s: string | null): number | null => {
    if (!s) return null;
    const ms = Date.parse(s.replace(" ", "T").replace(/\+00$/, "Z"));
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};
