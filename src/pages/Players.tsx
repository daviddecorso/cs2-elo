import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { useTableSort } from "../hooks/useTableSort.ts";
import { columnOrder, rankOrder } from "../utils/tableSort.ts";
import { textMatches } from "../utils/search.ts";
import { DataTable, Row, SortHeader, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { Badge, EmptyState, Inset, LoadingBar, PageHeader, Section, Segmented, TextInput } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { TeamLink } from "../components/TeamLink.tsx";
import { HltvGapValue, PlayerLink, RateValue, WaaValue } from "../components/WarValues.tsx";
import {
    CONVERSION_LABEL,
    CREDIT_OPTIONS,
    CREDIT_VERSIONS,
    DEFAULT_CREDIT,
    USAGE_LABEL,
    rankPlayers,
    signed,
    type RankedPlayer,
} from "../war/players.ts";
import { teamPath } from "../utils/teams.ts";
import { playerWarQuery } from "../data/queries.ts";
import { PlayerClutch } from "./PlayerClutch.tsx";
import type { CreditVersion, PlayerWarData, WarPlayer } from "../war/types.ts";

const VIEWS = ["war", "clutch", "validation"] as const;
type View = (typeof VIEWS)[number];
const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
    { value: "war", label: "WAR" },
    { value: "clutch", label: "Clutch" },
    { value: "validation", label: "Validation" },
];

const ROLE_FILTERS = ["all", "awp", "entry", "rifle"] as const;
type RoleFilter = (typeof ROLE_FILTERS)[number];

const ROLE_OPTIONS: Array<{ value: RoleFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "awp", label: "AWP" },
    { value: "entry", label: "Entry" },
    { value: "rifle", label: "Rifle" },
];

const SORT_KEYS = [
    "rank",
    "player",
    "team",
    "role",
    "rounds",
    "waa",
    "per100",
    "usage",
    "conversion",
    "killsAbove",
    "rating3",
    "hltvGap",
] as const;
type SortKey = (typeof SORT_KEYS)[number];
const COLUMN_COUNT = 12;

const matchesRole = (p: WarPlayer, role: RoleFilter): boolean => {
    switch (role) {
        case "awp":
            return p.tRole === "AWPer" || p.ctRole === "AWPer";
        case "entry":
            return p.tRole === "Entry";
        case "rifle":
            return p.tRole === "Rifler";
        default:
            return true;
    }
};

const matchesQuery = (p: WarPlayer, q: string): boolean => {
    const trimmed = q.trim();
    if (!trimmed) return true;
    return (
        textMatches(p.name, trimmed) ||
        (p.lpPlayer !== null && textMatches(p.lpPlayer, trimmed)) ||
        (p.lpTeam !== null && textMatches(p.lpTeam, trimmed))
    );
};

const sortRankedRows = (list: RankedPlayer[], sort: { key: SortKey; reversed: boolean }, credit: CreditVersion): RankedPlayer[] => {
    const opts = (ascending: boolean) => ({ ascending, reversed: sort.reversed });
    return [...list].sort((a, b) => {
        switch (sort.key) {
            case "player":
                return columnOrder(a.player.name, b.player.name, opts(true));
            case "team":
                return columnOrder(a.player.lpTeam, b.player.lpTeam, opts(true));
            case "role":
                return columnOrder(`${a.player.tRole} ${a.player.ctRole}`, `${b.player.tRole} ${b.player.ctRole}`, opts(true));
            case "rounds":
                return columnOrder(a.player.rounds, b.player.rounds, opts(false));
            case "waa":
                return columnOrder(a.player.metrics[credit].waa, b.player.metrics[credit].waa, opts(false));
            case "per100":
                return columnOrder(a.player.metrics[credit].per100, b.player.metrics[credit].per100, opts(false));
            case "usage":
            case "conversion":
                return columnOrder(
                    a.player.metrics[credit][sort.key]?.per100 ?? null,
                    b.player.metrics[credit][sort.key]?.per100 ?? null,
                    opts(false)
                );
            case "killsAbove":
                return columnOrder(a.player.killsAbove, b.player.killsAbove, opts(false));
            case "rating3":
                return columnOrder(a.player.rating3, b.player.rating3, opts(false));
            case "hltvGap":
                return columnOrder(a.player.metrics[credit].hltvGap?.z ?? null, b.player.metrics[credit].hltvGap?.z ?? null, opts(false));
            default:
                return rankOrder(a.rank, b.rank, sort.reversed);
        }
    });
};

const LeaderboardTable = ({
    rows,
    emptyMessage,
    sort,
    onSort,
    credit,
    metric,
    intervalBound,
}: {
    rows: RankedPlayer[];
    emptyMessage: string;
    sort: { key: SortKey; reversed: boolean };
    onSort: (key: SortKey) => void;
    credit: CreditVersion;
    metric: "WAA" | "WAR";
    intervalBound: number;
}) => (
    <DataTable stickyHeader>
        <TableHead>
            <SortHeader sortKey="rank" sort={sort} onSort={onSort} ascending className="w-px">
                #
            </SortHeader>
            <SortHeader sortKey="player" sort={sort} onSort={onSort} ascending align="left">
                Player
            </SortHeader>
            <SortHeader sortKey="team" sort={sort} onSort={onSort} ascending align="left" className="hidden md:table-cell">
                Team
            </SortHeader>
            <SortHeader sortKey="role" sort={sort} onSort={onSort} ascending align="left" className="hidden sm:table-cell">
                Role
            </SortHeader>
            <SortHeader sortKey="rounds" sort={sort} onSort={onSort}>
                Rds
            </SortHeader>
            <SortHeader sortKey="waa" sort={sort} onSort={onSort}>
                {metric} (90% CI)
            </SortHeader>
            <SortHeader sortKey="per100" sort={sort} onSort={onSort} className="hidden lg:table-cell">
                / 100 rds
            </SortHeader>
            <SortHeader sortKey="usage" sort={sort} onSort={onSort} className="hidden lg:table-cell">
                Usage
            </SortHeader>
            <SortHeader sortKey="conversion" sort={sort} onSort={onSort} className="hidden lg:table-cell">
                Conversion
            </SortHeader>
            <SortHeader sortKey="killsAbove" sort={sort} onSort={onSort} className="hidden xl:table-cell">
                Kills +/−
            </SortHeader>
            <SortHeader sortKey="rating3" sort={sort} onSort={onSort} className="hidden xl:table-cell">
                HLTV 3.0
            </SortHeader>
            <SortHeader sortKey="hltvGap" sort={sort} onSort={onSort} className="hidden xl:table-cell">
                vs HLTV
            </SortHeader>
        </TableHead>
        <TableBody>
            {rows.length === 0 ? (
                <tr>
                    <td colSpan={COLUMN_COUNT}>
                        <EmptyState>{emptyMessage}</EmptyState>
                    </td>
                </tr>
            ) : (
                rows.map(({ player: p, rank }) => {
                    const est = p.metrics[credit];
                    return (
                        <Row key={p.steamid}>
                            <Td align="right" className="text-muted">
                                {rank}
                            </Td>
                            <Td className="font-sans">
                                <div className="inline-flex items-center gap-1.5">
                                    <span className="md:hidden">{p.lpTeam && <TeamLogo team={p.lpTeam} size={16} />}</span>
                                    <PlayerLink name={p.name} />
                                    {p.isIgl && <Badge tone="accent">IGL</Badge>}
                                </div>
                                {p.lpTeam && (
                                    <Link to={teamPath(p.lpTeam)} className="md:hidden block text-[10px] font-mono text-muted hover:text-accent">
                                        {p.lpTeam}
                                    </Link>
                                )}
                            </Td>
                            <Td className="hidden md:table-cell font-sans text-muted">{p.lpTeam ? <TeamLink team={p.lpTeam} /> : "–"}</Td>
                            <Td className="hidden sm:table-cell text-muted">
                                {p.tRole} / {p.ctRole}
                            </Td>
                            <Td align="right" className="text-muted tabular-nums">
                                {p.rounds.toLocaleString("en-US")}
                            </Td>
                            <Td align="right">
                                <WaaValue est={est} bound={intervalBound} metric={metric} />
                            </Td>
                            <Td align="right" className="hidden lg:table-cell">
                                <RateValue est={est} />
                            </Td>
                            <Td align="right" className="hidden lg:table-cell">
                                <RateValue est={est.usage} label={USAGE_LABEL} />
                            </Td>
                            <Td align="right" className="hidden lg:table-cell">
                                <RateValue est={est.conversion} label={CONVERSION_LABEL} />
                            </Td>
                            <Td align="right" className="hidden xl:table-cell text-muted tabular-nums">
                                {signed(p.killsAbove, 1)}
                            </Td>
                            <Td align="right" className="hidden xl:table-cell text-muted tabular-nums">
                                {p.rating3 !== null ? p.rating3.toFixed(2) : "–"}
                            </Td>
                            <Td align="right" className="hidden xl:table-cell">
                                <HltvGapValue gap={est.hltvGap} />
                            </Td>
                        </Row>
                    );
                })
            )}
        </TableBody>
    </DataTable>
);

const WarTables = ({ data, credit, role, query }: { data: PlayerWarData; credit: CreditVersion; role: RoleFilter; query: string }) => {
    const { sort, onSort } = useTableSort<SortKey>(SORT_KEYS);
    const ranked = useMemo(() => rankPlayers(data.players, credit), [data, credit]);
    const roleFiltered = useMemo(() => ranked.nonIgls.filter(({ player }) => matchesRole(player, role)), [ranked, role]);
    const rows = useMemo(
        () => sortRankedRows(roleFiltered.filter(({ player }) => matchesQuery(player, query)), sort, credit),
        [roleFiltered, query, sort, credit]
    );
    const iglRows = useMemo(
        () => sortRankedRows(ranked.igls.filter(({ player }) => matchesQuery(player, query)), sort, credit),
        [ranked, query, sort, credit]
    );
    const intervalBound = useMemo(() => {
        let maxAbs = 1;
        for (const p of data.players) {
            const m = p.metrics[credit];
            maxAbs = Math.max(maxAbs, Math.abs(m.waaP5), Math.abs(m.waaP95));
        }
        return maxAbs;
    }, [data, credit]);

    const metric = data.metric;
    const adj = data.iglAdjustmentPer100[credit];
    const table = { sort, onSort, credit, metric, intervalBound };

    return (
        <>
            {data.provisional && (
                <Inset className="text-xs space-y-1.5">
                    <p>
                        <strong className="font-mono uppercase text-heat mr-1.5">Provisional:</strong>
                        Round win-probability credits currently come from the 2026 dry-run split ({data.model ?? "unverified"}) while the
                        2025 tier-1 LAN demo backfill completes for the Phase 5 gate.
                    </p>
                    <p className="text-muted">
                        Values report <strong>Wins Above Average (WAA)</strong> against Tier-1 LAN role baselines plus a zero-sum IGL
                        positional adjustment (CT {signed(adj.ct)} / T {signed(adj.t)} round-wins per 100 rounds). Replacement level will
                        be anchored once Tier-2 demos enter the archive.
                    </p>
                </Inset>
            )}

            <Section
                title="Players / map wins above role average (90% round-bootstrap intervals)"
                subtitle="Each map assigns T roles (AWPer, Entry, Rifler) and CT callout positions and subtracts empirically shrunk role baselines. Per 100 rounds, the rate splits into team context + usage (what the player's own equipment, utility and drops are worth) + conversion (what they made of them), so receiving resources is never penalized."
                actions={
                    <span className="text-xs font-mono text-muted">
                        {query.trim() || role !== "all" ? `${rows.length} of ${ranked.nonIgls.length} players` : `${rows.length} players`}
                    </span>
                }
            >
                <LeaderboardTable
                    rows={rows}
                    emptyMessage={query.trim() ? `No players match “${query.trim()}”` : "No players match filter"}
                    {...table}
                />
            </Section>

            <Section
                title="IGLs / separate leaderboard"
                subtitle={`Callers on 50%+ of rounds, ranked separately while the zero-sum IGL positional adjustment (CT ${signed(adj.ct)} / T ${signed(adj.t)} round-wins per 100 rounds) is tuned.`}
                actions={
                    <span className="text-xs font-mono text-muted">
                        {query.trim() ? `${iglRows.length} of ${ranked.igls.length} IGLs` : `${iglRows.length} IGLs`}
                    </span>
                }
            >
                <LeaderboardTable rows={iglRows} emptyMessage={query.trim() ? `No IGLs match “${query.trim()}”` : "No IGLs"} {...table} />

                <div className="space-y-1">
                    <LiquipediaCredit what="Tournament, team, roster and player page data" />
                    <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
                </div>
            </Section>
        </>
    );
};

const ValidationTable = ({ data, credit }: { data: PlayerWarData; credit: CreditVersion }) => {
    const valKey = `${credit}_waa_r`;
    const m100 = data.validation.monthToMonth100[valKey];
    const m200 = data.validation.monthToMonth200[valKey];
    const splitHalf = data.validation.splitHalf[valKey];
    const kdCorr = data.validation.withKd[valKey];
    const r3Kd = data.validation.withKd.rating3;
    const r = (s?: { r: number | null }) => (s?.r !== null && s?.r !== undefined ? s.r.toFixed(3) : "–");

    return (
        <Section
            title="Validation diagnostics"
            subtitle={`Out-of-role skill stability and independence from raw kill/death ratio on qualified players, for ${
                CREDIT_OPTIONS.find((o) => o.value === credit)?.label ?? credit
            }.`}
        >
            <DataTable>
                <TableHead>
                    <Th align="left">Check</Th>
                    <Th>Selected {data.metric}</Th>
                    <Th>Reference</Th>
                </TableHead>
                <TableBody>
                    <Row>
                        <Td className="font-sans">Month-to-month Pearson r (100+ rounds / month)</Td>
                        <Td align="right">{r(m100)}</Td>
                        <Td align="right" className="text-muted">
                            {m100?.pairs ?? 0} pairs (~4.5 MR12 maps)
                        </Td>
                    </Row>
                    <Row>
                        <Td className="font-sans">Month-to-month Pearson r (200+ rounds / month)</Td>
                        <Td align="right">{r(m200)}</Td>
                        <Td align="right" className="text-muted">
                            {m200?.pairs ?? 0} pairs (~9 MR12 maps)
                        </Td>
                    </Row>
                    <Row>
                        <Td className="font-sans">Alternating-series split-half r (Spearman-Brown)</Td>
                        <Td align="right">
                            {splitHalf?.r !== null && splitHalf?.r !== undefined
                                ? `${splitHalf.r.toFixed(3)} (${(splitHalf.spearman_brown ?? 0).toFixed(3)})`
                                : "–"}
                        </Td>
                        <Td align="right" className="text-muted">
                            {splitHalf?.players ?? 0} players ({data.minRounds}+ rds)
                        </Td>
                    </Row>
                    <Row>
                        <Td className="font-sans">Correlation with K/D (lower = less box-score overlap)</Td>
                        <Td align="right">{r(kdCorr)}</Td>
                        <Td align="right" className="text-muted">
                            HLTV 3.0: {r(r3Kd)}
                        </Td>
                    </Row>
                </TableBody>
            </DataTable>
        </Section>
    );
};

export const Players = () => {
    const [queryParams, setQueryParams] = useQueryParams();
    const requestedView = queryParams.get("view") as View | null;
    const view: View = requestedView && VIEWS.includes(requestedView) ? requestedView : "war";
    const rawRole = queryParams.get("role") as RoleFilter | null;
    const role: RoleFilter = rawRole && ROLE_FILTERS.includes(rawRole) ? rawRole : "all";
    const rawCredit = queryParams.get("credit") as CreditVersion | null;
    const credit: CreditVersion = rawCredit && CREDIT_VERSIONS.includes(rawCredit) ? rawCredit : DEFAULT_CREDIT;

    const [query, setQuery] = useState(queryParams.get("q") ?? "");
    const urlQuery = queryParams.get("q") ?? "";
    useEffect(() => {
        setQuery(urlQuery);
    }, [urlQuery]);

    const handleQueryChange = (q: string) => {
        setQuery(q);
        setQueryParams({ q: q || null });
    };

    const { data, isLoading, error } = useQuery(playerWarQuery);

    if (isLoading) return <LoadingBar label="Loading players…" />;
    if (error || !data) {
        return (
            <EmptyState className="text-down">
                Error loading player WAA: {error instanceof Error ? error.message : "Unknown error"}
            </EmptyState>
        );
    }

    return (
        <div className="space-y-10">
            <PageHeader
                eyebrow={data.provisional ? "Provisional / dry-run win-probability model" : "Tier-1 LAN demos"}
                title="CS2 Player Rankings"
                subtitle={
                    <>
                        {data.metric} / {data.window.from} to {data.window.to} / {data.window.maps.toLocaleString("en-US")} maps across{" "}
                        {data.window.events} events / {data.minRounds}+ rounds / {data.roundsPerWin.toFixed(2)} round-wins per map win /{" "}
                        <Link to="/methodology#player-war" className="text-accent hover:underline">
                            methodology
                        </Link>
                    </>
                }
                actions={
                    <div className="flex flex-wrap gap-2">
                        <TextInput
                            value={query}
                            onChange={(e) => handleQueryChange(e.target.value)}
                            placeholder="Player or team"
                            aria-label="Filter players by name or team"
                            className="w-44"
                        />
                        <Segmented
                            aria-label="Stat type"
                            options={VIEW_OPTIONS}
                            value={view}
                            onChange={(v) => setQueryParams({ view: v === "war" ? null : v, sort: null, rev: null })}
                        />
                        {view === "war" && (
                            <Segmented
                                aria-label="Role filter"
                                options={ROLE_OPTIONS}
                                value={role}
                                onChange={(r) => setQueryParams({ role: r === "all" ? null : r })}
                            />
                        )}
                        {view !== "clutch" && (
                            <Segmented
                                aria-label="Credit version"
                                options={CREDIT_OPTIONS}
                                value={credit}
                                onChange={(c) => setQueryParams({ credit: c === DEFAULT_CREDIT ? null : c })}
                            />
                        )}
                    </div>
                }
            />

            {view === "war" && <WarTables data={data} credit={credit} role={role} query={query} />}
            {view === "clutch" && <PlayerClutch query={query} />}
            {view === "validation" && <ValidationTable data={data} credit={credit} />}
        </div>
    );
};
