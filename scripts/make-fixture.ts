import fs from "node:fs";
import path from "node:path";

// Mulberry32 deterministic PRNG
const mulberry32 = (seed: number) => {
    let s = seed;
    return () => {
        let t = (s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

export const generateFixture = () => {
    const rng = mulberry32(1337);

    // 30 teams: 15 EU, 8 AM, 7 Asia
    const regionCountries = {
        EU: ["dk", "se", "fr", "de", "pl", "ua", "ru", "fi", "no"],
        AM: ["us", "ca", "br", "ar", "mx"],
        Asia: ["cn", "mn", "au", "sg", "kz"],
    };

    const teamConfigs: Array<{ id: string; name: string; region: "EU" | "AM" | "Asia" }> = [
        // 15 EU
        { id: "1", name: "Spiritus", region: "EU" },
        { id: "2", name: "Legatus", region: "EU" },
        { id: "3", name: "Vitalis", region: "EU" },
        { id: "4", name: "Mouses", region: "EU" },
        { id: "5", name: "G-Force", region: "EU" },
        { id: "6", name: "Falconry", region: "EU" },
        { id: "7", name: "Astral", region: "EU" },
        { id: "8", name: "B-Eight", region: "EU" },
        { id: "9", name: "Heroicus", region: "EU" },
        { id: "10", name: "Pyjamas", region: "EU" },
        { id: "11", name: "Big Clan", region: "EU" },
        { id: "12", name: "FaZe-Up", region: "EU" },
        { id: "13", name: "Aurora-B", region: "EU" },
        { id: "14", name: "Bet-Boomer", region: "EU" },
        { id: "15", name: "Fnatic-X", region: "EU" },
        // 8 AM
        { id: "16", name: "Furia-BR", region: "AM" },
        { id: "17", name: "Mibr-Org", region: "AM" },
        { id: "18", name: "Liquid-Gold", region: "AM" },
        { id: "19", name: "Complexity-NA", region: "AM" },
        { id: "20", name: "PaiN-Gaming", region: "AM" },
        { id: "21", name: "Nouns-Esports", region: "AM" },
        { id: "22", name: "Imperial-BR", region: "AM" },
        { id: "23", name: "Wildcard-NA", region: "AM" },
        // 7 Asia
        { id: "24", name: "Mongol-Horde", region: "Asia" },
        { id: "25", name: "Tyloo-Dragon", region: "Asia" },
        { id: "26", name: "Lynn-Vision", region: "Asia" },
        { id: "27", name: "FlyQuest-AU", region: "Asia" },
        { id: "28", name: "Rare-Atom", region: "Asia" },
        { id: "29", name: "Rooster-AU", region: "Asia" },
        { id: "30", name: "Talon-Asia", region: "Asia" },
    ];

    let playerCounter = 1;
    interface PlayerData {
        playerId: string;
        nick: string;
        countryIso: string;
    }

    const teamRosters: Map<string, PlayerData[]> = new Map();
    for (const team of teamConfigs) {
        const pool = regionCountries[team.region];
        const players: PlayerData[] = [];
        for (let i = 0; i < 5; i++) {
            const pId = String(playerCounter++);
            const countryIso = pool[Math.floor(rng() * pool.length)];
            players.push({
                playerId: pId,
                nick: `player_${pId}`,
                countryIso,
            });
        }
        teamRosters.set(team.id, players);
    }

    // One roster swap that keeps 3 of 5 players for Team 1
    // Original: P1, P2, P3, P4, P5
    // Swapped (after match ~130): P1, P2, P3, P301, P302
    const swappedTeam1Roster: PlayerData[] = [
        teamRosters.get("1")![0],
        teamRosters.get("1")![1],
        teamRosters.get("1")![2],
        { playerId: "301", nick: "player_301", countryIso: "dk" },
        { playerId: "302", nick: "player_302", countryIso: "se" },
    ];

    // Events: 8 events
    // 101: LAN $1.5M (exercises cap)
    // 102: Online $50k (qualifier linked to 101)
    // 103: LAN $750k
    // 104: Online $100k
    // 105: LAN $400k
    // 106: Online $250k
    // 107: LAN $500k (unfinished)
    // 108: LAN $10k (showmatch)
    interface PrizeDistributionItem {
        teamId: string;
        placement: number;
        prize: number;
        clubShare: number;
        shared: boolean;
        qualifiedEvents: number[];
    }

    const buildPrizeDist = (
        participatingTeamIds: string[],
        basePrize: number,
        hasQualified: boolean = false
    ): PrizeDistributionItem[] => {
        return participatingTeamIds.map((tId, idx) => ({
            teamId: tId,
            placement: idx + 1,
            prize: Math.max(0, Math.floor(basePrize / (idx + 1))),
            clubShare: Math.floor(basePrize * 0.05),
            shared: false,
            qualifiedEvents: hasQualified && idx === 0 ? [101] : [],
        }));
    };

    const allTeamIds = teamConfigs.map((t) => t.id);

    const events = [
        {
            eventId: "101",
            eventName: "Major Championship 2026",
            prizePool: "$1,500,000",
            lan: true,
            finished: true,
            prizeDistribution: buildPrizeDist(allTeamIds.slice(0, 16), 1500000),
        },
        {
            eventId: "102",
            eventName: "Major Closed Qualifier",
            prizePool: "$50,000",
            lan: false,
            finished: true,
            prizeDistribution: buildPrizeDist(allTeamIds.slice(10, 26), 50000, true),
        },
        {
            eventId: "103",
            eventName: "Pro League Spring",
            prizePool: "$750,000",
            lan: true,
            finished: true,
            prizeDistribution: buildPrizeDist(allTeamIds.slice(0, 20), 750000),
        },
        {
            eventId: "104",
            eventName: "Online Masters Series",
            prizePool: "$100,000",
            lan: false,
            finished: true,
            prizeDistribution: buildPrizeDist(allTeamIds, 100000),
        },
        {
            eventId: "105",
            eventName: "Summer Invitational",
            prizePool: "$400,000",
            lan: true,
            finished: true,
            prizeDistribution: buildPrizeDist(allTeamIds.slice(5, 25), 400000),
        },
        {
            eventId: "106",
            eventName: "Fall Open Trophy",
            prizePool: "$250,000",
            lan: false,
            finished: true,
            prizeDistribution: buildPrizeDist(allTeamIds, 250000),
        },
        {
            eventId: "107",
            eventName: "Winter Championship (In Progress)",
            prizePool: "$500,000",
            lan: true,
            finished: false,
            prizeDistribution: buildPrizeDist(allTeamIds.slice(0, 8), 500000),
        },
        {
            eventId: "108",
            eventName: "All-Star Showmatch Exhibition",
            prizePool: "$10,000",
            lan: true,
            finished: true,
            prizeDistribution: buildPrizeDist(allTeamIds.slice(0, 4), 10000),
        },
    ];

    // About 250 matches over 7 months ending 2026-10-04 (1791136800)
    // 7 months ~ 210 days * 86400 = 18,144,000 s
    const endTimestamp = 1791136800; // 2026-10-04T18:00:00Z
    const startTimestamp = endTimestamp - 210 * 86400;

    const activeFinishedEvents = ["101", "102", "103", "104", "105", "106"];
    const totalMatches = 252;
    const timeStep = (endTimestamp - startTimestamp) / totalMatches;

    const matches = [];

    for (let i = 0; i < totalMatches; i++) {
        const matchTime = Math.floor(startTimestamp + i * timeStep + (rng() * 1000 - 500));

        // Pick two distinct teams
        const t1Idx = Math.floor(rng() * teamConfigs.length);
        let t2Idx = Math.floor(rng() * teamConfigs.length);
        while (t2Idx === t1Idx) {
            t2Idx = Math.floor(rng() * teamConfigs.length);
        }

        const t1 = teamConfigs[t1Idx];
        const t2 = teamConfigs[t2Idx];

        // Event assignment
        let eventId: string;
        if (i === 10) {
            eventId = "108"; // showmatch
        } else if (i === 20) {
            eventId = "107"; // unfinished event
        } else {
            eventId = activeFinishedEvents[Math.floor(rng() * activeFinishedEvents.length)];
        }

        // Roster for team 1: if i >= 130 and t1.id === "1", use swapped roster
        let t1Roster = teamRosters.get(t1.id)!;
        if (t1.id === "1" && i >= 130) {
            t1Roster = swappedTeam1Roster;
        }

        let t2Roster = teamRosters.get(t2.id)!;
        if (t2.id === "1" && i >= 130) {
            t2Roster = swappedTeam1Roster;
        }

        const winningTeam = rng() < 0.5 ? 1 : 2;

        matches.push({
            matchStartTime: matchTime,
            team1Id: t1.id,
            team2Id: t2.id,
            team1Name: t1.name,
            team2Name: t2.name,
            team1Players: t1Roster,
            team2Players: t2Roster,
            eventId,
            winningTeam,
            valveRanked: true,
            forfeited: false,
        });
    }

    return { matches, events };
};

const main = () => {
    const fixture = generateFixture();
    const outDir = path.resolve(process.cwd(), "fixtures");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "matchdata.synthetic.json");
    fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2));
    console.log(`Generated synthetic fixture with ${fixture.matches.length} matches and ${fixture.events.length} events.`);
    console.log(`Saved to ${outFile}`);
};

main();
