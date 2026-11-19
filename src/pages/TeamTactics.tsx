import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Section } from "../components/ui.tsx";
import { StintCredit, StintTable } from "../components/StintTable.tsx";
import { tacticsQuery } from "../data/queries.ts";
import { stintMatches, tacticsColumns, tacticsMetaKey } from "../war/teamColumns.ts";
import type { TacticsKey } from "../war/types.ts";

/** Renders nothing until `tactics.json` is published. */
export const TeamTactics = ({ query }: { query: string }) => {
    const { data } = useQuery(tacticsQuery);
    const columns = useMemo(() => (data ? tacticsColumns(data) : []), [data]);
    const rows = useMemo(() => (data ? data.teams.filter((t) => stintMatches(t, query)) : []), [data, query]);

    if (!data || columns.length === 0) return null;
    const anyPredictive = columns.some((c) => !data.stats[tacticsMetaKey(c.key as TacticsKey)]?.descriptive);

    return (
        <Section
            id="team-tactics"
            title="Teams / tactics (90% series-bootstrap intervals)"
            subtitle={`One row per team and IGL stint with ${data.min_rounds}+ rounds. Post-plant T and retake CT are win-rate points per 100 post-plant rounds, against an expectation from site, men alive, buys and kits; numbers at contact is extra defenders per 100 rounds. None uses team Elo in its expectation. ${
                anyPredictive
                    ? "Stats marked descriptive don't improve an Elo prediction of map results."
                    : "None improves an Elo prediction of map results."
            }`}
            actions={
                <span className="text-xs font-mono text-muted">
                    {query.trim() ? `${rows.length} of ${data.teams.length} stints` : `${rows.length} stints`}
                </span>
            }
        >
            <StintTable rows={rows} columns={columns} emptyMessage={`No teams match “${query.trim()}”`} />
            <StintCredit />
        </Section>
    );
};
