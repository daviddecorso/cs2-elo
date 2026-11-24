import React, { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { Badge, DataRow, EmptyState, Inset, Label, LoadingBar, PageHeader, Section, Tooltip } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { StintTable } from "../components/StintTable.tsx";
import { PlayerLink, WaaRateValue } from "../components/WarValues.tsx";
import { waaRate } from "../war/players.ts";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { teamFromParam } from "../utils/teams.ts";
import { percent } from "../utils/format.ts";
import { fetchSimJson } from "../sim/fetch.ts";
import { eloGamesQuery, eloRankingsQuery, planIndexQuery, playerWarQuery, tacticsQuery, teamDuelsQuery, teamStatsQuery } from "../data/queries.ts";
import {
    duelColumns,
    duelCount,
    roundColumns,
    roundCount,
    tacticsColumns,
    type StintBase,
    type StintColumn,
    type StintCount,
} from "../war/teamColumns.ts";
import { getRosterKey } from "../vrs/types.ts";
import type { EloGameLog, EloRoster } from "../elo/types.ts";
import { TeamLink } from "../components/TeamLink.tsx";
import type { EventIndexEntry, EventOdds, InviteIndexEntry, InviteOdds, InviteOddsRoster, SeasonIndex } from "../sim/types.ts";
import type { WarPlayer } from "../war/types.ts";


const signed = (n: number, digits = 0) => (n > 0 ? `+${n.toFixed(digits)}` : n.toFixed(digits));

const RosterCard = ({ roster }: { roster: EloRoster }) => {
    const offsets = Object.entries(roster.mapOffsets).sort((a, b) => b[1] - a[1]);
    return (
        <Inset className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4 text-xs font-mono">
            <div className="space-y-1">
                <Label>Roster</Label>
                <div className="font-sans text-fg whitespace-normal">
                    {roster.players.map((p, i) => (
                        <React.Fragment key={p.page}>
                            {i > 0 && ", "}
                            <a href={liquipediaUrl(p.page)} target="_blank" rel="noopener noreferrer" className="hover:text-accent hover:underline">
                                {p.nick}
                            </a>
                        </React.Fragment>
                    ))}
                </div>
                <dl className="space-y-0.5 pt-1">
                    <DataRow label="Elo rank">
                        <Link to={`/rankings?q=${encodeURIComponent(roster.team)}`} className="text-accent hover:underline">
                            #{roster.rank}
                        </Link>
                    </DataRow>
                    <DataRow label="Rating">{Math.round(roster.rating)}</DataRow>
                </dl>
            </div>
            <dl className="space-y-0.5">
                <Label>Activity</Label>
                <DataRow label="Maps rated">{roster.maps}</DataRow>
                <DataRow label="Last series">{roster.lastMatch}</DataRow>
                <DataRow label="Region">{roster.region ?? "–"}</DataRow>
                <DataRow label="VRS roster">
                    {roster.vrs ? `#${roster.vrs.rank} ${roster.vrs.teamName} (${Math.round(roster.vrs.points)})` : "Unranked"}
                </DataRow>
                {roster.departed.length > 0 && <DataRow label="Left squad">{roster.departed.join(", ")}</DataRow>}
            </dl>
            <dl className="space-y-0.5">
                <Label>Map offsets</Label>
                {offsets.length === 0 && <div className="text-muted">–</div>}
                {offsets.map(([map, offset]) => (
                    <DataRow key={map} label={map}>
                        <span className={offset > 0 ? "text-up" : offset < 0 ? "text-down" : "text-muted"}>{signed(offset)}</span>
                    </DataRow>
                ))}
            </dl>
        </Inset>
    );
};

const eventName = (page: string) => page.replace(/_/g, " ").split("/").join(" ");

const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

const GameLogSection = ({ log }: { log: EloGameLog }) => {
    const { games } = log;
    const wins = games.filter((g) => g.won).length;
    const avgOpp = games.reduce((sum, g) => sum + g.oppElo, 0) / games.length;
    return (
        <Section
            title="Game log"
            subtitle={`Since ${log.from} / ${games.length} series / ${wins}-${games.length - wins} / avg opp Elo ${Math.round(avgOpp)}`}
        >
            <DataTable>
                <TableHead>
                    <Th>Date</Th>
                    <Th align="left">Opponent</Th>
                    <Th align="left" className="hidden md:table-cell">
                        Event
                    </Th>
                    <Th align="left">Result</Th>
                    <Th>Elo</Th>
                    <Th>Opp Elo</Th>
                    <Th>Win %</Th>
                    <Th>Elo Δ</Th>
                </TableHead>
                <TableBody>
                    {games.map((g, i) => (
                        <Row key={i}>
                            <Td className="text-muted">{shortDate(g.date)}</Td>
                            <Td align="left" className="font-sans">
                                <span className="inline-block w-8 font-mono text-[10px] uppercase text-muted">{g.lan ? "LAN" : "Onl"}</span>
                                <TeamLink team={g.opponent} logoSize={16} />
                            </Td>
                            <Td align="left" className="hidden md:table-cell text-muted">
                                <a href={liquipediaUrl(g.event)} target="_blank" rel="noopener noreferrer" className="hover:text-accent hover:underline">
                                    {eventName(g.event)}
                                </a>
                                <span className="text-muted/60"> T{g.tier}</span>
                            </Td>
                            <Td align="left">
                                <Tooltip content={g.maps.map((m) => `${m.map} ${m.rounds[0]}-${m.rounds[1]}`).join(", ")}>
                                    <span className={g.won ? "text-up" : "text-down"}>{g.won ? "W" : "L"}</span>{" "}
                                    <span className="text-fg">
                                        {g.score[0]}-{g.score[1]}
                                    </span>
                                    <span className="text-muted"> Bo{g.bestOf}</span>
                                </Tooltip>
                            </Td>
                            <Td className="text-fg">{Math.round(g.elo)}</Td>
                            <Td className="text-muted">{Math.round(g.oppElo)}</Td>
                            <Td className="text-fg">{Math.round(g.p * 100)}%</Td>
                            <Td className={g.delta > 0 ? "text-up" : g.delta < 0 ? "text-down" : "text-muted"}>{signed(g.delta, 1)}</Td>
                        </Row>
                    ))}
                </TableBody>
            </DataTable>
            <div className="space-y-1">
                <div className="text-xs text-muted">
                    Elo and Opp Elo are before the series; Win % is the pre-series forecast. Hover a result for map scores.
                </div>
                <LiquipediaCredit what="Match and map results" />
            </div>
        </Section>
    );
};

const Pct = ({ p }: { p: number }) => <span className={p === 0 ? "text-muted/50" : "text-fg"}>{percent(p)}</span>;

const EventOddsSection = ({ team, events }: { team: string; events: EventOdds[] }) => {
    const rows = events.flatMap((e) => {
        const t = e.teams.find((x) => x.team === team);
        return t ? [{ event: e, team: t }] : [];
    });
    if (rows.length === 0) return null;
    return (
        <Section title="Event odds" subtitle="Simulated chances at announced events.">
            <DataTable>
                <TableHead>
                    <Th align="left">Event</Th>
                    <Th className="hidden sm:table-cell">Dates</Th>
                    <Th>Deepest stage</Th>
                    <Th>Win</Th>
                </TableHead>
                <TableBody>
                    {rows.map(({ event, team: t }) => {
                        const last = event.stages.at(-1);
                        return (
                            <Row key={event.slug}>
                                <Td className="font-sans">
                                    <Link to={`/events/${event.slug}`} className="font-medium text-fg hover:text-accent">
                                        {event.name}
                                    </Link>
                                </Td>
                                <Td align="right" className="hidden sm:table-cell text-muted">
                                    {event.startDate} to {event.endDate}
                                </Td>
                                <Td align="right">
                                    {last ? (
                                        <>
                                            <span className="text-muted">{last.name} </span>
                                            <Pct p={t.reach[last.id] ?? 0} />
                                        </>
                                    ) : (
                                        "–"
                                    )}
                                </Td>
                                <Td align="right">
                                    <Pct p={t.placements[event.placements[0]] ?? 0} />
                                </Td>
                            </Row>
                        );
                    })}
                </TableBody>
            </DataTable>
            <LiquipediaCredit what="Brackets and results" />
        </Section>
    );
};

/** VRS names often differ from Liquipedia's, so rosters match by player key first and by name only as a fallback. */
const InviteSection = ({ team, rosterKeys, invites }: { team: string; rosterKeys: Set<string>; invites: InviteOdds[] }) => {
    const rows = invites.flatMap((inv) =>
        inv.rosters.filter((r) => rosterKeys.has(r.rosterKey) || r.teamName === team).map((r) => ({ invite: inv, roster: r }))
    );
    if (rows.length === 0) return null;
    const fmt = (n: number) => (n >= 999 ? "unranked" : String(n));
    return (
        <Section title="Major invite odds" subtitle="Chance each rated roster is invited to each Major stage, from simulated VRS snapshots.">
            <DataTable>
                <TableHead>
                    <Th align="left">Major</Th>
                    <Th align="left" className="hidden md:table-cell">
                        Roster
                    </Th>
                    <Th>Stage 3</Th>
                    <Th>Stage 2</Th>
                    <Th>Stage 1</Th>
                    <Th>Miss</Th>
                    <Th className="hidden sm:table-cell">Regional rank</Th>
                </TableHead>
                <TableBody>
                    {rows.map(({ invite, roster }: { invite: InviteOdds; roster: InviteOddsRoster }) => (
                        <Row key={`${invite.slug}-${roster.rosterKey}`}>
                            <Td className="font-sans">
                                <Link to={`/major/${invite.slug}?region=${roster.region}`} className="font-medium text-fg hover:text-accent">
                                    {invite.name}
                                </Link>
                            </Td>
                            <Td className="hidden md:table-cell font-sans text-muted">{roster.players.join(", ")}</Td>
                            <Td align="right">
                                <Pct p={roster.stage3} />
                            </Td>
                            <Td align="right">
                                <Pct p={roster.stage2} />
                            </Td>
                            <Td align="right">
                                <Pct p={roster.stage1} />
                            </Td>
                            <Td align="right">
                                <Pct p={roster.miss} />
                            </Td>
                            <Td align="right" className="hidden sm:table-cell">
                                <Tooltip content="Median projected regional rank, with the 10th–90th percentile range">
                                    <span>
                                        {fmt(roster.rank.p50)}
                                        <span className="text-muted text-[10px]">
                                            {" "}
                                            ({fmt(roster.rank.p10)}–{fmt(roster.rank.p90)})
                                        </span>
                                    </span>
                                </Tooltip>
                            </Td>
                        </Row>
                    ))}
                </TableBody>
            </DataTable>
            <LiquipediaCredit what="Tournament and roster data" />
        </Section>
    );
};

const StintSection = <T extends StintBase>({
    title,
    rows,
    columns,
    count,
}: {
    title: string;
    rows: T[];
    columns: StintColumn<T>[];
    count?: StintCount<T>;
}) =>
    rows.length === 0 || columns.length === 0 ? null : (
        <div className="space-y-2">
            <Label>{title}</Label>
            <StintTable rows={rows} columns={columns} count={count} showTeam={false} emptyMessage="No stints" />
        </div>
    );

const PlayersSection = ({ players }: { players: WarPlayer[] }) => {
    if (players.length === 0) return null;
    const sorted = [...players].sort((a, b) => waaRate(b) - waaRate(a));
    return (
        <Section
            title="Players / round-wins above role average"
            subtitle={
                <>
                    WAA per 100 rounds, shrunk toward the league average for sample size. Full breakdown on{" "}
                    <Link to="/players" className="text-accent hover:underline">
                        Players
                    </Link>
                    .
                </>
            }
        >
            <DataTable>
                <TableHead>
                    <Th align="left">Player</Th>
                    <Th align="left" className="hidden sm:table-cell">
                        T / CT role
                    </Th>
                    <Th>Rounds</Th>
                    <Th>WAA / 100</Th>
                </TableHead>
                <TableBody>
                    {sorted.map((p) => (
                        <Row key={p.steamid}>
                            <Td className="font-sans">
                                <span className="inline-flex items-center gap-1.5">
                                    <PlayerLink name={p.name} />
                                    {p.isIgl && <Badge tone="accent">IGL</Badge>}
                                </span>
                            </Td>
                            <Td className="hidden sm:table-cell text-muted">
                                {p.tRole} / {p.ctRole}
                            </Td>
                            <Td align="right" className="text-muted tabular-nums">
                                {p.rounds.toLocaleString("en-US")}
                            </Td>
                            <Td align="right">
                                <WaaRateValue player={p} />
                            </Td>
                        </Row>
                    ))}
                </TableBody>
            </DataTable>
            <div className="space-y-1">
                <LiquipediaCredit what="Team, roster and player page data" />
                <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
            </div>
        </Section>
    );
};

export const TeamPage = () => {
    const { team: param = "" } = useParams();
    const team = teamFromParam(param);

    const elo = useQuery(eloRankingsQuery);
    const games = useQuery(eloGamesQuery(team));
    const duels = useQuery(teamDuelsQuery);
    const stats = useQuery(teamStatsQuery);
    const tactics = useQuery(tacticsQuery);
    const war = useQuery(playerWarQuery);
    const eventIndex = useQuery({
        queryKey: ["sim", "events"],
        queryFn: () => fetchSimJson<EventIndexEntry[]>("events/index.json"),
    });
    const inviteIndex = useQuery({
        queryKey: ["sim", "invites"],
        queryFn: () => fetchSimJson<InviteIndexEntry[]>("invites/index.json"),
    });
    const seasonIndex = useQuery({
        queryKey: ["sim", "season", "index"],
        queryFn: () => fetchSimJson<SeasonIndex>("season/index.json"),
    });
    const hasSchedule = !!seasonIndex.data?.schedules?.some((s) => s.team === team);
    const planIndex = useQuery(planIndexQuery);
    const hasPlan = !!planIndex.data?.teams.some((t) => t.team === team);
    const events = useQueries({
        queries: (eventIndex.data ?? []).map((e) => ({
            queryKey: ["sim", "event", e.slug],
            queryFn: () => fetchSimJson<EventOdds>(`events/${e.slug}.json`),
        })),
    });
    const invites = useQueries({
        queries: (inviteIndex.data ?? []).map((m) => ({
            queryKey: ["sim", "invites", m.slug],
            queryFn: () => fetchSimJson<InviteOdds>(`invites/${m.slug}.json`),
        })),
    });

    const rosters = useMemo(() => (elo.data?.rosters ?? []).filter((r) => r.team === team), [elo.data, team]);
    const rosterKeys = useMemo(() => new Set(rosters.map((r) => getRosterKey(r.players.map((p) => p.nick)))), [rosters]);
    const duelRows = useMemo(() => (duels.data?.teams ?? []).filter((t) => t.lp_team === team), [duels.data, team]);
    const roundRows = useMemo(() => (stats.data?.teams ?? []).filter((t) => t.lp_team === team), [stats.data, team]);
    const tacticsRows = useMemo(() => (tactics.data?.teams ?? []).filter((t) => t.lp_team === team), [tactics.data, team]);
    const players = useMemo(() => (war.data?.players ?? []).filter((p) => p.lpTeam === team), [war.data, team]);
    const eventData = events.flatMap((q) => (q.data ? [q.data] : []));
    const inviteData = invites.flatMap((q) => (q.data ? [q.data] : []));

    if (elo.isLoading) return <LoadingBar label="Loading team…" />;

    const hasStints = duelRows.length + roundRows.length + tacticsRows.length > 0;
    const stillLoading = duels.isLoading || stats.isLoading || tactics.isLoading || war.isLoading;
    if (rosters.length === 0 && !hasStints && players.length === 0) {
        if (stillLoading) return <LoadingBar label="Loading team…" />;
        return (
            <EmptyState>
                {`No rated data for “${team}”. `}
                <Link to="/rankings" className="text-accent hover:underline">
                    Back to rankings
                </Link>
            </EmptyState>
        );
    }

    const top = rosters[0];

    return (
        <div className="space-y-10">
            <PageHeader
                eyebrow={
                    <Link to="/rankings" className="hover:text-accent">
                        Rankings
                    </Link>
                }
                title={
                    <span className="inline-flex items-center gap-3">
                        <TeamLogo team={team} size={32} />
                        {team}
                    </span>
                }
                subtitle={
                    <>
                        {top?.region ?? "Region unknown"}
                        {top && ` / Elo #${top.rank} (${Math.round(top.rating)})`}
                        {top?.vrs && ` / VRS #${top.vrs.rank} (${Math.round(top.vrs.points)} pts)`} /{" "}
                        <a href={liquipediaUrl(team)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                            Liquipedia
                        </a>
                        {hasSchedule && (
                            <>
                                {" / "}
                                <Link to={`/vrs-sim?view=schedules&team=${encodeURIComponent(team.replace(/ /g, "_"))}`} className="text-accent hover:underline">
                                    LAN schedule planner
                                </Link>
                            </>
                        )}
                        {hasPlan && (
                            <>
                                {" / "}
                                <Link to={`/vrs-sim?view=plan&team=${encodeURIComponent(team.replace(/ /g, "_"))}`} className="text-accent hover:underline">
                                    Major invite plan
                                </Link>
                            </>
                        )}
                    </>
                }
            />

            {rosters.length > 0 && (
                <Section
                    title={rosters.length > 1 ? "Elo rosters" : "Elo roster"}
                    subtitle="Rosters with 15+ rated maps and a series in the last 90 days. Map offsets are rating points added on each map."
                >
                    <div className="space-y-3">
                        {rosters.map((r) => (
                            <RosterCard key={r.rank} roster={r} />
                        ))}
                    </div>
                    <LiquipediaCredit what="Match, roster, map and team logo data" />
                </Section>
            )}

            {games.data && games.data.games.length > 0 && <GameLogSection log={games.data} />}

            <EventOddsSection team={team} events={eventData} />
            <InviteSection team={team} rosterKeys={rosterKeys} invites={inviteData} />

            {hasStints && (
                <Section
                    title="Team stats by IGL stint (90% series-bootstrap intervals)"
                    subtitle={
                        <>
                            Duels per 100 duels, rounds per 100 rounds, post-plant per 100 post-plant rounds. Definitions and every team on{" "}
                            <Link to="/rankings?view=duels" className="text-accent hover:underline">
                                Rankings
                            </Link>
                            .
                        </>
                    }
                >
                    {duels.data && <StintSection title="Duels" rows={duelRows} columns={duelColumns(duels.data)} count={duelCount} />}
                    {stats.data && <StintSection title="Rounds" rows={roundRows} columns={roundColumns(stats.data)} count={roundCount} />}
                    {tactics.data && <StintSection title="Tactics" rows={tacticsRows} columns={tacticsColumns(tactics.data)} />}
                    <div className="space-y-1">
                        <LiquipediaCredit what="Team pages, rosters and IGLs" />
                        <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
                    </div>
                </Section>
            )}

            <PlayersSection players={players} />
        </div>
    );
};
