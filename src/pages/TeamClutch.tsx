import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Section } from "../components/ui.tsx";
import { StintCredit, StintTable } from "../components/StintTable.tsx";
import { clutchQuery } from "../data/queries.ts";
import { clutchColumns, stintMatches } from "../war/teamColumns.ts";

/** Renders nothing until `clutch.json` publishes a team class. */
export const TeamClutch = ({ query }: { query: string }) => {
    const { data } = useQuery(clutchQuery);
    const columns = useMemo(() => (data ? clutchColumns(data) : []), [data]);
    const rows = useMemo(() => (data ? data.teams.filter((t) => stintMatches(t, query)) : []), [data, query]);

    if (!data || columns.length === 0) return null;

    return (
        <Section
            id="team-clutch"
            title="Teams / clutch and man-disadvantage conversion (90% series-bootstrap intervals)"
            subtitle={`One row per team and IGL stint with ${data.min_entries.stint}+ entries. Round wins per 100 entries above the win-probability model's expectation at the moment the team first reaches 1vN or first falls behind in men alive, valued at even Elo. Both are stable from 2025 to 2026. Falling-behind conversion tracks team strength closely; clutches barely do.`}
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
