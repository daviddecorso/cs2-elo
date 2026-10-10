import { execFileSync } from "node:child_process";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { getRosterKey, type Region, type Roster, type Standings } from "../../../src/vrs/types.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../../");
const submodulePath = path.resolve(repoRoot, "vendor/counter-strike_regional_standings");
const valveModelDir = path.resolve(submodulePath, "model");

let inMemoryJson = "";
const fsShim = {
    readFileSync: () => inMemoryJson,
};

const moduleCache = new Map<string, { exports: unknown }>();

const loadValveCjs = (filePath: string): unknown => {
    let resolved = filePath;
    if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.js`)) {
        resolved = `${resolved}.js`;
    }
    if (moduleCache.has(resolved)) {
        return moduleCache.get(resolved)!.exports;
    }

    const code = fs.readFileSync(resolved, "utf8");
    const wrapper = Module.wrap(code);
    const script = new vm.Script(wrapper, { filename: resolved });
    const fn = script.runInThisContext();
    const dir = path.dirname(resolved);

    const customRequire = (id: string): unknown => {
        if (id === "fs" || id === "node:fs") return fsShim;
        if (id.startsWith(".")) {
            const target = path.resolve(dir, id);
            return loadValveCjs(target);
        }
        const nodeReq = createRequire(resolved);
        return nodeReq(id);
    };

    const mod = { exports: {} };
    moduleCache.set(resolved, mod);
    fn(mod.exports, customRequire, mod, resolved, dir);
    return mod.exports;
};

interface ValveRankingModule {
    generateRanking: (versionTimestamp: number, filename: string) => [unknown[], ValveTeam[]];
}

interface ValveGlickoTeam {
    rank: () => number;
}

interface ValveTeam {
    name: string;
    rankValue: number;
    rankValueSeed: number;
    globalRank?: number;
    regionalRank: number[];
    region: number[];
    satisfiesRankingCriteria: boolean;
    activeRoster: Array<{ nick: string }>;
    glickoTeam: ValveGlickoTeam;
    modifiers: {
        bountyOffered: number;
        bountyCollected: number;
        opponentNetwork: number;
        lanFactor: number;
    };
}

let rankingModule: ValveRankingModule | null = null;
const getRankingModule = (): ValveRankingModule => {
    if (!rankingModule) {
        rankingModule = loadValveCjs(path.join(valveModelDir, "ranking.js")) as ValveRankingModule;
    }
    return rankingModule;
};

let cachedValveCommit = "";
let cachedModelCommit = "";

const getSubmoduleCommits = (): { valveCommit: string; modelCommit: string } => {
    if (!cachedValveCommit || !cachedModelCommit) {
        cachedValveCommit = execFileSync("git", ["-C", submodulePath, "rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim();
        cachedModelCommit = execFileSync(
            "git",
            ["-C", submodulePath, "log", "-n", "1", "--format=%H", "--", "model"],
            { encoding: "utf8" }
        ).trim();
        if (!cachedValveCommit || !cachedModelCommit) {
            throw new Error(`Failed to resolve submodule commits in ${submodulePath}`);
        }
    }
    return { valveCommit: cachedValveCommit, modelCommit: cachedModelCommit };
};

const validateSnapshotDate = (snapshotDate: string): void => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
        throw new Error(`snapshotDate must be YYYY-MM-DD, got "${snapshotDate}"`);
    }
    const [y, m, d] = snapshotDate.split("-").map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d));
    if (
        dateObj.getUTCFullYear() !== y ||
        dateObj.getUTCMonth() !== m - 1 ||
        dateObj.getUTCDate() !== d
    ) {
        throw new Error(`Invalid calendar date for snapshotDate: "${snapshotDate}"`);
    }
};

export const getLosAngelesMidnightSeconds = (dateStr: string): number => {
    validateSnapshotDate(dateStr);
    const [y, m, d] = dateStr.split("-").map(Number);
    const approxUtc = Date.UTC(y, m - 1, d, 8, 0, 0);
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    const parts = formatter.formatToParts(new Date(approxUtc));
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    const second = Number(parts.find((p) => p.type === "second")?.value ?? 0);
    const diffSec = hour * 3600 + minute * 60 + second;
    return Math.floor(approxUtc / 1000) - diffSec;
};

const regionIdxToName = (idx: number): Region => {
    if (idx === 0) return "Europe";
    if (idx === 1) return "Americas";
    return "Asia";
};

/**
 * Pure wrapper around Valve's official Regional Standings model. It isolates
 * Valve's unmodified CommonJS codebase inside a dedicated VM context with an
 * in-memory filesystem shim, guaranteeing that callers' inputs are not mutated
 * and no side effects reach disk. Snapshot cutoff semantics filter matches to
 * those starting strictly before 00:00 America/Los_Angeles on snapshotDate,
 * passing versionTimestamp -1 so the time window aligns with the latest match
 * in the dataset rather than shifting the window end.
 */
export const computeStandings = (
    matchData: unknown[],
    eventData: unknown[],
    snapshotDate: string
): Standings => {
    validateSnapshotDate(snapshotDate);

    const cutoffSeconds = getLosAngelesMidnightSeconds(snapshotDate);

    // Keep only matches before cutoff
    const filteredMatches = (matchData as Array<{ matchStartTime: number }>).filter(
        (m) => m.matchStartTime < cutoffSeconds
    );

    // Deep clone and store in memory shim
    inMemoryJson = JSON.stringify({
        matches: filteredMatches,
        events: eventData,
    });

    const ranking = getRankingModule();
    const [, teams] = ranking.generateRanking(-1, "in-memory-sentinel.json");

    const { valveCommit, modelCommit } = getSubmoduleCommits();

    const rosters: Roster[] = teams.map((team) => {
        const players = team.activeRoster.map((p) => p.nick);
        const rosterKey = getRosterKey(players);
        const regionIdx = team.region.findIndex((v) => v === 1);
        const region = regionIdxToName(regionIdx >= 0 ? regionIdx : 0);
        const points = team.glickoTeam.rank();
        const startingValue = team.rankValueSeed;
        const h2hAdjustment = points - startingValue;

        return {
            rosterKey,
            teamName: team.name,
            region,
            regionalRank:
                team.satisfiesRankingCriteria && regionIdx >= 0
                    ? team.regionalRank[regionIdx]
                    : null,
            globalRank: team.satisfiesRankingCriteria ? (team.globalRank ?? null) : null,
            points,
            factors: {
                bountyOffered: team.modifiers.bountyOffered,
                bountyCollected: team.modifiers.bountyCollected,
                opponentNetwork: team.modifiers.opponentNetwork,
                lanFactor: team.modifiers.lanFactor,
            },
            startingValue,
            h2hAdjustment,
            players,
        };
    });

    return {
        snapshotDate,
        valveCommit,
        modelCommit,
        source: "model",
        generatedAt: new Date().toISOString(),
        rosters,
    };
};
