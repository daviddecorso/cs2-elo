import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DataTable, Row, SortHeader, TableBody, TableHead, Td } from "../components/DataTable.tsx";
import { EmptyState, Section, Tooltip } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { columnOrder, nextSort, type SortState } from "../utils/tableSort.ts";
import { textMatches } from "../utils/search.ts";
import { RateCell } from "../components/RateCell.tsx";
import type { TeamStatKey, TeamStatMeta, TeamStatStint, TeamStatsData } from "../war/types.ts";

const STAT_ORDER: TeamStatKey[] = ["rwoe_econ", "ct_def", "t_off", "tpv", "conv", "rwoe_war"];
const SHORT_LABEL: Record<TeamStatKey, string> = {
    rwoe_econ: "RW over econ",
    ct_def: "Adj. CT",
    t_off: "Adj. T",
    tpv: "Time & position",
    conv: "Conversion",
    rwoe_war: "RW over WAR",
};
const DESCRIPTION: Record<TeamStatKey, string> = {
    rwoe_econ: "Rounds won above what the map, side and both teams' buys predict: overall strength, skill plus tactics",
    ct_def: "CT round win rate above expectation, adjusted for map, economy and the opponent's T side",
    t_off: "T round win rate above expectation, adjusted for map, economy and the opponent's CT side",
    tpv: "Win probability gained between kills and plants: positioning and use of time, which WPA credits to no player",
    conv: "Rounds won beyond what the round's gun duels predict: post-plants, saves, utility kills",
    rwoe_war: "Rounds won above what the players' WAR predicts: the team factor",
};
const PRIMARY: TeamStatKey[] = ["rwoe_econ", "ct_def", "t_off"];

type SortKey = "team" | "maps" | "rounds" | TeamStatKey;
const DEFAULT_SORT: SortState<SortKey> = { key: "rwoe_econ", reversed: false };

const fetchTeamStats = async (): Promise<TeamStatsData | null> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/war/team-stats.json`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load team round stats: HTTP ${res.status}`);
    return res.json();
};

const sortStints = (list: TeamStatStint[], sort: SortState<SortKey>) => {
    const opts = (ascending: boolean) => ({ ascending, reversed: sort.reversed });
    return [...list].sort((a, b) => {
        switch (sort.key) {
            case "team":
                return columnOrder(a.label, b.label, opts(true));
            case "maps":
                return columnOrder(a.maps, b.maps, opts(false));
            case "rounds":
                return columnOrder(a.rounds, b.rounds, opts(false));
            default:
                return columnOrder(a[sort.key]?.per100 ?? null, b[sort.key]?.per100 ?? null, opts(false));
        }
    });
};

const matchesQuery = (t: TeamStatStint, q: string) => {
    const trimmed = q.trim();
    return !trimmed || textMatches(t.lp_team, trimmed) || (t.igl_player !== null && textMatches(t.igl_player, trimmed));
};

const ci = (c?: [number | null, number | null]) =>
    c && c[0] !== null && c[1] !== null ? ` (90% CI ${c[0].toFixed(2)}, ${c[1].toFixed(2)})` : "";

const headerTooltip = (s: TeamStatKey, m: TeamStatMeta) =>
    [
        DESCRIPTION[s],
        `Split-half r ${m.split_half_r.toFixed(2)}${ci(m.split_half_r_ci)}`,
        m.persistence_r != null ? `Quarter-to-quarter r ${m.persistence_r.toFixed(2)}${ci(m.persistence_r_ci)}` : null,
        m.gain_vs_raw != null ? "Predicts rounds better than raw T and CT win rates" : null,
        m.descriptive ? "Descriptive: not shown to add to Elo" : null,
    ]
        .filter(Boolean)
        .join("\n");

/** Renders nothing until `team-stats.json` is published. */
export const TeamRounds = ({ query }: { query: string }) => {
    const { data } = useQuery({ queryKey: ["war", "team-stats"], queryFn: fetchTeamStats });
    const [sort, setSort] = useState<SortState<SortKey>>(DEFAULT_SORT);

    const stats = useMemo(() => STAT_ORDER.filter((s) => data?.stats[s]), [data]);
    const rows = useMemo(
        () => (data ? sortStints(data.teams.filter((t) => matchesQuery(t, query)), sort) : []),
        [data, query, sort]
    );

    if (!data || stats.length === 0) return null;
    const onSort = (k: SortKey) => setSort(nextSort(sort, k));
    const hideOnSmall = (s: TeamStatKey) => (PRIMARY.includes(s) ? "" : "hidden lg:table-cell");

    return (
        <Section
            id="team-rounds"
            title="Teams / round-level stats (per 100 rounds, 90% series-bootstrap intervals)"
            subtitle={`One row per team and IGL stint with ${data.min_rounds}+ rounds. None of these uses team Elo in its expectation, and they describe how teams win rounds rather than predict map results beyond Elo. Adjusted T and CT are win-rate points per 100 rounds on that side.`}
            actions={
                <span className="text-xs font-mono text-muted">
                    {query.trim() ? `${rows.length} of ${data.teams.length} stints` : `${rows.length} stints`}
                </span>
            }
        >
            <DataTable>
                <TableHead>
                    <SortHeader sortKey="team" sort={sort} onSort={onSort} ascending align="left">
                        Team (IGL)
                    </SortHeader>
                    <SortHeader sortKey="maps" sort={sort} onSort={onSort}>
                        Maps
                    </SortHeader>
                    <SortHeader sortKey="rounds" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                        Rounds
                    </SortHeader>
                    {stats.map((s) => (
                        <SortHeader key={s} sortKey={s} sort={sort} onSort={onSort} className={hideOnSmall(s)}>
                            <Tooltip content={headerTooltip(s, data.stats[s]!)}>
                                <span>{SHORT_LABEL[s]}</span>
                            </Tooltip>
                        </SortHeader>
                    ))}
                </TableHead>
                <TableBody>
                    {rows.length === 0 ? (
                        <tr>
                            <td colSpan={3 + stats.length}>
                                <EmptyState>{`No teams match “${query.trim()}”`}</EmptyState>
                            </td>
                        </tr>
                    ) : (
                        rows.map((t) => (
                            <Row key={t.stint_id}>
                                <Td className="font-sans">
                                    <span className="inline-flex items-center gap-2">
                                        <TeamLogo team={t.lp_team} />
                                        <a
                                            href={liquipediaUrl(t.lp_team)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="font-medium text-fg hover:text-accent"
                                        >
                                            {t.lp_team}
                                        </a>
                                        <span className="text-muted text-[11px] font-mono">{t.label.slice(t.lp_team.length).trim()}</span>
                                    </span>
                                </Td>
                                <Td align="right" className="text-muted tabular-nums">
                                    {t.maps}
                                </Td>
                                <Td align="right" className="hidden sm:table-cell text-muted tabular-nums">
                                    {t.rounds.toLocaleString("en-US")}
                                </Td>
                                {stats.map((s) => (
                                    <Td key={s} align="right" className={hideOnSmall(s)}>
                                        <RateCell rate={t[s]} label={data.stats[s]!.label} unit="rounds" />
                                    </Td>
                                ))}
                            </Row>
                        ))
                    )}
                </TableBody>
            </DataTable>
            <div className="space-y-1">
                <LiquipediaCredit what="Team pages, rosters and IGLs" />
                <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
            </div>
        </Section>
    );
};
