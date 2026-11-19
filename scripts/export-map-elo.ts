import fs from "node:fs";
import path from "node:path";
import { EloEngine } from "./lib/elo/engine.ts";
import { loadFeed } from "./lib/elo/history.ts";
import { DEFAULT_PARAMS } from "./lib/elo/params.ts";

// Pre-map Elo for every played map, read by wp/ to give each demo round its team strength gap.
// Maps are keyed by (match2id, Liquipedia map name, order among scored maps) because Elo drops unplayed games.
// Stays on luckWeight 0 so WP credits don't move with the luck experiment.
const OUT = path.resolve("data/wp/elo-maps.jsonl");
// One row per series: base ratings and map offsets over the active pool, read by the veto model.
const SERIES_OUT = path.resolve("data/wp/elo-series.jsonl");

const round2 = (r: number) => Math.round(r * 100) / 100;

const feed = loadFeed();
const engine = new EloEngine({ ...DEFAULT_PARAMS, luckWeight: 0 }, feed.players);
const byId = new Map(feed.matches.map((m) => [m.id, m]));
const lines: string[] = [];
const seriesLines: string[] = [];
for (const s of engine.run(feed.matches)) {
    const split = s.id.lastIndexOf(":");
    const series = byId.get(s.id)!;
    const match2id = s.id.slice(split + 1);
    const pagename = s.id.slice(0, split);
    s.maps.forEach((m, index) => {
        lines.push(
            JSON.stringify({
                match2id,
                pagename,
                t: s.t,
                tier: series.tier,
                lan: series.lan,
                index,
                map: m.map,
                teams: s.teams,
                lineages: s.lineages,
                rounds: series.maps[index].rounds,
                ratings: m.ratings.map(round2),
                p: m.p,
            })
        );
    });
    seriesLines.push(
        JSON.stringify({
            match2id,
            pagename,
            t: s.t,
            tier: series.tier,
            lan: series.lan,
            bestOf: s.bestOf,
            teams: s.teams,
            lineages: s.lineages,
            ratings: s.ratings.map(round2),
            offsets: s.poolOffsets.map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v)]))),
            maps: s.maps.map((m) => m.map),
            p: s.p,
            y: s.y,
        })
    );
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${lines.join("\n")}\n`);
fs.writeFileSync(SERIES_OUT, `${seriesLines.join("\n")}\n`);
console.log(`Wrote ${lines.length} maps to ${path.relative(process.cwd(), OUT)} and ${seriesLines.length} series to ${path.relative(process.cwd(), SERIES_OUT)}.`);
