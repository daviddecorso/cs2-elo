import fs from "node:fs";
import path from "node:path";
import { readDetailsSnapshot } from "./lib/vrs/valveDetails.ts";
import { calibratedSnapshotDates, computeStandingsWithDetails } from "./lib/vrs/valveModel.ts";
import type { Matchdata, ValveEvent } from "./lib/vrs/buildMatchdata.ts";

const args = process.argv.slice(2);
let matchdataPath = "data/matchdata.json";
let valveRoot = path.resolve(process.cwd(), "vendor/counter-strike_regional_standings");
let topN = 100;
let minDiff = 100;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--matchdata" && args[i + 1]) matchdataPath = args[++i];
    else if (args[i] === "--valve-root" && args[i + 1]) valveRoot = path.resolve(process.cwd(), args[++i]);
    else if (args[i] === "--top" && args[i + 1]) topN = Number(args[++i]);
    else if (args[i] === "--min-diff" && args[i + 1]) minDiff = Number(args[++i]);
}

const matchJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), matchdataPath), "utf8")) as Matchdata;
const eventById = new Map<string, ValveEvent>(matchJson.events.map((e) => [String(e.eventId), e]));

// Map each (eventId, teamId) -> lastMatchTime for matching Bounty Offered rows to events
const eventLastMatch = new Map<string, number>();
const teamEvents = new Map<string, Set<string>>();
for (const m of matchJson.matches) {
    const eId = String(m.eventId);
    eventLastMatch.set(eId, Math.max(eventLastMatch.get(eId) ?? 0, m.matchStartTime));
    for (const t of [String(m.team1Id), String(m.team2Id)]) {
        if (!teamEvents.has(t)) teamEvents.set(t, new Set());
        teamEvents.get(t)!.add(eId);
    }
}

interface Proposal {
    eventId: string;
    teamId: string;
    valvePrize: number;
    modelPrize: number;
    snapshot: string;
    eventDate: string;
}

const proposals = new Map<string, Proposal[]>();

for (const date of calibratedSnapshotDates()) {
    const pub = readDetailsSnapshot(valveRoot, date);
    const { detailsFiles: mod } = computeStandingsWithDetails(matchJson.matches, matchJson.events, date);

    for (const v of pub.values()) {
        if (!v.globalRank || v.globalRank > topN) continue;
        const m = mod.get(v.rosterKey);
        if (!m) continue;

        const mUsed = new Set<number>();
        const pubOnly = [];
        for (const vr of v.bountyOfferedRows) {
            const vt = Date.parse(vr.eventDate);
            const idx = m.bountyOfferedRows.findIndex((mr, i) => {
                if (mUsed.has(i)) return false;
                const mt = Date.parse(mr.eventDate);
                return Math.abs(vt - mt) <= 2 * 86400000 && Math.abs(vr.prizeWinnings - mr.prizeWinnings) < minDiff;
            });
            if (idx >= 0) mUsed.add(idx);
            else pubOnly.push(vr);
        }

        for (const vr of pubOnly) {
            const vt = Date.parse(vr.eventDate);
            // Find candidate event for this team near vr.eventDate
            const candidates: Array<{ eventId: string; prize: number; dtDiff: number }> = [];
            for (const eId of teamEvents.get(v.teamName) ?? []) {
                const ev = eventById.get(eId);
                if (!ev) continue;
                const lastT = (eventLastMatch.get(eId) ?? 0) * 1000;
                const dtDiff = Math.abs(vt - lastT);
                if (dtDiff <= 3 * 86400000) {
                    const entry = ev.prizeDistribution.find((p) => String(p.teamId) === v.teamName);
                    candidates.push({ eventId: eId, prize: entry ? entry.prize + entry.clubShare : 0, dtDiff });
                }
            }
            if (candidates.length === 0) continue;
            candidates.sort((a, b) => a.dtDiff - b.dtDiff || b.prize - a.prize);
            const best = candidates[0];
            if (Math.abs(vr.prizeWinnings - best.prize) < minDiff) continue;
            const key = `${best.eventId}|${v.teamName}`;
            if (!proposals.has(key)) proposals.set(key, []);
            proposals.get(key)!.push({
                eventId: best.eventId,
                teamId: v.teamName,
                valvePrize: vr.prizeWinnings,
                modelPrize: best.prize,
                snapshot: date,
                eventDate: vr.eventDate,
            });
        }
    }
}

console.log(`Found ${proposals.size} (eventId, teamId) prize discrepancies (diff >= $${minDiff}, top ${topN}):\n`);
for (const [, list] of [...proposals.entries()].sort((a, b) => Math.abs(b[1][0].valvePrize - b[1][0].modelPrize) - Math.abs(a[1][0].valvePrize - a[1][0].modelPrize))) {
    const p = list[0];
    const snaps = list.map((x) => `${x.snapshot}:$${x.valvePrize}`).join(", ");
    console.log(
        `  ${p.eventId.padEnd(48)} ${p.teamId.padEnd(18)} model=$${String(Math.round(p.modelPrize)).padStart(6)} valve=$${String(p.valvePrize).padStart(6)} (${snaps})`
    );
}
