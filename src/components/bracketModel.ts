import type { BracketSlot, StageBracket } from "../sim/types.ts";

/** A pairing at least this likely is shown as set. */
export const FIXED = 0.99;

export interface DestinationInfo {
    label: string;
    p: number;
    win?: number;
    isCurrent: boolean;
    key: string;
}

export interface DestinationCarrier {
    destinations: DestinationInfo[];
}

export const byRound = (slots: BracketSlot[]) => {
    const rounds = new Map<number, BracketSlot[]>();
    for (const s of slots) rounds.set(s.round, [...(rounds.get(s.round) ?? []), s]);
    return [...rounds].sort((a, b) => a[0] - b[0]);
};

export const record = (slot: BracketSlot) => slot.id.split(":")[1] ?? slot.id;
const parseWL = (slot: BracketSlot) => record(slot).split("-").map(Number);

export interface TeamRoundStatus extends DestinationCarrier {
    /** Pool, `adv` or `elim` the team is shown in this round; empty when it's off the likeliest path. */
    bestKey: string;
}

/** Teams of a pool that win their match: played results, then each set pairing's favourite, then the best conditional win rates. */
const poolWinners = (slot: BracketSlot, members: string[]): Set<string> => {
    if (slot.results) return new Set(slot.results.map((r) => r.teams[r.winner]));
    const winRate = (team: string) => {
        const t = slot.teams.find((x) => x.team === team);
        return t && t.here > 0 ? t.win / t.here : 0;
    };
    const winners = new Set<string>();
    const open = new Set(members);
    for (const m of slot.matchups) {
        if (m.p < FIXED || !m.teams.every((t) => open.has(t))) continue;
        const [a, b] = m.teams;
        winners.add(winRate(a) >= winRate(b) ? a : b);
        open.delete(a);
        open.delete(b);
    }
    const rest = [...open].sort((a, b) => winRate(b) - winRate(a));
    for (const team of rest.slice(0, Math.floor(rest.length / 2))) winners.add(team);
    return winners;
};

/** Each round's pool odds per team, plus its place on one likeliest path so pools hold exactly their size and records only move forward. */
export const swissRoundModel = (stage: StageBracket) => {
    const maxW = Math.max(...stage.slots.map((s) => parseWL(s)[0] || 0));
    const maxL = Math.max(...stage.slots.map((s) => parseWL(s)[1] || 0));
    const rounds = byRound(stage.slots);
    const roundTeams = new Map<number, Map<string, TeamRoundStatus>>();

    const allTeams = new Set<string>();
    for (const s of stage.slots) {
        for (const t of s.teams) allTeams.add(t.team);
        if (s.results) for (const r of s.results) for (const t of r.teams) allTeams.add(t);
        for (const m of s.matchups) for (const t of m.teams) allTeams.add(t);
    }

    let path = new Map<string, string>();
    rounds.forEach(([round, currentSlots], i) => {
        if (i === 0) {
            for (const s of currentSlots) {
                const size = Math.round(s.size ?? s.teams.reduce((a, t) => a + t.here, 0));
                for (const t of [...s.teams].sort((a, b) => b.here - a.here).slice(0, size)) path.set(t.team, s.id);
            }
        } else {
            const [prevRound, prevSlots] = rounds[i - 1];
            const next = new Map<string, string>();
            for (const [team, key] of path) if (key === "adv" || key === "elim") next.set(team, key);
            for (const s of prevSlots) {
                const members = [...path].filter(([, key]) => key === s.id).map(([team]) => team);
                const winners = poolWinners(s, members);
                const [w, l] = parseWL(s);
                for (const team of members) {
                    const [nw, nl] = winners.has(team) ? [w + 1, l] : [w, l + 1];
                    next.set(team, nw > maxW ? "adv" : nl > maxL ? "elim" : `r${prevRound + 1}:${nw}-${nl}`);
                }
            }
            path = next;
        }

        const pastSlots = stage.slots.filter((s) => s.round < round);
        const teamMap = new Map<string, TeamRoundStatus>();
        for (const team of allTeams) {
            let advBefore = 0;
            let elimBefore = 0;
            for (const s of pastSlots) {
                const [w, l] = parseWL(s);
                const t = s.teams.find((x) => x.team === team);
                if (!t) continue;
                if (w === maxW) advBefore += t.win;
                if (l === maxL) elimBefore += t.here - t.win;
            }

            const dests: Array<Omit<DestinationInfo, "isCurrent">> = [];
            if (advBefore >= 0.005) dests.push({ label: round === 4 ? "Qualified (3-0)" : "Qualified", p: advBefore, key: "adv" });
            for (const s of currentSlots) {
                const t = s.teams.find((x) => x.team === team);
                if (t && t.here >= 0.005) dests.push({ label: record(s), p: t.here, win: t.win, key: s.id });
            }
            if (elimBefore >= 0.005) dests.push({ label: round === 4 ? "Eliminated (0-3)" : "Eliminated", p: elimBefore, key: "elim" });
            if (dests.length === 0 && !path.has(team)) continue;

            dests.sort((a, b) => b.p - a.p);
            const bestKey = path.get(team) ?? "";
            teamMap.set(team, { bestKey, destinations: dests.map((d) => ({ ...d, isCurrent: d.key === bestKey })) });
        }
        roundTeams.set(round, teamMap);
    });

    return roundTeams;
};
