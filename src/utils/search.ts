export const normalize = (s: string): string =>
    s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

export const compact = (s: string): string =>
    s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");

const COMMON_ALIASES: Record<string, string[]> = {
    "natus vincere": ["navi"],
    "ninjas in pyjamas": ["nip"],
    "virtus pro": ["vp"],
};

export const textMatches = (text: string, query: string): boolean => {
    const q = normalize(query);
    if (!q) return true;
    const n = normalize(text);
    if (n.startsWith(q) || n.includes(` ${q}`) || n.includes(q)) return true;

    const cQ = compact(query);
    const cN = compact(text);
    if (cQ.length > 0 && cN.includes(cQ)) return true;

    if (cQ.length >= 2) {
        const words = n.split(" ").filter(Boolean);
        const acronym = words.map((w) => w[0]).join("");
        if (acronym === cQ || acronym.startsWith(cQ)) return true;

        const aliases = COMMON_ALIASES[n];
        if (aliases && aliases.some((a) => a === cQ || a.startsWith(cQ))) return true;
    }

    return false;
};

export const rosterMatches = (
    team: string,
    players: readonly string[] | undefined,
    query: string
): boolean => {
    const q = query.trim();
    if (!q) return true;
    if (textMatches(team, q)) return true;
    if (players && players.some((p) => textMatches(p, q))) return true;
    return false;
};
