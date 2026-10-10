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
    Td,
    SortHeader,
    FactorBar,
} from "../components/DataTable.tsx";
import {
    DataRow,
    EmptyState,
    Inset,
    Label,
    LoadingBar,
    PageHeader,
    Section,
    Segmented,
} from "../components/ui.tsx";
import type { Region, Roster, RosterFactors, Standings as StandingsData } from "../vrs/types.ts";

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

const FACTOR_LABELS: Record<keyof RosterFactors, string> = {
    bountyOffered: "Bounty Offered",
    bountyCollected: "Bounty Collected",
    opponentNetwork: "Opponent Network",
    lanFactor: "LAN Wins",
};

const COLUMN_COUNT = 8;

const signed = (value: number) => (value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1));

const fetchLatestStandings = async (): Promise<StandingsData> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/vrs/latest.json`);
    if (!res.ok) {
        throw new Error(`Failed to load standings: HTTP ${res.status}`);
    }
    return res.json();
};

const RosterDetails = ({ roster }: { roster: Roster }) => (
    <Inset className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4 text-xs font-mono">
        <div className="space-y-1">
            <Label>Roster</Label>
            <div className="font-sans text-fg whitespace-normal">{roster.players.join(", ")}</div>
            <div className="text-muted">
                {roster.region} / #{roster.regionalRank ?? "–"}
            </div>
        </div>

        <div className="space-y-1">
            <Label>Rank Calculation</Label>
            <dl className="space-y-0.5">
                <DataRow label="Starting">{roster.startingValue.toFixed(1)}</DataRow>
                <DataRow label="H2H adj.">{signed(roster.h2hAdjustment)}</DataRow>
                <div className="border-t border-line pt-0.5 font-semibold">
                    <DataRow label="Points">{roster.points.toFixed(1)}</DataRow>
                </div>
            </dl>
        </div>

        <div className="md:col-span-2 space-y-1">
            <Label>Modifier Factors</Label>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                {(Object.keys(FACTOR_LABELS) as Array<keyof RosterFactors>).map((key) => (
                    <div key={key} className="space-y-1">
                        <div className="flex justify-between gap-3">
                            <span className="text-muted">{FACTOR_LABELS[key]}</span>
                            <span className="text-fg">{roster.factors[key].toFixed(3)}</span>
                        </div>
                        <FactorBar val={roster.factors[key]} className="w-full" />
                    </div>
                ))}
            </div>
        </div>
    </Inset>
);

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
        return <LoadingBar label="Loading standings…" />;
    }

    if (error || !data) {
        return (
            <EmptyState className="text-down">
                Error loading standings: {error instanceof Error ? error.message : "Unknown error"}
            </EmptyState>
        );
    }

    const isGlobal = selectedRegion === "Global";

    return (
        <div className="space-y-10">
            <PageHeader
                title="CS2 Regional Standings"
                subtitle={
                    <>
                        Snapshot {data.snapshotDate} /{" "}
                        {data.source === "valve-published" ? "Valve Published Standings" : "Model Simulation"}{" "}
                        / model{" "}
                        <a
                            href={`https://github.com/ValveSoftware/counter-strike_regional_standings/commit/${data.modelCommit}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-accent hover:underline"
                        >
                            {data.modelCommit.slice(0, 7)}
                        </a>
                    </>
                }
                actions={
                    <Segmented
                        aria-label="Region"
                        options={REGIONS}
                        value={selectedRegion}
                        onChange={handleSelectRegion}
                    />
                }
            />

            <Section
                title={`${isGlobal ? "Global" : selectedRegion} / ${data.snapshotDate}`}
                actions={
                    <span className="text-xs font-mono text-muted">
                        {sortedRosters.length} teams
                    </span>
                }
            >
                <DataTable>
                    <TableHead>
                        <SortHeader
                            sortKey="rank"
                            sort={sort}
                            onSort={onSort}
                            ascending
                            className="w-px"
                        >
                            #
                        </SortHeader>
                        <SortHeader sortKey="team" sort={sort} onSort={onSort} ascending align="left">
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
                        <SortHeader sortKey="points" sort={sort} onSort={onSort}>
                            Points
                        </SortHeader>
                        <SortHeader
                            sortKey="bountyOffered"
                            sort={sort}
                            onSort={onSort}
                            className="hidden lg:table-cell"
                        >
                            Bounty Off.
                        </SortHeader>
                        <SortHeader
                            sortKey="bountyCollected"
                            sort={sort}
                            onSort={onSort}
                            className="hidden lg:table-cell"
                        >
                            Bounty Col.
                        </SortHeader>
                        <SortHeader
                            sortKey="opponentNetwork"
                            sort={sort}
                            onSort={onSort}
                            className="hidden xl:table-cell"
                        >
                            Opp. Net.
                        </SortHeader>
                        <SortHeader
                            sortKey="lanFactor"
                            sort={sort}
                            onSort={onSort}
                            className="hidden xl:table-cell"
                        >
                            LAN
                        </SortHeader>
                    </TableHead>
                    <TableBody>
                        {sortedRosters.length === 0 ? (
                            <tr>
                                <td colSpan={COLUMN_COUNT}>
                                    <EmptyState>No teams found</EmptyState>
                                </td>
                            </tr>
                        ) : (
                            sortedRosters.map((roster) => {
                                const rank = isGlobal ? roster.globalRank : roster.regionalRank;
                                const isExpanded = expandedRows.has(roster.rosterKey);
                                const players = roster.players.join(", ");

                                return (
                                    <React.Fragment key={roster.rosterKey}>
                                        <Row>
                                            <Td align="right" className="text-muted">
                                                {rank ?? "–"}
                                            </Td>
                                            <Td className="font-sans">
                                                <button
                                                    type="button"
                                                    aria-expanded={isExpanded}
                                                    onClick={() => toggleRow(roster.rosterKey)}
                                                    className="group inline-flex items-center gap-1.5 font-medium text-fg hover:text-accent transition-colors cursor-pointer"
                                                >
                                                    <svg
                                                        viewBox="0 0 16 16"
                                                        fill="currentColor"
                                                        aria-hidden="true"
                                                        className={`w-3 h-3 text-muted group-hover:text-accent transition-transform ${isExpanded ? "rotate-90" : ""}`}
                                                    >
                                                        <path d="M6 3.5 11 8l-5 4.5z" />
                                                    </svg>
                                                    {roster.teamName}
                                                </button>
                                                <span className="md:hidden block pl-[18px] text-[10px] font-mono text-muted">
                                                    {players}
                                                </span>
                                            </Td>
                                            <Td className="hidden md:table-cell font-sans text-muted">
                                                {players}
                                            </Td>
                                            <Td align="right" className="text-fg">
                                                {Math.round(roster.points)}
                                            </Td>
                                            <Td align="right" className="hidden lg:table-cell text-muted">
                                                {roster.factors.bountyOffered.toFixed(3)}
                                            </Td>
                                            <Td align="right" className="hidden lg:table-cell text-muted">
                                                {roster.factors.bountyCollected.toFixed(3)}
                                            </Td>
                                            <Td align="right" className="hidden xl:table-cell text-muted">
                                                {roster.factors.opponentNetwork.toFixed(3)}
                                            </Td>
                                            <Td align="right" className="hidden xl:table-cell text-muted">
                                                {roster.factors.lanFactor.toFixed(3)}
                                            </Td>
                                        </Row>
                                        {isExpanded && (
                                            <tr>
                                                <td colSpan={COLUMN_COUNT} className="px-3 pt-1 pb-3">
                                                    <RosterDetails roster={roster} />
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })
                        )}
                    </TableBody>
                </DataTable>
            </Section>
        </div>
    );
};
