import fs from "node:fs";
import path from "node:path";

export const DEFAULT_HLTV_RANKS_PATH = path.resolve(import.meta.dirname, "../../../data/demos/hltv/ranks.jsonl");

const EPS = 1e-6;

export interface HltvRankEntry {
    ranks: [number, number];
    points: [number, number] | null;
}

export interface HltvPointsLink {
    id: "log" | "linear";
    label: string;
    diff: (ptsA: number, ptsB: number) => number;
}

export const HLTV_POINTS_LINKS: readonly HltvPointsLink[] = [
    { id: "log", label: "ln pts_a − ln pts_b", diff: (a, b) => Math.log(a) - Math.log(b) },
    { id: "linear", label: "(pts_a − pts_b) / 100", diff: (a, b) => (a - b) / 100 },
];

export const readHltvRanks = (file = DEFAULT_HLTV_RANKS_PATH): Map<string, HltvRankEntry> | null => {
    if (!fs.existsSync(file)) return null;
    const ranks = new Map<string, HltvRankEntry>();
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { match2id: string; ranks: [number, number]; points?: [number, number] | null };
        ranks.set(row.match2id, { ranks: row.ranks, points: row.points ?? null });
    }
    return ranks;
};

export const logisticProbability = (diff: number, beta: number): number => 1 / (1 + Math.exp(-beta * diff));

export const rankDiff = (rankA: number, rankB: number): number => Math.log(rankB) - Math.log(rankA);

export const rankProbability = (rankA: number, rankB: number, beta: number): number =>
    logisticProbability(rankDiff(rankA, rankB), beta);

export const fitBeta = (rows: Array<{ diff: number; y: 0 | 1 }>): { beta: number; loss: number } => {
    let best = { beta: 1, loss: Infinity };
    for (let i = 1; i <= 500; i++) {
        const beta = i / 100;
        let loss = 0;
        for (let j = 0; j < rows.length; j++) {
            const p = logisticProbability(rows[j].diff, beta);
            const q = Math.min(1 - EPS, Math.max(EPS, p));
            loss -= rows[j].y ? Math.log(q) : Math.log(1 - q);
        }
        if (loss < best.loss) best = { beta, loss };
    }
    return { beta: best.beta, loss: best.loss / rows.length };
};

export const fitRankBeta = (rows: Array<{ rankA: number; rankB: number; y: 0 | 1 }>): number =>
    fitBeta(rows.map(({ rankA, rankB, y }) => ({ diff: rankDiff(rankA, rankB), y }))).beta;
