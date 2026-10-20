import type { ValidationResult } from "./matchdataSchema.ts";
import { validateMatchdata } from "./matchdataSchema.ts";

export interface ValvePlayer {
    playerId: string | number;
    nick: string;
    countryIso: string;
    country?: string;
    steamIds?: string[];
}

export interface ValveMatch {
    matchStartTime: number;
    team1Id: string | number;
    team2Id: string | number;
    team1Name: string;
    team2Name: string;
    team1Players: ValvePlayer[];
    team2Players: ValvePlayer[];
    eventId: string | number;
    winningTeam: 1 | 2;
    valveRanked?: boolean;
    forfeited?: boolean;
}

export interface ValvePrizeItem {
    teamId: string | number;
    placement: number;
    prize: number;
    clubShare: number;
    qualifiedEvents: (string | number)[];
    shared?: boolean;
}

export interface ValveEvent {
    eventId: string | number;
    eventName: string;
    prizePool: string;
    lan: boolean;
    finished: boolean;
    endDate?: string;
    prizeDistribution: ValvePrizeItem[];
}

export interface Matchdata {
    matches: ValveMatch[];
    events: ValveEvent[];
}

export interface Overrides {
    rankedEvents?: Array<{ eventId: string; reason: string }>;
    unrankedEvents?: Array<{ eventId: string; reason: string }>;
    eventRollups?: Record<string, { parentEventId: string; reason: string }>;
    eventOverrides?: Record<
        string,
        {
            eventName?: string;
            prizePool?: string;
            lan?: boolean;
            finished?: boolean;
            endDate?: string;
            reason: string;
        }
    >;
    teamAliases?: Record<string, { targetTeamId: string; reason: string }>;
    playerAliases?: Record<
        string,
        {
            targetPlayerId?: string;
            nick?: string;
            countryIso?: string;
            reason: string;
        }
    >;
    matchLineupFixes?: Record<
        string,
        {
            team1Players?: ValvePlayer[];
            team2Players?: ValvePlayer[];
            winningTeam?: 1 | 2;
            valveRanked?: boolean;
            reason: string;
        }
    >;
    prizeDistributionOverrides?: Array<{
        eventId: string;
        teamId: string;
        placement?: number;
        prize?: number;
        clubShare?: number;
        qualifiedEvents?: (string | number)[];
        reason: string;
    }>;
    excludedMatches?: Array<{ matchId: string; reason: string }>;
    addedMatches?: Array<ValveMatch & { reason: string }>;
}

const COUNTRY_MAP: Record<string, string> = {
    "afghanistan": "af",
    "åland islands": "ax",
    "albania": "al",
    "algeria": "dz",
    "american samoa": "as",
    "andorra": "ad",
    "angola": "ao",
    "anguilla": "ai",
    "antarctica": "aq",
    "antigua & barbuda": "ag",
    "argentina": "ar",
    "armenia": "am",
    "aruba": "aw",
    "australia": "au",
    "austria": "at",
    "azerbaijan": "az",
    "bahamas": "bs",
    "bahrain": "bh",
    "bangladesh": "bd",
    "barbados": "bb",
    "belarus": "by",
    "belgium": "be",
    "belize": "bz",
    "benin": "bj",
    "bermuda": "bm",
    "bhutan": "bt",
    "bolivia": "bo",
    "bosnia": "ba",
    "bosnia & herzegovina": "ba",
    "bosnia and herzegovina": "ba",
    "botswana": "bw",
    "bouvet island": "bv",
    "brazil": "br",
    "british indian ocean territory": "io",
    "british virgin islands": "vg",
    "brunei": "bn",
    "bulgaria": "bg",
    "burkina faso": "bf",
    "burma": "mm",
    "burundi": "bi",
    "cambodia": "kh",
    "cameroon": "cm",
    "canada": "ca",
    "cape verde": "cv",
    "caribbean netherlands": "bq",
    "cayman islands": "ky",
    "central african republic": "cf",
    "chad": "td",
    "chile": "cl",
    "china": "cn",
    "christmas island": "cx",
    "cocos (keeling) islands": "cc",
    "colombia": "co",
    "comoros": "km",
    "congo": "cg",
    "congo - brazzaville": "cg",
    "congo - kinshasa": "cd",
    "cook islands": "ck",
    "costa rica": "cr",
    "cote d'ivoire": "ci",
    "côte d’ivoire": "ci",
    "croatia": "hr",
    "cuba": "cu",
    "curaçao": "cw",
    "cyprus": "cy",
    "czech republic": "cz",
    "czechia": "cz",
    "democratic republic of the congo": "cd",
    "denmark": "dk",
    "djibouti": "dj",
    "dominica": "dm",
    "dominican republic": "do",
    "dr congo": "cd",
    "east timor": "tl",
    "ecuador": "ec",
    "egypt": "eg",
    "el salvador": "sv",
    "england": "gb",
    "equatorial guinea": "gq",
    "eritrea": "er",
    "estonia": "ee",
    "eswatini": "sz",
    "ethiopia": "et",
    "falkland islands": "fk",
    "faroe islands": "fo",
    "fiji": "fj",
    "finland": "fi",
    "france": "fr",
    "french guiana": "gf",
    "french polynesia": "pf",
    "french southern territories": "tf",
    "gabon": "ga",
    "gambia": "gm",
    "georgia": "ge",
    "germany": "de",
    "ghana": "gh",
    "gibraltar": "gi",
    "great britain": "gb",
    "greece": "gr",
    "greenland": "gl",
    "grenada": "gd",
    "guadeloupe": "gp",
    "guam": "gu",
    "guatemala": "gt",
    "guernsey": "gg",
    "guinea": "gn",
    "guinea-bissau": "gw",
    "guyana": "gy",
    "haiti": "ht",
    "heard & mcdonald islands": "hm",
    "honduras": "hn",
    "hong kong": "hk",
    "hong kong sar china": "hk",
    "hungary": "hu",
    "iceland": "is",
    "india": "in",
    "indonesia": "id",
    "iran": "ir",
    "iraq": "iq",
    "ireland": "ie",
    "isle of man": "im",
    "israel": "il",
    "italy": "it",
    "ivory coast": "ci",
    "jamaica": "jm",
    "japan": "jp",
    "jersey": "je",
    "jordan": "jo",
    "kazakhstan": "kz",
    "kenya": "ke",
    "kiribati": "ki",
    "korea": "kr",
    "kosovo": "xk",
    "kuwait": "kw",
    "kyrgyzstan": "kg",
    "laos": "la",
    "latvia": "lv",
    "lebanon": "lb",
    "lesotho": "ls",
    "liberia": "lr",
    "libya": "ly",
    "liechtenstein": "li",
    "lithuania": "lt",
    "luxembourg": "lu",
    "macao sar china": "mo",
    "macau": "mo",
    "macedonia": "mk",
    "madagascar": "mg",
    "malawi": "mw",
    "malaysia": "my",
    "maldives": "mv",
    "mali": "ml",
    "malta": "mt",
    "marshall islands": "mh",
    "martinique": "mq",
    "mauritania": "mr",
    "mauritius": "mu",
    "mayotte": "yt",
    "mexico": "mx",
    "micronesia": "fm",
    "moldova": "md",
    "monaco": "mc",
    "mongolia": "mn",
    "montenegro": "me",
    "montserrat": "ms",
    "morocco": "ma",
    "mozambique": "mz",
    "myanmar": "mm",
    "myanmar (burma)": "mm",
    "namibia": "na",
    "nauru": "nr",
    "nepal": "np",
    "netherlands": "nl",
    "new caledonia": "nc",
    "new zealand": "nz",
    "nicaragua": "ni",
    "niger": "ne",
    "nigeria": "ng",
    "niue": "nu",
    "norfolk island": "nf",
    "north korea": "kp",
    "north macedonia": "mk",
    "northern ireland": "gb",
    "northern mariana islands": "mp",
    "norway": "no",
    "oman": "om",
    "pakistan": "pk",
    "palau": "pw",
    "palestine": "ps",
    "palestinian territories": "ps",
    "panama": "pa",
    "papua new guinea": "pg",
    "paraguay": "py",
    "peru": "pe",
    "philippines": "ph",
    "pitcairn islands": "pn",
    "poland": "pl",
    "portugal": "pt",
    "puerto rico": "pr",
    "qatar": "qa",
    "republic of the congo": "cg",
    "réunion": "re",
    "romania": "ro",
    "russia": "ru",
    "russian federation": "ru",
    "rwanda": "rw",
    "samoa": "ws",
    "san marino": "sm",
    "são tomé & príncipe": "st",
    "saudi arabia": "sa",
    "scotland": "gb",
    "senegal": "sn",
    "serbia": "rs",
    "seychelles": "sc",
    "sierra leone": "sl",
    "singapore": "sg",
    "sint maarten": "sx",
    "slovakia": "sk",
    "slovenia": "si",
    "solomon islands": "sb",
    "somalia": "so",
    "south africa": "za",
    "south georgia & south sandwich islands": "gs",
    "south korea": "kr",
    "south sudan": "ss",
    "spain": "es",
    "sri lanka": "lk",
    "st. barthélemy": "bl",
    "st. helena": "sh",
    "st. kitts & nevis": "kn",
    "st. lucia": "lc",
    "st. martin": "mf",
    "st. pierre & miquelon": "pm",
    "st. vincent & grenadines": "vc",
    "sudan": "sd",
    "suriname": "sr",
    "svalbard & jan mayen": "sj",
    "sweden": "se",
    "switzerland": "ch",
    "syria": "sy",
    "taiwan": "tw",
    "tajikistan": "tj",
    "tanzania": "tz",
    "thailand": "th",
    "timor-leste": "tl",
    "togo": "tg",
    "tokelau": "tk",
    "tonga": "to",
    "trinidad & tobago": "tt",
    "trinidad and tobago": "tt",
    "tunisia": "tn",
    "turkey": "tr",
    "türkiye": "tr",
    "turkmenistan": "tm",
    "turks & caicos islands": "tc",
    "tuvalu": "tv",
    "u.s. outlying islands": "um",
    "u.s. virgin islands": "vi",
    "uae": "ae",
    "uganda": "ug",
    "ukraine": "ua",
    "united arab emirates": "ae",
    "united kingdom": "gb",
    "united states": "us",
    "uruguay": "uy",
    "usa": "us",
    "uzbekistan": "uz",
    "vanuatu": "vu",
    "vatican city": "va",
    "venezuela": "ve",
    "vietnam": "vn",
    "wales": "gb",
    "wallis & futuna": "wf",
    "western sahara": "eh",
    "yemen": "ye",
    "zambia": "zm",
    "zimbabwe": "zw",
};

const VALID_COUNTRY_CODES = new Set(Object.values(COUNTRY_MAP));

export const normalizeCountryIso = (countryOrFlag: string): string => {
    if (!countryOrFlag) return "";
    const cleaned = countryOrFlag.trim().toLowerCase();
    if (VALID_COUNTRY_CODES.has(cleaned)) return cleaned;
    return COUNTRY_MAP[cleaned] ?? "";
};

const formatPrizePool = (amount: number | string | undefined): string => {
    if (!amount) return "$0";
    const num = typeof amount === "number" ? amount : Number(String(amount).replace(/[$,]/g, ""));
    if (Number.isNaN(num) || num < 0) return "$0";
    return `$${Math.round(num).toLocaleString("en-US")}`;
};

const parseNumericPlacement = (placement: unknown): number => {
    if (typeof placement === "number") return placement;
    if (typeof placement !== "string") return 99;
    const match = /^(\d+)/.exec(placement.trim());
    return match ? Number(match[1]) : 99;
};

const isTourneyFinished = (
    tourney: Record<string, unknown> | undefined,
    snapshotDate?: string
): boolean => {
    if (!tourney) return true;
    if (tourney.status === "cancelled" || tourney.status === "postponed") return false;
    const cutoffDate = snapshotDate ?? new Date().toISOString().slice(0, 10);
    if (tourney.enddate && typeof tourney.enddate === "string" && tourney.enddate > cutoffDate) {
        return false;
    }
    return true;
};

const roundKey = (m: Record<string, unknown>): string =>
    `${String(m.pagename)}|${String(m.match2bracketid)}|${String(m.match2id).replace(/^.*_(R\d+)-M.*$/, "$1")}`;

// HLTV, Valve's source, skips most Bo1 qualifier brackets: rounds with more than 8 matches never
// appear in published details, and Tier 2 qualifier brackets don't appear at all.
const isUntrackedQualifierMatch = (
    m: Record<string, unknown>,
    roundSizes: Map<string, number>,
    publisherTier: string
): boolean => {
    const bracketData = m.match2bracketdata as Record<string, unknown> | undefined;
    if (Number(m.bestof) !== 1 || bracketData?.type !== "bracket") return false;
    return (roundSizes.get(roundKey(m)) ?? 0) > 8 || publisherTier === "Tier 2 Qualifier";
};

const LINEUP_WINDOW_SECONDS = 21 * 24 * 3600;

// Liquipedia lists every player who appeared in a series (6+ after a substitution) and sometimes
// fewer than 5; Valve's HLTV data always has the 5-player lineup, which the team's nearby matches predict.
export const resolveLineups = (matches: ValveMatch[]): ValveMatch[] => {
    const fullLineups = new Map<string, Array<{ t: number; players: ValvePlayer[] }>>();
    for (const m of matches) {
        for (const [teamId, players] of [
            [m.team1Id, m.team1Players],
            [m.team2Id, m.team2Players],
        ] as const) {
            if (players.length !== 5) continue;
            const key = String(teamId);
            if (!fullLineups.has(key)) fullLineups.set(key, []);
            fullLineups.get(key)!.push({ t: m.matchStartTime, players });
        }
    }

    const resolve = (teamId: string | number, t: number, listed: ValvePlayer[]): ValvePlayer[] | null => {
        if (listed.length === 5) return listed;
        if (listed.length === 0) return null;

        const counts = new Map<string, { player: ValvePlayer; n: number }>();
        for (const lineup of fullLineups.get(String(teamId)) ?? []) {
            if (Math.abs(lineup.t - t) > LINEUP_WINDOW_SECONDS) continue;
            for (const p of lineup.players) {
                const key = String(p.playerId);
                const entry = counts.get(key) ?? { player: p, n: 0 };
                entry.n++;
                counts.set(key, entry);
            }
        }
        const frequency = (p: ValvePlayer) => counts.get(String(p.playerId))?.n ?? 0;

        if (listed.length > 5) {
            return listed
                .map((p, idx) => ({ p, idx }))
                .sort((a, b) => frequency(b.p) - frequency(a.p) || a.idx - b.idx)
                .slice(0, 5)
                .sort((a, b) => a.idx - b.idx)
                .map(({ p }) => p);
        }

        const listedIds = new Set(listed.map((p) => String(p.playerId)));
        const fillers = [...counts.values()]
            .filter(({ player }) => !listedIds.has(String(player.playerId)))
            .sort((a, b) => b.n - a.n)
            .slice(0, 5 - listed.length)
            .map(({ player }) => player);
        return listed.length + fillers.length === 5 ? [...listed, ...fillers] : null;
    };

    const resolved: ValveMatch[] = [];
    for (const m of matches) {
        const team1Players = resolve(m.team1Id, m.matchStartTime, m.team1Players);
        const team2Players = resolve(m.team2Id, m.matchStartTime, m.team2Players);
        if (!team1Players || !team2Players) continue;
        resolved.push(
            team1Players === m.team1Players && team2Players === m.team2Players
                ? m
                : { ...m, team1Players, team2Players }
        );
    }
    return resolved;
};

export interface BuildMatchdataOptions {
    snapshotDate?: string;
}

export const buildMatchdata = (
    rawMatches: Array<Record<string, unknown>>,
    rawTournaments: Array<Record<string, unknown>>,
    rawPlacements: Array<Record<string, unknown>>,
    rawPlayers: Array<Record<string, unknown>>,
    overrides: Overrides = {},
    options: BuildMatchdataOptions = {}
): Matchdata => {
    const playerDb = new Map<string, { nationality?: string; nationality2?: string; id?: string }>();
    for (const p of rawPlayers) {
        if (p.pagename && typeof p.pagename === "string") {
            playerDb.set(p.pagename.toLowerCase(), {
                nationality: typeof p.nationality === "string" ? p.nationality : undefined,
                nationality2: typeof p.nationality2 === "string" ? p.nationality2 : undefined,
                id: typeof p.id === "string" ? p.id : undefined,
            });
        }
    }

    const roundSizes = new Map<string, number>();
    for (const m of rawMatches) roundSizes.set(roundKey(m), (roundSizes.get(roundKey(m)) ?? 0) + 1);

    const tournamentDb = new Map<string, Record<string, unknown>>();
    for (const t of rawTournaments) {
        if (t.pagename && typeof t.pagename === "string") {
            tournamentDb.set(t.pagename, t);
        }
    }

    const rankedEventIds = new Set(
        overrides.rankedEvents
            ? overrides.rankedEvents.map((r) => (typeof r === "string" ? r : (r as { eventId: string }).eventId))
            : []
    );
    const unrankedEventIds = new Set(
        overrides.unrankedEvents
            ? overrides.unrankedEvents.map((u) => (typeof u === "string" ? u : (u as { eventId: string }).eventId))
            : []
    );
    const excludedMatchIds = new Set(
        overrides.excludedMatches
            ? overrides.excludedMatches.map((e) => (typeof e === "string" ? e : (e as { matchId: string }).matchId))
            : []
    );

    const getCanonicalEventId = (matchPagename: string, matchParent?: string): string => {
        if (overrides.eventRollups && overrides.eventRollups[matchPagename]) {
            return overrides.eventRollups[matchPagename].parentEventId;
        }
        if (matchParent && matchParent.trim() && tournamentDb.has(matchParent)) {
            return matchParent.trim();
        }
        return matchPagename;
    };

    const getCanonicalTeamId = (rawTeam: Record<string, unknown>): string => {
        const teamTemplate = rawTeam.teamtemplate as Record<string, unknown> | undefined;
        let baseId = "";
        if (teamTemplate && typeof teamTemplate.page === "string" && teamTemplate.page) {
            baseId = teamTemplate.page;
        } else if (typeof rawTeam.name === "string" && rawTeam.name) {
            baseId = rawTeam.name;
        } else if (typeof rawTeam.template === "string" && rawTeam.template) {
            baseId = rawTeam.template;
        }

        if (overrides.teamAliases && overrides.teamAliases[baseId]) {
            return overrides.teamAliases[baseId].targetTeamId;
        }
        return baseId;
    };

    const getCanonicalPlayer = (p: Record<string, unknown>): ValvePlayer => {
        const rawName = typeof p.name === "string" ? p.name : "";
        const rawDisplayName = typeof p.displayname === "string" ? p.displayname : rawName;
        const rawFlag = typeof p.flag === "string" ? p.flag : "";

        let playerId = rawName || rawDisplayName;
        let nick = rawDisplayName || rawName;
        let countryIso = normalizeCountryIso(rawFlag);

        if (!countryIso && rawName) {
            const dbPlayer = playerDb.get(rawName.toLowerCase());
            if (dbPlayer?.nationality) {
                countryIso = normalizeCountryIso(dbPlayer.nationality);
            }
            if (!countryIso && dbPlayer?.nationality2) {
                countryIso = normalizeCountryIso(dbPlayer.nationality2);
            }
        }

        if (overrides.playerAliases) {
            const alias = overrides.playerAliases[playerId] || overrides.playerAliases[nick];
            if (alias) {
                if (alias.targetPlayerId) playerId = alias.targetPlayerId;
                if (alias.nick) nick = alias.nick;
                if (alias.countryIso) countryIso = alias.countryIso;
            }
        }

        return {
            playerId,
            nick,
            countryIso,
        };
    };

    const eventMap = new Map<string, ValveEvent>();
    const matches: ValveMatch[] = [];

    // Process matches
    for (const m of rawMatches) {
        const matchId = `${String(m.pagename)}:${String(m.match2id ?? m.objectname ?? "")}`;
        if (excludedMatchIds.has(matchId) || (m.match2id && excludedMatchIds.has(String(m.match2id)))) {
            continue;
        }

        const matchParent = typeof m.parent === "string" ? m.parent : undefined;
        const matchPagename = typeof m.pagename === "string" ? m.pagename : "";
        const eventId = getCanonicalEventId(matchPagename, matchParent);

        // Ensure Event exists in eventMap
        if (!eventMap.has(eventId)) {
            const tourney = tournamentDb.get(eventId) ?? tournamentDb.get(matchPagename);
            const rawPrize = tourney?.prizepool as number | string | undefined;
            const tourneyType = String(tourney?.type ?? m.type ?? "");
            const lan = tourneyType.toLowerCase() === "offline";
            const eventName = String(tourney?.name ?? m.tournament ?? eventId);
            const finished = isTourneyFinished(tourney, options.snapshotDate);
            const endDate =
                typeof tourney?.enddate === "string" && tourney.enddate.trim()
                    ? tourney.enddate.trim()
                    : undefined;

            eventMap.set(eventId, {
                eventId,
                eventName,
                prizePool: formatPrizePool(rawPrize),
                lan,
                finished,
                endDate,
                prizeDistribution: [],
            });
        }

        const opponents = Array.isArray(m.match2opponents) ? m.match2opponents : [];
        if (opponents.length < 2) continue;

        const team1Raw = opponents[0] as Record<string, unknown>;
        const team2Raw = opponents[1] as Record<string, unknown>;

        const team1Id = getCanonicalTeamId(team1Raw);
        const team2Id = getCanonicalTeamId(team2Raw);
        const team1Name = team1Id;
        const team2Name = team2Id;

        let team1Players = (Array.isArray(team1Raw.match2players) ? team1Raw.match2players : []).map(
            (p) => getCanonicalPlayer(p as Record<string, unknown>)
        );
        let team2Players = (Array.isArray(team2Raw.match2players) ? team2Raw.match2players : []).map(
            (p) => getCanonicalPlayer(p as Record<string, unknown>)
        );

        let winningTeam: 1 | 2 = m.winner === "1" ? 1 : 2;
        const forfeited = m.walkover === "ff";

        // Determine valveRanked
        const tourney = tournamentDb.get(eventId) ?? tournamentDb.get(matchPagename);
        const tourneyPubTier = String(tourney?.publishertier ?? "");
        const matchPubTier = String(m.publishertier ?? "");
        const effectivePubTier = tourneyPubTier || matchPubTier;
        let valveRanked = Boolean(effectivePubTier);

        if (rankedEventIds.has(eventId) || rankedEventIds.has(matchPagename)) {
            valveRanked = true;
        } else if (unrankedEventIds.has(eventId) || unrankedEventIds.has(matchPagename)) {
            valveRanked = false;
        }
        if (isUntrackedQualifierMatch(m, roundSizes, effectivePubTier)) {
            valveRanked = false;
        }

        // Apply lineup fixes if present
        if (overrides.matchLineupFixes) {
            const fix =
                overrides.matchLineupFixes[matchId] ??
                (m.match2id ? overrides.matchLineupFixes[String(m.match2id)] : undefined);
            if (fix) {
                if (fix.team1Players) team1Players = fix.team1Players;
                if (fix.team2Players) team2Players = fix.team2Players;
                if (fix.winningTeam) winningTeam = fix.winningTeam;
                if (fix.valveRanked !== undefined) valveRanked = fix.valveRanked;
            }
        }

        const extradata = m.extradata as Record<string, unknown> | undefined;
        let matchStartTime = Number(extradata?.timestamp);
        if (Number.isNaN(matchStartTime) || !matchStartTime) {
            const rawDate = String(m.date ?? "").trim();
            if (rawDate) {
                const utcIso = rawDate.includes("T")
                    ? (rawDate.endsWith("Z") ? rawDate : `${rawDate}Z`)
                    : `${rawDate.replace(" ", "T")}Z`;
                const parsed = Date.parse(utcIso);
                matchStartTime = Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
            } else {
                matchStartTime = 0;
            }
        }

        matches.push({
            matchStartTime,
            team1Id,
            team2Id,
            team1Name,
            team2Name,
            team1Players,
            team2Players,
            eventId,
            winningTeam,
            valveRanked,
            forfeited,
        });
    }

    const lineupResolved = resolveLineups(matches);
    matches.length = 0;
    for (const m of lineupResolved) {
        const invalidPlayer = [...m.team1Players, ...m.team2Players].find(
            (p) => !p.countryIso || !VALID_COUNTRY_CODES.has(p.countryIso.toLowerCase())
        );
        if (invalidPlayer) {
            console.warn(
                `Dropping match ${m.team1Id} vs ${m.team2Id} at ${m.matchStartTime}: player "${invalidPlayer.playerId}" has invalid or missing countryIso "${invalidPlayer.countryIso}". Add a playerAliases countryIso override to fix.`
            );
            continue;
        }
        matches.push(m);
    }

    // Process placements into event prize distributions
    for (const pl of rawPlacements) {
        const placePagename = String(pl.pagename ?? "");
        const placeParent = typeof pl.parent === "string" ? pl.parent : undefined;
        const eventId = getCanonicalEventId(placePagename, placeParent);

        if (!eventMap.has(eventId)) {
            const tourney = tournamentDb.get(eventId) ?? tournamentDb.get(placePagename);
            const rawPrize = tourney?.prizepool as number | string | undefined;
            const tourneyType = String(tourney?.type ?? pl.type ?? "");
            const lan = tourneyType.toLowerCase() === "offline";
            const eventName = String(tourney?.name ?? pl.tournament ?? eventId);
            const finished = isTourneyFinished(tourney, options.snapshotDate);
            const endDate =
                typeof tourney?.enddate === "string" && tourney.enddate.trim()
                    ? tourney.enddate.trim()
                    : undefined;

            eventMap.set(eventId, {
                eventId,
                eventName,
                prizePool: formatPrizePool(rawPrize),
                lan,
                finished,
                endDate,
                prizeDistribution: [],
            });
        }

        const ev = eventMap.get(eventId)!;

        let teamId = String(pl.opponentname ?? pl.opponenttemplate ?? "");
        if (overrides.teamAliases && overrides.teamAliases[teamId]) {
            teamId = overrides.teamAliases[teamId].targetTeamId;
        }

        const placement = parseNumericPlacement(pl.placement);
        const prize = Number(pl.prizemoney) || 0;

        ev.prizeDistribution.push({
            teamId,
            placement,
            prize,
            clubShare: 0,
            qualifiedEvents: [],
        });
    }

    // Apply event overrides and prize overrides
    if (overrides.eventOverrides) {
        for (const [eId, evOverride] of Object.entries(overrides.eventOverrides)) {
            const ev = eventMap.get(eId);
            if (ev) {
                if (evOverride.eventName !== undefined) ev.eventName = evOverride.eventName;
                if (evOverride.prizePool !== undefined) ev.prizePool = evOverride.prizePool;
                if (evOverride.lan !== undefined) ev.lan = evOverride.lan;
                if (evOverride.finished !== undefined) ev.finished = evOverride.finished;
                if (evOverride.endDate !== undefined) ev.endDate = evOverride.endDate;
            }
        }
    }

    if (overrides.prizeDistributionOverrides) {
        for (const po of overrides.prizeDistributionOverrides) {
            const ev = eventMap.get(po.eventId);
            if (ev) {
                let entry = ev.prizeDistribution.find((p) => String(p.teamId) === String(po.teamId));
                if (!entry) {
                    entry = {
                        teamId: po.teamId,
                        placement: po.placement ?? 1,
                        prize: po.prize ?? 0,
                        clubShare: po.clubShare ?? 0,
                        qualifiedEvents: po.qualifiedEvents ?? [],
                    };
                    ev.prizeDistribution.push(entry);
                } else {
                    if (po.placement !== undefined) entry.placement = po.placement;
                    if (po.prize !== undefined) entry.prize = po.prize;
                    if (po.clubShare !== undefined) entry.clubShare = po.clubShare;
                    if (po.qualifiedEvents !== undefined) entry.qualifiedEvents = po.qualifiedEvents;
                }
            }
        }
    }

    if (overrides.addedMatches) {
        matches.push(...overrides.addedMatches);
    }

    return {
        matches,
        events: Array.from(eventMap.values()),
    };
};

export const buildAndValidateMatchdata = (
    rawMatches: Array<Record<string, unknown>>,
    rawTournaments: Array<Record<string, unknown>>,
    rawPlacements: Array<Record<string, unknown>>,
    rawPlayers: Array<Record<string, unknown>>,
    overrides: Overrides = {},
    options: BuildMatchdataOptions = {}
): { matchdata: Matchdata; validation: ValidationResult } => {
    const matchdata = buildMatchdata(
        rawMatches,
        rawTournaments,
        rawPlacements,
        rawPlayers,
        overrides,
        options
    );
    const validation = validateMatchdata(matchdata);
    return { matchdata, validation };
};
