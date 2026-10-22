import { useMemo } from "react";
import type { BracketSlot, StageBracket } from "../sim/types.ts";
import { TeamLogo } from "./TeamLogo.tsx";
import { Tooltip } from "./ui.tsx";
import { percent } from "../utils/format.ts";

const FIXED = 0.99;
const CANDIDATES = 4;

interface Selection {
    selected: string | null;
    onSelect: (team: string) => void;
}

const TeamName = ({
    team,
    selected,
    onSelect,
    className = "",
    title,
}: { team: string; className?: string; title?: string } & Selection) => (
    <button
        type="button"
        onClick={() => onSelect(team)}
        title={title}
        className={`min-w-0 truncate text-left rounded-sm px-1 -mx-1 cursor-pointer hover:text-accent inline-flex items-center gap-1.5 ${
            team === selected ? "bg-accent/15 text-accent" : ""
        } ${className}`}
    >
        <TeamLogo team={team} size={16} />
        <span className="truncate">{team}</span>
    </button>
);

const Played = ({ result, ...sel }: { result: NonNullable<BracketSlot["results"]>[number] } & Selection) => (
    <div className="space-y-0.5">
        {result.teams.map((team, i) => (
            <div key={team} className="flex items-center justify-between gap-2">
                <TeamName team={team} {...sel} title={team} className={i === result.winner ? "font-medium text-fg" : "text-muted"} />
                <span className={i === result.winner ? "text-up" : "text-muted/50"}>{i === result.winner ? "W" : "L"}</span>
            </div>
        ))}
    </div>
);

const Pairing = ({ teams, slot, ...sel }: { teams: [string, string]; slot: BracketSlot } & Selection) => (
    <div className="space-y-0.5">
        {teams.map((team) => (
            <div key={team} className="flex items-center justify-between gap-2">
                <TeamName team={team} {...sel} title={team} className="text-fg" />
                <span className="text-muted">{percent(slot.teams.find((t) => t.team === team)?.win ?? 0)}</span>
            </div>
        ))}
    </div>
);

interface DestinationInfo {
    label: string;
    p: number;
    win?: number;
    isCurrent: boolean;
    key: string;
}

interface DestinationCarrier {
    destinations: DestinationInfo[];
}

const DestinationTooltip = ({
    team,
    destinations,
    round,
}: {
    team: string;
    destinations: DestinationInfo[];
    round: number;
}) => (
    <div className="space-y-1.5 text-xs font-mono">
        <div className="font-semibold text-fg border-b border-line pb-1">
            {team} · Round {round}
        </div>
        <div className="space-y-0.5">
            {destinations.map((d) => (
                <div key={d.label} className="flex items-center justify-between gap-3">
                    <span className={d.isCurrent ? "text-fg font-medium" : "text-muted"}>{d.label}</span>
                    <span className="tabular-nums text-fg">
                        {percent(d.p)}
                        {d.win !== undefined && d.win > 0 && (
                            <span className="text-muted text-[10px] ml-1">({percent(d.win)} win)</span>
                        )}
                    </span>
                </div>
            ))}
        </div>
    </div>
);

const Candidates = ({
    teams,
    round,
    teamStatusMap,
    ...sel
}: {
    teams: Array<{ team: string; here: number; win: number }>;
    round: number;
    teamStatusMap: Map<string, DestinationCarrier>;
} & Selection) => (
    <table className="w-full">
        <thead>
            <tr className="text-muted/70 text-[10px] uppercase tracking-wider">
                <th className="text-left font-normal">Team</th>
                <th className="text-right font-normal">Here</th>
                <th className="text-right font-normal pl-2">Wins</th>
            </tr>
        </thead>
        <tbody>
            {teams.map((t) => (
                <tr key={t.team}>
                    <td className="max-w-0 w-full">
                        <Tooltip
                            content={
                                <DestinationTooltip
                                    team={t.team}
                                    destinations={teamStatusMap.get(t.team)?.destinations ?? []}
                                    round={round}
                                />
                            }
                            hoverOnly
                            className="block min-w-0"
                        >
                            <TeamName team={t.team} {...sel} className="block text-fg" />
                        </Tooltip>
                    </td>
                    <td className="text-right text-muted">{percent(t.here)}</td>
                    <td className="text-right text-muted pl-2">{percent(t.win)}</td>
                </tr>
            ))}
        </tbody>
    </table>
);

const cardClass = (highlighted: boolean) =>
    `rounded-sm border bg-surface p-2 text-xs font-mono space-y-1.5 ${
        highlighted ? "border-accent/60" : "border-line"
    }`;

const slotLabel = (slot: BracketSlot): string => {
    const id = slot.id.toLowerCase();
    if (id === "gf") return "Grand Final";
    if (id === "f") return "Final";
    if (id === "uf") return "Upper Final";
    if (id === "lf") return "Lower Final";
    if (id === "tp") return "3rd Place Match";
    if (id.startsWith("qf")) return `Quarterfinal ${id.slice(2)}`;
    if (id.startsWith("sf")) return `Semifinal ${id.slice(2)}`;
    if (id.startsWith("u")) return `Upper ${id.toUpperCase()}`;
    if (id.startsWith("l")) return `Lower ${id.toUpperCase()}`;
    return slot.id.toUpperCase();
};

interface TeamElimStatus extends DestinationCarrier {
    bestSlotId: string | null;
}

const matchCandidates = (
    slot: BracketSlot,
    roundModel: Map<string, TeamElimStatus>
) => {
    const preferred = slot.teams.filter(
        (t) => roundModel.get(t.team)?.bestSlotId === slot.id
    );
    const candidates = preferred.slice(0, CANDIDATES);
    if (candidates.length < 2) {
        const existing = new Set(candidates.map((t) => t.team));
        for (const t of slot.teams) {
            if (!existing.has(t.team)) {
                candidates.push(t);
                existing.add(t.team);
                if (candidates.length >= 2) break;
            }
        }
    }
    return candidates;
};

const MatchCard = ({
    slot,
    teamStatusMap,
    ...sel
}: {
    slot: BracketSlot;
    teamStatusMap: Map<string, TeamElimStatus>;
} & Selection) => {
    const [likely] = slot.matchups;
    const isFixed = Boolean(likely && likely.p >= FIXED);
    const candidates = slot.results || isFixed ? [] : matchCandidates(slot, teamStatusMap);

    const isSelected = Boolean(
        sel.selected &&
            (slot.results?.some((r) => r.teams.includes(sel.selected!)) ||
                (isFixed && likely.teams.includes(sel.selected!)) ||
                candidates.some((t) => t.team === sel.selected))
    );

    return (
        <div className={`w-56 ${cardClass(isSelected)}`}>
            <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted/70">
                <span>Bo{slot.bestOf}</span>
                {slot.reach < FIXED && <span>Played in {percent(slot.reach)}</span>}
            </div>
            {slot.results ? (
                <Played result={slot.results[0]} {...sel} />
            ) : isFixed ? (
                <Pairing teams={likely.teams} slot={slot} {...sel} />
            ) : (
                <>
                    {likely && (
                        <div className="text-muted">
                            Likeliest: {likely.teams.join(" v ")} <span className="text-fg">{percent(likely.p)}</span>
                        </div>
                    )}
                    {candidates.length > 0 && (
                        <Candidates
                            teams={candidates}
                            round={slot.round}
                            teamStatusMap={teamStatusMap}
                            {...sel}
                        />
                    )}
                </>
            )}
        </div>
    );
};

const byRound = (slots: BracketSlot[]) => {
    const rounds = new Map<number, BracketSlot[]>();
    for (const s of slots) rounds.set(s.round, [...(rounds.get(s.round) ?? []), s]);
    return [...rounds].sort((a, b) => a[0] - b[0]);
};

const eliminationRoundModel = (stage: StageBracket) => {
    const rounds = byRound(stage.slots);
    const roundTeams = new Map<number, Map<string, TeamElimStatus>>();

    const allTeams = new Set<string>();
    for (const s of stage.slots) {
        for (const t of s.teams) allTeams.add(t.team);
        if (s.results) for (const r of s.results) for (const t of r.teams) allTeams.add(t);
        for (const m of s.matchups) for (const t of m.teams) allTeams.add(t);
    }

    for (const [round, currentSlots] of rounds) {
        const teamMap = new Map<string, TeamElimStatus>();

        for (const team of allTeams) {
            let hereSum = 0;
            const dests: Array<{ label: string; p: number; win?: number; key: string }> = [];
            let bestSlotId: string | null = null;
            let maxHere = 0;

            for (const s of currentSlots) {
                const t = s.teams.find((x) => x.team === team);
                if (t && t.here >= 0.005) {
                    hereSum += t.here;
                    dests.push({ label: slotLabel(s), p: t.here, win: t.win, key: s.id });
                    if (t.here > maxHere) {
                        maxHere = t.here;
                        bestSlotId = s.id;
                    }
                }
            }

            const eliminated = Math.max(0, 1 - hereSum);
            if (eliminated >= 0.005 && dests.length > 0) {
                dests.push({ label: "Eliminated", p: eliminated, key: "elim" });
            }

            dests.sort((a, b) => b.p - a.p);
            const destinations = dests.map((d) => ({
                ...d,
                isCurrent: d.key === bestSlotId,
            }));

            if (bestSlotId) teamMap.set(team, { bestSlotId, destinations });
        }
        roundTeams.set(round, teamMap);
    }

    return roundTeams;
};

const Elimination = ({ stage, ...sel }: { stage: StageBracket } & Selection) => {
    const roundModel = useMemo(() => eliminationRoundModel(stage), [stage]);
    const upper = stage.slots.filter((s) => s.lane === "upper");
    const lower = stage.slots.filter((s) => s.lane === "lower");
    const labelled = lower.length > 1;
    const lanes = [
        { name: "Upper bracket", slots: upper },
        { name: labelled ? "Lower bracket" : "", slots: lower },
    ].filter((l) => l.slots.length);

    return (
        <div className="space-y-6">
            {lanes.map((lane) => (
                <div key={lane.name || "lower"} className="space-y-2">
                    {labelled && <div className="text-[11px] font-mono uppercase tracking-wider text-muted">{lane.name}</div>}
                    <div className="flex gap-4 w-max">
                        {byRound(lane.slots).map(([round, slots]) => {
                            const teamStatusMap = roundModel.get(round) ?? new Map<string, TeamElimStatus>();
                            return (
                                <div key={round} className="flex flex-col justify-around gap-3">
                                    {slots.map((s) => (
                                        <MatchCard
                                            key={s.id}
                                            slot={s}
                                            teamStatusMap={teamStatusMap}
                                            {...sel}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
};

const record = (slot: BracketSlot) => slot.id.split(":")[1] ?? slot.id;
const wins = (slot: BracketSlot) => Number(record(slot).split("-")[0]);
const parseWL = (slot: BracketSlot) => record(slot).split("-").map(Number);

interface TeamRoundStatus extends DestinationCarrier {
    bestKey: string;
}

const swissRoundModel = (stage: StageBracket) => {
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

    for (const [round, currentSlots] of rounds) {
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

            const currentDests: Array<{ label: string; p: number; win?: number; key: string }> = [];
            if (advBefore >= 0.005) {
                currentDests.push({
                    label: round === 4 ? "Qualified (3-0)" : "Qualified",
                    p: advBefore,
                    key: "adv",
                });
            }
            for (const s of currentSlots) {
                const t = s.teams.find((x) => x.team === team);
                if (t && t.here >= 0.005) {
                    currentDests.push({
                        label: record(s),
                        p: t.here,
                        win: t.win,
                        key: s.id,
                    });
                }
            }
            if (elimBefore >= 0.005) {
                currentDests.push({
                    label: round === 4 ? "Eliminated (0-3)" : "Eliminated",
                    p: elimBefore,
                    key: "elim",
                });
            }

            if (currentDests.length === 0) continue;

            currentDests.sort((a, b) => b.p - a.p);
            const bestKey = currentDests[0].key;
            const destinations: DestinationInfo[] = currentDests.map((d) => ({
                ...d,
                isCurrent: d.key === bestKey,
            }));

            teamMap.set(team, { bestKey, destinations });
        }
        roundTeams.set(round, teamMap);
    }

    return roundTeams;
};

const StatusCard = ({
    title,
    badge,
    teams,
    round,
    teamStatusMap,
    isSelected,
    ...sel
}: {
    title: string;
    badge?: string;
    teams: Array<{ team: string; p: number }>;
    round: number;
    teamStatusMap: Map<string, TeamRoundStatus>;
    isSelected: boolean;
} & Selection) => (
    <div className={`w-56 ${cardClass(isSelected)}`}>
        <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted/70">
            <span className={title === "Qualified" ? "text-up font-medium" : "text-muted font-medium"}>{title}</span>
            {badge && <span>{badge}</span>}
        </div>
        <table className="w-full">
            <thead>
                <tr className="text-muted/70 text-[10px] uppercase tracking-wider">
                    <th className="text-left font-normal">Team</th>
                    <th className="text-right font-normal">Odds</th>
                </tr>
            </thead>
            <tbody>
                {teams.map((t) => (
                    <tr key={t.team}>
                        <td className="max-w-0 w-full">
                            <Tooltip
                                content={
                                    <DestinationTooltip
                                        team={t.team}
                                        destinations={teamStatusMap.get(t.team)?.destinations ?? []}
                                        round={round}
                                    />
                                }
                                hoverOnly
                                className="block min-w-0"
                            >
                                <TeamName team={t.team} {...sel} className="block text-fg" />
                            </Tooltip>
                        </td>
                        <td className="text-right text-muted">{percent(t.p)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

const SwissPool = ({
    slot,
    round,
    teamStatusMap,
    ...sel
}: {
    slot: BracketSlot;
    round: number;
    teamStatusMap: Map<string, TeamRoundStatus>;
} & Selection) => {
    const fixed = slot.results ? [] : slot.matchups.filter((m) => m.p >= FIXED);
    const pinned = new Set(fixed.flatMap((m) => m.teams));
    const openTeams = slot.teams.filter(
        (t) => !pinned.has(t.team) && teamStatusMap.get(t.team)?.bestKey === slot.id
    );

    const isSelected = Boolean(
        sel.selected &&
            (slot.results?.some((r) => r.teams.includes(sel.selected!)) ||
                fixed.some((m) => m.teams.includes(sel.selected!)) ||
                openTeams.some((t) => t.team === sel.selected))
    );

    return (
        <div className={`w-56 ${cardClass(isSelected)}`}>
            <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted/70">
                <span className="text-fg">{record(slot)}</span>
                <span>Bo{slot.bestOf}</span>
            </div>
            {slot.results?.map((r) => <Played key={r.teams.join("|")} result={r} {...sel} />)}
            {fixed.map((m) => (
                <Pairing key={m.teams.join("|")} teams={m.teams} slot={slot} {...sel} />
            ))}
            {!slot.results && openTeams.length > 0 && (
                <Candidates teams={openTeams} round={round} teamStatusMap={teamStatusMap} {...sel} />
            )}
        </div>
    );
};

const Swiss = ({ stage, ...sel }: { stage: StageBracket } & Selection) => {
    const roundModel = useMemo(() => swissRoundModel(stage), [stage]);
    const rounds = byRound(stage.slots);

    return (
        <div className="flex gap-4 w-max items-start">
            {rounds.map(([round, slots]) => {
                const teamStatusMap = roundModel.get(round) ?? new Map<string, TeamRoundStatus>();

                const qualifiedTeams: Array<{ team: string; p: number }> = [];
                const eliminatedTeams: Array<{ team: string; p: number }> = [];

                for (const [team, status] of teamStatusMap) {
                    if (status.bestKey === "adv") {
                        const d = status.destinations.find((x) => x.key === "adv");
                        if (d) qualifiedTeams.push({ team, p: d.p });
                    } else if (status.bestKey === "elim") {
                        const d = status.destinations.find((x) => x.key === "elim");
                        if (d) eliminatedTeams.push({ team, p: d.p });
                    }
                }

                qualifiedTeams.sort((a, b) => b.p - a.p);
                eliminatedTeams.sort((a, b) => b.p - a.p);

                return (
                    <div key={round} className="space-y-3">
                        <div className="text-[11px] font-mono uppercase tracking-wider text-muted">Round {round}</div>
                        {qualifiedTeams.length > 0 && (
                            <StatusCard
                                title="Qualified"
                                badge={round === 4 ? "3-0" : undefined}
                                teams={qualifiedTeams}
                                round={round}
                                teamStatusMap={teamStatusMap}
                                isSelected={Boolean(sel.selected && qualifiedTeams.some((t) => t.team === sel.selected))}
                                {...sel}
                            />
                        )}
                        {[...slots]
                            .sort((a, b) => wins(b) - wins(a))
                            .map((s) => (
                                <SwissPool
                                    key={s.id}
                                    slot={s}
                                    round={round}
                                    teamStatusMap={teamStatusMap}
                                    {...sel}
                                />
                            ))}
                        {eliminatedTeams.length > 0 && (
                            <StatusCard
                                title="Eliminated"
                                badge={round === 4 ? "0-3" : undefined}
                                teams={eliminatedTeams}
                                round={round}
                                teamStatusMap={teamStatusMap}
                                isSelected={Boolean(sel.selected && eliminatedTeams.some((t) => t.team === sel.selected))}
                                {...sel}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export const Bracket = ({ stage, ...sel }: { stage: StageBracket } & Selection) => {
    if (stage.format === "round_robin") {
        return <p className="text-xs font-mono text-muted">No bracket view for round-robin stages.</p>;
    }
    return (
        <div className="overflow-x-auto pb-2">
            {stage.format === "swiss" ? <Swiss stage={stage} {...sel} /> : <Elimination stage={stage} {...sel} />}
        </div>
    );
};
