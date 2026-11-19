import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Section } from "../components/ui.tsx";
import { StintCredit, StintTable } from "../components/StintTable.tsx";
import { teamDuelsQuery } from "../data/queries.ts";
import { duelColumns, duelCount, stintMatches } from "../war/teamColumns.ts";
import type { DuelStatKey } from "../war/types.ts";

/** Renders nothing until `team-duels.json` is published. */
export const TeamDuels = ({ query }: { query: string }) => {
    const { data } = useQuery(teamDuelsQuery);
    const columns = useMemo(() => (data ? duelColumns(data) : []), [data]);
    const rows = useMemo(() => (data ? data.teams.filter((t) => stintMatches(t, query)) : []), [data, query]);

    if (!data || columns.length === 0) return null;
    const anyPredictive = columns.some((c) => !data.stats[c.key as DuelStatKey]?.descriptive);
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
            <StintTable rows={rows} columns={columns} count={duelCount} emptyMessage={`No teams match “${query.trim()}”`} />
            <StintCredit />
        </Section>
    );
};
