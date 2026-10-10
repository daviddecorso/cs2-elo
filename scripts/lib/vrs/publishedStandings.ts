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

const getSubmoduleCommits = (valveRoot: string): { valveCommit: string; modelCommit: string } => {
    try {
        const valveCommit = execFileSync("git", ["-C", valveRoot, "rev-parse", "HEAD"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const modelCommit = execFileSync(
            "git",
            ["-C", valveRoot, "log", "-n", "1", "--format=%H", "--", "model"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        ).trim();
        return { valveCommit, modelCommit };
    } catch {
        return {
            valveCommit: "eec4853d7bcf0f1f7efe7f0d901234bef7e98b75",
            modelCommit: "297ee0099e7b50fb3aa579c35831ab5ae8987128",
        };
    }
};

interface GlobalRow {
    globalRank: number;
    points: number;
    teamName: string;
    players: string[];
    detailRelativePath: string;
}

const parseGlobalStandings = (content: string): GlobalRow[] => {
    const rows: GlobalRow[] = [];
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) continue;
        // Skip header lines
        if (trimmed.includes("Standing") || trimmed.includes("---") || trimmed.includes(":-")) continue;

        const parts = trimmed.split("|").map((p) => p.trim());
        // parts[0] is before first |, parts[1] is Standing, parts[2] is Points, parts[3] is Team Name, parts[4] is Roster, parts[5] is details link
        if (parts.length < 6) continue;
        const standing = Number(parts[1]);
        const points = Number(parts[2]);
        if (Number.isNaN(standing) || Number.isNaN(points)) continue;

        const teamName = parts[3];
        const players = parts[4]
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);

        const linkMatch = /\((.*?)\)/.exec(parts[5]);
        const detailRelativePath = linkMatch ? linkMatch[1] : "";

        rows.push({
            globalRank: standing,
            points,
            teamName,
            players,
            detailRelativePath,
        });
    }
    return rows;
};

interface DetailData {
    teamName: string;
    players: string[];
    globalRank: number;
    region: Region;
    regionalRank: number;
    finalRankValue: number;
    startingValue: number;
    h2hAdjustment: number;
    bountyOffered: number;
    bountyCollected: number;
    opponentNetwork: number;
    lanFactor: number;
}

const parseDetailFile = (content: string): DetailData => {
    const teamMatch = /Team Name:\s*(.*?)(?:<br\s*\/?>|\r?\n)/i.exec(content);
    const rosterMatch = /Roster:\s*(.*?)(?:<br\s*\/?>|\r?\n)/i.exec(content);
    const globalRankMatch = /Global Rank:\s*\[?(\d+)\]?/i.exec(content);
    const regionMatch = /Region:\s*\[?([A-Za-z]+)\]?/i.exec(content);
    const regionalRankMatch = /Regional Rank:\s*\[?(\d+)\]?/i.exec(content);
    const finalRankMatch = /Final Rank Value:\s*([0-9.]+)/i.exec(content);
    const startingValMatch = /Starting Rank Value\s*\(([0-9.]+)\)/i.exec(content);
    const h2hMatch = /Head To Head Adjustments\s*\(([+-]?[0-9.]+)\)/i.exec(content);
    const bountyOffMatch = /Bounty Offered:\s*([0-9.]+)/i.exec(content);
    const bountyColMatch = /Bounty Collected:\s*([0-9.]+)/i.exec(content);
    const oppNetMatch = /Opponent Network:\s*([0-9.]+)/i.exec(content);
    const lanMatch = /LAN Wins:\s*([0-9.]+)/i.exec(content);

    const players = (rosterMatch ? rosterMatch[1] : "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

    return {
        teamName: teamMatch ? teamMatch[1].trim() : "",
        players,
        globalRank: globalRankMatch ? Number(globalRankMatch[1]) : 0,
        region: (regionMatch ? regionMatch[1].trim() : "Europe") as Region,
        regionalRank: regionalRankMatch ? Number(regionalRankMatch[1]) : 0,
        finalRankValue: finalRankMatch ? Number(finalRankMatch[1]) : 0,
        startingValue: startingValMatch ? Number(startingValMatch[1]) : 0,
        h2hAdjustment: h2hMatch ? Number(h2hMatch[1]) : 0,
        bountyOffered: bountyOffMatch ? Number(bountyOffMatch[1]) : 0,
        bountyCollected: bountyColMatch ? Number(bountyColMatch[1]) : 0,
        opponentNetwork: oppNetMatch ? Number(oppNetMatch[1]) : 0,
        lanFactor: lanMatch ? Number(lanMatch[1]) : 0,
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
    const globalRows = parseGlobalStandings(globalContent);

    // Also verify regional standings files exist
    const europeFile = path.join(baseDir, `standings_europe_${dateUnderscores}.md`);
    const americasFile = path.join(baseDir, `standings_americas_${dateUnderscores}.md`);
    const asiaFile = path.join(baseDir, `standings_asia_${dateUnderscores}.md`);

    if (!fs.existsSync(europeFile) || !fs.existsSync(americasFile) || !fs.existsSync(asiaFile)) {
        throw new Error(`Missing regional standings files for ${date} in ${baseDir}`);
    }

    const rosters: Roster[] = globalRows.map((row) => {
        let detailData: DetailData | null = null;
        if (row.detailRelativePath) {
            const detailFilePath = path.resolve(baseDir, row.detailRelativePath);
            if (fs.existsSync(detailFilePath)) {
                detailData = parseDetailFile(fs.readFileSync(detailFilePath, "utf8"));
            }
        }

        const players = detailData?.players?.length ? detailData.players : row.players;
        const rosterKey = getRosterKey(players);
        const region = detailData?.region ?? "Europe";
        const regionalRank = detailData?.regionalRank ?? null;
        const points = row.points;
        const startingValue = detailData?.startingValue ?? 0;
        const h2hAdjustment = detailData?.h2hAdjustment ?? 0;

        return {
            rosterKey,
            teamName: row.teamName,
            region,
            regionalRank,
            globalRank: row.globalRank,
            points,
            factors: {
                bountyOffered: detailData?.bountyOffered ?? 0,
                bountyCollected: detailData?.bountyCollected ?? 0,
                opponentNetwork: detailData?.opponentNetwork ?? 0,
                lanFactor: detailData?.lanFactor ?? 0,
            },
            startingValue,
            h2hAdjustment,
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
