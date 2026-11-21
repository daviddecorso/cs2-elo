import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { Button, EmptyState, LoadingBar, PageHeader, Section, Segmented } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { PickemPlayoffs, PickemSummary, PickemSwiss } from "../components/Pickem.tsx";
import { MajorInvites } from "./MajorInvites.tsx";
import { fetchSimJson } from "../sim/fetch.ts";
import { favouritePicks, oddsFn, runPickem, type Picks } from "../sim/pickem.ts";
import type { EventIndexEntry, EventOdds, InviteIndexEntry, PickemData } from "../sim/types.ts";
import { liquipediaUrl } from "../utils/liquipedia.ts";

interface MajorEntry {
    slug: string;
    name: string;
    /** Has a simulated event file; otherwise only invite odds. */
    event: boolean;
}

interface StoredPicks {
    picks: Picks;
    /** Open matches fill with the favourite. */
    autoFill: boolean;
}

const storageKey = (slug: string) => `pickem:${slug}`;

const loadPicks = (slug: string): StoredPicks => {
    try {
        const raw = localStorage.getItem(storageKey(slug));
        if (raw) return JSON.parse(raw) as StoredPicks;
    } catch {
        // Storage can be blocked; picks then last only for the visit.
    }
    return { picks: {}, autoFill: true };
};

const savePicks = (slug: string, stored: StoredPicks) => {
    try {
        localStorage.setItem(storageKey(slug), JSON.stringify(stored));
    } catch {
        // See loadPicks.
    }
};

const Simulator = ({ event, data, switcher }: { event: EventOdds; data: PickemData; switcher: ReactNode }) => {
    const [queryParams, setQueryParams] = useQueryParams();
    const [stored, setStored] = useState<StoredPicks>(() => loadPicks(event.slug));
    useEffect(() => savePicks(event.slug, stored), [event.slug, stored]);

    const picks = useMemo(() => (stored.autoFill ? favouritePicks(data, stored.picks) : stored.picks), [data, stored]);
    const runs = useMemo(() => runPickem(data, picks), [data, picks]);
    const odds = useMemo(() => oddsFn(data.odds), [data]);

    const stageId = runs.some((r) => r.stage.id === queryParams.get("stage")) ? queryParams.get("stage")! : runs[0].stage.id;
    const run = runs.find((r) => r.stage.id === stageId)!;
    const onPick = (key: string, team: string) => setStored((s) => ({ ...s, picks: { ...picks, [key]: team } }));
    const stageLabel = (id: string, name: string) => (id === "playoffs" ? "Playoffs" : name.replace("Stage ", "S"));

    return (
        <div className="space-y-8">
            <PageHeader
                eyebrow="Major simulator"
                title={event.name}
                subtitle={
                    <>
                        {event.startDate} to {event.endDate} / Elo as of {event.asOf} /{" "}
                        <Link to={`/events/${event.slug}`} className="text-accent hover:underline">
                            full odds
                        </Link>
                    </>
                }
                actions={switcher}
            />

            <Section
                title="Pick the winners"
                subtitle="Click a team to advance it. Pairings follow Valve's Swiss rules, so a changed pick re-pairs every later round. Percentages are today's Elo series odds; played matches are locked."
                actions={
                    <div className="flex flex-wrap gap-2">
                        <Segmented
                            aria-label="Stage"
                            options={runs.map((r) => ({ value: r.stage.id, label: stageLabel(r.stage.id, r.stage.name) }))}
                            value={stageId}
                            onChange={(id) => setQueryParams({ stage: id === runs[0].stage.id ? null : id })}
                        />
                        <Button size="sm" onClick={() => setStored({ picks: {}, autoFill: true })}>
                            Model picks
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setStored({ picks: {}, autoFill: false })}>
                            Clear
                        </Button>
                    </div>
                }
            >
                {run.seeds.length === 0 ? (
                    <EmptyState>
                        Finish {runs.find((r) => r.stage.id === run.stage.from)?.stage.name ?? "the previous stage"} to seed this stage.
                    </EmptyState>
                ) : run.stage.format === "swiss" ? (
                    <div className="space-y-4">
                        <PickemSwiss run={run} odds={odds} onPick={onPick} />
                        <PickemSummary run={run} model={data.model?.[run.stage.id]} />
                        <p className="text-[11px] font-mono text-muted">3-X means advancing 3-1 or 3-2.</p>
                    </div>
                ) : (
                    <PickemPlayoffs run={run} odds={odds} onPick={onPick} />
                )}
                <LiquipediaCredit what="Participants, brackets, results and team logo data" />
                <a
                    href={liquipediaUrl(event.liquipedia)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-mono text-accent hover:underline"
                >
                    {event.name} on Liquipedia
                </a>
            </Section>
        </div>
    );
};

const today = () => new Date().toISOString().slice(0, 10);

export const Major = () => {
    const { slug } = useParams();
    const navigate = useNavigate();
    const eventsQuery = useQuery({ queryKey: ["sim", "events"], queryFn: () => fetchSimJson<EventIndexEntry[]>("events/index.json") });
    const invitesQuery = useQuery({ queryKey: ["sim", "invites"], queryFn: () => fetchSimJson<InviteIndexEntry[]>("invites/index.json") });

    const majors = useMemo((): MajorEntry[] => {
        const events = (eventsQuery.data ?? [])
            .filter((e) => e.major && e.endDate >= today())
            .map((e) => ({ slug: e.slug, name: e.name, event: true }));
        const invites = (invitesQuery.data ?? [])
            .filter((i) => !events.some((e) => e.slug === i.slug))
            .map((i) => ({ slug: i.slug, name: i.name, event: false }));
        return [...events, ...invites];
    }, [eventsQuery.data, invitesQuery.data]);

    const major = majors.find((m) => m.slug === slug) ?? majors[0];
    const eventQuery = useQuery({
        queryKey: ["sim", "event", major?.slug],
        queryFn: () => fetchSimJson<EventOdds>(`events/${major!.slug}.json`),
        enabled: major?.event === true,
    });

    if (eventsQuery.isLoading || invitesQuery.isLoading || eventQuery.isLoading) return <LoadingBar label="Loading Major…" />;
    const error = eventsQuery.error ?? invitesQuery.error ?? eventQuery.error;
    if (error) return <EmptyState className="text-down">Error loading the Major: {error.message}</EmptyState>;
    if (!major) return <EmptyState>No upcoming Major is configured yet.</EmptyState>;

    const switcher =
        majors.length > 1 ? (
            <Segmented
                aria-label="Major"
                className="max-w-full overflow-x-auto"
                options={majors.map((m) => ({ value: m.slug, label: m.name }))}
                value={major.slug}
                onChange={(s) => navigate(s === majors[0].slug ? "/major" : `/major/${s}`)}
            />
        ) : undefined;

    const event = eventQuery.data;
    if (event?.pickem) return <Simulator key={event.slug} event={event} data={event.pickem} switcher={switcher} />;
    if (major.event && !(invitesQuery.data ?? []).some((i) => i.slug === major.slug)) {
        return <EmptyState>{major.name}'s field is set, but its simulator data hasn't been generated yet.</EmptyState>;
    }
    return <MajorInvites key={major.slug} slug={major.slug} switcher={switcher} />;
};
