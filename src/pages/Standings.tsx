import React, { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { useTableSort } from "../hooks/useTableSort.ts";
import { columnOrder, rankOrder } from "../utils/tableSort.ts";
import {
    DataTable,
    TableHead,
    TableBody,
    Row,
    Th,
    Td,
    SortHeader,
    FactorBar,
} from "../components/DataTable.tsx";
import type { Region, Roster, Standings as StandingsData } from "../vrs/types.ts";

const REGIONS: Array<"Global" | Region> = ["Global", "Europe", "Americas", "Asia"];
const SORT_KEYS = [
    "rank",
    "team",
    "players",
    "points",
    "bountyOffered",
    "bountyCollected",
    "opponentNetwork",
    "lanFactor",
] as const;

type SortKey = (typeof SORT_KEYS)[number];

const fetchLatestStandings = async (): Promise<StandingsData> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/vrs/latest.json`);
    if (!res.ok) {
        throw new Error(`Failed to load standings: HTTP ${res.status}`);
    }
    return res.json();
};

export const Standings = () => {
    const [queryParams, setQueryParams] = useQueryParams();
    const currentRegion = (queryParams.get("region") as "Global" | Region) || "Global";
    const selectedRegion = REGIONS.includes(currentRegion) ? currentRegion : "Global";

    const { data, isLoading, error } = useQuery({
        queryKey: ["standings", "latest"],
        queryFn: fetchLatestStandings,
        staleTime: 1000 * 60 * 10,
    });

    const { sort, onSort } = useTableSort<SortKey>(SORT_KEYS);
    const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

    const toggleRow = (rosterKey: string) => {
        setExpandedRows((prev) => {
            const next = new Set(prev);
            if (next.has(rosterKey)) next.delete(rosterKey);
            else next.add(rosterKey);
            return next;
        });
    };

    const filteredRosters = useMemo(() => {
        if (!data?.rosters) return [];
        if (selectedRegion === "Global") return data.rosters;
        return data.rosters.filter((r) => r.region === selectedRegion);
    }, [data, selectedRegion]);

    const sortedRosters = useMemo(() => {
        const rosters = [...filteredRosters];
        const isGlobal = selectedRegion === "Global";

        rosters.sort((a, b) => {
            const aRank = isGlobal ? a.globalRank : a.regionalRank;
            const bRank = isGlobal ? b.globalRank : b.regionalRank;

            switch (sort.key) {
                case "rank":
                    return rankOrder(aRank, bRank, sort.reversed);
                case "team":
                    return columnOrder(a.teamName, b.teamName, {
                        ascending: true,
                        reversed: sort.reversed,
                    });
                case "players":
                    return columnOrder(a.players.join(", "), b.players.join(", "), {
                        ascending: true,
                        reversed: sort.reversed,
                    });
                case "points":
                    return columnOrder(a.points, b.points, {
                        ascending: false,
                        reversed: sort.reversed,
                    });
                case "bountyOffered":
                    return columnOrder(a.factors.bountyOffered, b.factors.bountyOffered, {
                        ascending: false,
                        reversed: sort.reversed,
                    });
                case "bountyCollected":
                    return columnOrder(a.factors.bountyCollected, b.factors.bountyCollected, {
                        ascending: false,
                        reversed: sort.reversed,
                    });
                case "opponentNetwork":
                    return columnOrder(a.factors.opponentNetwork, b.factors.opponentNetwork, {
                        ascending: false,
                        reversed: sort.reversed,
                    });
                case "lanFactor":
                    return columnOrder(a.factors.lanFactor, b.factors.lanFactor, {
                        ascending: false,
                        reversed: sort.reversed,
                    });
                default:
                    return rankOrder(aRank, bRank, false);
            }
        });

        return rosters;
    }, [filteredRosters, selectedRegion, sort]);

    const handleSelectRegion = (region: "Global" | Region) => {
        setQueryParams({ region: region === "Global" ? null : region });
    };

    if (isLoading) {
        return (
            <div className="p-8 text-center text-muted font-mono text-sm">
                Loading standings data...
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="p-8 text-center text-down font-mono text-sm">
                Error loading standings: {error instanceof Error ? error.message : "Unknown error"}
            </div>
        );
    }

    const isGlobal = selectedRegion === "Global";

    return (
        <div className="min-h-screen flex flex-col bg-bg text-fg">
            <header className="border-b border-line px-4 py-4 sm:px-6">
                <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div>
                        <h1 className="text-xl font-bold tracking-tight">CS2 Regional Standings</h1>
                        <p className="text-xs text-muted font-mono mt-0.5">
                            Valve Regional Standings (VRS) &amp; Factor Breakdown
                        </p>
                    </div>

                    <nav className="flex items-center gap-1 bg-surface-2 p-1 rounded-lg border border-line">
                        {REGIONS.map((region) => {
                            const active = selectedRegion === region;
                            return (
                                <button
                                    key={region}
                                    type="button"
                                    onClick={() => handleSelectRegion(region)}
                                    className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                                        active
                                            ? "bg-surface text-fg shadow-xs font-semibold"
                                            : "text-muted hover:text-fg"
                                    }`}
                                >
                                    {region}
                                </button>
                            );
                        })}
                    </nav>
                </div>
            </header>

            <main className="flex-1 max-w-7xl mx-auto w-full p-4 sm:p-6">
                <div className="border border-line rounded-lg overflow-hidden bg-surface">
                    <DataTable>
                        <TableHead>
                            <Th align="center" className="w-10">
                                <span className="sr-only">Details</span>
                            </Th>
                            <SortHeader
                                sortKey="rank"
                                sort={sort}
                                onSort={onSort}
                                ascending
                                align="right"
                                className="w-16"
                            >
                                Rank
                            </SortHeader>
                            <SortHeader
                                sortKey="team"
                                sort={sort}
                                onSort={onSort}
                                ascending
                                align="left"
                            >
                                Team
                            </SortHeader>
                            <SortHeader
                                sortKey="players"
                                sort={sort}
                                onSort={onSort}
                                ascending
                                align="left"
                                className="hidden md:table-cell"
                            >
                                Players
                            </SortHeader>
                            <SortHeader
                                sortKey="points"
                                sort={sort}
                                onSort={onSort}
                                align="right"
                                className="w-24"
                            >
                                Points
                            </SortHeader>
                            <SortHeader
                                sortKey="bountyOffered"
                                sort={sort}
                                onSort={onSort}
                                align="right"
                                className="hidden lg:table-cell w-28"
                            >
                                Bounty Off.
                            </SortHeader>
                            <SortHeader
                                sortKey="bountyCollected"
                                sort={sort}
                                onSort={onSort}
                                align="right"
                                className="hidden lg:table-cell w-28"
                            >
                                Bounty Col.
                            </SortHeader>
                            <SortHeader
                                sortKey="opponentNetwork"
                                sort={sort}
                                onSort={onSort}
                                align="right"
                                className="hidden xl:table-cell w-28"
                            >
                                Opp. Net.
                            </SortHeader>
                            <SortHeader
                                sortKey="lanFactor"
                                sort={sort}
                                onSort={onSort}
                                align="right"
                                className="hidden xl:table-cell w-24"
                            >
                                LAN
                            </SortHeader>
                        </TableHead>
                        <TableBody>
                            {sortedRosters.map((roster: Roster) => {
                                const rank = isGlobal ? roster.globalRank : roster.regionalRank;
                                const isExpanded = expandedRows.has(roster.rosterKey);

                                return (
                                    <React.Fragment key={roster.rosterKey}>
                                        <Row>
                                            <Td align="center">
                                                <button
                                                    type="button"
                                                    aria-expanded={isExpanded}
                                                    aria-label={`Toggle details for ${roster.teamName}`}
                                                    onClick={() => toggleRow(roster.rosterKey)}
                                                    className="text-muted hover:text-fg font-mono text-xs px-1 cursor-pointer"
                                                >
                                                    {isExpanded ? "▼" : "▶"}
                                                </button>
                                            </Td>
                                            <Td align="right" className="font-semibold">
                                                {rank !== null ? rank : "-"}
                                            </Td>
                                            <Td align="left" className="font-semibold">
                                                {roster.teamName}
                                                <span className="md:hidden block text-[10px] text-muted font-normal">
                                                    {roster.players.join(", ")}
                                                </span>
                                            </Td>
                                            <Td align="left" className="hidden md:table-cell text-muted">
                                                {roster.players.join(", ")}
                                            </Td>
                                            <Td align="right" className="font-semibold text-fg">
                                                {Math.round(roster.points)}
                                            </Td>
                                            <Td align="right" className="hidden lg:table-cell">
                                                {roster.factors.bountyOffered.toFixed(3)}
                                            </Td>
                                            <Td align="right" className="hidden lg:table-cell">
                                                {roster.factors.bountyCollected.toFixed(3)}
                                            </Td>
                                            <Td align="right" className="hidden xl:table-cell">
                                                {roster.factors.opponentNetwork.toFixed(3)}
                                            </Td>
                                            <Td align="right" className="hidden xl:table-cell">
                                                {roster.factors.lanFactor.toFixed(3)}
                                            </Td>
                                        </Row>
                                        {isExpanded && (
                                            <tr className="bg-surface-2 border-b border-line text-xs">
                                                <td colSpan={9} className="p-4">
                                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                                                        <div>
                                                            <div className="text-[11px] font-mono uppercase text-muted mb-1">
                                                                Roster
                                                            </div>
                                                            <div className="font-mono text-fg">
                                                                {roster.players.join(", ")}
                                                            </div>
                                                            <div className="text-[11px] text-muted mt-1">
                                                                Region: {roster.region} (Regional #{roster.regionalRank ?? "-"})
                                                            </div>
                                                        </div>

                                                        <div>
                                                            <div className="text-[11px] font-mono uppercase text-muted mb-1">
                                                                Rank Calculation
                                                            </div>
                                                            <div className="font-mono space-y-0.5">
                                                                <div>
                                                                    Starting:{" "}
                                                                    <span className="font-semibold">
                                                                        {roster.startingValue.toFixed(1)}
                                                                    </span>
                                                                </div>
                                                                <div>
                                                                    H2H Adj:{" "}
                                                                    <span className="font-semibold">
                                                                        {roster.h2hAdjustment >= 0
                                                                            ? `+${roster.h2hAdjustment.toFixed(1)}`
                                                                            : roster.h2hAdjustment.toFixed(1)}
                                                                    </span>
                                                                </div>
                                                                <div className="border-t border-line pt-0.5 font-bold">
                                                                    Points: {roster.points.toFixed(1)}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        <div className="md:col-span-2">
                                                            <div className="text-[11px] font-mono uppercase text-muted mb-2">
                                                                Modifier Factors
                                                            </div>
                                                            <div className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[11px]">
                                                                <div>
                                                                    <div className="flex justify-between mb-0.5 text-muted">
                                                                        <span>Bounty Offered</span>
                                                                        <span>{roster.factors.bountyOffered.toFixed(3)}</span>
                                                                    </div>
                                                                    <FactorBar val={roster.factors.bountyOffered} />
                                                                </div>
                                                                <div>
                                                                    <div className="flex justify-between mb-0.5 text-muted">
                                                                        <span>Bounty Collected</span>
                                                                        <span>{roster.factors.bountyCollected.toFixed(3)}</span>
                                                                    </div>
                                                                    <FactorBar val={roster.factors.bountyCollected} />
                                                                </div>
                                                                <div>
                                                                    <div className="flex justify-between mb-0.5 text-muted">
                                                                        <span>Opponent Network</span>
                                                                        <span>{roster.factors.opponentNetwork.toFixed(3)}</span>
                                                                    </div>
                                                                    <FactorBar val={roster.factors.opponentNetwork} />
                                                                </div>
                                                                <div>
                                                                    <div className="flex justify-between mb-0.5 text-muted">
                                                                        <span>LAN Wins</span>
                                                                        <span>{roster.factors.lanFactor.toFixed(3)}</span>
                                                                    </div>
                                                                    <FactorBar val={roster.factors.lanFactor} />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </TableBody>
                    </DataTable>
                </div>
            </main>

            <footer className="border-t border-line mt-8 py-6 px-4 sm:px-6 text-xs text-muted font-mono">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                    <div className="space-y-1">
                        <div>
                            Snapshot: <span className="text-fg font-semibold">{data.snapshotDate}</span> · Source:{" "}
                            <span className="text-fg font-semibold">
                                {data.source === "valve-published"
                                    ? "Valve Published Standings"
                                    : "Model Simulation"}
                            </span>
                        </div>
                        <div>
                            Model commit:{" "}
                            <a
                                href={`https://github.com/ValveSoftware/counter-strike_regional_standings/commit/${data.modelCommit}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-accent hover:underline font-mono"
                            >
                                {data.modelCommit.slice(0, 7)}
                            </a>
                        </div>
                    </div>
                    <div className="text-left md:text-right space-y-1">
                        <div>Event data for Regional Standings provided by HLTV.org</div>
                        <div>CS2 Regional Standings model &copy; Valve Corporation</div>
                    </div>
                </div>
            </footer>
        </div>
    );
};
