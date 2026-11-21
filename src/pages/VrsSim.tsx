import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { rosterMatches } from "../utils/search.ts";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { Badge, EmptyState, Inset, LoadingBar, PageHeader, Section, Segmented, Select, TextInput, Tooltip } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { SeriesLineChart, type Series, type SeriesPoint } from "../components/charts/SeriesLineChart.tsx";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { percent } from "../utils/format.ts";
import { teamFromParam, teamPath } from "../utils/teams.ts";
import { fetchSimJson } from "../sim/fetch.ts";
import { conflicts, popcount } from "../sim/schedule.ts";
import { NOISE_WORTH, defaultSchedule, scheduleRows, stale, timeline } from "../sim/plan.ts";
import { planIndexQuery, planTeamQuery } from "../data/queries.ts";
import type {
    PlanEventRef,
    PlanOdds,
    PlanOptionKind,
    PlanSchedule,
    PlanTeamFile,
    ScheduleCandidate,
    ScheduleGoal,
    ScheduleSummary,
    ScheduleVolume,
    SeasonEvent,
    SeasonIndex,
    SeasonRange,
    SeasonRoster,
    SeasonStandings,
    SeasonTeamSchedule,
} from "../sim/types.ts";

const VIEWS = ["calendar", "projections", "schedules", "plan"] as const;
type View = (typeof VIEWS)[number];
const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
    { value: "calendar", label: "Calendar" },
    { value: "projections", label: "Projections" },
    { value: "schedules", label: "Schedules" },
    { value: "plan", label: "Plan" },
];
const VOLUME_LABEL: Record<ScheduleVolume, string> = { low: "low volume", average: "average volume", high: "high volume" };
const GOAL_LABEL: Record<ScheduleGoal, string> = { points: "most points", invite: "best invite odds" };
const REGIONS = ["Global", "Europe", "Americas", "Asia"] as const;
type RegionFilter = (typeof REGIONS)[number];
const SERIES_COLORS = ["var(--color-accent)", "var(--color-series-2)", "var(--color-series-3)", "var(--color-series-4)", "var(--color-violet)", "var(--color-heat)"];
const FIELD_SHOWN = 10;
const KINDS = [
    { value: "lan", label: "LANs" },
    { value: "all", label: "All" },
    { value: "projected", label: "Projected" },
] as const;
type KindFilter = (typeof KINDS)[number]["value"];
const kindMatches = (e: SeasonEvent, kind: KindFilter) => (kind === "all" ? true : kind === "lan" ? e.kind === "lan" : e.projection !== undefined);
const SOURCE_LABEL: Record<SeasonEvent["field"][number]["source"], string> = { announced: "announced", vrs: "VRS invite", qualifier: "qualifier (assumed)", open: "drawn like past editions (assumed)" };

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const monthLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const RangeCell = ({ range, label, digits = 0 }: { range: SeasonRange; label: string; digits?: number }) => {
    const fmt = (v: number | null) => (v === null ? "unranked" : v.toFixed(digits));
    return (
        <Tooltip content={`Median ${label}, with the 10th–90th percentile range`}>
            <span>
                <span className="text-fg">{fmt(range.p50)}</span>
                <span className="text-muted text-[10px]">
                    {" "}
                    ({fmt(range.p10)}–{fmt(range.p90)})
                </span>
            </span>
        </Tooltip>
    );
};

const EventRow = ({ event }: { event: SeasonEvent }) => {
    const shown = event.field.slice(0, FIELD_SHOWN);
    const { projection } = event;
    return (
        <Row>
            <Td className="font-mono text-muted whitespace-nowrap">
                {shortDate(event.startDate)}–{shortDate(event.endDate)}
            </Td>
            <Td className="font-sans">
                {projection ? (
                    <span className="font-medium text-fg">{event.name}</span>
                ) : (
                    <a href={liquipediaUrl(event.liquipedia)} target="_blank" rel="noopener noreferrer" className="font-medium text-fg hover:underline">
                        {event.name}
                    </a>
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                    {projection && (
                        <Tooltip
                            content={`Not listed on Liquipedia yet. ${projection.editions} past editions, one every ${projection.gapDays} days; stepped from ${projection.lastPage.replace(/_/g, " ")} (${shortDate(projection.lastStart)}). Played in ${percent(projection.chance)} of runs, how often past projections like it came true.`}
                        >
                            <a href={liquipediaUrl(projection.lastPage)} target="_blank" rel="noopener noreferrer">
                                <Badge tone="heat">projected {percent(projection.chance)}</Badge>
                            </a>
                        </Tooltip>
                    )}
                    <Badge>{event.kind === "lan" ? "LAN" : "Online"}</Badge>
                    {event.tier !== null && <Badge>Tier {event.tier}</Badge>}
                    {event.location?.region && <Badge>{event.location.region}</Badge>}
                    {event.assumed.map((a) => (
                        <Tooltip key={a} content={`The ${a === "teams" ? "team count" : a} is assumed, not announced`}>
                            <Badge tone="heat">assumed {a}</Badge>
                        </Tooltip>
                    ))}
                </div>
            </Td>
            <Td align="right" className="font-mono whitespace-nowrap">
                {event.prizePool > 0 ? usd(event.prizePool) : "—"}
            </Td>
            <Td className="font-mono text-[11px] whitespace-normal">
                {!event.simulated ? (
                    <span className="text-muted">Not simulated: {event.reason}</span>
                ) : (
                    <>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                            {shown.map((f) => (
                                <Tooltip key={f.team} content={`${SOURCE_LABEL[f.source]}${f.win !== null ? `, wins ${percent(f.win)}` : ""}`}>
                                    <span>
                                        <Link to={teamPath(f.team)} className={`${f.source === "qualifier" || f.source === "open" ? "text-muted" : "text-fg"} hover:text-accent hover:underline`}>
                                            {f.team}
                                        </Link>
                                        {f.attend < 1 && <span className="text-muted"> {percent(f.attend)}</span>}
                                    </span>
                                </Tooltip>
                            ))}
                            {event.field.length > shown.length && <span className="text-muted">+{event.field.length - shown.length} more</span>}
                        </div>
                        {event.fedBy && (
                            <div className="text-muted">
                                {event.fedBy.map((f) => `${f.slots} ${f.slots === 1 ? "slot" : "slots"} from ${f.name}`).join(", ")}
                            </div>
                        )}
                        {event.shortRuns > 0 && <div className="text-heat">Field not filled in {event.shortRuns} runs</div>}
                    </>
                )}
            </Td>
        </Row>
    );
};

const Calendar = ({ index }: { index: SeasonIndex }) => {
    const months = useMemo(() => {
        const out = new Map<string, SeasonEvent[]>();
        for (const e of index.events) out.set(e.startDate.slice(0, 7), [...(out.get(e.startDate.slice(0, 7)) ?? []), e]);
        return [...out];
    }, [index]);
    const [showAll, setShowAll] = useState(false);
    const [queryParams, setQueryParams] = useQueryParams();
    const requestedKind = queryParams.get("kind");
    const kind: KindFilter = KINDS.find((k) => k.value === requestedKind)?.value ?? "lan";
    const hidden = index.events.filter((e) => kindMatches(e, kind) && !e.simulated && e.tier !== null && e.tier > 2).length;
    return (
        <Section
            title="Upcoming events"
            actions={
                <div className="flex flex-wrap items-center gap-3">
                    {hidden > 0 && (
                        <button type="button" className="text-xs font-mono text-accent hover:underline" onClick={() => setShowAll((s) => !s)}>
                            {showAll ? "Hide" : "Show"} {hidden} unsimulated tier 3–4 events
                        </button>
                    )}
                    <Segmented aria-label="Kind" options={[...KINDS]} value={kind} onChange={(k) => setQueryParams({ kind: k === "lan" ? null : k })} />
                </div>
            }
        >
            <DataTable>
                <TableHead>
                    <Th align="left" className="w-px">
                        Dates
                    </Th>
                    <Th align="left">Event</Th>
                    <Th>Prize pool</Th>
                    <Th align="left">Field (attendance)</Th>
                </TableHead>
                <TableBody>
                    {months.map(([month, events]) => {
                        const visible = events.filter((e) => kindMatches(e, kind) && (showAll || e.simulated || e.tier === null || e.tier <= 2));
                        if (visible.length === 0) return null;
                        return [
                            <tr key={month}>
                                <td colSpan={4} className="pt-4 pb-1 text-[11px] font-mono uppercase tracking-wider text-muted">
                                    {monthLabel(`${month}-01`)}
                                </td>
                            </tr>,
                            ...visible.map((e) => <EventRow key={e.slug} event={e} />),
                        ];
                    })}
                </TableBody>
            </DataTable>
            <LiquipediaCredit what="Event dates, locations, prize pools and participant data" />
        </Section>
    );
};

const rankOf = (r: SeasonRoster, cp: number, region: RegionFilter) =>
    (region === "Global" ? r.checkpoints[cp].globalRank.p50 : r.checkpoints[cp].regionalRank.p50) ?? Infinity;

const Projections = ({ index, standings, query }: { index: SeasonIndex; standings: SeasonStandings; query: string }) => {
    const [queryParams, setQueryParams] = useQueryParams();
    const requestedRegion = queryParams.get("region") as RegionFilter | null;
    const region: RegionFilter = requestedRegion && REGIONS.includes(requestedRegion) ? requestedRegion : "Global";
    const last = standings.checkpoints.length - 1;
    const requestedCheckpoint = standings.checkpoints.indexOf(queryParams.get("at") ?? "");
    const cp = requestedCheckpoint >= 0 ? requestedCheckpoint : last;

    const rosters = useMemo(
        () =>
            standings.rosters
                .filter((r) => region === "Global" || r.region === region)
                .filter((r) => rosterMatches(r.teamName, r.players, query))
                .sort((a, b) => rankOf(a, cp, region) - rankOf(b, cp, region) || (b.checkpoints[cp].points.p50 ?? 0) - (a.checkpoints[cp].points.p50 ?? 0)),
        [standings, region, query, cp]
    );

    const charted = rosters.slice(0, SERIES_COLORS.length);
    const series: Series[] = charted.map((r, i) => ({ key: r.rosterKey, label: r.teamName, color: SERIES_COLORS[i] }));
    const points: SeriesPoint[] = [
        { label: "Today", ...Object.fromEntries(charted.map((r) => [r.rosterKey, r.today?.points])) },
        ...standings.checkpoints.map((date, i) => ({
            label: date,
            ...Object.fromEntries(charted.map((r) => [r.rosterKey, r.checkpoints[i].points.p50 ?? undefined])),
        })),
    ];
    const target = index.target;

    return (
        <div className="space-y-10">
            <Section
                title={`${region === "Global" ? "Global" : region} standings at ${standings.checkpoints[cp]}`}
                actions={
                    <div className="flex flex-wrap gap-2">
                        <Select
                            aria-label="Checkpoint"
                            value={standings.checkpoints[cp]}
                            options={standings.checkpoints.map((d) => ({ value: d, label: d === target.date ? `${d} (${target.name} snapshot)` : d }))}
                            onChange={(e) => setQueryParams({ at: e.target.value === standings.checkpoints[last] ? null : e.target.value })}
                        />
                        <Segmented aria-label="Region" options={[...REGIONS]} value={region} onChange={(r) => setQueryParams({ region: r === "Global" ? null : r })} />
                    </div>
                }
            >
                <DataTable>
                    <TableHead>
                        <Th className="w-px">Rank</Th>
                        <Th align="left">Team</Th>
                        <Th>Points</Th>
                        <Th className="hidden sm:table-cell">Today</Th>
                        <Th className="hidden sm:table-cell">Ranked</Th>
                    </TableHead>
                    <TableBody>
                        {rosters.length === 0 ? (
                            <tr>
                                <td colSpan={5}>
                                    <EmptyState>{query.trim() ? `No rosters match “${query.trim()}”` : "No rosters"}</EmptyState>
                                </td>
                            </tr>
                        ) : (
                            rosters.map((r) => {
                                const at = r.checkpoints[cp];
                                const todayRank = region === "Global" ? r.today?.globalRank : r.today?.regionalRank;
                                return (
                                    <Row key={r.rosterKey}>
                                        <Td align="right" className="font-mono">
                                            <RangeCell range={region === "Global" ? at.globalRank : at.regionalRank} label={`${region.toLowerCase()} rank`} />
                                        </Td>
                                        <Td className="font-sans">
                                            <div className="inline-flex items-center gap-2">
                                                <TeamLogo team={r.teamName} />
                                                <span className="font-medium text-fg">{r.teamName}</span>
                                            </div>
                                            <span className="block pl-[28px] text-[10px] font-mono text-muted whitespace-normal">{r.players.join(", ")}</span>
                                        </Td>
                                        <Td align="right" className="font-mono">
                                            <RangeCell range={at.points} label="points" />
                                        </Td>
                                        <Td align="right" className="font-mono text-muted hidden sm:table-cell">
                                            {r.today ? `${Math.round(r.today.points)} (#${todayRank ?? "–"})` : "—"}
                                        </Td>
                                        <Td align="right" className="font-mono text-muted hidden sm:table-cell">
                                            {percent(at.ranked)}
                                        </Td>
                                    </Row>
                                );
                            })
                        )}
                    </TableBody>
                </DataTable>
                <LiquipediaCredit what="Brackets, results, rosters, prize and team logo data" />
            </Section>

            <SeriesLineChart
                title="Median points by publication date"
                data={points}
                series={series}
                format={(v) => String(Math.round(v))}
                empty="No rosters to chart"
            />
        </div>
    );
};

const SummaryCell = ({ summary, muted = false }: { summary: ScheduleSummary; muted?: boolean }) => (
    <Tooltip content="Mean points, with the 10th–90th percentile range">
        <span className={muted ? "text-muted" : "text-fg"}>
            {Math.round(summary.mean)}
            <span className="text-muted text-[10px]">
                {" "}
                ({Math.round(summary.p10)}–{Math.round(summary.p90)})
            </span>
        </span>
    </Tooltip>
);

const inviteText = (s: ScheduleSummary) => (s.invite === null ? "—" : percent(s.invite));

const EventList = ({ slugs, names }: { slugs: string[]; names: Map<string, SeasonEvent> }) =>
    slugs.length === 0 ? (
        <span className="text-muted">No optional events</span>
    ) : (
        <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            {slugs.map((slug) => {
                const e = names.get(slug);
                return e ? (
                    <a key={slug} href={liquipediaUrl(e.liquipedia)} target="_blank" rel="noopener noreferrer" className="text-fg hover:underline">
                        {e.name}
                    </a>
                ) : (
                    <span key={slug}>{slug}</span>
                );
            })}
        </span>
    );

const slugsOf = (mask: number, candidates: ScheduleCandidate[]) => candidates.filter((_, i) => (mask >> i) & 1).map((c) => c.slug);

const Picker = ({ schedule, initial, names }: { schedule: SeasonTeamSchedule; initial: number; names: Map<string, SeasonEvent> }) => {
    const [mask, setMask] = useState(initial);
    const { candidates, volume, committed } = schedule;
    const row = schedule.subsets.find((s) => s[0] === mask);
    const chosen = candidates.filter((_, i) => (mask >> i) & 1);
    const clashes = chosen.flatMap((a, i) => chosen.slice(i + 1).filter((b) => conflicts(a, b)).map((b) => `${a.name} and ${b.name}`));
    const count = popcount(mask) + committed.length;
    const fits = (["low", "average", "high"] as const).find((v) => count <= volume[v]);

    return (
        <Section title="Build a schedule">
            <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
                <ul className="space-y-1.5 text-xs font-mono">
                    {committed.map((c) => (
                        <li key={c.slug} className="flex items-center gap-2 text-muted">
                            <input type="checkbox" checked disabled aria-label={`${c.name} (under way)`} />
                            <span>{c.name}</span>
                            <Badge>under way</Badge>
                        </li>
                    ))}
                    {candidates.map((c, i) => (
                        <li key={c.slug} className="flex flex-wrap items-center gap-2">
                            <input
                                type="checkbox"
                                checked={((mask >> i) & 1) === 1}
                                onChange={() => setMask((m) => m ^ (1 << i))}
                                aria-label={c.name}
                                className="cursor-pointer"
                            />
                            <span className="text-muted whitespace-nowrap">
                                {shortDate(c.startDate)}–{shortDate(c.endDate)}
                            </span>
                            <EventList slugs={[c.slug]} names={names} />
                            {c.region && <Badge>{c.region}</Badge>}
                            {c.announced && <Badge tone="accent">announced</Badge>}
                            {c.projected !== undefined && (
                                <Tooltip content="Not listed on Liquipedia yet; stepped from its series' past editions">
                                    <Badge tone="heat">projected {percent(c.projected)}</Badge>
                                </Tooltip>
                            )}
                            {c.generic && (
                                <Tooltip content="Format assumed from the team count">
                                    <Badge>assumed format</Badge>
                                </Tooltip>
                            )}
                            {c.assumedInvite && (
                                <Tooltip content="No known invite rule: assumes the organizer invites a team ranked at least as well as half its past attendees">
                                    <Badge>assumed invite</Badge>
                                </Tooltip>
                            )}
                            <Tooltip content="Share of simulations in which the team could get a slot">
                                <span className="text-muted">reachable {percent(c.reach)}</span>
                            </Tooltip>
                        </li>
                    ))}
                </ul>
                <Inset className="text-xs space-y-2 self-start">
                    {clashes.length > 0 && <p className="text-down">Too close to travel between: {clashes.join("; ")}.</p>}
                    {!fits && <p className="text-down">{count} LANs is over the high-volume cap of {volume.high}.</p>}
                    {row ? (
                        <>
                            <div className="text-[11px] font-mono uppercase tracking-wider text-muted">One-team estimate</div>
                            <div className="font-mono text-base">
                                <SummaryCell summary={{ mean: row[1], p10: row[2], p90: row[3], invite: row[4] }} />
                            </div>
                            <div className="font-mono">Major invite {row[4] === null ? "—" : percent(row[4])}</div>
                            <p className="text-muted">
                                {count} LANs, within the {fits} cap. Estimated with the one-team model, not rerun exactly.
                            </p>
                        </>
                    ) : (
                        clashes.length === 0 && fits && <p className="text-muted">No estimate for this combination.</p>
                    )}
                </Inset>
            </div>
            {schedule.requiresQualifying.some((q) => !q.via) && (
                <p className="mt-4 text-xs text-muted">
                    Reachable only through a qualifier, so left out:{" "}
                    {schedule.requiresQualifying
                        .filter((q) => !q.via)
                        .map((q) => `${q.name} (${percent(q.reach)})`)
                        .join(", ")}
                    .
                </p>
            )}
            {schedule.requiresQualifying.some((q) => q.via) && (
                <div className="mt-4 text-xs">
                    <Tooltip content="Each qualifier is replayed with the team in it, in the runs where it could enter. Simulated, not announced, and not counted in the schedules above.">
                        <span className="text-muted underline decoration-dotted">Through qualifiers:</span>
                    </Tooltip>
                    <ul className="mt-1 space-y-0.5 font-mono">
                        {schedule.requiresQualifying
                            .filter((q) => q.via)
                            .map((q) => (
                                <li key={q.slug}>
                                    {q.name} via {q.via!.map((v) => v.name).join(" or ")}: qualifies in {percent(q.qualified ?? 0)} of runs when entered
                                    <span className="text-muted"> (can enter in {percent(q.reach)})</span>
                                </li>
                            ))}
                    </ul>
                </div>
            )}
        </Section>
    );
};

const Schedules = ({ index }: { index: SeasonIndex }) => {
    const [queryParams, setQueryParams] = useQueryParams();
    const entries = index.schedules ?? [];
    const requested = teamFromParam(queryParams.get("team") ?? "");
    const entry = entries.find((e) => e.team === requested) ?? entries[0];
    const scheduleQuery = useQuery({
        queryKey: ["sim", "season", "team", entry?.file],
        queryFn: () => fetchSimJson<SeasonTeamSchedule>(`season/teams/${encodeURIComponent(entry!.file)}`),
        enabled: !!entry,
    });
    const names = useMemo(() => new Map(index.events.map((e) => [e.slug, e])), [index]);
    const planIndex = useQuery(planIndexQuery);
    const hasPlan = !!entry && !!planIndex.data?.teams.some((t) => t.team === entry.team);

    if (!entry) return <EmptyState>No team schedules in this simulation.</EmptyState>;
    const schedule = scheduleQuery.data;
    const stats = index.optimizer;
    const initial = schedule?.recommended.find((r) => r.volumes.includes("average") && r.goals.includes("points"))?.mask ?? 0;

    return (
        <div className="space-y-10">
            <Section
                title={`${entry.teamName}: recommended schedules`}
                actions={
                    <Select
                        aria-label="Team"
                        value={entry.team}
                        options={entries.map((e) => ({ value: e.team, label: e.teamName }))}
                        onChange={(e) => setQueryParams({ team: e.target.value.replace(/ /g, "_") })}
                    />
                }
            >
                {scheduleQuery.isLoading && <LoadingBar label="Loading schedules…" />}
                {scheduleQuery.error && <EmptyState className="text-down">Error loading {entry.teamName}'s schedules.</EmptyState>}
                {schedule && (
                    <>
                        <DataTable>
                            <TableHead>
                                <Th align="left">Schedule</Th>
                                <Th align="left">Events</Th>
                                <Th>Points at {schedule.target.date}</Th>
                                <Th>Major invite</Th>
                                <Th className="hidden sm:table-cell">One-team estimate</Th>
                            </TableHead>
                            <TableBody>
                                <Row>
                                    <Td className="font-sans whitespace-normal">
                                        <Tooltip content="What the simulation does by default: accept invites as teams of its rank did in past editions, up to its usual volume. Includes events reached through qualifiers or drawn fields, which are assumed.">
                                            <span className="text-muted">Season rules</span>
                                        </Tooltip>
                                    </Td>
                                    <Td className="font-mono text-[11px] text-muted whitespace-normal">Whatever invites come</Td>
                                    <Td align="right" className="font-mono">
                                        <SummaryCell summary={schedule.rules} muted />
                                    </Td>
                                    <Td align="right" className="font-mono text-muted">
                                        {inviteText(schedule.rules)}
                                    </Td>
                                    <Td className="hidden sm:table-cell" />
                                </Row>
                                {schedule.recommended.map((rec) => (
                                    <Row key={rec.mask}>
                                        <Td className="font-sans whitespace-normal">
                                            <div className="flex flex-wrap gap-1">
                                                {rec.goals.map((g) => (
                                                    <Badge key={g} tone="accent">
                                                        {GOAL_LABEL[g]}
                                                    </Badge>
                                                ))}
                                                {rec.volumes.map((v) => (
                                                    <Badge key={v}>{VOLUME_LABEL[v]}</Badge>
                                                ))}
                                            </div>
                                        </Td>
                                        <Td className="font-mono text-[11px] whitespace-normal">
                                            <EventList slugs={slugsOf(rec.mask, schedule.candidates)} names={names} />
                                            {rec.dropsAnnounced.length > 0 && (
                                                <div className="text-heat">Drops announced: {rec.dropsAnnounced.map((s) => names.get(s)?.name ?? s).join(", ")}</div>
                                            )}
                                        </Td>
                                        <Td align="right" className="font-mono">
                                            <SummaryCell summary={rec.exact} />
                                        </Td>
                                        <Td align="right" className="font-mono">
                                            {inviteText(rec.exact)}
                                        </Td>
                                        <Td align="right" className="font-mono hidden sm:table-cell">
                                            <SummaryCell summary={rec.estimate} muted />
                                        </Td>
                                    </Row>
                                ))}
                            </TableBody>
                        </DataTable>
                        <p className="mt-3 text-xs text-muted">
                            Points and invite odds come from exact reruns of Valve's model over {schedule.rescoreN} simulations, the season rules
                            included. The one-team estimate covers all {schedule.n}.
                            {schedule.committed.length > 0 && ` Every schedule keeps ${schedule.committed.map((c) => c.name).join(", ")}, already under way.`} Volume
                            caps: {schedule.volume.low} / {schedule.volume.average} / {schedule.volume.high} LANs.
                            {stats && ` Nightly check: one-team estimates are off by ${stats.estimateError.mean.toFixed(1)} points on average (p95 ${stats.estimateError.p95.toFixed(1)}).`}
                        </p>
                        {hasPlan && (
                            <p className="mt-2 text-xs">
                                <Link to={`/vrs-sim?view=plan&team=${encodeURIComponent(entry.team.replace(/ /g, "_"))}`} className="text-accent hover:underline">
                                    Full plan for {entry.teamName}, with online events and qualifier routes →
                                </Link>
                            </p>
                        )}
                        <LiquipediaCredit what="Event dates, locations, prize pools and participant data" />
                    </>
                )}
            </Section>
            {schedule && <Picker key={schedule.team} schedule={schedule} initial={initial} names={names} />}
        </div>
    );
};

const pts = (share: number) => (share * 100).toFixed(0);
const signedPts = (share: number, digits = 0) => `${share >= 0 ? "+" : "−"}${Math.abs(share * 100).toFixed(digits)}`;

const OddsPoints = ({ odds }: { odds: PlanOdds }) => (
    <Tooltip content="Median points, with the 10th–90th percentile range">
        <span>
            {Math.round(odds.points.p50)}
            <span className="text-muted text-[10px]">
                {" "}
                ({Math.round(odds.points.p10)}–{Math.round(odds.points.p90)})
            </span>
        </span>
    </Tooltip>
);

const PlanEventName = ({ event }: { event: PlanEventRef }) =>
    event.projected !== null ? (
        <span className="text-fg">{event.name}</span>
    ) : (
        <a href={liquipediaUrl(event.liquipedia)} target="_blank" rel="noopener noreferrer" className="text-fg hover:underline">
            {event.name}
        </a>
    );

const ROUTE_LABEL: Record<PlanOptionKind, string | null> = { event: null, qualify: "via qualifier", inviteOrQualify: "invite or qualifier" };

const PlanRoute = ({ plan, schedule }: { plan: PlanTeamFile; schedule: PlanSchedule }) => {
    const entries = timeline(plan, schedule);
    const maxWorth = Math.max(...entries.map((e) => e.worth ?? 0), NOISE_WORTH);
    return (
        <ol className="space-y-2 text-xs font-mono">
            {entries.map((e) => {
                const route = e.option && ROUTE_LABEL[e.option.kind];
                return (
                    <li key={e.event.slug} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] gap-x-3 items-start">
                        <span className="text-muted whitespace-nowrap">{shortDate(e.event.startDate)}</span>
                        <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-1.5">
                                <PlanEventName event={e.event} />
                                <Badge>{e.event.kind === "lan" ? "LAN" : "Online"}</Badge>
                                {e.event.tier !== null && <Badge>Tier {e.event.tier}</Badge>}
                                {e.status === "locked" && <Badge tone="accent">announced</Badge>}
                                {e.status === "committed" && <Badge>under way</Badge>}
                                {route && <Badge tone="accent">{route}</Badge>}
                                {e.event.projected !== null && (
                                    <Tooltip content="Not listed on Liquipedia yet; stepped from its series' past editions">
                                        <Badge tone="heat">projected {percent(e.event.projected)}</Badge>
                                    </Tooltip>
                                )}
                                {e.event.generic && (
                                    <Tooltip content="Format assumed from the team count">
                                        <Badge>assumed format</Badge>
                                    </Tooltip>
                                )}
                            </span>
                            {e.route && <span className="block text-muted whitespace-normal">{e.route}</span>}
                        </span>
                        <span className="text-right whitespace-nowrap">
                            {e.worth === null ? null : e.noise ? (
                                <Tooltip content="Dropping it changes the hold-out invite odds by less than half a point: within simulation noise">
                                    <span className="text-muted">no measurable gain</span>
                                </Tooltip>
                            ) : (
                                <Tooltip content="Points of invite odds lost on the hold-out simulations by dropping it from this schedule">
                                    <span className="inline-flex items-center gap-2">
                                        <span className="hidden sm:inline-block h-1.5 rounded-sm bg-accent" style={{ width: `${Math.max(0, e.worth / maxWorth) * 4}rem` }} />
                                        worth {signedPts(e.worth, 1)}
                                    </span>
                                </Tooltip>
                            )}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
};

const Plan = ({ index }: { index: SeasonIndex }) => {
    const [queryParams, setQueryParams] = useQueryParams();
    const planIndex = useQuery(planIndexQuery);
    const entries = planIndex.data?.teams ?? [];
    const requested = teamFromParam(queryParams.get("team") ?? "");
    const entry = entries.find((e) => e.team === requested) ?? entries[0];
    const planQuery = useQuery({ ...planTeamQuery(entry?.file ?? ""), enabled: !!entry });

    if (planIndex.isLoading) return <LoadingBar label="Loading team plans…" />;
    if (planIndex.error) return <EmptyState className="text-down">Error loading team plans.</EmptyState>;
    if (!entry) return <EmptyState>No team plans published yet.</EmptyState>;
    const plan = planQuery.data;
    const requestedPlan = Number(queryParams.get("plan") ?? NaN);
    const selected = plan && Number.isInteger(requestedPlan) && requestedPlan >= 0 && requestedPlan < plan.schedules.length ? requestedPlan : plan ? defaultSchedule(plan) : 0;
    const chosen = plan?.schedules[selected];
    const optionsById = new Map(plan?.options.map((o) => [o.id, o]));
    const volumeBadges = (s: PlanSchedule) =>
        s.bestFor.length === 0 ? <span className="text-muted">runner-up</span> : s.bestFor.map((v) => <Badge key={v}>{VOLUME_LABEL[v]}</Badge>);

    return (
        <div className="space-y-10">
            <Section
                title={`${entry.teamName}: route to the ${entry.target.name} invite`}
                subtitle={
                    plan && (
                        <>
                            Elo and results as of {plan.asOf} / {plan.runs.search} search, {plan.runs.holdout} hold-out and {plan.runs.exact} exact simulations / LAN and
                            online caps {(["low", "average", "high"] as const).map((v) => `${plan.caps[v].lan} + ${plan.caps[v].online}`).join(", ")}
                            {stale(plan, index) && (
                                <>
                                    {" "}
                                    <Badge tone="heat">older than the season simulation ({index.asOf})</Badge>
                                </>
                            )}
                        </>
                    )
                }
                actions={
                    <Select
                        aria-label="Team"
                        value={entry.team}
                        options={entries.map((e) => ({ value: e.team, label: e.teamName }))}
                        onChange={(e) => setQueryParams({ team: e.target.value.replace(/ /g, "_"), plan: null })}
                    />
                }
            >
                {planQuery.isLoading && <LoadingBar label="Loading plan…" />}
                {planQuery.error && <EmptyState className="text-down">Error loading {entry.teamName}'s plan.</EmptyState>}
                {plan && (
                    <>
                        <DataTable>
                            <TableHead>
                                <Th align="left">Schedule</Th>
                                <Th align="left">Events</Th>
                                <Th>Major invite</Th>
                                <Th>vs season rules</Th>
                                <Th className="hidden sm:table-cell">Exact</Th>
                                <Th className="hidden sm:table-cell">Points at {plan.target.date}</Th>
                            </TableHead>
                            <TableBody>
                                {scheduleRows(plan).map((row) =>
                                    row.kind === "baseline" ? (
                                        <Row key={row.label}>
                                            <Td className="font-sans text-muted whitespace-normal">{row.label}</Td>
                                            <Td className="font-mono text-[11px] text-muted whitespace-normal">
                                                {row.label === "Season rules"
                                                    ? "Whatever invites come"
                                                    : plan.locked.length + plan.committed.length === 0
                                                      ? "No events"
                                                      : [...plan.locked, ...plan.committed].map((e) => e.name).join(", ")}
                                            </Td>
                                            <Td align="right" className="font-mono text-muted">
                                                {percent(row.odds.invite)}
                                            </Td>
                                            <Td />
                                            <Td className="hidden sm:table-cell" />
                                            <Td align="right" className="font-mono text-muted hidden sm:table-cell">
                                                <OddsPoints odds={row.odds} />
                                            </Td>
                                        </Row>
                                    ) : (
                                        <Row key={row.index} highlighted={row.index === selected}>
                                            <Td className="font-sans whitespace-normal">
                                                <button
                                                    type="button"
                                                    aria-pressed={row.index === selected}
                                                    onClick={() => setQueryParams({ plan: String(row.index) })}
                                                    className="flex flex-wrap gap-1 items-center text-left cursor-pointer"
                                                >
                                                    {volumeBadges(row.schedule)}
                                                </button>
                                            </Td>
                                            <Td className="font-mono text-[11px] whitespace-normal">
                                                <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                                                    {row.schedule.options.map((id) => {
                                                        const o = optionsById.get(id);
                                                        if (!o) return null;
                                                        return (
                                                            <span key={id}>
                                                                <PlanEventName event={o.event} />
                                                                {o.kind !== "event" && <span className="text-muted"> ({ROUTE_LABEL[o.kind]})</span>}
                                                            </span>
                                                        );
                                                    })}
                                                </span>
                                            </Td>
                                            <Td align="right" className="font-mono">
                                                {percent(row.schedule.holdout.invite)}
                                            </Td>
                                            <Td align="right" className="font-mono whitespace-nowrap">
                                                <Tooltip content="Paired difference from the season rules on the same hold-out simulations, in points of invite odds, with a 95% interval">
                                                    <span>
                                                        {signedPts(row.schedule.vsHabitual.invite.mean)}
                                                        <span className="text-muted text-[10px]">
                                                            {" "}
                                                            ({pts(row.schedule.vsHabitual.invite.low)} to {pts(row.schedule.vsHabitual.invite.high)})
                                                        </span>
                                                    </span>
                                                </Tooltip>
                                            </Td>
                                            <Td align="right" className="font-mono hidden sm:table-cell">
                                                {row.schedule.exact ? (
                                                    <Tooltip content={`Exact reruns of Valve's model on ${row.schedule.exact.n} hold-out simulations`}>
                                                        <span>{percent(row.schedule.exact.invite)}</span>
                                                    </Tooltip>
                                                ) : (
                                                    "—"
                                                )}
                                            </Td>
                                            <Td align="right" className="font-mono hidden sm:table-cell">
                                                <OddsPoints odds={row.schedule.holdout} />
                                            </Td>
                                        </Row>
                                    )
                                )}
                            </TableBody>
                        </DataTable>
                        <LiquipediaCredit what="Event dates, formats and participant data" />
                    </>
                )}
            </Section>

            {plan && chosen && (
                <Section title="Route" subtitle={chosen.bestFor.length > 0 ? `Best for ${chosen.bestFor.map((v) => VOLUME_LABEL[v]).join(", ")}` : "Runner-up"}>
                    <PlanRoute plan={plan} schedule={chosen} />
                </Section>
            )}

            {plan && (
                <Inset className="text-xs space-y-2">
                    <p>
                        The search tried events, online series and qualifier routes for {plan.teamName} on {plan.runs.search} simulations of the season and kept
                        the schedules with the best smoothed invite odds within each volume cap. The odds shown come from {plan.runs.holdout} other simulations
                        the search never saw, and the interval is a paired 95% interval against the season rules on those same simulations. Exact odds rerun
                        Valve's model on the first {plan.runs.exact}. Of {plan.options.length} options, the search covered the {plan.searched.length} reached in at
                        least {percent(plan.minReach)} of simulations that were worth the most on their own.
                    </p>
                    <p>
                        Rivals' seasons and later invites come from the season rules, so a schedule that lifts the team's rank doesn't earn it more invites
                        here. Fields are partly assumed, as on the rest of this page. Plans are run by hand, not nightly.
                    </p>
                </Inset>
            )}
        </div>
    );
};

const UNANNOUNCED_LABELS: Record<string, string> = { lan2: "tier 2 LANs", lan34: "tier 3–4 LANs", online: "online events", qualifier: "qualifiers" };

export const VrsSim = () => {
    const [queryParams, setQueryParams] = useQueryParams();
    const requestedView = queryParams.get("view") as View | null;
    const view: View = requestedView && VIEWS.includes(requestedView) ? requestedView : "calendar";

    const [query, setQuery] = useState(queryParams.get("q") ?? "");
    const urlQuery = queryParams.get("q") ?? "";
    useEffect(() => {
        setQuery(urlQuery);
    }, [urlQuery]);

    const indexQuery = useQuery({ queryKey: ["sim", "season", "index"], queryFn: () => fetchSimJson<SeasonIndex>("season/index.json") });
    const standingsQuery = useQuery({
        queryKey: ["sim", "season", "standings"],
        queryFn: () => fetchSimJson<SeasonStandings>("season/standings.json"),
        enabled: view === "projections",
    });
    const index = indexQuery.data;
    const error = indexQuery.error ?? standingsQuery.error;

    if (indexQuery.isLoading || (view === "projections" && standingsQuery.isLoading)) return <LoadingBar label="Loading season simulation…" />;
    if (index === null) return <EmptyState>The season simulation hasn't run yet.</EmptyState>;
    if (error || !index) {
        return <EmptyState className="text-down">Error loading the season simulation: {error instanceof Error ? error.message : "Unknown error"}</EmptyState>;
    }
    const simulated = index.events.filter((e) => e.simulated);
    const unannounced = (index.unannounced ?? [])
        .filter((u) => Math.round(u.expected) > 0)
        .map((u) => `${Math.round(u.expected)} ${UNANNOUNCED_LABELS[u.category] ?? u.category}`);

    return (
        <div className="space-y-10">
            <PageHeader
                eyebrow="Includes assumed fields"
                title="VRS season simulator"
                subtitle={
                    <>
                        Through the {index.target.name} invite snapshot ({index.target.date}
                        {index.target.estimated && ", estimated"}) / Elo and results as of {index.asOf} / {index.n.toLocaleString("en-US")} simulations /{" "}
                        <Link to="/methodology" className="text-accent hover:underline">
                            methodology
                        </Link>
                    </>
                }
                actions={
                    <div className="flex flex-wrap gap-2">
                        {view === "projections" && (
                            <TextInput
                                value={query}
                                onChange={(e) => {
                                    setQuery(e.target.value);
                                    setQueryParams({ q: e.target.value || null });
                                }}
                                placeholder="Team or player"
                                aria-label="Filter rosters by team or player"
                                className="w-44"
                            />
                        )}
                        <Segmented aria-label="View" options={VIEW_OPTIONS} value={view} onChange={(v) => setQueryParams({ view: v === "calendar" ? null : v, q: null, team: null })} />
                    </div>
                }
            />

            <Inset className="text-xs space-y-2">
                <p>
                    Each simulation plays the {simulated.length} upcoming LANs, online events and qualifiers it can, in date order, and reruns
                    Valve's Regional Standings model at every publication date: {index.checkpoints.join(", ")}. Open invite slots go down
                    each projected VRS list in rank order, and each team accepts as often as teams of its rank took that kind of invite in
                    past editions. A qualifier the simulation plays sends its top finishers to the event it feeds. Fields with no invite
                    rule, and the winners of qualifiers it doesn't play, are drawn by rank band and region the way past editions of the
                    series filled. A team declines when the event clashes with one it's already attending (2 days to
                    travel within a region, 4 across regions), when it has played as much as it usually does, or at its usual maximum
                    (at least {index.volume.high} LANs).
                </p>
                <p>
                    Recurring series also get the editions Liquipedia doesn't list yet, at their usual gap. Each is played in as many runs as past
                    projections came true.
                    {unannounced.length > 0 && (
                        <>
                            {" "}
                            Events Liquipedia will list later are filled in at each region&apos;s usual rate, for rivals&apos; points only: about{" "}
                            {unannounced.join(", ")} per simulation. They aren&apos;t shown or offered in schedules.
                        </>
                    )}{" "}
                    Schedules also offer LANs with an assumed format and invite, marked as such. This page shows what-ifs from announced and assumed
                    fields. The{" "}
                    <Link to="/major" className="text-accent hover:underline">
                        Major invite odds
                    </Link>{" "}
                    use announced events only.
                </p>
            </Inset>

            {view === "calendar" && <Calendar index={index} />}
            {view === "projections" && standingsQuery.data && <Projections index={index} standings={standingsQuery.data} query={query} />}
            {view === "schedules" && <Schedules index={index} />}
            {view === "plan" && <Plan index={index} />}
        </div>
    );
};
