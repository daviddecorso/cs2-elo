import { freezeHistory } from "./lib/elo/history.ts";

const written = freezeHistory(new Date().toISOString().slice(0, 10));
console.log(written.length ? `Froze ${written.length} months into data/history/.` : "No new months to freeze.");
