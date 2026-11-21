import { freezeCsgoHistory, freezeHistory } from "./lib/elo/history.ts";

const csgo = process.argv.includes("--game") && process.argv[process.argv.indexOf("--game") + 1] === "csgo";
const written = csgo ? freezeCsgoHistory() : freezeHistory(new Date().toISOString().slice(0, 10));
const dir = csgo ? "data/history/csgo/" : "data/history/";
console.log(written.length ? `Froze ${written.length} months into ${dir}.` : "No new months to freeze.");
