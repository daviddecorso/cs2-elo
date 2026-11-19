import { useMemo, useState } from "react";
import { DataTable, Row, SortHeader, TableBody, TableHead, Td } from "./DataTable.tsx";
import { EmptyState, Tooltip } from "./ui.tsx";
import { RateCell } from "./RateCell.tsx";
import { TeamLink } from "./TeamLink.tsx";
import { LiquipediaCredit } from "./LiquipediaCredit.tsx";
import { columnOrder, nextSort, type SortState } from "../utils/tableSort.ts";
import type { StintBase, StintColumn, StintCount } from "../war/teamColumns.ts";

export const StintCredit = () => (
    <div className="space-y-1">
        <LiquipediaCredit what="Team pages, rosters and IGLs" />
        <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
    </div>
);

const iglLabel = (t: StintBase) => t.label.slice(t.lp_team.length).trim();

/** One row per team and IGL stint; `showTeam` false labels rows by IGL alone, for a single team's page. */
export const StintTable = <T extends StintBase>({
    rows,
    columns,
    count,
    showTeam = true,
    emptyMessage,
}: {
    rows: T[];
    columns: StintColumn<T>[];
    count?: StintCount<T>;
    showTeam?: boolean;
    emptyMessage: string;
}) => {
    const [sort, setSort] = useState<SortState<string>>({ key: columns[0]?.key ?? "maps", reversed: false });
    const onSort = (k: string) => setSort(nextSort(sort, k));

    const sorted = useMemo(() => {
        const opts = (ascending: boolean) => ({ ascending, reversed: sort.reversed });
        const col = columns.find((c) => c.key === sort.key);
        return [...rows].sort((a, b) => {
            switch (sort.key) {
                case "team":
                    return columnOrder(a.label, b.label, opts(true));
                case "maps":
                    return columnOrder(a.maps, b.maps, opts(false));
                case "count":
                    return columnOrder(count?.value(a) ?? null, count?.value(b) ?? null, opts(false));
                default:
                    return columnOrder(col?.rate(a)?.per100 ?? null, col?.rate(b)?.per100 ?? null, opts(false));
            }
        });
    }, [rows, columns, count, sort]);

    const hideOnSmall = (c: StintColumn<T>) => (c.primary ? "" : "hidden lg:table-cell");

    return (
        <DataTable>
            <TableHead>
                <SortHeader sortKey="team" sort={sort} onSort={onSort} ascending align="left">
                    {showTeam ? "Team (IGL)" : "IGL"}
                </SortHeader>
                <SortHeader sortKey="maps" sort={sort} onSort={onSort}>
                    Maps
                </SortHeader>
                {count && (
                    <SortHeader sortKey="count" sort={sort} onSort={onSort} className="hidden sm:table-cell">
                        {count.header}
                    </SortHeader>
                )}
                {columns.map((c) => (
                    <SortHeader key={c.key} sortKey={c.key} sort={sort} onSort={onSort} className={hideOnSmall(c)}>
                        <Tooltip content={c.tooltip}>
                            <span>{c.header}</span>
                        </Tooltip>
                    </SortHeader>
                ))}
            </TableHead>
            <TableBody>
                {sorted.length === 0 ? (
                    <tr>
                        <td colSpan={(count ? 3 : 2) + columns.length}>
                            <EmptyState>{emptyMessage}</EmptyState>
                        </td>
                    </tr>
                ) : (
                    sorted.map((t) => (
                        <Row key={t.stint_id}>
                            <Td className="font-sans">
                                {showTeam ? (
                                    <span className="inline-flex items-center gap-2">
                                        <TeamLink team={t.lp_team} />
                                        <span className="text-muted text-[11px] font-mono">{iglLabel(t)}</span>
                                    </span>
                                ) : (
                                    <span className="text-fg">{t.igl_player ?? (iglLabel(t) || "–")}</span>
                                )}
                            </Td>
                            <Td align="right" className="text-muted tabular-nums">
                                {t.maps}
                            </Td>
                            {count && (
                                <Td align="right" className="hidden sm:table-cell text-muted tabular-nums">
                                    {count.value(t)?.toLocaleString("en-US") ?? "–"}
                                </Td>
                            )}
                            {columns.map((c) => (
                                <Td key={c.key} align="right" className={hideOnSmall(c)}>
                                    <RateCell rate={c.rate(t)} label={c.rateLabel} unit={c.unit} />
                                </Td>
                            ))}
                        </Row>
                    ))
                )}
            </TableBody>
        </DataTable>
    );
};
