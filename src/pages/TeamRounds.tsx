import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Section } from "../components/ui.tsx";
import { StintCredit, StintTable } from "../components/StintTable.tsx";
import { teamStatsQuery } from "../data/queries.ts";
import { roundColumns, roundCount, stintMatches } from "../war/teamColumns.ts";

/** Renders nothing until `team-stats.json` is published. */
export const TeamRounds = ({ query }: { query: string }) => {
    const { data } = useQuery(teamStatsQuery);
    const columns = useMemo(() => (data ? roundColumns(data) : []), [data]);
    const rows = useMemo(() => (data ? data.teams.filter((t) => stintMatches(t, query)) : []), [data, query]);

    if (!data || columns.length === 0) return null;

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
            <StintTable rows={rows} columns={columns} count={roundCount} emptyMessage={`No teams match “${query.trim()}”`} />
            <StintCredit />
        </Section>
    );
};
