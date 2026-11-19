import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { useTableSort } from "../hooks/useTableSort.ts";
import { columnOrder, rankOrder } from "../utils/tableSort.ts";
import { rosterMatches } from "../utils/search.ts";
import { DataTable, Row, SortHeader, TableBody, TableHead, Td } from "../components/DataTable.tsx";
import { EmptyState, LoadingBar, PageHeader, Section, Segmented, TextInput, Tooltip } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLink } from "../components/TeamLink.tsx";
import { eloRankingsQuery } from "../data/queries.ts";
import { TeamDuels } from "./TeamDuels.tsx";
import { TeamRounds } from "./TeamRounds.tsx";
import { TeamTactics } from "./TeamTactics.tsx";
import { TeamClutch } from "./TeamClutch.tsx";
import type { EloRankings as EloRankingsData, EloRoster } from "../elo/types.ts";
import type { Region } from "../vrs/types.ts";

const REGIONS: Array<"Global" | Region> = ["Global", "Europe", "Americas", "Asia"];
const VIEWS = ["elo", "duels", "rounds", "tactics"] as const;
type View = (typeof VIEWS)[number];
const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
    { value: "elo", label: "Elo" },
    { value: "duels", label: "Duels" },
    { value: "rounds", label: "Rounds" },
    { value: "tactics", label: "Tactics" },
];
const SORT_KEYS = ["rank", "team", "players", "rating", "vrsRank", "gap", "vrsPoints"] as const;
type SortKey = (typeof SORT_KEYS)[number];
const COLUMN_COUNT = 7;

/** Positive when Elo ranks the roster higher than VRS does. */
const rankGap = (r: EloRoster): number | null => (r.vrs ? r.vrs.rank - r.rank : null);

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

const EloTable = ({ data, region, query }: { data: EloRankingsData; region: "Global" | Region; query: string }) => {
    const { sort, onSort } = useTableSort<SortKey>(SORT_KEYS);

    const regionRosters = useMemo(
        () => data.rosters.filter((r) => region === "Global" || r.region === region),
        [data, region]
    );

    const rosters = useMemo(() => {
        const list = regionRosters.filter((r) => rosterMatches(r.team, r.players.map((p) => p.nick), query));
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

    return (
        <Section
            title={`${region} / map-level Elo vs. VRS`}
            subtitle="Rosters with 15+ rated maps and a series in the last 90 days. Δ is VRS rank minus Elo rank."
            actions={
                <span className="text-xs font-mono text-muted">
                    {query.trim() ? `${rosters.length} of ${regionRosters.length} rosters` : `${rosters.length} rosters`}
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
                                <EmptyState>{query.trim() ? `No rosters match “${query.trim()}”` : "No rosters found"}</EmptyState>
                            </td>
                        </tr>
                    ) : (
                        rosters.map((r) => {
                            const players = r.players.map((p) => p.nick).join(", ");
                            return (
                                <Row key={r.rank}>
                                    <Td align="right" className="text-muted">
                                        {r.rank}
                                    </Td>
                                    <Td className="font-sans">
                                        <TeamLink team={r.team} />
                                        {r.departed.length > 0 && (
                                            <Tooltip content={`Left the squad: ${r.departed.join(", ")}`}>
                                                <span className="ml-1.5 text-[10px] font-mono text-heat">roster change</span>
                                            </Tooltip>
                                        )}
                                        <span className="md:hidden block pl-7 text-[10px] font-mono text-muted">{players}</span>
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
                            );
                        })
                    )}
                </TableBody>
            </DataTable>
            <LiquipediaCredit what="Match, roster, map and team logo data" />
        </Section>
    );
};

export const Rankings = () => {
    const [queryParams, setQueryParams] = useQueryParams();
    const requestedRegion = (queryParams.get("region") as "Global" | Region) || "Global";
    const region = REGIONS.includes(requestedRegion) ? requestedRegion : "Global";
    const requestedView = queryParams.get("view") as View | null;
    const view: View = requestedView && VIEWS.includes(requestedView) ? requestedView : "elo";

    const [query, setQuery] = useState(queryParams.get("q") ?? "");
    const urlQuery = queryParams.get("q") ?? "";
    useEffect(() => {
        setQuery(urlQuery);
    }, [urlQuery]);

    const handleQueryChange = (q: string) => {
        setQuery(q);
        setQueryParams({ q: q || null });
    };

    const { data, isLoading, error } = useQuery(eloRankingsQuery);

    if (isLoading) return <LoadingBar label="Loading rankings…" />;
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
                title="CS2 Team Rankings"
                subtitle={
                    <>
                        Elo through {data.asOf} / VRS snapshot {data.vrsSnapshot} /{" "}
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
                            placeholder={view === "elo" ? "Team or player" : "Team or IGL"}
                            aria-label={view === "elo" ? "Filter rosters by team or player" : "Filter teams by name or IGL"}
                            className="w-44"
                        />
                        <Segmented
                            aria-label="Stat type"
                            options={VIEW_OPTIONS}
                            value={view}
                            onChange={(v) => setQueryParams({ view: v === "elo" ? null : v, sort: null, rev: null })}
                        />
                        {view === "elo" && (
                            <Segmented
                                aria-label="Region"
                                options={REGIONS}
                                value={region}
                                onChange={(r) => setQueryParams({ region: r === "Global" ? null : r })}
                            />
                        )}
                    </div>
                }
            />

            {view === "elo" && <EloTable data={data} region={region} query={query} />}
            {view === "duels" && <TeamDuels query={query} />}
            {view === "rounds" && <TeamRounds query={query} />}
            {view === "tactics" && <TeamTactics query={query} />}
            {view === "tactics" && <TeamClutch query={query} />}
        </div>
    );
};
