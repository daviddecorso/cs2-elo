import fs from "node:fs";
import path from "node:path";
import { EloEngine } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";

// Pre-map Elo for every played map, read by wp/ to give each demo round its team strength gap.
// Maps are keyed by (match2id, Liquipedia map name, order among scored maps) because Elo drops unplayed games.
const OUT = path.resolve("data/wp/elo-maps.jsonl");

const feed = loadFeed();
const engine = new EloEngine(DEFAULT_PARAMS, feed.players);
const byId = new Map(feed.matches.map((m) => [m.id, m]));
const lines: string[] = [];
for (const s of engine.run(feed.matches)) {
    const split = s.id.lastIndexOf(":");
    const series = byId.get(s.id)!;
    s.maps.forEach((m, index) => {
        lines.push(
            JSON.stringify({
                match2id: s.id.slice(split + 1),
                pagename: s.id.slice(0, split),
                t: s.t,
                tier: series.tier,
                lan: series.lan,
                index,
                map: m.map,
                teams: s.teams,
                rounds: series.maps[index].rounds,
                ratings: m.ratings.map((r) => Math.round(r * 100) / 100),
                p: m.p,
            })
        );
    });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${lines.join("\n")}\n`);
console.log(`Wrote ${lines.length} maps to ${path.relative(process.cwd(), OUT)}.`);
