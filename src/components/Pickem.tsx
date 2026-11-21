import { useMemo, useState, type ReactNode } from "react";
import { percent } from "../utils/format.ts";
import { TeamLogo } from "./TeamLogo.tsx";
import { Label, Tooltip } from "./ui.tsx";
import {
    COIN_THRESHOLD,
    decodeSample,
    scorePicks,
    type OddsFn,
    type PickemMatch,
    type PickemScore,
    type StageRun,
    type SwissOutcome,
} from "../sim/pickem.ts";
import type { PickemModel, PickemSet } from "../sim/types.ts";

const SWISS_ROUNDS = 5;

interface Hover {
    hovered: string | null;
    onHover: (team: string | null) => void;
}

const MatchCard = ({
    match,
    odds,
    onPick,
    hovered,
    onHover,
}: { match: PickemMatch; odds: OddsFn; onPick: (key: string, team: string) => void } & Hover) => {
    const [a, b] = match.teams;
    const pA = a && b ? odds(a, b, match.bestOf) : null;
    return (
        <div
            className={`w-52 rounded-sm border bg-surface overflow-hidden ${
                hovered && match.teams.includes(hovered) ? "border-accent" : "border-line"
            }`}
        >
            {match.teams.map((team, i) => {
                const p = pA === null ? null : i === 0 ? pA : 1 - pA;
                const won = team !== null && match.winner === team;
                const lost = match.winner !== null && !won;
                return (
                    <button
                        key={team ?? i}
                        type="button"
                        disabled={!team || !match.teams[1 - i] || match.locked}
                        onClick={() => team && onPick(match.key, team)}
                        onMouseEnter={() => onHover(team)}
                        onMouseLeave={() => onHover(null)}
                        className={`w-full h-8 px-2 flex items-center gap-2 text-xs text-left transition-colors ${
                            i === 1 ? "border-t border-line" : ""
                        } ${won ? "bg-accent/15 text-fg font-medium" : lost ? "text-muted/60" : "text-fg"} ${
                            match.locked || !team ? "cursor-default" : "cursor-pointer hover:bg-surface-2"
                        }`}
                    >
                        {team ? <TeamLogo team={team} size={16} /> : <span className="w-4" />}
                        <span className="truncate flex-1">{team ?? "TBD"}</span>
                        {match.locked && won && <span className="font-mono text-[10px] text-up">W</span>}
                        {!match.locked && p !== null && (
                            <span className="font-mono text-[10px] tabular-nums text-muted">{percent(p)}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
};

const outcomeLabel = (o: SwissOutcome) => `${o.wins}-${o.losses}`;

const OutcomeCard = ({ outcomes, advanced, hovered, onHover }: { outcomes: SwissOutcome[]; advanced: boolean } & Hover) => {
    if (outcomes.length === 0) return null;
    const groups = new Map<string, SwissOutcome[]>();
    for (const o of outcomes) groups.set(outcomeLabel(o), [...(groups.get(outcomeLabel(o)) ?? []), o]);
    return (
        <>
            {[...groups].map(([label, teams]) => (
                <div
                    key={label}
                    className={`w-52 rounded-sm border bg-surface p-2 space-y-1.5 ${advanced ? "border-up/60" : "border-down/60"}`}
                >
                    <div className="flex justify-between text-[10px] font-mono uppercase tracking-wider">
                        <span className={advanced ? "text-up" : "text-down"}>{advanced ? "Advanced" : "Eliminated"}</span>
                        <span className="text-fg">{label}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {teams.map((o) => (
                            <Tooltip key={o.team} content={o.team}>
                                <span
                                    onMouseEnter={() => onHover(o.team)}
                                    onMouseLeave={() => onHover(null)}
                                    className={`inline-flex rounded-sm p-0.5 ${hovered === o.team ? "bg-accent/20" : ""}`}
                                >
                                    <TeamLogo team={o.team} size={22} />
                                </span>
                            </Tooltip>
                        ))}
                    </div>
                </div>
            ))}
        </>
    );
};

const wins = (m: PickemMatch) => Number(m.label.split("-")[0]);

const Column = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="space-y-2 shrink-0">
        <div className="text-[11px] font-mono uppercase tracking-wider text-muted">{title}</div>
        {children}
    </div>
);

export const PickemSwiss = ({
    run,
    odds,
    onPick,
}: {
    run: StageRun;
    odds: OddsFn;
    onPick: (key: string, team: string) => void;
}) => {
    const [hovered, onHover] = useState<string | null>(null);
    const hover = { hovered, onHover };
    const finishedAfter = (round: number) => run.outcomes.filter((o) => o.round === round);

    return (
        <div className="overflow-x-auto pb-2">
            <div className="flex gap-4 w-max items-start">
                {Array.from({ length: SWISS_ROUNDS }, (_, i) => i + 1).map((round) => {
                    const matches = run.rounds[round - 1];
                    const done = finishedAfter(round - 1);
                    const pools = new Map<string, PickemMatch[]>();
                    for (const m of [...(matches ?? [])].sort((x, y) => wins(y) - wins(x))) {
                        pools.set(m.label, [...(pools.get(m.label) ?? []), m]);
                    }
                    return (
                        <Column key={round} title={`Round ${round}`}>
                            <OutcomeCard outcomes={done.filter((o) => o.wins === 3)} advanced {...hover} />
                            {matches ? (
                                [...pools].map(([label, ms]) => (
                                    <div key={label} className="space-y-1.5">
                                        <div className="flex justify-between text-[10px] font-mono text-muted/80">
                                            <span className="text-fg">{label}</span>
                                            <span>Bo{ms[0].bestOf}</span>
                                        </div>
                                        {ms.map((m) => (
                                            <MatchCard key={m.key} match={m} odds={odds} onPick={onPick} {...hover} />
                                        ))}
                                    </div>
                                ))
                            ) : (
                                <div className="w-52 text-[11px] font-mono text-muted/70">Pick every round {round - 1} match first.</div>
                            )}
                            <OutcomeCard outcomes={done.filter((o) => o.losses === 3)} advanced={false} {...hover} />
                        </Column>
                    );
                })}
                <Column title="Final results">
                    <OutcomeCard outcomes={finishedAfter(SWISS_ROUNDS).filter((o) => o.wins === 3)} advanced {...hover} />
                    <OutcomeCard outcomes={finishedAfter(SWISS_ROUNDS).filter((o) => o.losses === 3)} advanced={false} {...hover} />
                </Column>
            </div>
        </div>
    );
};

export const PickemPlayoffs = ({
    run,
    odds,
    onPick,
}: {
    run: StageRun;
    odds: OddsFn;
    onPick: (key: string, team: string) => void;
}) => {
    const [hovered, onHover] = useState<string | null>(null);
    const titles = ["Quarterfinals", "Semifinals", "Final"];
    return (
        <div className="overflow-x-auto pb-2">
            <div className="flex gap-4 w-max items-start">
                {run.rounds.map((matches, i) => (
                    <Column key={i} title={titles[i] ?? `Round ${i + 1}`}>
                        <div className="flex flex-col justify-around gap-3" style={{ minHeight: `${run.rounds[0].length * 76}px` }}>
                            {[...matches].sort((x, y) => (x.lane === y.lane ? 0 : x.lane === "lower" ? 1 : -1)).map((m) => (
                                <div key={m.label} className="space-y-1">
                                    {m.lane === "lower" && <Label>Third place</Label>}
                                    <MatchCard match={m} odds={odds} onPick={onPick} hovered={hovered} onHover={onHover} />
                                    <div className="text-[10px] font-mono text-muted/70">Bo{m.bestOf}</div>
                                </div>
                            ))}
                        </div>
                    </Column>
                ))}
                <Column title="Champion">
                    <div className="w-52 rounded-sm border border-up/60 bg-surface p-3 flex items-center gap-2">
                        {run.champion ? (
                            <>
                                <TeamLogo team={run.champion} size={28} />
                                <span className="font-medium text-fg truncate">{run.champion}</span>
                            </>
                        ) : (
                            <span className="text-xs font-mono text-muted">Pick the final</span>
                        )}
                    </div>
                </Column>
            </div>
        </div>
    );
};

const PickChip = ({ team, label, p }: { team: string; label: string; p: number | undefined }) => (
    <Tooltip content={`${team}: ${p === undefined ? "no simulated odds" : `${percent(p)} to finish ${label}`}`}>
        <div className="flex flex-col items-center gap-1 w-16">
            <span className="flex items-center justify-center size-12 rounded-full border border-line bg-surface-2">
                <TeamLogo team={team} size={32} />
            </span>
            <span className="text-[11px] font-mono text-muted">{label}</span>
            <span className="text-xs font-mono tabular-nums text-fg">{p === undefined ? "–" : percent(p)}</span>
        </div>
    </Tooltip>
);

const PickRow = ({ title, picks, caption }: { title: string; picks: Array<{ team: string; label: string; p: number | undefined }>; caption: string }) => (
    <div className="rounded-sm border border-line bg-surface p-4 space-y-3">
        <div className="flex flex-wrap justify-between gap-2">
            <Label>{title}</Label>
            <span className="text-xs font-mono text-muted">{caption}</span>
        </div>
        <div className="flex flex-wrap gap-3">
            {picks.map((p) => (
                <PickChip key={`${p.label}-${p.team}`} {...p} />
            ))}
        </div>
    </div>
);

const chips = (set: PickemSet, score: PickemScore) => [
    ...set.threeZero.map((team) => ({ team, label: "3-0", p: score.perTeam.get(team) })),
    ...set.advance.map((team) => ({ team, label: "3-X", p: score.perTeam.get(team) })),
    ...set.zeroThree.map((team) => ({ team, label: "0-3", p: score.perTeam.get(team) })),
];

const caption = (s: PickemScore) => `${percent(s.coin)} coin · ${s.expected.toFixed(1)} of 10 expected`;

/** Your bracket's Pick'em next to the model's, both scored on the model's frozen pre-stage simulations. */
export const PickemSummary = ({ run, model }: { run: StageRun; model: PickemModel | undefined }) => {
    const buckets = useMemo(() => (model ? decodeSample(model) : null), [model]);
    if (!run.complete || !model || !buckets || run.seeds.join("|") !== model.seeds.join("|")) return null;

    const yours: PickemSet = {
        threeZero: run.outcomes.filter((o) => o.wins === 3 && o.losses === 0).map((o) => o.team),
        advance: run.outcomes.filter((o) => o.wins === 3 && o.losses > 0).map((o) => o.team),
        zeroThree: run.outcomes.filter((o) => o.wins === 0 && o.losses === 3).map((o) => o.team),
    };
    const yourScore = scorePicks(model.seeds, buckets, yours);
    const modelScore = scorePicks(model.seeds, buckets, model.picks);

    return (
        <div className="space-y-2">
            <div className="space-y-3">
                <PickRow title="Your Pick'em" picks={chips(yours, yourScore)} caption={caption(yourScore)} />
                <PickRow title="Model Pick'em" picks={chips(model.picks, modelScore)} caption={caption(modelScore)} />
            </div>
            <p className="text-[11px] font-mono text-muted">
                Coin is the chance of {COIN_THRESHOLD}+ correct over {model.n.toLocaleString("en-US")} simulations of this stage from round 1.
                The model picks maximize it and are frozen at stage start (ratings as of {model.asOf}).
            </p>
        </div>
    );
};
