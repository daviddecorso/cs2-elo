import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { Badge, DataRow, EmptyState, Inset, Label, LoadingBar, PageHeader, Section } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { RateCell } from "../components/RateCell.tsx";
import { TeamLink } from "../components/TeamLink.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { HltvGapValue, PlayerLink, RateValue, WaaValue } from "../components/WarValues.tsx";
import { CONVERSION_LABEL, CREDIT_OPTIONS, DEFAULT_CREDIT, USAGE_LABEL, rankPlayers, signed } from "../war/players.ts";
import { clutchQuery, playerWarQuery } from "../data/queries.ts";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { clutchTooltip } from "../war/teamColumns.ts";
import type { PlayerWarData, WarPlayer } from "../war/types.ts";

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);

const findPlayer = (players: WarPlayer[], param: string) =>
    players.find((p) => p.name === param) ??
    players.find((p) => p.name.toLowerCase() === param.toLowerCase()) ??
    players.find((p) => p.steamid === param);

const MetricsSection = ({ player, data }: { player: WarPlayer; data: PlayerWarData }) => {
    const ranks = useMemo(
        () =>
            Object.fromEntries(
                CREDIT_OPTIONS.map(({ value }) => {
                    const ranked = rankPlayers(data.players, value);
                    const group = player.isIgl ? ranked.igls : ranked.nonIgls;
                    return [value, { rank: group.find((r) => r.player.steamid === player.steamid)?.rank, of: group.length }];
                })
            ),
        [data, player]
    );

    return (
        <Section
            title={`${data.metric} by credit version (90% round-bootstrap intervals)`}
            subtitle={`Map wins above role average over ${player.maps} maps (${player.rounds.toLocaleString("en-US")} rounds). Per 100 rounds, the rate is team context + usage + conversion. Rank is by rate among ${player.isIgl ? "IGLs" : "non-IGL players"}.`}
        >
            <DataTable>
                <TableHead>
                    <Th align="left">Credit</Th>
                    <Th>{data.metric}</Th>
                    <Th>/ 100 rds</Th>
                    <Th className="hidden md:table-cell">Context</Th>
                    <Th className="hidden md:table-cell">Usage</Th>
                    <Th className="hidden md:table-cell">Conversion</Th>
                    <Th className="hidden sm:table-cell">vs HLTV</Th>
                    <Th>Rank</Th>
                </TableHead>
                <TableBody>
                    {CREDIT_OPTIONS.map(({ value, label }) => {
                        const est = player.metrics[value];
                        const { rank, of } = ranks[value];
                        return (
                            <Row key={value}>
                                <Td className={`font-sans ${value === DEFAULT_CREDIT ? "text-fg" : "text-muted"}`}>{label}</Td>
                                <Td align="right">
                                    <WaaValue est={est} metric={data.metric} />
                                </Td>
                                <Td align="right">
                                    <RateValue est={est} />
                                </Td>
                                <Td align="right" className="hidden md:table-cell text-muted tabular-nums">
                                    {est.context !== undefined ? signed(est.context) : "–"}
                                </Td>
                                <Td align="right" className="hidden md:table-cell">
                                    <RateValue est={est.usage} label={USAGE_LABEL} />
                                </Td>
                                <Td align="right" className="hidden md:table-cell">
                                    <RateValue est={est.conversion} label={CONVERSION_LABEL} />
                                </Td>
                                <Td align="right" className="hidden sm:table-cell">
                                    <HltvGapValue gap={est.hltvGap} />
                                </Td>
                                <Td align="right" className="tabular-nums">
                                    {rank ? `${rank} / ${of}` : "–"}
                                </Td>
                            </Row>
                        );
                    })}
                </TableBody>
            </DataTable>
        </Section>
    );
};

const ProfileSection = ({ player }: { player: WarPlayer }) => {
    const r = player.resources;
    return (
        <Section title="Profile" subtitle="Roles, CT positions, duels, box score and resources over the same window.">
            <Inset className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4 text-xs font-mono">
                <dl className="space-y-0.5">
                    <Label>Roles</Label>
                    <DataRow label="T / CT role">
                        {player.tRole} / {player.ctRole}
                    </DataRow>
                    <DataRow label="AWP buy share">{pct(player.awpShare)}</DataRow>
                    <DataRow label="Opening duel share">{pct(player.entryShare)}</DataRow>
                    <DataRow label="IGL rounds">{pct(player.iglShare)}</DataRow>
                    <div className="pt-1">
                        <Label>CT positions by map</Label>
                    </div>
                    {player.ctByMap.length === 0 && <div className="text-muted">–</div>}
                    {player.ctByMap.map((m) => (
                        <DataRow key={m.map} label={`${m.map} (${m.maps}m)`}>
                            {m.role}
                        </DataRow>
                    ))}
                </dl>

                <dl className="space-y-0.5">
                    <Label>Duels &amp; box score</Label>
                    <DataRow label="Kills above expected">
                        {signed(player.killsAbove, 1)} ({signed(player.killsAbovePer100)} / 100 rds)
                    </DataRow>
                    <DataRow label="Gun duels">{player.duels.toLocaleString("en-US")}</DataRow>
                    <DataRow label="HLTV Rating 3.0">{player.rating3 !== null ? player.rating3.toFixed(2) : "–"}</DataRow>
                    <DataRow label="Rating 2.0 (approx)">{player.rating2Approx !== null ? player.rating2Approx.toFixed(2) : "–"}</DataRow>
                    <DataRow label="HLTV Swing">{player.swing !== null ? signed(player.swing) : "–"}</DataRow>
                    <DataRow label="K/D / ADR">
                        {player.kd !== null ? player.kd.toFixed(2) : "–"} / {player.adr !== null ? player.adr.toFixed(1) : "–"}
                    </DataRow>
                </dl>

                <dl className="space-y-0.5">
                    <Label>Resources</Label>
                    {!r && <div className="text-muted">–</div>}
                    {r && (
                        <>
                            <DataRow label="Equip share eco / force / full">
                                {pct(r.equipShare.eco)} / {pct(r.equipShare.force)} / {pct(r.equipShare.full)}
                            </DataRow>
                            <DataRow label="AWP rounds">{pct(r.awpRate)}</DataRow>
                            <DataRow label="Drops received / given (per 100)">
                                {r.dropsReceivedPer100?.toFixed(1) ?? "–"} / {r.dropsGivenPer100?.toFixed(1) ?? "–"}
                            </DataRow>
                            <DataRow label="Duels with team flash / smoke">
                                {pct(r.flashSupportShare)} / {pct(r.smokeSupportShare)}
                            </DataRow>
                            <DataRow label="Deaths traded">{pct(r.tradedDeathRate)}</DataRow>
                            {r.flashGift !== null && <DataRow label="Kills from team flashes">{signed(r.flashGift, 1)}</DataRow>}
                        </>
                    )}
                </dl>
            </Inset>
        </Section>
    );
};

const ClutchSection = ({ steamid }: { steamid: string }) => {
    const { data } = useQuery(clutchQuery);
    const meta = data?.player_stats.clutch;
    const row = data?.players.find((p) => p.steamid === steamid);
    if (!meta || !row) return null;
    return (
        <Section
            title="Clutch conversion"
            subtitle={
                <>
                    Round wins per 100 clutches above the win-probability model's expectation at even Elo. A tendency, not a skill
                    rating.{" "}
                    <Link to="/players?view=clutch" className="text-accent hover:underline">
                        Every player
                    </Link>
                    .
                </>
            }
        >
            <Inset className="text-xs font-mono">
                <dl className="space-y-0.5 max-w-sm">
                    <DataRow label="Clutches">{row.entries}</DataRow>
                    <DataRow label="Per 100 (90% CI)">
                        <span title={clutchTooltip("Clutch rounds won above expectation", meta)}>
                            <RateCell rate={row.clutch} label="Clutch conversion" unit="clutches" />
                        </span>
                    </DataRow>
                </dl>
            </Inset>
            <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
        </Section>
    );
};

const TeammatesSection = ({ player, data }: { player: WarPlayer; data: PlayerWarData }) => {
    const mates = data.players
        .filter((p) => p.lpTeam !== null && p.lpTeam === player.lpTeam && p.steamid !== player.steamid)
        .sort((a, b) => b.metrics[DEFAULT_CREDIT].per100 - a.metrics[DEFAULT_CREDIT].per100);
    if (!player.lpTeam || mates.length === 0) return null;
    return (
        <Section title="Teammates" subtitle={`Other qualified players whose current team is ${player.lpTeam}.`}>
            <DataTable>
                <TableHead>
                    <Th align="left">Player</Th>
                    <Th align="left" className="hidden sm:table-cell">
                        T / CT role
                    </Th>
                    <Th>Rounds</Th>
                    <Th>/ 100 rds</Th>
                </TableHead>
                <TableBody>
                    {mates.map((p) => (
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
                                <RateValue est={p.metrics[DEFAULT_CREDIT]} />
                            </Td>
                        </Row>
                    ))}
                </TableBody>
            </DataTable>
        </Section>
    );
};

export const PlayerPage = () => {
    const { player: param = "" } = useParams();
    const { data, isLoading, error } = useQuery(playerWarQuery);
    const player = useMemo(() => (data ? findPlayer(data.players, param) : undefined), [data, param]);

    if (isLoading) return <LoadingBar label="Loading player…" />;
    if (error || !data) {
        return (
            <EmptyState className="text-down">
                Error loading players: {error instanceof Error ? error.message : "Unknown error"}
            </EmptyState>
        );
    }
    if (!player) {
        return (
            <EmptyState>
                {`No rated data for “${param}”. `}
                <Link to="/players" className="text-accent hover:underline">
                    Back to players
                </Link>
            </EmptyState>
        );
    }

    return (
        <div className="space-y-10">
            <PageHeader
                eyebrow={
                    <Link to="/players" className="hover:text-accent">
                        Players
                    </Link>
                }
                title={
                    <span className="inline-flex items-center gap-3">
                        {player.lpTeam && <TeamLogo team={player.lpTeam} size={32} />}
                        {player.name}
                        {player.isIgl && <Badge tone="accent">IGL</Badge>}
                    </span>
                }
                subtitle={
                    <span className="inline-flex flex-wrap items-center gap-x-1">
                        {player.lpTeam ? <TeamLink team={player.lpTeam} logoSize={14} /> : "No current team"}
                        <span>
                            {" "}
                            / {player.tRole} (T) / {player.ctRole} (CT) / {player.maps} maps
                        </span>
                        {player.lpPlayer && (
                            <span>
                                {" / "}
                                <a href={liquipediaUrl(player.lpPlayer)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                                    Liquipedia
                                </a>
                            </span>
                        )}
                    </span>
                }
            />

            <MetricsSection player={player} data={data} />
            <ProfileSection player={player} />
            <ClutchSection steamid={player.steamid} />
            <TeammatesSection player={player} data={data} />

            <div className="space-y-1">
                <LiquipediaCredit what="Team, roster and player page data" />
                <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
            </div>
        </div>
    );
};
