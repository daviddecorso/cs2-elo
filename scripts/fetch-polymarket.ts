import fs from "node:fs";
import {
    EVENTS_PATH,
    PRICES_DIR,
    RateLimited,
    fetchClosedEvents,
    fetchPrices,
    parseStart,
    pricePath,
    readEvents,
    type PmEvent,
} from "./lib/markets/polymarket.ts";

// Offline benchmark data only: nothing here is published to the site (see docs/elo-model.md, Market benchmark).
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const full = args.includes("--full");
const minVolume = Number(option("min-volume", "500"));
const priceLimit = Number(option("limit", "Infinity"));
const REFETCH_DAYS = 14;

const cached = full ? [] : readEvents();
const latestEnd = cached.reduce((max, e) => (e.endDate && e.endDate > max ? e.endDate : max), "");
const since = latestEnd ? new Date(Date.parse(latestEnd) - REFETCH_DAYS * 86400_000).toISOString() : null;
console.log(since ? `Events ending since ${since.slice(0, 10)} (${cached.length} cached)` : "All closed CS2 events");

const byId = new Map(cached.map((e) => [e.id, e]));
for (const e of await fetchClosedEvents(since)) byId.set(e.id, e);
const events: PmEvent[] = [...byId.values()].sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
fs.mkdirSync(PRICES_DIR, { recursive: true });
fs.writeFileSync(EVENTS_PATH, JSON.stringify(events));
console.log(`Wrote ${events.length} events`);

const todo = events
    .flatMap((e) => e.markets.filter((m) => m.type === "moneyline" && m.volume >= minVolume))
    .filter((m) => parseStart(m.gameStartTime) !== null && !fs.existsSync(pricePath(m.id)))
    .slice(0, priceLimit);
console.log(`Price histories to fetch: ${todo.length} (moneyline, volume ≥ $${minVolume})`);

let done = 0;
try {
    for (const m of todo) {
        const prices = await fetchPrices(m, parseStart(m.gameStartTime)!);
        fs.writeFileSync(pricePath(m.id), JSON.stringify(prices));
        process.stdout.write(`\r  prices: ${++done}/${todo.length}`);
        await new Promise((r) => setTimeout(r, 150));
    }
} catch (err) {
    if (!(err instanceof RateLimited)) throw err;
    console.log(`\n${err.message}; stopping. Rerun later to resume.`);
}
process.stdout.write("\n");
