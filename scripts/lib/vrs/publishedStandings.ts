import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getRosterKey, type Region, type Roster, type Standings } from "../../../src/vrs/types.ts";

export const findLatestSnapshot = (valveRoot: string): string => {
    const dates: string[] = [];
    for (const sub of ["invitation", "live"]) {
        const subDir = path.join(valveRoot, sub);
        if (!fs.existsSync(subDir)) continue;
        for (const yr of fs.readdirSync(subDir)) {
            const yrDir = path.join(subDir, yr);
            if (!fs.statSync(yrDir).isDirectory()) continue;
            for (const f of fs.readdirSync(yrDir)) {
                const match = /^standings_global_(\d{4})_(\d{2})_(\d{2})\.md$/.exec(f);
                if (match) {
                    dates.push(`${match[1]}-${match[2]}-${match[3]}`);
                }
            }
        }
    }
    if (dates.length === 0) {
        throw new Error(`No published snapshots found in ${valveRoot}`);
    }
    dates.sort();
    return dates.at(-1)!;
};

const defaultValveRoot = path.resolve(
    import.meta.dirname,
    "../../../vendor/counter-strike_regional_standings"
);

const getSubmoduleCommits = (valveRoot: string): { valveCommit: string; modelCommit: string } => {
    const gitDir = fs.existsSync(path.join(valveRoot, ".git")) ? valveRoot : defaultValveRoot;
    const valveCommit = execFileSync("git", ["-C", gitDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
    }).trim();
    const modelCommit = execFileSync(
        "git",
        ["-C", gitDir, "log", "-n", "1", "--format=%H", "--", "model"],
        { encoding: "utf8" }
    ).trim();
    if (!valveCommit || !modelCommit) {
        throw new Error(`Failed to resolve submodule commits in ${gitDir}`);
    }
    return { valveCommit, modelCommit };
};

interface StandingsRow {
    rank: number;
    points: number;
    teamName: string;
    players: string[];
    detailRelativePath: string;
}

const parseStandingsTable = (content: string): StandingsRow[] => {
    const rows: StandingsRow[] = [];
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) continue;
        if (trimmed.includes("Standing") || trimmed.includes("---") || trimmed.includes(":-")) continue;

        const parts = trimmed.split("|").map((p) => p.trim());
        if (parts.length < 6) continue;
        const rank = Number(parts[1]);
        const points = Number(parts[2]);
        if (Number.isNaN(rank) || Number.isNaN(points)) continue;

        const teamName = parts[3];
        const players = parts[4]
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);

        const linkMatch = /\((.*?)\)/.exec(parts[5]);
        const detailRelativePath = linkMatch ? linkMatch[1] : "";

        rows.push({
            rank,
            points,
            teamName,
            players,
            detailRelativePath,
        });
    }
    return rows;
};

interface DetailData {
    players: string[];
    startingValue: number;
    h2hAdjustment: number;
    bountyOffered: number;
    bountyCollected: number;
    opponentNetwork: number;
    lanFactor: number;
}

const parseDetailFile = (content: string): DetailData => {
    const rosterMatch = /Roster:\s*(.*?)(?:<br\s*\/?>|\r?\n)/i.exec(content);
    const startingValMatch = /Starting Rank Value\s*\(([0-9.]+)\)/i.exec(content);
    const h2hMatch = /Head To Head Adjustments\s*\(([+-]?[0-9.]+)\)/i.exec(content);
    const bountyOffMatch = /Bounty Offered:\s*([0-9.]+)/i.exec(content);
    const bountyColMatch = /Bounty Collected:\s*([0-9.]+)/i.exec(content);
    const oppNetMatch = /Opponent Network:\s*([0-9.]+)/i.exec(content);
    const lanMatch = /LAN Wins:\s*([0-9.]+)/i.exec(content);

    if (!startingValMatch || !h2hMatch || !bountyOffMatch || !bountyColMatch || !oppNetMatch || !lanMatch) {
        throw new Error("Failed to parse factor values from detail file");
    }

    const players = (rosterMatch ? rosterMatch[1] : "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

    return {
        players,
        startingValue: Number(startingValMatch[1]),
        h2hAdjustment: Number(h2hMatch[1]),
        bountyOffered: Number(bountyOffMatch[1]),
        bountyCollected: Number(bountyColMatch[1]),
        opponentNetwork: Number(oppNetMatch[1]),
        lanFactor: Number(lanMatch[1]),
    };
};

export const readPublishedSnapshot = (valveRoot: string, date: string): Standings => {
    const dateUnderscores = date.replaceAll("-", "_");
    const dateDashes = date.replaceAll("_", "-");
    const year = dateDashes.slice(0, 4);

    const invDir = path.join(valveRoot, "invitation", year);
    const liveDir = path.join(valveRoot, "live", year);

    let baseDir = "";
    if (fs.existsSync(path.join(invDir, `standings_global_${dateUnderscores}.md`))) {
        baseDir = invDir;
    } else if (fs.existsSync(path.join(liveDir, `standings_global_${dateUnderscores}.md`))) {
        baseDir = liveDir;
    } else {
        throw new Error(
            `Snapshot ${date} not found in ${invDir} or ${liveDir}`
        );
    }

    const globalContent = fs.readFileSync(
        path.join(baseDir, `standings_global_${dateUnderscores}.md`),
        "utf8"
    );
    const globalRows = parseStandingsTable(globalContent);

    const europeFile = path.join(baseDir, `standings_europe_${dateUnderscores}.md`);
    const americasFile = path.join(baseDir, `standings_americas_${dateUnderscores}.md`);
    const asiaFile = path.join(baseDir, `standings_asia_${dateUnderscores}.md`);

    if (!fs.existsSync(europeFile) || !fs.existsSync(americasFile) || !fs.existsSync(asiaFile)) {
        throw new Error(`Missing regional standings files for ${date} in ${baseDir}`);
    }

    const europeRows = parseStandingsTable(fs.readFileSync(europeFile, "utf8"));
    const americasRows = parseStandingsTable(fs.readFileSync(americasFile, "utf8"));
    const asiaRows = parseStandingsTable(fs.readFileSync(asiaFile, "utf8"));

    const regionalMap = new Map<string, { region: Region; regionalRank: number }>();
    const registerRegionalRows = (rows: StandingsRow[], region: Region) => {
        for (const r of rows) {
            if (r.detailRelativePath) {
                regionalMap.set(r.detailRelativePath, { region, regionalRank: r.rank });
            }
            regionalMap.set(getRosterKey(r.players), { region, regionalRank: r.rank });
        }
    };
    registerRegionalRows(europeRows, "Europe");
    registerRegionalRows(americasRows, "Americas");
    registerRegionalRows(asiaRows, "Asia");

    const rosters: Roster[] = globalRows.map((row) => {
        const regionalInfo =
            regionalMap.get(row.detailRelativePath) ??
            regionalMap.get(getRosterKey(row.players));

        if (!regionalInfo) {
            throw new Error(
                `Roster "${row.teamName}" (${row.detailRelativePath}) not found in any regional standings file for ${date}`
            );
        }

        if (!row.detailRelativePath) {
            throw new Error(`Missing detail relative path for roster "${row.teamName}" in global standings`);
        }

        const detailFilePath = path.resolve(baseDir, row.detailRelativePath);
        if (!fs.existsSync(detailFilePath)) {
            throw new Error(`Detail file not found: ${detailFilePath}`);
        }

        const detailData = parseDetailFile(fs.readFileSync(detailFilePath, "utf8"));
        const players = detailData.players.length ? detailData.players : row.players;
        const rosterKey = getRosterKey(players);

        return {
            rosterKey,
            teamName: row.teamName,
            region: regionalInfo.region,
            regionalRank: regionalInfo.regionalRank,
            globalRank: row.rank,
            points: row.points,
            factors: {
                bountyOffered: detailData.bountyOffered,
                bountyCollected: detailData.bountyCollected,
                opponentNetwork: detailData.opponentNetwork,
                lanFactor: detailData.lanFactor,
            },
            startingValue: detailData.startingValue,
            h2hAdjustment: detailData.h2hAdjustment,
            players,
        };
    });

    const { valveCommit, modelCommit } = getSubmoduleCommits(valveRoot);

    return {
        snapshotDate: dateDashes,
        valveCommit,
        modelCommit,
        source: "valve-published",
        generatedAt: new Date().toISOString(),
        rosters,
    };
};
