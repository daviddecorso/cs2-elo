import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { Badge, EmptyState, LoadingBar, PageHeader, Section, Tooltip } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { planEventsQuery, seasonEventQuery } from "../data/queries.ts";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { percent } from "../utils/format.ts";
import { teamPath } from "../utils/teams.ts";
import { signed } from "../sim/why.ts";
import type { PlanEvents, SeasonEventFile, SeasonOptimalTeam } from "../sim/types.ts";

const SOURCE_LABEL: Record<SeasonEventFile["field"][number]["source"], string> = {
    announced: "announced",
    vrs: "VRS invite",
    qualifier: "qualifier",
    open: "drawn like past editions",
};
const GOAL_LABEL = { points: "points", invite: "invite" } as const;
const ROUTE_LABEL = { event: "takes a place", qualify: "via qualifier", inviteOrQualify: "invite or qualifier" } as const;

const TeamCell = ({ team, name }: { team: string; name?: string }) => (
    <Link to={teamPath(team)} className="inline-flex items-center gap-2 font-medium text-fg hover:text-accent">
        <TeamLogo team={team} />
        {name ?? team}
    </Link>
);

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

const Picks = ({ team }: { team: SeasonOptimalTeam }) => (
    <span className="flex flex-wrap gap-1">
        {team.picks.map((p) => (
            <Badge key={p.goal} tone="accent">
                {GOAL_LABEL[p.goal]}: {p.volumes.join(", ")}
            </Badge>
        ))}
        {team.dropped && <Badge tone="heat">dropped</Badge>}
    </span>
);

const OptimalTable = ({ rows }: { rows: SeasonOptimalTeam[] }) => (
    <DataTable>
        <TableHead>
            <Th align="left">Team</Th>
            <Th>Attends</Th>
            <Th className="hidden sm:table-cell">Reachable</Th>
            <Th align="left">Recommended in</Th>
            <Th>Alone</Th>
            <Th className="hidden sm:table-cell">Likely finish</Th>
        </TableHead>
        <TableBody>
            {rows.map((t) => (
                <Row key={t.team}>
                    <Td className="font-sans">
                        <TeamCell team={t.team} name={t.teamName} />
                    </Td>
                    <Td align="right" className="font-mono">
                        {percent(t.attend)}
                    </Td>
                    <Td align="right" className="font-mono text-muted hidden sm:table-cell">
                        {percent(t.reach)}
                    </Td>
                    <Td className="font-mono text-[11px] whitespace-normal">
                        {t.picks.length || t.dropped ? <Picks team={t} /> : <span className="text-muted">none</span>}
                    </Td>
                    <Td align="right" className="font-mono whitespace-nowrap">
                        {t.points === null ? (
                            "—"
                        ) : (
                            <Tooltip content="The event alone against no optional events: points at the target when the team goes, and points of invite odds over every run">
                                <span>
                                    {signed(t.points)} pts
                                    {t.invite !== null && <span className="text-muted text-[10px]"> / {signed(t.invite * 100)} invite</span>}
                                </span>
                            </Tooltip>
                        )}
                    </Td>
                    <Td align="right" className="font-mono text-muted hidden sm:table-cell">
                        {t.finish ?? "—"}
                    </Td>
                </Row>
            ))}
        </TableBody>
    </DataTable>
);

/** Teams whose recommended schedules disagree with where the season rules send them, plus planned teams' routes here. */
export const WhoShouldGo = ({ slug }: { slug: string }) => {
    const { data } = useQuery(seasonEventQuery(slug));
    const plans = useQuery(planEventsQuery);
    if (!data) return null;
    const missing = data.optimal.filter((t) => t.picks.length > 0 && t.attend < 0.5);
    const extra = data.optimal.filter((t) => t.attend >= 0.5 && (t.dropped || t.picks.length === 0));
    const planned: PlanEvents["events"][string] = plans.data?.events[slug] ?? [];
    if (missing.length === 0 && extra.length === 0 && planned.length === 0) return null;
    const open = Math.max(0, data.teams - data.announced);

    return (
        <Section
            title="Who should go"
            subtitle={`The schedule search scores every top-60 team's LAN options at the ${data.target.name} invite snapshot (${data.target.date}). ${data.demand} team${data.demand === 1 ? "'s" : "s'"} average-volume schedule includes this event, for ${open} open place${open === 1 ? "" : "s"}. Each team is optimized with rivals' seasons fixed, so this is what each would choose alone, not a field that could all fit.`}
        >
            <div className="space-y-6">
                {missing.length > 0 && (
                    <div>
                        <h3 className="text-xs font-mono uppercase tracking-wider text-muted mb-2">Recommended, but usually elsewhere</h3>
                        <OptimalTable rows={missing} />
                    </div>
                )}
                {extra.length > 0 && (
                    <div>
                        <h3 className="text-xs font-mono uppercase tracking-wider text-muted mb-2">Usually there, but no recommended schedule needs it</h3>
                        <OptimalTable rows={extra} />
                    </div>
                )}
                {planned.length > 0 && (
                    <div>
                        <h3 className="text-xs font-mono uppercase tracking-wider text-muted mb-2">In teams' invite plans</h3>
                        <ul className="space-y-1 text-xs font-mono">
                            {planned.map((p) => (
                                <li key={p.team} className="flex flex-wrap items-center gap-2">
                                    <TeamCell team={p.team} name={p.teamName} />
                                    <Badge>{ROUTE_LABEL[p.route]}</Badge>
                                    {p.worth !== null && (
                                        <Tooltip content="Points of invite odds the plan loses by dropping this event">
                                            <span className="text-muted">worth {signed(p.worth * 100, 1)} invite</span>
                                        </Tooltip>
                                    )}
                                    <Link to={`/vrs-sim?view=plan&team=${encodeURIComponent(p.team.replace(/ /g, "_"))}`} className="text-accent hover:underline">
                                        plan →
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
            <LiquipediaCredit what="Event dates, prize pools and participant data" />
        </Section>
    );
};

/** An upcoming event the season simulation plays but no bracket config covers. */
export const SeasonEventPage = ({ slug }: { slug: string }) => {
    const { data, isLoading, error } = useQuery(seasonEventQuery(slug));
    if (isLoading) return <LoadingBar label="Loading event…" />;
    if (data === null) return <EmptyState>This event hasn't been simulated yet.</EmptyState>;
    if (error || !data) return <EmptyState className="text-down">Error loading event: {error instanceof Error ? error.message : "Unknown error"}</EmptyState>;
    const e = data.event;
    const page = e.projection ? e.projection.lastPage : e.liquipedia;

    return (
        <div className="space-y-10">
            <PageHeader
                eyebrow={
                    <Link to="/events" className="hover:text-fg">
                        Events
                    </Link>
                }
                title={e.name}
                subtitle={
                    <>
                        {e.startDate} to {e.endDate}
                        {e.location && (e.location.region || e.location.country) && ` / ${e.location.region ?? e.location.country.toUpperCase()}`} /{" "}
                        {e.kind === "lan" ? "LAN" : "Online"}
                        {e.tier !== null && ` / Tier ${e.tier}`}
                        {e.prizePool > 0 && ` / ${usd(e.prizePool)}`} / {e.simulated ? `${data.n.toLocaleString("en-US")} season simulations` : "not simulated"} as of {data.asOf} /{" "}
                        <a href={liquipediaUrl(page)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                            {e.projection ? "Last edition on Liquipedia" : "Liquipedia"}
                        </a>
                    </>
                }
            />
            <Section
                title={e.simulated ? "Likely field" : "Announced teams"}
                subtitle={
                    e.simulated
                        ? `${data.announced} of ${data.teams || "?"} places announced. The rest are filled the way past editions went: VRS invites down the list, qualifiers and open draws. Share of season simulations each team attends.`
                        : `${data.announced} of ${data.teams || "?"} places announced. Not simulated: ${e.reason ?? "no simulated format"}.`
                }
                actions={
                    <span className="flex flex-wrap gap-1">
                        {e.projection && (
                            <Tooltip content="Not listed on Liquipedia yet; stepped from its series' past editions">
                                <Badge tone="heat">projected, played in {percent(e.projection.chance)}</Badge>
                            </Tooltip>
                        )}
                        {e.generic && <Badge>assumed format</Badge>}
                        {e.assumed.includes("field") && <Badge>assumed field</Badge>}
                    </span>
                }
            >
                {data.field.length === 0 ? (
                    <EmptyState>{e.simulated ? "No simulated field." : "No teams announced yet."}</EmptyState>
                ) : !e.simulated ? (
                    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                        {data.field.map((t) => (
                            <li key={t.team}>
                                <TeamCell team={t.team} />
                            </li>
                        ))}
                    </ul>
                ) : (
                    <DataTable>
                        <TableHead>
                            <Th align="left">Team</Th>
                            <Th>Attends</Th>
                            <Th align="left" className="hidden sm:table-cell">
                                Usually via
                            </Th>
                            <Th>Likely finish</Th>
                            <Th>Win</Th>
                        </TableHead>
                        <TableBody>
                            {data.field.map((t) => (
                                <Row key={t.team}>
                                    <Td className="font-sans">
                                        <TeamCell team={t.team} />
                                    </Td>
                                    <Td align="right" className="font-mono">
                                        {percent(t.attend)}
                                    </Td>
                                    <Td className="font-mono text-[11px] text-muted hidden sm:table-cell">{SOURCE_LABEL[t.source]}</Td>
                                    <Td align="right" className="font-mono text-muted">
                                        {t.finish ?? "—"}
                                    </Td>
                                    <Td align="right" className="font-mono">
                                        {t.win === null ? "—" : percent(t.win)}
                                    </Td>
                                </Row>
                            ))}
                        </TableBody>
                    </DataTable>
                )}
                <LiquipediaCredit what="Event dates, prize pools and participant data" />
            </Section>
            <WhoShouldGo slug={slug} />
        </div>
    );
};
