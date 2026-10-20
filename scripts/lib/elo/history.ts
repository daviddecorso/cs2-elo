import fs from "node:fs";
import path from "node:path";
import { normalizeMatches, type RawRow } from "./normalize.ts";
import type { EloMatch, EloPlayers, HistoryMonth } from "./types.ts";

/** Months are `YYYY-MM`. */
export const addMonths = (month: string, n: number): string => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 7);
};

export const monthEnd = (month: string): string => {
    const d = new Date(`${addMonths(month, 1)}-01T00:00:00Z`);
    d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
};

const monthOf = (t: number): string => new Date(t * 1000).toISOString().slice(0, 7);

/** Liquipedia keeps editing results for a while; months younger than this stay in the hot store. */
export const FREEZE_AFTER_DAYS = 60;

const readJson = <T>(filePath: string, fallback: T): T =>
    fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as T) : fallback;

export interface FeedPaths {
    rawDir: string;
    historyDir: string;
}

export const defaultFeedPaths = (root = process.cwd()): FeedPaths => ({
    rawDir: path.resolve(root, "data/raw"),
    historyDir: path.resolve(root, "data/history"),
});

const readHistory = (historyDir: string): HistoryMonth[] => {
    if (!fs.existsSync(historyDir)) return [];
    return fs
        .readdirSync(historyDir)
        .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
        .sort()
        .map((f) => readJson<HistoryMonth>(path.join(historyDir, f), { month: f.slice(0, 7), matches: [], players: {} }));
};

interface RawSource {
    /** Months this source covers completely. */
    completeMonths: Set<string>;
    matches: RawRow[];
    tournaments: RawRow[];
}

const readArchive = (rawDir: string): RawSource => {
    const archiveDir = path.join(rawDir, "archive");
    const done = readJson<{ done: string[] }>(path.join(archiveDir, "meta.json"), { done: [] }).done;
    const source: RawSource = { completeMonths: new Set(done), matches: [], tournaments: [] };
    for (const month of done) {
        source.matches.push(...readJson<RawRow[]>(path.join(archiveDir, `matches-${month}.json`), []));
        source.tournaments.push(...readJson<RawRow[]>(path.join(archiveDir, `tournaments-${month}.json`), []));
    }
    return source;
};

const readHot = (rawDir: string): RawSource => {
    const meta = readJson<{ from: string; to: string } | null>(path.join(rawDir, "meta.json"), null);
    const completeMonths = new Set<string>();
    if (meta) {
        for (let m = meta.from.slice(0, 7); m <= meta.to.slice(0, 7); m = addMonths(m, 1)) {
            if (`${m}-01` >= meta.from && monthEnd(m) <= meta.to) completeMonths.add(m);
        }
    }
    return {
        completeMonths,
        matches: readJson<RawRow[]>(path.join(rawDir, "matches.json"), []),
        tournaments: readJson<RawRow[]>(path.join(rawDir, "tournaments.json"), []),
    };
};

export interface Feed {
    matches: EloMatch[];
    players: EloPlayers;
}

/** Each month comes from exactly one source (history, archive or hot store), so overlapping fetches never double-count a series. */
export const loadFeed = (paths: FeedPaths = defaultFeedPaths()): Feed => {
    const history = readHistory(paths.historyDir);
    const frozen = new Set(history.map((h) => h.month));
    const players: EloPlayers = {};
    const matches: EloMatch[] = [];
    for (const h of history) {
        Object.assign(players, h.players);
        matches.push(...h.matches);
    }

    const archive = readArchive(paths.rawDir);
    const hot = readHot(paths.rawDir);
    const tournaments = [...archive.tournaments, ...hot.tournaments];
    const fromArchive = normalizeMatches(archive.matches, tournaments);
    const fromHot = normalizeMatches(hot.matches, tournaments);
    const hotMonths = new Set(fromHot.matches.map((m) => monthOf(m.t)));

    // The hot store wins wherever it has rows, unless the archive alone covers a month the hot store only partly does.
    const fromHotStore = (month: string) => hotMonths.has(month) && (hot.completeMonths.has(month) || !archive.completeMonths.has(month));
    for (const m of fromArchive.matches) {
        const month = monthOf(m.t);
        if (!frozen.has(month) && !fromHotStore(month)) matches.push(m);
    }
    for (const m of fromHot.matches) {
        const month = monthOf(m.t);
        if (!frozen.has(month) && fromHotStore(month)) matches.push(m);
    }
    Object.assign(players, fromArchive.players, fromHot.players);

    matches.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
    return { matches, players };
};

/** Writes every complete, settled month not yet in `data/history/`; returns the months written. */
export const freezeHistory = (today: string, paths: FeedPaths = defaultFeedPaths()): string[] => {
    const frozen = new Set(readHistory(paths.historyDir).map((h) => h.month));
    const archive = readArchive(paths.rawDir);
    const hot = readHot(paths.rawDir);
    const cutoff = new Date(`${today}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - FREEZE_AFTER_DAYS);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const tournaments = [...archive.tournaments, ...hot.tournaments];
    const written: string[] = [];
    fs.mkdirSync(paths.historyDir, { recursive: true });

    for (const [source, label] of [
        [hot, "hot"],
        [archive, "archive"],
    ] as const) {
        const months = [...source.completeMonths].filter((m) => !frozen.has(m) && monthEnd(m) < cutoffDate).sort();
        if (months.length === 0) continue;
        const wanted = new Set(months);
        const feed = normalizeMatches(
            source.matches.filter((r) => wanted.has(String(r.date ?? "").slice(0, 7))),
            tournaments
        );
        for (const month of months) {
            const monthMatches = feed.matches.filter((m) => monthOf(m.t) === month);
            const monthPlayers: EloPlayers = {};
            for (const m of monthMatches) {
                for (const p of m.lineups.flat()) if (feed.players[p]) monthPlayers[p] = feed.players[p];
            }
            const out: HistoryMonth = { month, matches: monthMatches, players: monthPlayers };
            fs.writeFileSync(path.join(paths.historyDir, `${month}.json`), JSON.stringify(out));
            frozen.add(month);
            written.push(month);
            console.log(`Froze ${month} from the ${label} store: ${monthMatches.length} series.`);
        }
    }
    return written.sort();
};
