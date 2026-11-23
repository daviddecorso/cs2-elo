import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { eventIndexQuery, seasonIndexQuery } from "../data/queries.ts";

/** Slugs `/events/:slug` can render: a simulated bracket or a season-simulation field file. */
export const useEventPages = (): ReadonlySet<string> => {
    const brackets = useQuery(eventIndexQuery);
    const season = useQuery(seasonIndexQuery);
    return useMemo(() => new Set([...(brackets.data ?? []).map((e) => e.slug), ...(season.data?.fields ?? [])]), [brackets.data, season.data]);
};
