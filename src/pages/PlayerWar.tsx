import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { useTableSort } from "../hooks/useTableSort.ts";
import { columnOrder, rankOrder } from "../utils/tableSort.ts";
import { textMatches } from "../utils/search.ts";
import { DataTable, Row, SortHeader, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import {
    Badge,
    DataRow,
    EmptyState,
    Inset,
    Label,
    LoadingBar,
    PageHeader,
    Section,
    Segmented,
    TextInput,
    Tooltip,
} from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import type { CreditVersion, HltvGap, PlayerWarData, WarEstimate, WarPlayer, WarRate } from "../war/types.ts";

const ROLE_FILTERS = ["all", "awp", "entry", "rifle"] as const;
type RoleFilter = (typeof ROLE_FILTERS)[number];

const ROLE_OPTIONS: Array<{ value: RoleFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "awp", label: "AWP" },
    { value: "entry", label: "Entry" },
    { value: "rifle", label: "Rifle" },
];

const DEFAULT_CREDIT: CreditVersion = "wpa_opp";
const CREDIT_VERSIONS: CreditVersion[] = ["wpa_opp", "wpa", "nwpa_mancount", "nwpa_event"];
const CREDIT_OPTIONS: Array<{ value: CreditVersion; label: string }> = [
    { value: "wpa_opp", label: "WPA (team-neutral)" },
    { value: "wpa", label: "WPA (raw)" },
    { value: "nwpa_mancount", label: "Neutral (man-count)" },
    { value: "nwpa_event", label: "Neutral (event)" },
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

const fetchPlayerWar = async (): Promise<PlayerWarData> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/war/players.json`);
    if (!res.ok) throw new Error(`Failed to load player WAR: HTTP ${res.status}`);
    return res.json();
};

const signed = (n: number, digits = 2) => (n > 0 ? `+${n.toFixed(digits)}` : n.toFixed(digits));

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

/** Symmetric clamp bound in map-win units so zero sits at 50% width across every row. */
const IntervalBar = ({ p5, point, p95, bound }: { p5: number; point: number; p95: number; bound: number }) => {
    const toPct = (v: number) => Math.min(100, Math.max(0, 50 + (v / bound) * 50));
    const left = toPct(p5);
    const right = toPct(p95);
    const dot = toPct(point);
    return (
        <span aria-hidden="true" className="relative hidden sm:inline-block w-16 h-2 align-middle ml-2">
            <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-line" />
            <span className="absolute left-1/2 top-0 bottom-0 w-px bg-muted/40" />
            <span
                className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full bg-accent/40"
                style={{ left: `${left}%`, width: `${Math.max(2, right - left)}%` }}
            />
            <span
                className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${
                    point > 0 ? "bg-up" : point < 0 ? "bg-down" : "bg-muted"
                }`}
                style={{ left: `${dot}%` }}
            />
        </span>
    );
};

const WaaValue = ({
    est,
    bound,
    metric,
}: {
    est: WarEstimate;
    bound: number;
    metric: "WAA" | "WAR";
}) => {
    const tone = est.waa > 0 ? "text-up" : est.waa < 0 ? "text-down" : "text-fg";
    return (
        <Tooltip
            content={`${metric}: ${signed(est.waa)} map wins\n90% round bootstrap: (${signed(est.waaP5)}, ${signed(est.waaP95)})`}
        >
            <span className="tabular-nums">
                <span className={`font-semibold ${tone}`}>{signed(est.waa)}</span>
                <span className="text-muted text-[10px] ml-1">{`(${signed(est.waaP5)}, ${signed(est.waaP95)})`}</span>
                <IntervalBar p5={est.waaP5} point={est.waa} p95={est.waaP95} bound={bound} />
            </span>
        </Tooltip>
    );
};

const RateValue = ({ est, label = "Round-wins above average per 100 rounds" }: { est?: WarRate; label?: string }) =>
    est ? (
        <Tooltip content={`${label}\n90% round bootstrap: (${signed(est.per100P5)}, ${signed(est.per100P95)})`}>
            <span className="tabular-nums">
                <span className="text-fg">{signed(est.per100)}</span>
                <span className="text-muted text-[10px] ml-1">{`(${signed(est.per100P5)}, ${signed(est.per100P95)})`}</span>
            </span>
        </Tooltip>
    ) : (
        <span className="text-muted">–</span>
    );

const USAGE_LABEL = "Usage: round-wins per 100 rounds expected from the player's own resources, beyond the team's economy";
const CONVERSION_LABEL = "Conversion: round-wins per 100 rounds above what the same resources earn on average";
const HLTV_GAP_LABEL = "z(WAA / 100 rds) − z(HLTV 3.0) in SD units across qualified players (HLTV fixed in CI)";

const HltvGapValue = ({ gap }: { gap?: HltvGap | null }) =>
    gap ? (
        <Tooltip
            content={`${HLTV_GAP_LABEL}\n90% round bootstrap: (${signed(gap.zP5)}, ${signed(gap.zP95)})`}
        >
            <span className={`tabular-nums ${gap.z > 0 ? "text-up" : gap.z < 0 ? "text-down" : "text-fg"}`}>
                {signed(gap.z)}
            </span>
        </Tooltip>
    ) : (
        <span className="text-muted">–</span>
    );

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);

const ResourceRows = ({ player, est }: { player: WarPlayer; est: WarEstimate }) => {
    const r = player.resources;
    if (!r || !est.usage || !est.conversion || est.context === undefined) return null;
    return (
        <>
            <div className="pt-1">
                <Label>Resources (per 100 rds)</Label>
            </div>
            <DataRow label="Context / usage / conversion">
                {signed(est.context)} / {signed(est.usage.per100)} / {signed(est.conversion.per100)}
            </DataRow>
            <DataRow label="Sum (= rate)">{signed(est.context + est.usage.per100 + est.conversion.per100)}</DataRow>
            <DataRow label="Equip share eco / force / full">
                {pct(r.equipShare.eco)} / {pct(r.equipShare.force)} / {pct(r.equipShare.full)}
            </DataRow>
            <DataRow label="AWP rounds">{pct(r.awpRate)}</DataRow>
            <DataRow label="Drops received / given">
                {r.dropsReceivedPer100?.toFixed(1) ?? "–"} / {r.dropsGivenPer100?.toFixed(1) ?? "–"}
            </DataRow>
            <DataRow label="Duels with team flash / smoke">
                {pct(r.flashSupportShare)} / {pct(r.smokeSupportShare)}
            </DataRow>
            <DataRow label="Deaths traded">{pct(r.tradedDeathRate)}</DataRow>
            {r.flashGift !== null && <DataRow label="Kills from team flashes">{signed(r.flashGift, 1)}</DataRow>}
        </>
    );
};

const PlayerDetails = ({
    player,
    metric,
    credit,
}: {
    player: WarPlayer;
    metric: "WAA" | "WAR";
    credit: CreditVersion;
}) => (
    <Inset className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4 text-xs font-mono">
        <div className="space-y-1.5">
            <Label>Identity &amp; roles</Label>
            <dl className="space-y-0.5">
                <DataRow label="T / CT role">
                    {player.tRole} / {player.ctRole}
                </DataRow>
                <DataRow label="AWP buy share">{`${Math.round(player.awpShare * 100)}%`}</DataRow>
                <DataRow label="Opening duel share">{`${Math.round(player.entryShare * 100)}%`}</DataRow>
                <DataRow label="IGL rounds">{`${Math.round(player.iglShare * 100)}%`}</DataRow>
                <DataRow label="Sample">
                    {player.maps} maps ({player.rounds.toLocaleString("en-US")} rds)
                </DataRow>
            </dl>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
                {player.lpPlayer && (
                    <a
                        href={liquipediaUrl(player.lpPlayer)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                    >
                        {player.name} on Liquipedia
                    </a>
                )}
                {player.lpTeam && (
                    <span className="inline-flex items-center gap-1.5">
                        <TeamLogo team={player.lpTeam} size={16} />
                        <a
                            href={liquipediaUrl(player.lpTeam)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent hover:underline"
                        >
                            {player.lpTeam} on Liquipedia
                        </a>
                    </span>
                )}
            </div>
        </div>

        <dl className="space-y-0.5">
            <Label>{metric} by credit version (90% CI)</Label>
            {CREDIT_OPTIONS.map(({ value, label }) => {
                const m = player.metrics[value];
                return (
                    <DataRow key={value} label={label}>
                        {signed(m.waa)} ({signed(m.waaP5)}, {signed(m.waaP95)})
                    </DataRow>
                );
            })}
            <div className="pt-1">
                <Label>CT positions by map</Label>
            </div>
            {player.ctByMap.map((m) => (
                <DataRow key={m.map} label={`${m.map} (${m.maps}m)`}>
                    {m.role}
                </DataRow>
            ))}
        </dl>

        <dl className="space-y-0.5">
            <Label>Duels &amp; box-score</Label>
            <DataRow label="Kills above expected">
                {signed(player.killsAbove, 1)} ({signed(player.killsAbovePer100)} / 100 rds)
            </DataRow>
            <DataRow label="Gun duels">{player.duels.toLocaleString("en-US")}</DataRow>
            <DataRow label="HLTV Rating 3.0">{player.rating3 !== null ? player.rating3.toFixed(2) : "–"}</DataRow>
            <DataRow label="vs HLTV">
                {player.metrics[credit].hltvGap
                    ? `${signed(player.metrics[credit].hltvGap.z)} (${signed(player.metrics[credit].hltvGap.zP5)}, ${signed(player.metrics[credit].hltvGap.zP95)})`
                    : "–"}
            </DataRow>
            <DataRow label="Rating 2.0 (approx)">{player.rating2Approx !== null ? player.rating2Approx.toFixed(2) : "–"}</DataRow>
            <DataRow label="HLTV Swing">{player.swing !== null ? signed(player.swing) : "–"}</DataRow>
            <DataRow label="K/D / ADR">
                {player.kd !== null ? player.kd.toFixed(2) : "–"} / {player.adr !== null ? player.adr.toFixed(1) : "–"}
            </DataRow>
            <ResourceRows player={player} est={player.metrics[credit]} />
        </dl>
    </Inset>
);

type RankedPlayer = { player: WarPlayer; rank: number };

const sortRankedRows = (
    list: RankedPlayer[],
    sort: { key: SortKey; reversed: boolean },
    credit: CreditVersion
): RankedPlayer[] => {
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
                return columnOrder(
                    a.player.metrics[credit].hltvGap?.z ?? null,
                    b.player.metrics[credit].hltvGap?.z ?? null,
                    opts(false)
                );
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
    expanded,
    onToggle,
}: {
    rows: RankedPlayer[];
    emptyMessage: string;
    sort: { key: SortKey; reversed: boolean };
    onSort: (key: SortKey) => void;
    credit: CreditVersion;
    metric: "WAA" | "WAR";
    intervalBound: number;
    expanded: Set<string>;
    onToggle: (steamid: string) => void;
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
                    const isExpanded = expanded.has(p.steamid);
                    const est = p.metrics[credit];
                    return (
                        <React.Fragment key={p.steamid}>
                            <Row>
                                <Td align="right" className="text-muted">
                                    {rank}
                                </Td>
                                <Td className="font-sans">
                                    <div className="inline-flex items-center gap-1.5">
                                        <button
                                            type="button"
                                            aria-expanded={isExpanded}
                                            onClick={() => onToggle(p.steamid)}
                                            className="group inline-flex items-center gap-2 font-medium text-fg hover:text-accent transition-colors cursor-pointer"
                                        >
                                            <svg
                                                viewBox="0 0 16 16"
                                                fill="currentColor"
                                                aria-hidden="true"
                                                className={`w-3 h-3 text-muted group-hover:text-accent transition-transform ${
                                                    isExpanded ? "rotate-90" : ""
                                                }`}
                                            >
                                                <path d="M6 3.5 11 8l-5 4.5z" />
                                            </svg>
                                            <span className="md:hidden">
                                                {p.lpTeam && <TeamLogo team={p.lpTeam} size={16} />}
                                            </span>
                                            {p.name}
                                        </button>
                                        {p.isIgl && <Badge tone="accent">IGL</Badge>}
                                    </div>
                                    {p.lpTeam && (
                                        <span className="md:hidden block pl-5 text-[10px] font-mono text-muted">
                                            {p.lpTeam}
                                        </span>
                                    )}
                                </Td>
                                <Td className="hidden md:table-cell font-sans text-muted">
                                    {p.lpTeam ? (
                                        <span className="inline-flex items-center gap-2">
                                            <TeamLogo team={p.lpTeam} />
                                            {p.lpTeam}
                                        </span>
                                    ) : (
                                        "–"
                                    )}
                                </Td>
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
                            {isExpanded && (
                                <tr>
                                    <td colSpan={COLUMN_COUNT} className="px-3 pt-1 pb-3">
                                        <PlayerDetails player={p} metric={metric} credit={credit} />
                                    </td>
                                </tr>
                            )}
                        </React.Fragment>
                    );
                })
            )}
        </TableBody>
    </DataTable>
);

export const PlayerWar = () => {
    const [queryParams, setQueryParams] = useQueryParams();
    const rawRole = queryParams.get("role") as RoleFilter | null;
    const role: RoleFilter = rawRole && ROLE_FILTERS.includes(rawRole) ? rawRole : "all";
    const rawCredit = queryParams.get("credit") as CreditVersion | null;
    const credit: CreditVersion = rawCredit && CREDIT_VERSIONS.includes(rawCredit) ? rawCredit : DEFAULT_CREDIT;

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

    const { data, isLoading, error } = useQuery({ queryKey: ["war", "players"], queryFn: fetchPlayerWar });

    const { rankedNonIgls, rankedIgls } = useMemo(() => {
        if (!data) return { rankedNonIgls: [] as RankedPlayer[], rankedIgls: [] as RankedPlayer[] };
        const sorted = [...data.players].sort((a, b) => b.metrics[credit].per100 - a.metrics[credit].per100);
        return {
            rankedNonIgls: sorted.filter((p) => !p.isIgl).map((player, idx) => ({ player, rank: idx + 1 })),
            rankedIgls: sorted.filter((p) => p.isIgl).map((player, idx) => ({ player, rank: idx + 1 })),
        };
    }, [data, credit]);

    const roleFiltered = useMemo(
        () => rankedNonIgls.filter(({ player }) => matchesRole(player, role)),
        [rankedNonIgls, role]
    );

    const rows = useMemo(
        () => sortRankedRows(roleFiltered.filter(({ player }) => matchesQuery(player, query)), sort, credit),
        [roleFiltered, query, sort, credit]
    );

    const iglRows = useMemo(
        () => sortRankedRows(rankedIgls.filter(({ player }) => matchesQuery(player, query)), sort, credit),
        [rankedIgls, query, sort, credit]
    );

    const intervalBound = useMemo(() => {
        if (!data || data.players.length === 0) return 5;
        let maxAbs = 1;
        for (const p of data.players) {
            const m = p.metrics[credit];
            maxAbs = Math.max(maxAbs, Math.abs(m.waaP5), Math.abs(m.waaP95));
        }
        return maxAbs;
    }, [data, credit]);

    const toggle = (steamid: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(steamid)) next.delete(steamid);
            else next.add(steamid);
            return next;
        });

    if (isLoading) return <LoadingBar label="Loading player WAA…" />;
    if (error || !data) {
        return (
            <EmptyState className="text-down">
                Error loading player WAA: {error instanceof Error ? error.message : "Unknown error"}
            </EmptyState>
        );
    }

    const metric = data.metric;
    const adj = data.iglAdjustmentPer100[credit];
    const valKey = `${credit}_waa_r`;
    const m100 = data.validation.monthToMonth100[valKey];
    const m200 = data.validation.monthToMonth200[valKey];
    const splitHalf = data.validation.splitHalf[valKey];
    const kdCorr = data.validation.withKd[valKey];
    const r3Kd = data.validation.withKd.rating3;

    return (
        <div className="space-y-10">
            <PageHeader
                eyebrow={data.provisional ? "Provisional / dry-run win-probability model" : "Tier-1 LAN demos"}
                title={`CS2 Player ${metric}`}
                subtitle={
                    <>
                        {data.window.from} to {data.window.to} / {data.window.maps.toLocaleString("en-US")} maps across{" "}
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
                            aria-label="Role filter"
                            options={ROLE_OPTIONS}
                            value={role}
                            onChange={(r) => setQueryParams({ role: r === "all" ? null : r })}
                        />
                        <Segmented
                            aria-label="Credit version"
                            options={CREDIT_OPTIONS}
                            value={credit}
                            onChange={(c) => setQueryParams({ credit: c === DEFAULT_CREDIT ? null : c })}
                        />
                    </div>
                }
            />

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
                title={`Players / map wins above role average (90% round-bootstrap intervals)`}
                subtitle={`Each map assigns T roles (AWPer, Entry, Rifler) and CT callout positions and subtracts empirically shrunk role baselines. Per 100 rounds, the rate splits into team context + usage (what the player's own equipment, utility and drops are worth) + conversion (what they made of them), so receiving resources is never penalized.`}
                actions={
                    <span className="text-xs font-mono text-muted">
                        {query.trim() || role !== "all"
                            ? `${rows.length} of ${rankedNonIgls.length} players`
                            : `${rows.length} players`}
                    </span>
                }
            >
                <LeaderboardTable
                    rows={rows}
                    emptyMessage={query.trim() ? `No players match “${query.trim()}”` : "No players match filter"}
                    sort={sort}
                    onSort={onSort}
                    credit={credit}
                    metric={metric}
                    intervalBound={intervalBound}
                    expanded={expanded}
                    onToggle={toggle}
                />
            </Section>

            <Section
                title="IGLs / separate leaderboard"
                subtitle={`Callers on 50%+ of rounds, ranked separately while the zero-sum IGL positional adjustment (CT ${signed(adj.ct)} / T ${signed(adj.t)} round-wins per 100 rounds) is tuned.`}
                actions={
                    <span className="text-xs font-mono text-muted">
                        {query.trim() ? `${iglRows.length} of ${rankedIgls.length} IGLs` : `${iglRows.length} IGLs`}
                    </span>
                }
            >
                <LeaderboardTable
                    rows={iglRows}
                    emptyMessage={query.trim() ? `No IGLs match “${query.trim()}”` : "No IGLs"}
                    sort={sort}
                    onSort={onSort}
                    credit={credit}
                    metric={metric}
                    intervalBound={intervalBound}
                    expanded={expanded}
                    onToggle={toggle}
                />

                <div className="space-y-1">
                    <LiquipediaCredit what="Tournament, team, roster and player page data" />
                    <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
                </div>
            </Section>

            <Section
                title="Validation diagnostics"
                subtitle="Out-of-role skill stability and independence from raw kill/death ratio on qualified players."
            >
                <DataTable>
                    <TableHead>
                        <Th align="left">Check</Th>
                        <Th>Selected {metric}</Th>
                        <Th>Reference</Th>
                    </TableHead>
                    <TableBody>
                        <Row>
                            <Td className="font-sans">Month-to-month Pearson r (100+ rounds / month)</Td>
                            <Td align="right">{m100?.r !== null && m100?.r !== undefined ? m100.r.toFixed(3) : "–"}</Td>
                            <Td align="right" className="text-muted">
                                {m100?.pairs ?? 0} pairs (~4.5 MR12 maps)
                            </Td>
                        </Row>
                        <Row>
                            <Td className="font-sans">Month-to-month Pearson r (200+ rounds / month)</Td>
                            <Td align="right">{m200?.r !== null && m200?.r !== undefined ? m200.r.toFixed(3) : "–"}</Td>
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
                            <Td align="right">{kdCorr?.r !== null && kdCorr?.r !== undefined ? kdCorr.r.toFixed(3) : "–"}</Td>
                            <Td align="right" className="text-muted">
                                HLTV 3.0: {r3Kd?.r !== null && r3Kd?.r !== undefined ? r3Kd.r.toFixed(3) : "–"}
                            </Td>
                        </Row>
                    </TableBody>
                </DataTable>
            </Section>
        </div>
    );
};
