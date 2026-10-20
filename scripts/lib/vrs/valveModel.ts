import { execFileSync } from "node:child_process";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { getRosterKey, type Region, type Roster, type Standings } from "../../../src/vrs/types.ts";

import { parseDetailsFile, type ParsedDetailsFile } from "./valveDetails.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../../");
const submodulePath = path.resolve(repoRoot, "vendor/counter-strike_regional_standings");
const valveModelDir = path.resolve(submodulePath, "model");

let inMemoryJson = "";
const inMemoryFiles = new Map<string, string>();

export const getInMemoryFiles = (): Map<string, string> => inMemoryFiles;

const fsShim = {
    readFileSync: (filePath: string) => {
        if (filePath.endsWith(".json")) return inMemoryJson;
        if (inMemoryFiles.has(filePath)) return inMemoryFiles.get(filePath)!;
        return "";
    },
    existsSync: () => true,
    mkdirSync: () => {},
    writeFileSync: (filePath: string, content: string) => {
        inMemoryFiles.set(filePath, content);
    },
};

const moduleCache = new Map<string, { exports: unknown }>();

export const loadValveCjs = (filePath: string): unknown => {
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

interface ValveReportModule {
    generateOutput: (teams: ValveTeam[], regions: number[], strDate: string) => void;
}

let reportModule: ValveReportModule | null = null;
const getReportModule = (): ValveReportModule => {
    if (!reportModule) {
        reportModule = loadValveCjs(path.join(valveModelDir, "report.js")) as ValveReportModule;
    }
    return reportModule;
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

// Valve's data pull runs into the snapshot day, and its window ends at the latest match in that
// pull. Published snapshots are calibrated from the age weights in their details files.
const WINDOW_ENDS: Record<string, number> = JSON.parse(
    fs.readFileSync(path.join(currentDir, "snapshotWindowEnds.json"), "utf8")
).windowEnds;

const DEFAULT_PULL_HOUR_LA = 7;

export interface SnapshotWindow {
    /** Unix seconds. Later matches are not in the pull, and their events count as unfinished. */
    pullTime: number;
    /** Valve's versionTimestamp; -1 lets Valve end the window at the latest match in the pull. */
    versionTimestamp: number;
}

export const getSnapshotWindow = (snapshotDate: string): SnapshotWindow => {
    validateSnapshotDate(snapshotDate);
    const calibrated = WINDOW_ENDS[snapshotDate];
    if (calibrated !== undefined) {
        return { pullTime: calibrated, versionTimestamp: calibrated };
    }
    return {
        pullTime: getLosAngelesMidnightSeconds(snapshotDate) + DEFAULT_PULL_HOUR_LA * 3600,
        versionTimestamp: -1,
    };
};

interface SnapshotEvent {
    eventId: string | number;
    finished?: boolean;
    endDate?: string;
}

const prepareSnapshotInput = (
    matchData: unknown[],
    eventData: unknown[],
    snapshotDate: string
): { json: string; versionTimestamp: number } => {
    const { pullTime, versionTimestamp } = getSnapshotWindow(snapshotDate);
    const matches = matchData as Array<{ matchStartTime: number; eventId: string | number }>;

    const eventsWithLaterMatches = new Set(
        matches.filter((m) => m.matchStartTime > pullTime).map((m) => String(m.eventId))
    );
    const events = (eventData as SnapshotEvent[]).map((ev) => {
        const finished =
            ev.finished !== false &&
            !(typeof ev.endDate === "string" && ev.endDate > snapshotDate) &&
            !eventsWithLaterMatches.has(String(ev.eventId));
        return finished === ev.finished ? ev : { ...ev, finished };
    });

    return {
        json: JSON.stringify({
            matches: matches.filter((m) => m.matchStartTime <= pullTime),
            events,
        }),
        versionTimestamp,
    };
};

const toRoster = (team: ValveTeam): Roster => {
    const players = team.activeRoster.map((p) => p.nick);
    const regionIdx = team.region.findIndex((v) => v === 1);
    const points = team.glickoTeam.rank();
    const startingValue = team.rankValueSeed;

    return {
        rosterKey: getRosterKey(players),
        teamName: team.name,
        region: regionIdxToName(regionIdx >= 0 ? regionIdx : 0),
        regionalRank:
            team.satisfiesRankingCriteria && regionIdx >= 0 ? team.regionalRank[regionIdx] : null,
        globalRank: team.satisfiesRankingCriteria ? (team.globalRank ?? null) : null,
        points,
        factors: {
            bountyOffered: team.modifiers.bountyOffered,
            bountyCollected: team.modifiers.bountyCollected,
            opponentNetwork: team.modifiers.opponentNetwork,
            lanFactor: team.modifiers.lanFactor,
        },
        startingValue,
        h2hAdjustment: points - startingValue,
        players,
    };
};

const runModel = (
    matchData: unknown[],
    eventData: unknown[],
    snapshotDate: string
): { standings: Standings; teams: ValveTeam[] } => {
    const { json, versionTimestamp } = prepareSnapshotInput(matchData, eventData, snapshotDate);
    inMemoryJson = json;

    const [, teams] = getRankingModule().generateRanking(versionTimestamp, "in-memory-sentinel.json");
    const { valveCommit, modelCommit } = getSubmoduleCommits();

    return {
        standings: {
            snapshotDate,
            valveCommit,
            modelCommit,
            source: "model",
            generatedAt: new Date().toISOString(),
            rosters: teams.map(toRoster),
        },
        teams,
    };
};

/** Window and event completion are evaluated as of Valve's data pull for snapshotDate. */
export const computeStandings = (
    matchData: unknown[],
    eventData: unknown[],
    snapshotDate: string
): Standings => runModel(matchData, eventData, snapshotDate).standings;

export const computeStandingsWithDetails = (
    matchData: unknown[],
    eventData: unknown[],
    snapshotDate: string
): {
    standings: Standings;
    detailsFiles: Map<string, ParsedDetailsFile>;
    rawMarkdownFiles: Map<string, string>;
} => {
    inMemoryFiles.clear();
    const { standings, teams } = runModel(matchData, eventData, snapshotDate);
    getReportModule().generateOutput(teams, [0, 1, 2], snapshotDate);

    const detailsFiles = new Map<string, ParsedDetailsFile>();
    const rawMarkdownFiles = new Map<string, string>();

    for (const [filePath, content] of inMemoryFiles.entries()) {
        if (filePath.includes("details/") && filePath.endsWith(".md")) {
            rawMarkdownFiles.set(filePath, content);
            const parsed = parseDetailsFile(content);
            detailsFiles.set(parsed.rosterKey, parsed);
        }
    }

    return { standings, detailsFiles, rawMarkdownFiles };
};

