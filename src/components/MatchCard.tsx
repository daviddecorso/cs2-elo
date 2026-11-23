import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { MatchSide, ScheduledMatch } from "../elo/types.ts";
import {
    computeExcitement,
    formatMatchTime,
    getExcitementTier,
    isUpset,
    matchAnchor,
    type ExcitementBreakdown,
} from "../utils/matches.ts";
import { teamPath } from "../utils/teams.ts";
import { EXCITEMENT_STYLES } from "./excitement.ts";
import { TeamLogo } from "./TeamLogo.tsx";
import { Badge, DataRow, Section, Tooltip } from "./ui.tsx";

const ELO_COL = "w-[48px] sm:w-[56px] pr-2";
const WIN_COL = "w-[44px] sm:w-[52px]";
const SCORE_COL = "w-[42px] pr-2 sm:w-[52px] sm:pr-2.5";

const TipText = ({ children }: { children: ReactNode }) => (
    <span className="block max-w-60 whitespace-pre-line normal-case">{children}</span>
);

const ExcitementTip = ({ breakdown }: { breakdown: ExcitementBreakdown }) => (
    <dl className="space-y-1 text-[11px] min-w-[140px]">
        <DataRow label="Quality">{Math.round(breakdown.quality * 100)}%</DataRow>
        <DataRow label="Closeness">{Math.round(breakdown.closeness * 100)}%</DataRow>
    </dl>
);

const TeamRow = ({
    side,
    winProb,
    isCompleted,
    isWinner,
    showScore,
}: {
    side: MatchSide;
    winProb: number;
    isCompleted: boolean;
    isWinner: boolean;
    showScore: boolean;
}) => {
    const mixPct = (10 + 75 * winProb).toFixed(1);
    const isLoser = isCompleted && !isWinner;
    const winPct = Math.round(winProb * 100);
    const profileTarget = side.profileTeam ?? side.team;

    return (
        <div className="h-9 flex items-stretch text-xs font-mono">
            <div className="flex-1 min-w-0 flex items-center gap-1.5 pl-2.5 pr-1">
                <TeamLogo team={side.team} size={18} />
                {side.rank !== null && (
                    <span className="text-[11px] text-muted shrink-0">#{side.rank}</span>
                )}
                {side.rated ? (
                    <Link
                        to={teamPath(profileTarget)}
                        className={`relative z-1 font-medium hover:text-accent transition-colors truncate ${
                            isLoser ? "text-muted" : "text-fg"
                        }`}
                    >
                        {side.team}
                    </Link>
                ) : (
                    <span className={`font-medium truncate ${isLoser ? "text-muted" : "text-fg"}`}>
                        {side.team}
                    </span>
                )}
            </div>
            <div
                className={`${ELO_COL} shrink-0 flex items-center justify-end tabular-nums ${
                    side.rating === null || isLoser ? "text-muted" : "text-fg"
                }`}
            >
                {side.rating !== null ? Math.round(side.rating) : "—"}
            </div>
            <div
                className={`${WIN_COL} shrink-0 flex items-center justify-center font-medium tabular-nums ${
                    winProb >= 0.65 ? "text-white" : "text-fg"
                }`}
                style={{
                    backgroundColor: `color-mix(in srgb, var(--accent) ${mixPct}%, transparent)`,
                }}
            >
                {`${winPct}%`}
            </div>
            {showScore && (
                <div className={`${SCORE_COL} shrink-0 flex items-center justify-end tabular-nums`}>
                    {side.score !== undefined && (
                        <span
                            className={`inline-flex items-center gap-1 ${
                                isWinner ? "text-fg font-semibold" : "text-muted"
                            }`}
                        >
                            {isWinner && (
                                <svg
                                    viewBox="0 0 12 12"
                                    className="w-2.5 h-2.5 text-up"
                                    aria-label="Winner"
                                    role="img"
                                >
                                    <path
                                        d="M2 6.5l2.5 2.5L10 3.5"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.75"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                            )}
                            {side.score}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};

export interface MatchCardProps {
    match: ScheduledMatch;
    topRating: number;
    showScore?: boolean;
    showDay?: boolean;
    highlighted?: boolean;
    anchor?: boolean;
    onOpen: () => void;
}

export const MatchCard = ({
    match,
    topRating,
    showScore = match.status === "completed",
    showDay = false,
    highlighted = false,
    anchor = true,
    onOpen,
}: MatchCardProps) => {
    const { score: excitement, breakdown } = computeExcitement(match, topRating);
    const roundedExcitement = Math.round(excitement);
    const { text: excitementText } = EXCITEMENT_STYLES[getExcitementTier(excitement)];
    const isCompleted = match.status === "completed";
    const upset = isUpset(match);
    const { localTime, localDate, utcTooltip } = formatMatchTime(match.t, match.dateExact);

    const statusNode: ReactNode = isCompleted ? (
        "Final"
    ) : utcTooltip ? (
        <Tooltip hoverOnly content={utcTooltip}>
            <span className="cursor-default">{localTime}</span>
        </Tooltip>
    ) : (
        localTime
    );

    const metaParts: ReactNode[] = [
        statusNode,
        ...(showDay && localDate !== "TBD" ? [localDate] : []),
        ...(match.bestOf > 0 ? [`Bo${match.bestOf}`] : []),
        match.lan ? "LAN" : "Online",
        ...(match.tier !== null ? [`T${match.tier}`] : []),
    ];

    const [a, b] = match.sides;

    return (
        <div
            id={anchor ? matchAnchor(match.id) : undefined}
            className={`flex flex-col scroll-mt-24 ${
                highlighted ? "ring-2 ring-accent ring-offset-4 ring-offset-bg rounded-sm" : ""
            }`}
        >
            <div className="flex items-end justify-between gap-2 text-[11px] font-mono uppercase text-muted mb-1 whitespace-nowrap">
                <div className="flex items-center gap-1.5 min-w-0 pl-1 truncate">
                    <Tooltip
                        content={<ExcitementTip breakdown={breakdown} />}
                        className={`font-medium ${excitementText}`}
                    >
                        {roundedExcitement}
                    </Tooltip>
                    <span className="truncate inline-flex items-center">
                        {metaParts.map((part, idx) => (
                            <span key={idx} className="inline-flex items-center">
                                {idx > 0 && <span className="mx-1 text-muted/60">/</span>}
                                {part}
                            </span>
                        ))}
                    </span>
                    {upset && <Badge tone="down">Upset</Badge>}
                </div>
            </div>

            <article className="relative bg-surface border border-line flex hover:bg-surface-2 transition-colors has-[>button:focus-visible]:outline-2 has-[>button:focus-visible]:outline-accent has-[>button:focus-visible]:outline-offset-2">
                <button
                    type="button"
                    onClick={onOpen}
                    aria-label={`View match details: ${a.team} vs ${b.team}`}
                    className="absolute inset-0 cursor-pointer focus-visible:outline-none"
                />
                <div className="flex-1 min-w-0 flex flex-col divide-y divide-line">
                    <TeamRow
                        side={a}
                        winProb={match.p}
                        isCompleted={isCompleted}
                        isWinner={isCompleted && match.winner === 0}
                        showScore={showScore}
                    />
                    <TeamRow
                        side={b}
                        winProb={1 - match.p}
                        isCompleted={isCompleted}
                        isWinner={isCompleted && match.winner === 1}
                        showScore={showScore}
                    />
                    <div className="px-2.5 py-1 text-[11px] font-mono text-muted truncate">
                        {match.eventName}
                        {match.section && <span className="text-muted/70"> · {match.section}</span>}
                    </div>
                </div>
            </article>
        </div>
    );
};

export const MatchColumnsHeader = ({ showScore = false }: { showScore?: boolean }) => (
    <div className="flex shrink-0 font-mono text-[11px] uppercase text-muted mr-px">
        <div className={`${ELO_COL} text-right`}>
            <Tooltip content={<TipText>Pre-series Elo rating (— when unrated).</TipText>}>Elo</Tooltip>
        </div>
        <div className={`${WIN_COL} text-center`}>
            <Tooltip content={<TipText>Pre-series Elo series win probability.</TipText>}>Win %</Tooltip>
        </div>
        {showScore && <div className={`${SCORE_COL} text-right`}>Score</div>}
    </div>
);

export const MatchSection = ({
    title,
    subtitle,
    showScore = false,
    actions,
    children,
}: {
    title: string;
    subtitle?: ReactNode;
    showScore?: boolean;
    actions?: ReactNode;
    children: ReactNode;
}) => (
    <Section
        title={title}
        subtitle={subtitle}
        actions={actions !== undefined ? actions : <MatchColumnsHeader showScore={showScore} />}
    >
        <div className="grid gap-x-6 gap-y-5 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </Section>
);
