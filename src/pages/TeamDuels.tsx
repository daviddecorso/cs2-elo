import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DataTable, Row, SortHeader, TableBody, TableHead, Td } from "../components/DataTable.tsx";
import { EmptyState, Section, Tooltip } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { columnOrder, nextSort, type SortState } from "../utils/tableSort.ts";
import { textMatches } from "../utils/search.ts";
import type { DuelRate, DuelStatKey, TeamDuelStint, TeamDuelsData } from "../war/types.ts";

const STAT_ORDER: DuelStatKey[] = ["exec", "quality", "q_pos", "q_flash", "q_hp"];
const SHORT_LABEL: Record<DuelStatKey, string> = {
    exec: "Execution",
    quality: "Quality",
    q_pos: "Positioning",
    q_flash: "Flashes",
    q_hp: "HP",
};
const DESCRIPTION: Record<DuelStatKey, string> = {
    exec: "Duels won above the duel model's expectation",
    quality: "Win probability of the duels the team takes, above a weapons-armor-side baseline",
    q_pos: "Quality from peeker vs holder and distance",
    q_flash: "Quality from flashes",
    q_hp: "Quality from HP going into the duel",
};

type SortKey = "team" | "maps" | "duels" | DuelStatKey;
const DEFAULT_SORT: SortState<SortKey> = { key: "exec", reversed: false };

const fetchTeamDuels = async (): Promise<TeamDuelsData | null> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/war/team-duels.json`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load team duels: HTTP ${res.status}`);
    return res.json();
};

const signed = (n: number) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

const RateCell = ({ rate, label }: { rate?: DuelRate; label: string }) =>
    rate ? (
        <Tooltip
            content={`${label} per 100 duels\n90% series bootstrap: (${signed(rate.p5)}, ${signed(rate.p95)})\nPer 100 rounds: ${signed(rate.per100_rounds)}`}
        >
            <span className="tabular-nums">
                <span className={rate.p5 > 0 ? "text-up" : rate.p95 < 0 ? "text-down" : "text-fg"}>{signed(rate.per100)}</span>
                <span className="text-muted text-[10px] ml-1">{`(${signed(rate.p5)}, ${signed(rate.p95)})`}</span>
            </span>
        </Tooltip>
    ) : (
        <span className="text-muted">–</span>
    );

const duelCount = (t: TeamDuelStint) => t.duels ?? t.opening_duels ?? null;

const sortStints = (list: TeamDuelStint[], sort: SortState<SortKey>) => {
    const opts = (ascending: boolean) => ({ ascending, reversed: sort.reversed });
    return [...list].sort((a, b) => {
        switch (sort.key) {
            case "team":
                return columnOrder(a.label, b.label, opts(true));
            case "maps":
                return columnOrder(a.maps, b.maps, opts(false));
            case "duels":
                return columnOrder(duelCount(a), duelCount(b), opts(false));
            default:
                return columnOrder(a[sort.key]?.per100 ?? null, b[sort.key]?.per100 ?? null, opts(false));
        }
    });
};

const matchesQuery = (t: TeamDuelStint, q: string) => {
    const trimmed = q.trim();
    return !trimmed || textMatches(t.lp_team, trimmed) || (t.igl_player !== null && textMatches(t.igl_player, trimmed));
};

/** Renders nothing until `team-duels.json` is published. */
export const TeamDuels = ({ query }: { query: string }) => {
    const { data } = useQuery({ queryKey: ["war", "team-duels"], queryFn: fetchTeamDuels });
    const [sort, setSort] = useState<SortState<SortKey>>(DEFAULT_SORT);

    const stats = useMemo(() => STAT_ORDER.filter((s) => data?.stats[s]), [data]);
    const rows = useMemo(
        () => (data ? sortStints(data.teams.filter((t) => matchesQuery(t, query)), sort) : []),
        [data, query, sort]
    );

    if (!data || stats.length === 0) return null;
    const anyPredictive = stats.some((s) => !data.stats[s]?.descriptive);
    const opening = data.quality_definition === "opening duels";

    return (
        <Section
            id="team-duels"
            title="Teams / duel execution and quality (per 100 duels, 90% series-bootstrap intervals)"
            subtitle={`One row per team and IGL stint with ${data.min_rounds}+ rounds. Execution is how many more duels a team wins than the duel model expects from the duel's setup; quality is how good that setup was, split into positioning, flashes and HP.${
                opening ? " Quality uses only each round's first duel." : ""
            } ${
                anyPredictive
                    ? "Stats marked descriptive don't improve an Elo prediction of map results."
                    : "These describe how teams play: none improves an Elo prediction of map results."
            }`}
            actions={
                <span className="text-xs font-mono text-muted">
                    {query.trim() ? `${rows.length} of ${data.teams.length} stints` : `${rows.length} stints`}
                </span>
            }
        >
            <DataTable>
                <TableHead>
                    <SortHeader sortKey="team" sort={sort} onSort={(k) => setSort(nextSort(sort, k))} ascending align="left">
                        Team (IGL)
                    </SortHeader>
                    <SortHeader sortKey="maps" sort={sort} onSort={(k) => setSort(nextSort(sort, k))}>
                        Maps
                    </SortHeader>
                    <SortHeader
                        sortKey="duels"
                        sort={sort}
                        onSort={(k) => setSort(nextSort(sort, k))}
                        className="hidden sm:table-cell"
                    >
                        Duels
                    </SortHeader>
                    {stats.map((s) => {
                        const m = data.stats[s]!;
                        return (
                            <SortHeader
                                key={s}
                                sortKey={s}
                                sort={sort}
                                onSort={(k) => setSort(nextSort(sort, k))}
                                className={s === "exec" || s === "quality" ? "" : "hidden lg:table-cell"}
                            >
                                <Tooltip
                                    content={`${DESCRIPTION[s]}\nSplit-half r ${m.split_half_r.toFixed(2)} (90% CI ${m.split_half_r_ci[0].toFixed(2)}, ${m.split_half_r_ci[1].toFixed(2)})${m.descriptive ? "\nDescriptive: adds nothing to Elo" : ""}`}
                                >
                                    <span>{SHORT_LABEL[s]}</span>
                                </Tooltip>
                            </SortHeader>
                        );
                    })}
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
                                    {duelCount(t)?.toLocaleString("en-US") ?? "–"}
                                </Td>
                                {stats.map((s) => (
                                    <Td
                                        key={s}
                                        align="right"
                                        className={s === "exec" || s === "quality" ? "" : "hidden lg:table-cell"}
                                    >
                                        <RateCell rate={t[s]} label={data.stats[s]!.label} />
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
