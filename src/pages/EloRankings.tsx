import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { useTableSort } from "../hooks/useTableSort.ts";
import { columnOrder, rankOrder } from "../utils/tableSort.ts";
import { rosterMatches } from "../utils/search.ts";
import { DataTable, Row, SortHeader, TableBody, TableHead, Td } from "../components/DataTable.tsx";
import { DataRow, EmptyState, Inset, Label, LoadingBar, PageHeader, Section, Segmented, TextInput, Tooltip } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import type { EloRankings as EloRankingsData, EloRoster } from "../elo/types.ts";
import type { Region } from "../vrs/types.ts";

const REGIONS: Array<"Global" | Region> = ["Global", "Europe", "Americas", "Asia"];
const SORT_KEYS = ["rank", "team", "players", "rating", "vrsRank", "gap", "vrsPoints"] as const;
type SortKey = (typeof SORT_KEYS)[number];
const COLUMN_COUNT = 7;

const fetchEloRankings = async (): Promise<EloRankingsData> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/elo/latest.json`);
    if (!res.ok) throw new Error(`Failed to load Elo rankings: HTTP ${res.status}`);
    return res.json();
};

/** Positive when Elo ranks the roster higher than VRS does. */
const rankGap = (r: EloRoster): number | null => (r.vrs ? r.vrs.rank - r.rank : null);

const signed = (n: number, digits = 0) => (n > 0 ? `+${n.toFixed(digits)}` : n.toFixed(digits));

const Gap = ({ roster }: { roster: EloRoster }) => {
    const gap = rankGap(roster);
    if (gap === null) return <span className="text-muted">–</span>;
    if (gap === 0) return <span className="text-muted">0</span>;
    return (
        <Tooltip content={gap > 0 ? `Elo ranks ${gap} places higher than VRS` : `Elo ranks ${-gap} places lower than VRS`}>
            <span className={gap > 0 ? "text-up" : "text-down"}>
                {gap > 0 ? "▲" : "▼"} {Math.abs(gap)}
            </span>
        </Tooltip>
    );
};

const RosterDetails = ({ roster }: { roster: EloRoster }) => {
    const offsets = Object.entries(roster.mapOffsets).sort((a, b) => b[1] - a[1]);
    return (
        <Inset className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4 text-xs font-mono">
            <div className="space-y-1">
                <Label>Roster</Label>
                <div className="font-sans text-fg whitespace-normal">
                    {roster.players.map((p, i) => (
                        <React.Fragment key={p.page}>
                            {i > 0 && ", "}
                            <a href={liquipediaUrl(p.page)} target="_blank" rel="noopener noreferrer" className="hover:text-accent hover:underline">
                                {p.nick}
                            </a>
                        </React.Fragment>
                    ))}
                </div>
                <div className="flex items-center gap-1.5 pt-0.5">
                    <TeamLogo team={roster.team} size={18} />
                    <a href={liquipediaUrl(roster.team)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                        {roster.team} on Liquipedia
                    </a>
                </div>
            </div>
            <dl className="space-y-0.5">
                <Label>Activity</Label>
                <DataRow label="Maps rated">{roster.maps}</DataRow>
                <DataRow label="Last series">{roster.lastMatch}</DataRow>
                <DataRow label="Region">{roster.region ?? "–"}</DataRow>
                <DataRow label="VRS roster">{roster.vrs ? `${roster.vrs.teamName} (${Math.round(roster.vrs.points)})` : "Unranked"}</DataRow>
                {roster.departed.length > 0 && <DataRow label="Left squad">{roster.departed.join(", ")}</DataRow>}
            </dl>
            <dl className="space-y-0.5">
                <Label>Map offsets</Label>
                {offsets.map(([map, offset]) => (
                    <DataRow key={map} label={map}>
                        <span className={offset > 0 ? "text-up" : offset < 0 ? "text-down" : "text-muted"}>{signed(offset)}</span>
                    </DataRow>
                ))}
            </dl>
        </Inset>
    );
};

export const EloRankings = () => {
    const [queryParams, setQueryParams] = useQueryParams();
    const requested = (queryParams.get("region") as "Global" | Region) || "Global";
    const region = REGIONS.includes(requested) ? requested : "Global";
    const { sort, onSort } = useTableSort<SortKey>(SORT_KEYS);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const [query, setQuery] = useState(queryParams.get("q") ?? "");
    const urlQuery = queryParams.get("q") ?? "";
    useEffect(() => {
        setQuery(urlQuery);
    }, [urlQuery]);

    const handleQueryChange = (q: string) => {
        setQuery(q);
        setQueryParams({ q: q || null });
    };

    const { data, isLoading, error } = useQuery({ queryKey: ["elo", "latest"], queryFn: fetchEloRankings });

    const regionRosters = useMemo(() => {
        return (data?.rosters ?? []).filter((r) => region === "Global" || r.region === region);
    }, [data, region]);

    const rosters = useMemo(() => {
        const list = regionRosters.filter((r) =>
            rosterMatches(r.team, r.players.map((p) => p.nick), query)
        );
        const opts = (ascending: boolean) => ({ ascending, reversed: sort.reversed });
        return [...list].sort((a, b) => {
            switch (sort.key) {
                case "team":
                    return columnOrder(a.team, b.team, opts(true));
                case "players":
                    return columnOrder(a.players.map((p) => p.nick).join(", "), b.players.map((p) => p.nick).join(", "), opts(true));
                case "rating":
                    return columnOrder(a.rating, b.rating, opts(false));
                case "vrsRank":
                    return rankOrder(a.vrs?.rank, b.vrs?.rank, sort.reversed);
                case "gap": {
                    const ga = rankGap(a);
                    const gb = rankGap(b);
                    return columnOrder(ga === null ? null : Math.abs(ga), gb === null ? null : Math.abs(gb), opts(false));
                }
                case "vrsPoints":
                    return columnOrder(a.vrs?.points, b.vrs?.points, opts(false));
                default:
                    return rankOrder(a.rank, b.rank, sort.reversed);
            }
        });
    }, [regionRosters, query, sort]);

    const toggle = (key: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    if (isLoading) return <LoadingBar label="Loading Elo rankings…" />;
    if (error || !data) {
        return (
            <EmptyState className="text-down">
                Error loading Elo rankings: {error instanceof Error ? error.message : "Unknown error"}
            </EmptyState>
        );
    }

    return (
        <div className="space-y-10">
            <PageHeader
                title="CS2 Team Elo"
                subtitle={
                    <>
                        Through {data.asOf} / VRS snapshot {data.vrsSnapshot} /{" "}
                        <Link to="/methodology" className="text-accent hover:underline">
                            methodology
                        </Link>
                    </>
                }
                actions={
                    <div className="flex flex-wrap gap-2">
                        <TextInput
                            value={query}
                            onChange={(e) => handleQueryChange(e.target.value)}
                            placeholder="Team or player"
                            aria-label="Filter rosters by team or player"
                            className="w-44"
                        />
                        <Segmented
                            aria-label="Region"
                            options={REGIONS}
                            value={region}
                            onChange={(r) => setQueryParams({ region: r === "Global" ? null : r })}
                        />
                    </div>
                }
            />

            <Section
                title={`${region} / map-level Elo vs. VRS`}
                subtitle="Rosters with 15+ rated maps and a series in the last 90 days. Δ is VRS rank minus Elo rank."
                actions={
                    <span className="text-xs font-mono text-muted">
                        {query.trim()
                            ? `${rosters.length} of ${regionRosters.length} rosters`
                            : `${rosters.length} rosters`}
                    </span>
                }
            >
                <DataTable>
                    <TableHead>
                        <SortHeader sortKey="rank" sort={sort} onSort={onSort} ascending className="w-px">
                            #
                        </SortHeader>
                        <SortHeader sortKey="team" sort={sort} onSort={onSort} ascending align="left">
                            Team
                        </SortHeader>
                        <SortHeader sortKey="players" sort={sort} onSort={onSort} ascending align="left" className="hidden md:table-cell">
                            Players
                        </SortHeader>
                        <SortHeader sortKey="rating" sort={sort} onSort={onSort}>
                            Elo
                        </SortHeader>
                        <SortHeader sortKey="vrsRank" sort={sort} onSort={onSort} ascending>
                            VRS #
                        </SortHeader>
                        <SortHeader sortKey="gap" sort={sort} onSort={onSort}>
                            Δ
                        </SortHeader>
                        <SortHeader sortKey="vrsPoints" sort={sort} onSort={onSort} className="hidden lg:table-cell">
                            VRS pts
                        </SortHeader>
                    </TableHead>
                    <TableBody>
                        {rosters.length === 0 ? (
                            <tr>
                                <td colSpan={COLUMN_COUNT}>
                                    <EmptyState>
                                        {query.trim() ? `No rosters match “${query.trim()}”` : "No rosters found"}
                                    </EmptyState>
                                </td>
                            </tr>
                        ) : (
                            rosters.map((r) => {
                                const key = `${r.rank}`;
                                const isExpanded = expanded.has(key);
                                const players = r.players.map((p) => p.nick).join(", ");
                                return (
                                    <React.Fragment key={key}>
                                        <Row>
                                            <Td align="right" className="text-muted">
                                                {r.rank}
                                            </Td>
                                            <Td className="font-sans">
                                                <button
                                                    type="button"
                                                    aria-expanded={isExpanded}
                                                    onClick={() => toggle(key)}
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
                                                    <TeamLogo team={r.team} />
                                                    {r.team}
                                                </button>
                                                {r.departed.length > 0 && (
                                                    <Tooltip content={`Left the squad: ${r.departed.join(", ")}`}>
                                                        <span className="ml-1.5 text-[10px] font-mono text-heat">
                                                            roster change
                                                        </span>
                                                    </Tooltip>
                                                )}
                                                <span className="md:hidden block pl-[44px] text-[10px] font-mono text-muted">{players}</span>
                                            </Td>
                                            <Td className="hidden md:table-cell font-sans text-muted">{players}</Td>
                                            <Td align="right" className="text-fg">
                                                {Math.round(r.rating)}
                                            </Td>
                                            <Td align="right" className="text-muted">
                                                {r.vrs?.rank ?? "–"}
                                            </Td>
                                            <Td align="right">
                                                <Gap roster={r} />
                                            </Td>
                                            <Td align="right" className="hidden lg:table-cell text-muted">
                                                {r.vrs ? Math.round(r.vrs.points) : "–"}
                                            </Td>
                                        </Row>
                                        {isExpanded && (
                                            <tr>
                                                <td colSpan={COLUMN_COUNT} className="px-3 pt-1 pb-3">
                                                    <RosterDetails roster={r} />
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })
                        )}
                    </TableBody>
                </DataTable>
                <LiquipediaCredit what="Match, roster, map and team logo data" />
            </Section>
        </div>
    );
};
