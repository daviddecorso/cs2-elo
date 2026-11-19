import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { EmptyState, LoadingBar, Section } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { RateCell } from "../components/RateCell.tsx";
import { TeamLink } from "../components/TeamLink.tsx";
import { PlayerLink } from "../components/WarValues.tsx";
import { clutchQuery, playerWarQuery } from "../data/queries.ts";
import { textMatches } from "../utils/search.ts";
import { clutchTooltip } from "../war/teamColumns.ts";

export const PlayerClutch = ({ query }: { query: string }) => {
    const { data, isLoading } = useQuery(clutchQuery);
    const war = useQuery(playerWarQuery);
    const teams = useMemo(() => new Map((war.data?.players ?? []).map((p) => [p.steamid, p.lpTeam])), [war.data]);
    const meta = data?.player_stats.clutch;
    const q = query.trim();
    const rows = useMemo(
        () =>
            (data?.players ?? [])
                .map((p) => ({ ...p, team: teams.get(p.steamid) ?? null }))
                .filter((p) => !q || textMatches(p.name, q) || (p.team !== null && textMatches(p.team, q))),
        [data, teams, q]
    );

    if (isLoading) return <LoadingBar label="Loading clutches…" />;
    if (!data || !meta) return <EmptyState>Player clutch conversion isn't published yet.</EmptyState>;

    return (
        <Section
            title="Players / clutch conversion (90% series-bootstrap intervals)"
            subtitle={`Players with ${data.min_entries.player}+ clutches (last alive against one or more). Round wins per 100 clutches above the win-probability model's expectation at even Elo, centred on the league for each 1vN and side. It carries weakly from 2025 to 2026 (r ${meta.year_r?.toFixed(2) ?? "–"}) but not between alternating series, so read it as a tendency, not a skill rating.`}
            actions={<span className="text-xs font-mono text-muted">{rows.length} players</span>}
        >
            {rows.length === 0 ? (
                <EmptyState>No players match “{q}”</EmptyState>
            ) : (
                <DataTable>
                    <TableHead>
                        <Th align="left">Player</Th>
                        <Th align="left" className="hidden md:table-cell">
                            Team
                        </Th>
                        <Th>Clutches</Th>
                        <Th>
                            <span title={clutchTooltip("Clutch rounds won above expectation", meta)}>Per 100</span>
                        </Th>
                    </TableHead>
                    <TableBody>
                        {rows.map((p) => (
                            <Row key={p.steamid}>
                                <Td className="font-sans">
                                    <PlayerLink name={p.name} />
                                </Td>
                                <Td className="hidden md:table-cell font-sans text-muted">{p.team ? <TeamLink team={p.team} /> : "–"}</Td>
                                <Td align="right">{p.entries}</Td>
                                <Td align="right">
                                    <RateCell rate={p.clutch} label="Clutch conversion" unit="clutches" />
                                </Td>
                            </Row>
                        ))}
                    </TableBody>
                </DataTable>
            )}
            <div className="space-y-1">
                <LiquipediaCredit what="Team pages and rosters" />
                <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
            </div>
        </Section>
    );
};
