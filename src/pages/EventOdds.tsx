import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { useTableSort } from "../hooks/useTableSort.ts";
import { columnOrder } from "../utils/tableSort.ts";
import { DataTable, Row, SortHeader, TableBody, TableHead, Td } from "../components/DataTable.tsx";
import { DataRow, EmptyState, Inset, Label, LoadingBar, PageHeader, Section, Segmented } from "../components/ui.tsx";
import { Bracket } from "../components/Bracket.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { percent } from "../utils/format.ts";
import { fetchSimJson } from "../sim/fetch.ts";
import type { EventIndexEntry, EventOdds as EventOddsData, EventOddsTeam, StageBracket } from "../sim/types.ts";


/** Probability of finishing at or above `label` in the event's best-first placement list. */
const atLeast = (team: EventOddsTeam, labels: string[], label: string) =>
    labels.slice(0, labels.indexOf(label) + 1).reduce((sum, l) => sum + (team.placements[l] ?? 0), 0);

const Pct = ({ p, strong = false }: { p: number; strong?: boolean }) => (
    <span className={p === 0 ? "text-muted/50" : strong ? "text-fg" : "text-muted"}>{percent(p)}</span>
);

const Placements = ({ team, data }: { team: EventOddsTeam; data: EventOddsData }) => (
    <Inset className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4 text-xs font-mono">
        <dl className="space-y-0.5">
            <Label>Placement</Label>
            {data.placements.map((l) => (
                <DataRow key={l} label={l}>
                    <Pct p={team.placements[l] ?? 0} strong />
                    {data.prizes && <span className="text-muted"> / ${(data.prizes[l] ?? 0).toLocaleString("en-US")}</span>}
                </DataRow>
            ))}
        </dl>
        <div className="space-y-1">
            <Label>Team</Label>
            <div className="flex items-center gap-1.5 pt-0.5">
                <TeamLogo team={team.team} size={18} />
                <a href={liquipediaUrl(team.team)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    {team.team} on Liquipedia
                </a>
            </div>
            <DataRow label="Elo">{team.rating === null ? "Unrated (tier 2 mean)" : Math.round(team.rating)}</DataRow>
        </div>
    </Inset>
);

export const EventOdds = () => {
    const { slug = "" } = useParams();
    const { data, isLoading, error } = useQuery({
        queryKey: ["sim", "event", slug],
        queryFn: () => fetchSimJson<EventOddsData>(`events/${slug}.json`),
    });
    const later = useMemo(() => data?.stages ?? [], [data]);
    const sortKeys = useMemo(() => ["win", "team", "rating", "final", ...later.map((s) => s.id)], [later]);
    const { sort, onSort } = useTableSort<string>(sortKeys);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const teams = useMemo(() => {
        if (!data) return [];
        const value = (t: EventOddsTeam): number | string | null => {
            if (sort.key === "team") return t.team;
            if (sort.key === "rating") return t.rating;
            if (sort.key === "final") return atLeast(t, data.placements, "2");
            if (sort.key === "win") return t.placements["1"] ?? 0;
            return t.reach[sort.key] ?? 0;
        };
        return [...data.teams].sort((a, b) =>
            columnOrder(value(a), value(b), { ascending: sort.key === "team", reversed: sort.reversed })
        );
    }, [data, sort]);

    if (isLoading) return <LoadingBar label="Loading event odds…" />;
    if (data === null) return <EmptyState>This event hasn't been simulated yet.</EmptyState>;
    if (error || !data) {
        return <EmptyState className="text-down">Error loading event odds: {error instanceof Error ? error.message : "Unknown error"}</EmptyState>;
    }

    const toggle = (team: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(team)) next.delete(team);
            else next.add(team);
            return next;
        });
    const columns = 5 + later.length;

    return (
        <div className="space-y-10">
            <PageHeader
                eyebrow={
                    <Link to="/events" className="hover:text-fg">
                        Events
                    </Link>
                }
                title={data.name}
                subtitle={
                    <>
                        {data.startDate} to {data.endDate} / {data.n.toLocaleString("en-US")} simulations / Elo as of {data.asOf}
                        {data.playedMatches > 0 && ` / ${data.playedMatches} matches played`} /{" "}
                        <a href={liquipediaUrl(data.liquipedia)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                            Liquipedia
                        </a>
                    </>
                }
            />
            <Section
                title="Placement odds"
                subtitle="Each match is drawn from Elo series odds; played results are fixed. A team's rating drifts by one random walk per simulation until the event starts."
            >
                <DataTable>
                    <TableHead>
                        <SortHeader sortKey="team" sort={sort} onSort={onSort} ascending align="left">
                            Team
                        </SortHeader>
                        <SortHeader sortKey="rating" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                            Elo
                        </SortHeader>
                        {later.map((s) => (
                            <SortHeader key={s.id} sortKey={s.id} sort={sort} onSort={onSort}>
                                {s.name}
                            </SortHeader>
                        ))}
                        <SortHeader sortKey="final" sort={sort} onSort={onSort}>
                            Final
                        </SortHeader>
                        <SortHeader sortKey="win" sort={sort} onSort={onSort}>
                            Win
                        </SortHeader>
                    </TableHead>
                    <TableBody>
                        {teams.map((t) => {
                            const isExpanded = expanded.has(t.team);
                            return (
                                <React.Fragment key={t.team}>
                                    <Row>
                                        <Td className="font-sans">
                                            <button
                                                type="button"
                                                aria-expanded={isExpanded}
                                                onClick={() => toggle(t.team)}
                                                className="group inline-flex items-center gap-2 font-medium text-fg hover:text-accent transition-colors cursor-pointer"
                                            >
                                                <svg
                                                    viewBox="0 0 16 16"
                                                    fill="currentColor"
                                                    aria-hidden="true"
                                                    className={`w-3 h-3 text-muted group-hover:text-accent transition-transform ${isExpanded ? "rotate-90" : ""}`}
                                                >
                                                    <path d="M6 3.5 11 8l-5 4.5z" />
                                                </svg>
                                                <TeamLogo team={t.team} />
                                                {t.team}
                                            </button>
                                        </Td>
                                        <Td align="right" className="hidden sm:table-cell text-muted">
                                            {t.rating === null ? "–" : Math.round(t.rating)}
                                        </Td>
                                        {later.map((s) => (
                                            <Td key={s.id} align="right">
                                                <Pct p={t.reach[s.id] ?? 0} />
                                            </Td>
                                        ))}
                                        <Td align="right">
                                            <Pct p={atLeast(t, data.placements, "2")} />
                                        </Td>
                                        <Td align="right">
                                            <Pct p={t.placements["1"] ?? 0} strong />
                                        </Td>
                                    </Row>
                                    {isExpanded && (
                                        <tr>
                                            <td colSpan={columns} className="px-3 pt-1 pb-3">
                                                <Placements team={t} data={data} />
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </TableBody>
                </DataTable>
                <LiquipediaCredit what="Brackets, results, prize and team logo data" />
            </Section>
            {data.bracket && data.bracket.length > 0 && <BracketSection stages={data.bracket} />}
        </div>
    );
};

/** The first stage with an unplayed match, else the last. */
const currentStage = (stages: StageBracket[]) =>
    (stages.find((s) => s.slots.some((slot) => !slot.results)) ?? stages[stages.length - 1]).id;

const BracketSection = ({ stages }: { stages: StageBracket[] }) => {
    const [stageId, setStageId] = useState(() => currentStage(stages));
    const [selected, setSelected] = useState<string | null>(null);
    const stage = stages.find((s) => s.id === stageId) ?? stages[0];
    return (
        <Section
            title="Bracket"
            subtitle="Played results, then the likeliest teams in each match. Here is the chance a team plays that match; wins is the chance it plays and wins it. Click a team to follow it."
        >
            {stages.length > 1 && (
                <div className="overflow-x-auto">
                    <Segmented
                        aria-label="Stage"
                        options={stages.map((s) => ({ value: s.id, label: s.name }))}
                        value={stage.id}
                        onChange={setStageId}
                    />
                </div>
            )}
            <Bracket stage={stage} selected={selected} onSelect={(team) => setSelected((prev) => (prev === team ? null : team))} />
            <LiquipediaCredit what="Brackets, results and team logo data" />
        </Section>
    );
};

export const EventList = () => {
    const { data, isLoading, error } = useQuery({
        queryKey: ["sim", "events"],
        queryFn: () => fetchSimJson<EventIndexEntry[]>("events/index.json"),
    });
    if (isLoading) return <LoadingBar label="Loading events…" />;
    if (data === null || data?.length === 0) return <EmptyState>No simulated events yet.</EmptyState>;
    if (error || !data) {
        return <EmptyState className="text-down">Error loading events: {error instanceof Error ? error.message : "Unknown error"}</EmptyState>;
    }
    return (
        <div className="space-y-10">
            <PageHeader
                title="Event odds"
                subtitle={
                    <>
                        Simulated brackets for announced events /{" "}
                        <Link to="/major-invites" className="text-accent hover:underline">
                            Major invite odds
                        </Link>
                    </>
                }
            />
            <Section>
                <ul className="divide-y divide-line">
                    {data.map((e) => (
                        <li key={e.slug} className="py-2 flex items-baseline justify-between gap-3">
                            <Link to={`/events/${e.slug}`} className="font-medium text-fg hover:text-accent">
                                {e.name}
                            </Link>
                            <span className="text-xs font-mono text-muted">
                                {e.startDate} to {e.endDate}
                            </span>
                        </li>
                    ))}
                </ul>
                <LiquipediaCredit what="Brackets, results and prize data" />
            </Section>
        </div>
    );
};
