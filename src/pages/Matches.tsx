import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { MatchCard, MatchSection } from "../components/MatchCard.tsx";
import { MatchDetailModal } from "../components/MatchDetailModal.tsx";
import { Button, EmptyState, Label, LoadingBar, PageHeader, Segmented, Select, TextInput, Toolbar } from "../components/ui.tsx";
import { eloMatchesQuery } from "../data/queries.ts";
import type { ScheduledMatch } from "../elo/types.ts";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import {
    formatDayHeading,
    groupByDay,
    isUpset,
    matchAnchor,
    sortMatches,
    type MatchSort,
} from "../utils/matches.ts";
import { textMatches } from "../utils/search.ts";

type MatchView = "upcoming" | "recent";
type MatchFilter = "top30" | "tier12" | "lan" | "all";

const isTop30OrMajorTier = (m: ScheduledMatch): boolean =>
    (m.tier !== null && m.tier <= 2) ||
    m.sides.some((s) => (s.rank !== null && s.rank <= 30) || (s.vrsRank !== null && s.vrsRank <= 30));

const matchesFilter = (m: ScheduledMatch, filter: MatchFilter): boolean => {
    if (filter === "all") return true;
    if (filter === "tier12") return m.tier !== null && m.tier <= 2;
    if (filter === "lan") return m.lan;
    return isTop30OrMajorTier(m);
};

export const Matches = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams, setParams] = useQueryParams();
    const { data, isLoading, error } = useQuery(eloMatchesQuery);

    const matchId = searchParams.get("match");
    const targetAnchor = location.hash.slice(1);
    const openedFromCard = Boolean((location.state as { fromCard?: boolean } | null)?.fromCard);

    const requestedView = searchParams.get("view");
    const view: MatchView = requestedView === "recent" ? "recent" : "upcoming";

    const requestedFilter = searchParams.get("show");
    const filter: MatchFilter =
        requestedFilter === "all" || requestedFilter === "top30" || requestedFilter === "tier12" || requestedFilter === "lan"
            ? requestedFilter
            : targetAnchor || (matchId && !openedFromCard)
              ? "all"
              : "top30";

    const rawSort = searchParams.get("sort");
    const sortBy: MatchSort = rawSort === "time" ? "time" : "excitement";

    const urlQuery = searchParams.get("q") ?? "";
    const [query, setQuery] = useState(urlQuery);
    useEffect(() => {
        setQuery(urlQuery);
    }, [urlQuery]);

    const handleQueryChange = (q: string) => {
        setQuery(q);
        setParams({ q: q || null });
    };

    const sourceMatches = useMemo(() => {
        if (!data) return [];
        return view === "recent" ? data.recent : data.upcoming;
    }, [data, view]);

    const events = useMemo(() => {
        const byEvent = new Map<string, string>();
        for (const m of sourceMatches) {
            if (!byEvent.has(m.event)) byEvent.set(m.event, m.eventName);
        }
        return [...byEvent.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    }, [sourceMatches]);

    const requestedEvent = searchParams.get("event");
    const selectedEvent = requestedEvent !== null && events.some(([ev]) => ev === requestedEvent) ? requestedEvent : "all";

    const filtered = useMemo(() => {
        const trimmed = query.trim();
        return sourceMatches.filter((m) => {
            if (selectedEvent !== "all" && m.event !== selectedEvent) return false;
            if (!matchesFilter(m, filter)) return false;
            if (trimmed) {
                const hit =
                    textMatches(m.sides[0].team, trimmed) ||
                    textMatches(m.sides[1].team, trimmed) ||
                    textMatches(m.eventName, trimmed);
                if (!hit) return false;
            }
            return true;
        });
    }, [sourceMatches, selectedEvent, filter, query]);

    const topRating = data?.topRating ?? 0;
    const timeOrder = view === "recent" ? "desc" : "asc";
    const sorted = useMemo(() => sortMatches(filtered, sortBy, timeOrder, topRating), [filtered, sortBy, timeOrder, topRating]);
    const dayGroups = useMemo(() => groupByDay(sorted, timeOrder), [sorted, timeOrder]);
    const displayedSequence = useMemo(() => dayGroups.flatMap((g) => g.items), [dayGroups]);

    const upsets = useMemo(() => {
        if (view !== "recent") return [];
        return filtered
            .filter(isUpset)
            .sort((a, b) => Math.max(b.p, 1 - b.p) - Math.max(a.p, 1 - a.p))
            .slice(0, 3);
    }, [filtered, view]);

    const selectedIndex = displayedSequence.findIndex((m) => m.id === matchId);
    const prevMatch = selectedIndex > 0 ? displayedSequence[selectedIndex - 1] : undefined;
    const nextMatch =
        selectedIndex >= 0 && selectedIndex < displayedSequence.length - 1 ? displayedSequence[selectedIndex + 1] : undefined;

    const selectedMatch = useMemo(() => {
        if (!matchId || !data) return undefined;
        return (
            displayedSequence.find((m) => m.id === matchId) ??
            data.upcoming.find((m) => m.id === matchId) ??
            data.recent.find((m) => m.id === matchId)
        );
    }, [matchId, data, displayedSequence]);

    const highlightedAnchor = targetAnchor || (matchId ? matchAnchor(matchId) : undefined);
    useEffect(() => {
        if (highlightedAnchor) {
            document.getElementById(highlightedAnchor)?.scrollIntoView({ block: "center" });
        }
    }, [highlightedAnchor]);

    const handleOpenMatch = (id: string) => {
        const next = new URLSearchParams(searchParams);
        next.set("match", id);
        navigate(
            { search: next.toString(), hash: location.hash },
            { state: { ...(location.state as Record<string, unknown> | null), fromCard: true } }
        );
    };

    const handleStepMatch = (id: string) => {
        const next = new URLSearchParams(searchParams);
        next.set("match", id);
        navigate({ search: next.toString(), hash: location.hash }, { replace: true, state: location.state });
    };

    const handleCloseModal = () => {
        if (openedFromCard) {
            navigate(-1);
        } else {
            const next = new URLSearchParams(searchParams);
            next.delete("match");
            next.set("show", filter);
            navigate({ search: next.toString(), hash: location.hash }, { replace: true });
        }
    };

    if (isLoading) return <LoadingBar label="Loading matches…" />;
    if (error || !data) {
        return (
            <EmptyState className="text-down">
                Error loading matches: {error instanceof Error ? error.message : "Unknown error"}
            </EmptyState>
        );
    }

    const showScore = view === "recent";

    return (
        <div className="space-y-10">
            <PageHeader
                title={view === "upcoming" ? "Matches / Upcoming" : "Matches / Recent"}
                subtitle={
                    view === "upcoming"
                        ? `Pre-series Elo odds through ${data.asOf}${data.upcomingFetched ? ` / schedule fetched ${data.upcomingFetched}` : ""}`
                        : `Pre-series Elo predictions and results over the last 14 days through ${data.asOf}`
                }
            />

            <Toolbar>
                <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-end flex-wrap">
                    <div className="flex flex-wrap gap-4 items-end">
                        <div className="flex flex-col gap-1">
                            <Label as="span">View</Label>
                            <Segmented
                                aria-label="Match view"
                                options={[
                                    { value: "upcoming" as const, label: "Upcoming" },
                                    { value: "recent" as const, label: "Recent" },
                                ]}
                                value={view}
                                onChange={(nextView) =>
                                    setParams({ view: nextView === "upcoming" ? null : nextView, event: null, match: null })
                                }
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <Label as="span">Filter</Label>
                            <Segmented
                                aria-label="Match filter"
                                options={[
                                    { value: "top30" as const, label: "Top 30" },
                                    { value: "tier12" as const, label: "Tier 1–2" },
                                    { value: "lan" as const, label: "LAN" },
                                    { value: "all" as const, label: "All" },
                                ]}
                                value={filter}
                                onChange={(show) => setParams({ show: show === "top30" ? null : show })}
                            />
                        </div>

                        {events.length > 0 && (
                            <Select
                                id="matches-event"
                                label="Event"
                                value={selectedEvent}
                                onChange={(e) => setParams({ event: e.target.value === "all" ? null : e.target.value })}
                                options={[
                                    { value: "all", label: "All events" },
                                    ...events.map(([value, label]) => ({ value, label })),
                                ]}
                                className="max-w-52"
                            />
                        )}

                        <div className="flex flex-col gap-1">
                            <Label as="span">Sort</Label>
                            <Segmented
                                aria-label="Sort matches"
                                options={[
                                    { value: "excitement" as const, label: "Excitement" },
                                    { value: "time" as const, label: "Start time" },
                                ]}
                                value={sortBy}
                                onChange={(sort) => setParams({ sort: sort === "excitement" ? null : sort })}
                            />
                        </div>

                        <TextInput
                            id="matches-search"
                            label="Search"
                            value={query}
                            onChange={(e) => handleQueryChange(e.target.value)}
                            placeholder="Team or event"
                            className="w-40"
                        />
                    </div>

                    <div className="text-xs font-mono text-muted sm:self-end pb-1.5">
                        {`Showing ${displayedSequence.length} of ${sourceMatches.length} matches`}
                    </div>
                </div>
            </Toolbar>

            {view === "recent" && upsets.length > 0 && (
                <div className="pb-4">
                    <MatchSection title="Biggest upsets" showScore>
                        {upsets.map((m) => (
                            <MatchCard
                                key={`upset-${m.id}`}
                                match={m}
                                topRating={topRating}
                                showScore
                                showDay
                                anchor={false}
                                onOpen={() => handleOpenMatch(m.id)}
                            />
                        ))}
                    </MatchSection>
                </div>
            )}

            {sourceMatches.length === 0 ? (
                <EmptyState>
                    <p>{view === "upcoming" ? "No upcoming matches scheduled yet." : "No recent matches in the feed."}</p>
                    {view === "upcoming" && data.recent.length > 0 && (
                        <Button variant="ghost" size="sm" className="mt-3" onClick={() => setParams({ view: "recent" })}>
                            View recent results
                        </Button>
                    )}
                </EmptyState>
            ) : displayedSequence.length === 0 ? (
                <EmptyState>
                    <p>No matches fit this filter.</p>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="mt-3"
                        onClick={() => {
                            setQuery("");
                            setParams({ show: "all", event: null, q: null });
                        }}
                    >
                        Show all matches
                    </Button>
                </EmptyState>
            ) : (
                <div className="space-y-8">
                    {dayGroups.map((group) => (
                        <MatchSection key={group.key} title={formatDayHeading(group.date)} showScore={showScore}>
                            {group.items.map((m) => (
                                <MatchCard
                                    key={m.id}
                                    match={m}
                                    topRating={topRating}
                                    showScore={showScore}
                                    highlighted={matchAnchor(m.id) === highlightedAnchor}
                                    onOpen={() => handleOpenMatch(m.id)}
                                />
                            ))}
                        </MatchSection>
                    ))}
                </div>
            )}

            <LiquipediaCredit what="Schedule, lineups, results and team logo data" />

            {selectedMatch && (
                <MatchDetailModal
                    match={selectedMatch}
                    onClose={handleCloseModal}
                    onPrev={prevMatch ? () => handleStepMatch(prevMatch.id) : undefined}
                    onNext={nextMatch ? () => handleStepMatch(nextMatch.id) : undefined}
                />
            )}
        </div>
    );
};
