import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import type { MatchSide, ScheduledMatch } from "../elo/types.ts";
import { useEventPages } from "../hooks/useEventPages.ts";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { formatMatchTime, isUpset } from "../utils/matches.ts";
import { teamPath } from "../utils/teams.ts";
import { DataTable, ProbabilityBar, Row, TableBody, TableHead, Td, Th } from "./DataTable.tsx";
import { LiquipediaCredit } from "./LiquipediaCredit.tsx";
import { ProbBar } from "./ProbBar.tsx";
import { TeamLogo } from "./TeamLogo.tsx";
import { Badge, Inset, Label, Modal } from "./ui.tsx";
import { VetoForecast } from "./VetoForecast.tsx";

const signed = (n: number, digits = 1) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;

const SideHeader = ({
    side,
    align,
    isWinner,
    isCompleted,
}: {
    side: MatchSide;
    align: "left" | "right";
    isWinner: boolean;
    isCompleted: boolean;
}) => {
    const profileTarget = side.profileTeam ?? side.team;
    const isLoser = isCompleted && !isWinner;
    return (
        <div className={`min-w-0 flex flex-col gap-1 ${align === "right" ? "items-end text-right" : "items-start"}`}>
            <div className={`flex items-center gap-2 min-w-0 max-w-full ${align === "right" ? "flex-row-reverse" : ""}`}>
                <TeamLogo team={side.team} size={28} />
                {side.rated ? (
                    <Link
                        to={teamPath(profileTarget)}
                        className={`text-sm sm:text-base font-semibold hover:text-accent transition-colors truncate ${
                            isLoser ? "text-muted" : "text-fg"
                        }`}
                    >
                        {side.team}
                    </Link>
                ) : (
                    <span className={`text-sm sm:text-base font-semibold truncate ${isLoser ? "text-muted" : "text-fg"}`}>
                        {side.team}
                    </span>
                )}
            </div>
            <div className="text-xs font-mono text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {side.rating !== null ? (
                    <span>
                        Elo {Math.round(side.rating)}
                        {side.rank !== null && ` (#${side.rank})`}
                    </span>
                ) : (
                    <span>Unrated</span>
                )}
                {side.vrsRank !== null && <span>VRS #{side.vrsRank}</span>}
                {side.delta !== undefined && (
                    <span className={side.delta > 0 ? "text-up" : side.delta < 0 ? "text-down" : "text-muted"}>
                        {signed(side.delta)}
                    </span>
                )}
            </div>
        </div>
    );
};

export interface MatchDetailModalProps {
    match: ScheduledMatch;
    onClose: () => void;
    onPrev?: () => void;
    onNext?: () => void;
}

export const MatchDetailModal = ({ match, onClose, onPrev, onNext }: MatchDetailModalProps) => {
    const eventPages = useEventPages();

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
            const target = e.target as HTMLElement | null;
            if (
                target &&
                (target.tagName === "INPUT" ||
                    target.tagName === "SELECT" ||
                    target.tagName === "TEXTAREA" ||
                    target.isContentEditable)
            ) {
                return;
            }
            if (e.key === "ArrowLeft" && onPrev) {
                e.preventDefault();
                onPrev();
            } else if (e.key === "ArrowRight" && onNext) {
                e.preventDefault();
                onNext();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onPrev, onNext]);

    const [a, b] = match.sides;
    const isCompleted = match.status === "completed";
    const upset = isUpset(match);
    const { localDate, localTime, utcTooltip } = formatMatchTime(match.t, match.dateExact);
    const hasEventPage = eventPages.has(match.eventSlug);
    const sortedMaps =
        isCompleted ? match.maps : [...match.maps].sort((x, y) => y.p - x.p || x.map.localeCompare(y.map));

    const navButtonClass =
        "min-w-7 min-h-7 inline-flex items-center justify-center rounded-sm border border-line bg-surface hover:bg-surface-2 text-muted hover:text-fg text-xs font-mono transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent";

    const modalTitle = (
        <span className="inline-flex items-center gap-2 min-w-0">
            {(onPrev || onNext) && (
                <span className="inline-flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={onPrev}
                        disabled={!onPrev}
                        aria-label="Previous match"
                        className={navButtonClass}
                    >
                        ‹
                    </button>
                    <button
                        type="button"
                        onClick={onNext}
                        disabled={!onNext}
                        aria-label="Next match"
                        className={navButtonClass}
                    >
                        ›
                    </button>
                </span>
            )}
            <span className="truncate">
                {a.team} vs {b.team}
            </span>
        </span>
    );

    return (
        <Modal open onClose={onClose} title={modalTitle}>
            <div className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-muted">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        {hasEventPage ? (
                            <Link to={`/events/${match.eventSlug}`} onClick={onClose} className="text-accent hover:underline">
                                {match.eventName}
                            </Link>
                        ) : (
                            <span className="text-fg">{match.eventName}</span>
                        )}
                        {match.section && <span>/ {match.section}</span>}
                        {match.bestOf > 0 && <span>/ Bo{match.bestOf}</span>}
                        <span>/ {match.lan ? "LAN" : "Online"}</span>
                        {match.tier !== null && <span>/ Tier {match.tier}</span>}
                        {upset && <Badge tone="down">Upset</Badge>}
                    </div>
                    <div className="flex items-center gap-2">
                        <span>
                            {localDate}
                            {localTime !== "TBD" ? ` · ${localTime}` : ""}
                            {utcTooltip ? ` (${utcTooltip})` : ""}
                        </span>
                        <a
                            href={liquipediaUrl(match.page)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent hover:underline"
                        >
                            Liquipedia
                        </a>
                    </div>
                </div>

                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                    <SideHeader side={a} align="left" isWinner={isCompleted && match.winner === 0} isCompleted={isCompleted} />
                    <div className="text-center font-mono">
                        {isCompleted && a.score !== undefined && b.score !== undefined ? (
                            <div className="text-xl sm:text-2xl font-bold tabular-nums">
                                <span className={match.winner === 0 ? "text-fg" : "text-muted"}>{a.score}</span>
                                <span className="text-muted mx-1">–</span>
                                <span className={match.winner === 1 ? "text-fg" : "text-muted"}>{b.score}</span>
                            </div>
                        ) : (
                            <span className="text-xs uppercase text-muted">vs</span>
                        )}
                    </div>
                    <SideHeader side={b} align="right" isWinner={isCompleted && match.winner === 1} isCompleted={isCompleted} />
                </div>

                <ProbBar leftName={a.team} rightName={b.team} leftProb={match.p} />

                {!isCompleted && match.seriesOdds && (
                    <Inset className="grid grid-cols-3 gap-3 text-center font-mono">
                        {(
                            [
                                ["Bo1", 1, match.seriesOdds.bo1],
                                ["Bo3", 3, match.seriesOdds.bo3],
                                ["Bo5", 5, match.seriesOdds.bo5],
                            ] as const
                        ).map(([label, len, prob]) => {
                            const active = (match.bestOf > 0 ? match.bestOf : 3) === len;
                            return (
                                <div key={label} className={active ? "text-fg" : "text-muted"}>
                                    <div className="text-[10px] uppercase tracking-wider text-muted">
                                        {label}
                                        {active ? " · scheduled" : ""}
                                    </div>
                                    <div className={`text-xs mt-0.5 tabular-nums ${active ? "font-semibold" : ""}`}>
                                        {Math.round(prob * 100)}% – {100 - Math.round(prob * 100)}%
                                    </div>
                                </div>
                            );
                        })}
                    </Inset>
                )}

                {!isCompleted && match.veto && <VetoForecast veto={match.veto} sides={match.sides} />}

                {sortedMaps.length > 0 && (
                    <div className="space-y-2">
                        <Label>{isCompleted ? "Maps played" : "Active map pool odds"}</Label>
                        <DataTable>
                            <TableHead>
                                <Th align="left">Map</Th>
                                {isCompleted ? (
                                    <Th align="center">Score</Th>
                                ) : (
                                    <>
                                        <Th>{a.team}</Th>
                                        <Th>{b.team}</Th>
                                    </>
                                )}
                                <Th>{isCompleted ? "Pre-map Win %" : `${a.team} Win %`}</Th>
                            </TableHead>
                            <TableBody>
                                {sortedMaps.map((m, idx) => (
                                    <Row key={`${m.map}-${idx}`}>
                                        <Td className="font-sans font-medium text-fg">{m.map}</Td>
                                        {isCompleted ? (
                                            <Td align="center" className="tabular-nums">
                                                {m.rounds ? (
                                                    <>
                                                        <span className={m.winner === 0 ? "text-fg font-semibold" : "text-muted"}>
                                                            {m.rounds[0]}
                                                        </span>
                                                        <span className="text-muted mx-1">–</span>
                                                        <span className={m.winner === 1 ? "text-fg font-semibold" : "text-muted"}>
                                                            {m.rounds[1]}
                                                        </span>
                                                    </>
                                                ) : (
                                                    "—"
                                                )}
                                            </Td>
                                        ) : (
                                            <>
                                                <Td
                                                    align="right"
                                                    className={
                                                        (m.offsets?.[0] ?? 0) > 0
                                                            ? "text-up"
                                                            : (m.offsets?.[0] ?? 0) < 0
                                                              ? "text-down"
                                                              : "text-muted"
                                                    }
                                                >
                                                    {signed(m.offsets?.[0] ?? 0, 0)}
                                                </Td>
                                                <Td
                                                    align="right"
                                                    className={
                                                        (m.offsets?.[1] ?? 0) > 0
                                                            ? "text-up"
                                                            : (m.offsets?.[1] ?? 0) < 0
                                                              ? "text-down"
                                                              : "text-muted"
                                                    }
                                                >
                                                    {signed(m.offsets?.[1] ?? 0, 0)}
                                                </Td>
                                            </>
                                        )}
                                        <Td align="right">
                                            <span className="inline-flex items-center justify-end gap-2">
                                                <ProbabilityBar p={m.p} className="hidden sm:block" />
                                                <span className="tabular-nums text-fg w-8 text-right">{Math.round(m.p * 100)}%</span>
                                            </span>
                                        </Td>
                                    </Row>
                                ))}
                            </TableBody>
                        </DataTable>
                    </div>
                )}

                {(a.players?.length || b.players?.length) && (
                    <Inset className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                        {[a, b].map((side) => (
                            <div key={side.team} className="space-y-1">
                                <Label>{side.team}</Label>
                                <div className="text-fg">
                                    {side.players && side.players.length > 0
                                        ? side.players.map((p, i) => (
                                              <React.Fragment key={p.page}>
                                                  {i > 0 && ", "}
                                                  <a
                                                      href={liquipediaUrl(p.page)}
                                                      target="_blank"
                                                      rel="noopener noreferrer"
                                                      className="hover:text-accent hover:underline"
                                                  >
                                                      {p.nick}
                                                  </a>
                                              </React.Fragment>
                                          ))
                                        : "—"}
                                </div>
                            </div>
                        ))}
                    </Inset>
                )}

                <LiquipediaCredit what="Schedule, lineups and results" />
            </div>
        </Modal>
    );
};
