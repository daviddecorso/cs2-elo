import type { BracketSlot, StageBracket } from "../sim/types.ts";
import { TeamLogo } from "./TeamLogo.tsx";
import { percent } from "../utils/format.ts";

const FIXED = 0.99;
const CANDIDATES = 4;

interface Selection {
    selected: string | null;
    onSelect: (team: string) => void;
}

const TeamName = ({ team, selected, onSelect, className = "" }: { team: string; className?: string } & Selection) => (
    <button
        type="button"
        onClick={() => onSelect(team)}
        title={team}
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
                <TeamName team={team} {...sel} className={i === result.winner ? "font-medium text-fg" : "text-muted"} />
                <span className={i === result.winner ? "text-up" : "text-muted/50"}>{i === result.winner ? "W" : "L"}</span>
            </div>
        ))}
    </div>
);

/** A pairing every simulation shares; `win` is then the chance to win it. */
const Pairing = ({ teams, slot, ...sel }: { teams: [string, string]; slot: BracketSlot } & Selection) => (
    <div className="space-y-0.5">
        {teams.map((team) => (
            <div key={team} className="flex items-center justify-between gap-2">
                <TeamName team={team} {...sel} className="text-fg" />
                <span className="text-muted">{percent(slot.teams.find((t) => t.team === team)?.win ?? 0)}</span>
            </div>
        ))}
    </div>
);

const Candidates = ({ slot, limit, ...sel }: { slot: BracketSlot; limit: number } & Selection) => (
    <table className="w-full">
        <thead>
            <tr className="text-muted/70 text-[10px] uppercase tracking-wider">
                <th className="text-left font-normal">Team</th>
                <th className="text-right font-normal">Here</th>
                <th className="text-right font-normal pl-2">Wins</th>
            </tr>
        </thead>
        <tbody>
            {slot.teams.slice(0, limit).map((t) => (
                <tr key={t.team}>
                    <td className="max-w-0 w-full">
                        <TeamName team={t.team} {...sel} className="block text-fg" />
                    </td>
                    <td className="text-right text-muted">{percent(t.here)}</td>
                    <td className="text-right text-muted pl-2">{percent(t.win)}</td>
                </tr>
            ))}
        </tbody>
    </table>
);

const cardClass = (slot: BracketSlot, selected: string | null) =>
    `rounded-sm border bg-surface p-2 text-xs font-mono space-y-1.5 ${
        selected && slot.teams.some((t) => t.team === selected) ? "border-accent/60" : "border-line"
    }`;

const MatchCard = ({ slot, ...sel }: { slot: BracketSlot } & Selection) => {
    const [likely] = slot.matchups;
    return (
        <div className={`w-56 ${cardClass(slot, sel.selected)}`}>
            <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted/70">
                <span>Bo{slot.bestOf}</span>
                {slot.reach < FIXED && <span>Played in {percent(slot.reach)}</span>}
            </div>
            {slot.results ? (
                <Played result={slot.results[0]} {...sel} />
            ) : likely && likely.p >= FIXED ? (
                <Pairing teams={likely.teams} slot={slot} {...sel} />
            ) : (
                <>
                    {likely && (
                        <div className="text-muted">
                            Likeliest: {likely.teams.join(" v ")} <span className="text-fg">{percent(likely.p)}</span>
                        </div>
                    )}
                    <Candidates slot={slot} limit={CANDIDATES} {...sel} />
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

const Elimination = ({ stage, ...sel }: { stage: StageBracket } & Selection) => {
    const upper = stage.slots.filter((s) => s.lane === "upper");
    const lower = stage.slots.filter((s) => s.lane === "lower");
    // A lone lower slot is a third-place match, not a lower bracket worth a heading.
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
                        {byRound(lane.slots).map(([round, slots]) => (
                            <div key={round} className="flex flex-col justify-around gap-3">
                                {slots.map((s) => (
                                    <MatchCard key={s.id} slot={s} {...sel} />
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
};

const record = (slot: BracketSlot) => slot.id.split(":")[1] ?? slot.id;
const wins = (slot: BracketSlot) => Number(record(slot).split("-")[0]);

const SwissPool = ({ slot, ...sel }: { slot: BracketSlot } & Selection) => {
    const fixed = slot.results ? [] : slot.matchups.filter((m) => m.p >= FIXED);
    const pinned = new Set(fixed.flatMap((m) => m.teams));
    const open = { ...slot, teams: slot.teams.filter((t) => !pinned.has(t.team)) };
    return (
        <div className={`w-56 ${cardClass(slot, sel.selected)}`}>
            <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted/70">
                <span className="text-fg">{record(slot)}</span>
                <span>Bo{slot.bestOf}</span>
            </div>
            {slot.results?.map((r) => <Played key={r.teams.join("|")} result={r} {...sel} />)}
            {fixed.map((m) => (
                <Pairing key={m.teams.join("|")} teams={m.teams} slot={slot} {...sel} />
            ))}
            {!slot.results && open.teams.length > 0 && <Candidates slot={open} limit={open.teams.length} {...sel} />}
        </div>
    );
};

const Swiss = ({ stage, ...sel }: { stage: StageBracket } & Selection) => (
    <div className="flex gap-4 w-max items-start">
        {byRound(stage.slots).map(([round, slots]) => (
            <div key={round} className="space-y-3">
                <div className="text-[11px] font-mono uppercase tracking-wider text-muted">Round {round}</div>
                {[...slots]
                    .sort((a, b) => wins(b) - wins(a))
                    .map((s) => (
                        <SwissPool key={s.id} slot={s} {...sel} />
                    ))}
            </div>
        ))}
    </div>
);

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
