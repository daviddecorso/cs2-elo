import { loserOf, winnerOf, type SimMatch, type StageRunner, type TeamId } from "../types.ts";

/** Exit keys: the match id for a loser nothing else uses, `w:<id>` for such a winner. */
export const bracket: StageRunner = (teams, ctx) => {
    const { matches: spec = [], qualify = [], bestOf, id: stageId } = ctx.config;
    const results = new Map<string, SimMatch>();
    const consumed = new Set<string>();

    const resolve = (ref: string): { team: TeamId; round: number } => {
        if (consumed.has(ref)) throw new Error(`Bracket ${stageId}: "${ref}" is used twice`);
        consumed.add(ref);
        const seed = /^s(\d+)$/.exec(ref);
        if (seed) {
            const team = teams[Number(seed[1]) - 1];
            if (!team) throw new Error(`Bracket ${stageId}: no seed ${seed[1]} among ${teams.length} teams`);
            return { team, round: 0 };
        }
        const side = /^([wl]):(.+)$/.exec(ref);
        const m = side && results.get(side[2]);
        if (!m) throw new Error(`Bracket ${stageId}: "${ref}" doesn't name an earlier match`);
        return { team: side[1] === "w" ? winnerOf(m) : loserOf(m), round: m.round };
    };

    // Liquipedia numbers seed-vs-seed matches first in round 1, in the order this config lists them.
    const opening = spec.filter((m) => m.teams.every((ref) => /^s\d+$/.test(ref)));
    const seeded = new Set(opening.flatMap((m) => m.teams.map((ref) => teams[Number(ref.slice(1)) - 1])));
    const draw = ctx.knownPairings(1).slice(0, opening.length);
    const useDraw = draw.length === opening.length && new Set(draw.flat()).size === seeded.size && draw.flat().every((t) => seeded.has(t));

    // Lower lane: matches fed only by losers and lower-lane winners, so lower brackets and third-place matches but not grand finals.
    const lower = new Set<string>();
    for (const m of spec) {
        const [a, b] = m.teams.map(resolve);
        const i = useDraw ? opening.indexOf(m) : -1;
        const [ta, tb] = i >= 0 ? draw[i] : [a.team, b.team];
        if (m.teams.every((ref) => ref.startsWith("l:") || (ref.startsWith("w:") && lower.has(ref.slice(2))))) lower.add(m.id);
        const place = { slot: m.id, lane: lower.has(m.id) ? "lower" : "upper" } as const;
        results.set(m.id, ctx.play(ta, tb, m.bestOf ?? bestOf.default, Math.max(a.round, b.round) + 1, place));
    }
    const advancing = qualify.map((ref) => resolve(ref).team);

    const unusedSeed = teams.findIndex((_, i) => !consumed.has(`s${i + 1}`));
    if (unusedSeed >= 0) throw new Error(`Bracket ${stageId}: seed ${unusedSeed + 1} never plays`);
    const exits = new Map<TeamId, string>();
    for (const [id, m] of results) {
        if (!consumed.has(`l:${id}`)) exits.set(loserOf(m), id);
        if (!consumed.has(`w:${id}`)) exits.set(winnerOf(m), `w:${id}`);
    }
    return { advancing, exits, matches: [...results.values()] };
};
