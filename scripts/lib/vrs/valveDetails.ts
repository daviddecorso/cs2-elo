import fs from "node:fs";
import path from "node:path";
import { getRosterKey, type Region } from "../../../src/vrs/types.ts";

export interface FactorCellValue {
    raw: number;
    adjusted: number;
}

export interface ParsedMatchRow {
    matchPlayed: number;
    matchId: number;
    date: string;
    opponent: string;
    result: "W" | "L";
    ageWeight: number;
    eventWeight: number | null;
    bountyCollected: FactorCellValue | null;
    opponentNetwork: FactorCellValue | null;
    lanWins: FactorCellValue | null;
    h2hAdjustment: number;
    roster: string[];
}

export interface ParsedBountyOfferedRow {
    eventDate: string;
    ageWeight: number;
    prizeWinnings: number;
    scaledWinnings: number;
}

export interface ParsedDetailsFile {
    teamName: string;
    roster: string[];
    rosterKey: string;
    globalRank: number | null;
    region: Region | null;
    regionalRank: number | null;
    finalRankValue: number;
    startingRankValue: number;
    h2hAdjustments: number;
    factors: {
        bountyOffered: number;
        bountyCollected: number;
        opponentNetwork: number;
        lanFactor: number;
    };
    factorAverage: number;
    top10ScaledWinnings: number;
    fifthHighestScaledWinnings: number;
    bountyOfferedRows: ParsedBountyOfferedRow[];
    matches: ParsedMatchRow[];
}

const parseMoney = (raw: string): number => {
    const cleaned = raw.replace(/[$,]/g, "").trim();
    const val = Number(cleaned);
    return Number.isNaN(val) ? 0 : val;
};

const parseFactorCell = (cell: string): FactorCellValue | null => {
    const trimmed = cell.trim();
    if (!trimmed || trimmed === "-") return null;
    const match = /([\d.-]+)\s*\(([\d.-]+)\)/.exec(trimmed);
    if (match) {
        return {
            raw: Number(match[1]),
            adjusted: Number(match[2]),
        };
    }
    const val = Number(trimmed);
    if (!Number.isNaN(val)) {
        return { raw: val, adjusted: val };
    }
    return null;
};

export const parseDetailsFile = (markdown: string): ParsedDetailsFile => {
    const teamNameMatch = /Team Name:\s*([^\r\n<]+)/.exec(markdown);
    const teamName = teamNameMatch ? teamNameMatch[1].trim() : "";

    const rosterMatch = /Roster:\s*([^\r\n<]+)/.exec(markdown);
    const roster = rosterMatch
        ? rosterMatch[1]
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean)
        : [];
    const rosterKey = getRosterKey(roster);

    const globalRankMatch = /Global Rank:\s*\[?(\d+)\]?/.exec(markdown);
    const globalRank = globalRankMatch ? Number(globalRankMatch[1]) : null;

    const regionMatch = /Region:\s*\[?(Europe|Americas|Asia)\]?/.exec(markdown);
    const region = regionMatch ? (regionMatch[1] as Region) : null;

    const regionalRankMatch = /Regional Rank:\s*\[?(\d+)\]?/.exec(markdown);
    const regionalRank = regionalRankMatch ? Number(regionalRankMatch[1]) : null;

    const finalRankMatch = /Final Rank Value:\s*([\d.-]+)/.exec(markdown);
    const finalRankValue = finalRankMatch ? Number(finalRankMatch[1]) : 0;

    const startingRankMatch = /Starting Rank Value\s*\(([\d.-]+)\)/.exec(markdown);
    const startingRankValue = startingRankMatch ? Number(startingRankMatch[1]) : 0;

    const h2hMatch = /Head To Head Adjustments\s*\(([\d.-]+)\)/.exec(markdown);
    const h2hAdjustments = h2hMatch ? Number(h2hMatch[1]) : 0;

    const bountyOfferedFactorMatch = /- Bounty Offered:\s*([\d.-]+)/.exec(markdown);
    const bountyCollectedFactorMatch = /- Bounty Collected:\s*([\d.-]+)/.exec(markdown);
    const opponentNetworkFactorMatch = /- Opponent Network:\s*([\d.-]+)/.exec(markdown);
    const lanWinsFactorMatch = /- LAN Wins:\s*([\d.-]+)/.exec(markdown);
    const factorAvgMatch = /The average of these factors is\s*([\d.-]+)/.exec(markdown);

    const factors = {
        bountyOffered: bountyOfferedFactorMatch ? Number(bountyOfferedFactorMatch[1]) : 0,
        bountyCollected: bountyCollectedFactorMatch ? Number(bountyCollectedFactorMatch[1]) : 0,
        opponentNetwork: opponentNetworkFactorMatch ? Number(opponentNetworkFactorMatch[1]) : 0,
        lanFactor: lanWinsFactorMatch ? Number(lanWinsFactorMatch[1]) : 0,
    };
    const factorAverage = factorAvgMatch ? Number(factorAvgMatch[1]) : 0;

    const top10WinningsMatch = /sum of their top 10 scaled winnings\s*\(\$([0-9,.]+)\)/.exec(markdown);
    const top10ScaledWinnings = top10WinningsMatch ? parseMoney(top10WinningsMatch[1]) : 0;

    const fifthHighestMatch = /5th highest value among all rosters\s*\(\$([0-9,.]+)\)/.exec(markdown);
    const fifthHighestScaledWinnings = fifthHighestMatch ? parseMoney(fifthHighestMatch[1]) : 0;

    const lines = markdown.split(/\r?\n/);
    const matches: ParsedMatchRow[] = [];
    const bountyOfferedRows: ParsedBountyOfferedRow[] = [];

    let inTable1 = false;
    let inTable2 = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.includes('id="table1"') || line.includes("Match Played")) {
            inTable1 = true;
            inTable2 = false;
        } else if (line.includes('id="table2"') || line.includes("Top ten winnings for this roster")) {
            inTable1 = false;
            inTable2 = true;
        }

        if (!line.trim().startsWith("|")) {
            continue;
        }

        const parts = line.split("|").map((p) => p.trim());
        if (parts.length < 5) continue;

        // Skip markdown table separators / headers
        if (parts.some((p) => p.includes("---") || p.includes(":-") || p.includes("-:"))) {
            continue;
        }

        if (inTable1 && /^\d+$/.test(parts[1])) {
            const matchPlayed = Number(parts[1]);
            const matchId = Number(parts[2]);
            const date = parts[3];
            const opponent = parts[4];
            const result = parts[5] as "W" | "L";
            const ageWeight = Number(parts[6]);
            const eventWeight = parts[7] === "-" ? null : Number(parts[7]);
            const bountyCollected = parseFactorCell(parts[8]);
            const opponentNetwork = parseFactorCell(parts[9]);
            const lanWins = parseFactorCell(parts[10]);
            const h2hAdjustment = Number(parts[11]);
            const matchRoster = parts[12]
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);

            matches.push({
                matchPlayed,
                matchId,
                date,
                opponent,
                result,
                ageWeight,
                eventWeight,
                bountyCollected,
                opponentNetwork,
                lanWins,
                h2hAdjustment,
                roster: matchRoster,
            });
        } else if (inTable2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])) {
            const eventDate = parts[1];
            const ageWeight = Number(parts[2]);
            const prizeWinnings = parseMoney(parts[3]);
            const scaledWinnings = parseMoney(parts[4]);

            bountyOfferedRows.push({
                eventDate,
                ageWeight,
                prizeWinnings,
                scaledWinnings,
            });
        }
    }

    return {
        teamName,
        roster,
        rosterKey,
        globalRank,
        region,
        regionalRank,
        finalRankValue,
        startingRankValue,
        h2hAdjustments,
        factors,
        factorAverage,
        top10ScaledWinnings,
        fifthHighestScaledWinnings,
        bountyOfferedRows,
        matches,
    };
};

export const readDetailsSnapshot = (
    valveRoot: string,
    date: string
): Map<string, ParsedDetailsFile> => {
    const formattedDate = date.replace(/-/g, "_");
    const year = formattedDate.slice(0, 4);

    const candidates = [
        path.join(valveRoot, `live/${year}/details/${formattedDate}`),
        path.join(valveRoot, `invitation/${year}/details/${formattedDate}`),
    ];

    let targetDir = "";
    for (const dir of candidates) {
        if (fs.existsSync(dir)) {
            targetDir = dir;
            break;
        }
    }

    if (!targetDir) {
        throw new Error(
            `Details folder for snapshot ${date} not found in ${valveRoot} (checked ${candidates.join(", ")})`
        );
    }

    const map = new Map<string, ParsedDetailsFile>();
    const files = fs.readdirSync(targetDir);

    for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(targetDir, file);
        const content = fs.readFileSync(filePath, "utf8");
        const parsed = parseDetailsFile(content);
        map.set(parsed.rosterKey, parsed);
    }

    return map;
};
