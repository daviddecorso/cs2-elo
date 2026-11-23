import { Suspense, lazy, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

const MapTendencies = lazy(() => import("../components/heatmap/MapTendencies.tsx"));
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { Badge, EmptyState, Inset, Label, LoadingBar, PageHeader, Section, Segmented, StatTile, Tooltip } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { PercentileRow } from "../components/PercentileRow.tsx";
import { RateCell } from "../components/RateCell.tsx";
import { TeamLink } from "../components/TeamLink.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { HltvGapValue, PlayerLink, WaaRateValue } from "../components/WarValues.tsx";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { formatMapName } from "../war/heatmap.ts";
import { CONVERSION_LABEL, USAGE_LABEL, WAA_CREDIT, rankPlayers, signed, waaRate } from "../war/players.ts";
import { clutchQuery, heatmapIndexQuery, playerWarQuery, styleQuery } from "../data/queries.ts";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { clutchTooltip } from "../war/teamColumns.ts";
import type { PlayerWarData, StyleComp, StyleData, StyleMetric, StylePlayer, WarPlayer, WarRate } from "../war/types.ts";

const VIEWS = ["overview", "style", "maps"] as const;
type View = (typeof VIEWS)[number];
const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
    { value: "overview", label: "Overview" },
    { value: "style", label: "Style" },
    { value: "maps", label: "Map tendencies" },
];

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);

const findPlayer = (players: WarPlayer[], param: string) =>
    players.find((p) => p.name === param) ??
    players.find((p) => p.name.toLowerCase() === param.toLowerCase()) ??
    players.find((p) => p.steamid === param);

const ProfileRow = ({ label, children }: { label: React.ReactNode; children: React.ReactNode }) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
        <dt className="text-xs text-muted shrink-0">{label}</dt>
        <dd className="text-xs font-mono tabular-nums text-fg text-right min-w-0 truncate">{children}</dd>
    </div>
);

const BreakdownCell = ({
    label,
    value,
    ci,
    caption,
    tooltip,
}: {
    label: string;
    value: React.ReactNode;
    ci?: string;
    caption: string;
    tooltip?: string;
}) => {
    const body = (
        <div className="space-y-1 min-w-0">
            <Label>{label}</Label>
            <div className="text-lg font-mono font-semibold tabular-nums text-fg leading-tight">{value}</div>
            {ci && <div className="text-[11px] font-mono tabular-nums text-muted">{ci}</div>}
            <div className="text-[11px] text-muted">{caption}</div>
        </div>
    );
    return (
        <Inset className="p-3.5">
            {tooltip ? (
                <Tooltip content={tooltip} className="block">
                    {body}
                </Tooltip>
            ) : (
                body
            )}
        </Inset>
    );
};

const rateCi = (est?: WarRate) => (est ? `(${signed(est.per100P5)}, ${signed(est.per100P95)})` : undefined);

const HeroStrip = ({
    player,
    data,
    rank,
    of,
    styleData,
    styleRow,
    onOpenStyle,
}: {
    player: WarPlayer;
    data: PlayerWarData;
    rank?: number;
    of: number;
    styleData?: StyleData | null;
    styleRow?: StylePlayer;
    onOpenStyle: () => void;
}) => {
    const est = player.metrics[WAA_CREDIT];
    const archetype = styleRow?.archetype ? styleData?.archetypes[styleRow.archetype] : undefined;
    const poolLabel = player.isIgl ? "IGLs" : "non-IGLs";

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-5 py-4 border-y border-line">
            <StatTile
                label={`${data.metric} / 100`}
                value={<WaaRateValue player={player} replacementRate={data.replacementRate} />}
                caption={rank ? `Rank ${rank} / ${of} ${poolLabel}` : `${player.rounds.toLocaleString("en-US")} rounds`}
            />
            <StatTile
                label="Map wins"
                value={
                    <Tooltip
                        content={`Total over the window, unshrunk: ${signed(est.waa)} map wins\n90% round bootstrap: (${signed(est.waaP5)}, ${signed(est.waaP95)})`}
                    >
                        <span className="tabular-nums">{signed(est.waa)}</span>
                    </Tooltip>
                }
                caption={`90% CI (${signed(est.waaP5)}, ${signed(est.waaP95)})`}
            />
            <StatTile
                label="HLTV 3.0"
                value={<span className="tabular-nums">{player.rating3 !== null ? player.rating3.toFixed(2) : "–"}</span>}
                caption={`K/D ${player.kd !== null ? player.kd.toFixed(2) : "–"} · ADR ${player.adr !== null ? player.adr.toFixed(1) : "–"}`}
            />
            <div className="min-w-0">
                <Label>{archetype ? "Archetype" : "Roles"}</Label>
                {archetype ? (
                    <>
                        <div className="text-xl sm:text-2xl font-bold tracking-tight text-accent mt-1.5 leading-snug truncate">
                            {archetype.label}
                        </div>
                        <div className="text-xs text-muted mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="truncate">{archetype.description}</span>
                            <button
                                type="button"
                                onClick={onOpenStyle}
                                className="font-mono text-accent hover:underline cursor-pointer shrink-0"
                            >
                                Style →
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="text-xl sm:text-2xl font-bold tracking-tight text-fg mt-1.5 leading-snug truncate">
                            {player.tRole} / {player.ctRole}
                        </div>
                        <div className="text-xs font-mono text-muted mt-1">
                            AWP {pct(player.awpShare)} · Opening {pct(player.entryShare)}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

const MetricsSection = ({ player, data }: { player: WarPlayer; data: PlayerWarData }) => {
    const est = player.metrics[WAA_CREDIT];

    return (
        <Section
            title={`${data.metric} breakdown`}
            subtitle={`Unshrunk per-100-round components over ${player.maps} maps (${player.rounds.toLocaleString("en-US")} rounds). Context + usage + conversion = unshrunk rate; intervals are 90% round bootstraps.`}
        >
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <BreakdownCell
                    label="Unshrunk / 100"
                    value={signed(est.per100)}
                    ci={rateCi(est)}
                    caption="Before sample shrinkage"
                    tooltip={`Round-wins above average per 100 rounds, unshrunk\n90% round bootstrap: ${rateCi(est)}`}
                />
                <BreakdownCell
                    label="Context"
                    value={
                        <span className="text-muted">
                            {est.context !== undefined ? signed(est.context) : "–"}
                        </span>
                    }
                    caption="Team & opponent state"
                />
                <BreakdownCell
                    label="Usage"
                    value={est.usage ? signed(est.usage.per100) : <span className="text-muted">–</span>}
                    ci={rateCi(est.usage)}
                    caption="Gear, utility & drops"
                    tooltip={est.usage ? `${USAGE_LABEL}\n90% round bootstrap: ${rateCi(est.usage)}` : undefined}
                />
                <BreakdownCell
                    label="Conversion"
                    value={est.conversion ? signed(est.conversion.per100) : <span className="text-muted">–</span>}
                    ci={rateCi(est.conversion)}
                    caption="Value made of resources"
                    tooltip={est.conversion ? `${CONVERSION_LABEL}\n90% round bootstrap: ${rateCi(est.conversion)}` : undefined}
                />
                <BreakdownCell
                    label="vs HLTV"
                    value={<HltvGapValue gap={est.hltvGap} />}
                    ci={est.hltvGap ? `(${signed(est.hltvGap.zP5)}, ${signed(est.hltvGap.zP95)})` : undefined}
                    caption="Std. gap vs Rating 3.0"
                />
            </div>
        </Section>
    );
};

const SIGNED_STYLE = new Set(["firepower", "openingWin", "clutch"]);

const styleValue = (key: string, v: number) => {
    const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
    return SIGNED_STYLE.has(key) ? signed(v, digits) : v.toFixed(digits);
};

const CompList = ({
    title,
    items,
    teamById,
}: {
    title: string;
    items: Array<StyleComp & { name: string }>;
    teamById: Map<string, string | null>;
}) => (
    <Inset className="p-4 space-y-2.5">
        <Label>{title}</Label>
        <ul className="divide-y divide-line/60">
            {items.map((c, idx) => {
                const team = teamById.get(c.steamid);
                return (
                    <li key={c.steamid} className="flex items-center justify-between gap-3 py-2 text-xs">
                        <div className="flex items-center gap-2.5 min-w-0">
                            <span className="w-4 font-mono tabular-nums text-[11px] text-muted shrink-0">{idx + 1}</span>
                            <PlayerLink name={c.name} />
                            {team && <span className="text-muted truncate hidden sm:inline">{team}</span>}
                        </div>
                        <div className="flex items-center gap-2.5 shrink-0">
                            <div className="w-16 h-1.5 bg-bg border border-line/70 rounded-full overflow-clip hidden sm:block" aria-hidden="true">
                                <div className="h-full bg-accent/70 rounded-full" style={{ width: `${Math.max(0, Math.min(100, c.similarity))}%` }} />
                            </div>
                            <span className="w-6 text-right font-mono tabular-nums text-fg font-medium">{c.similarity}</span>
                        </div>
                    </li>
                );
            })}
        </ul>
    </Inset>
);

const StyleSection = ({
    player,
    data,
    row,
    war,
    isLoading,
}: {
    player: WarPlayer;
    data?: StyleData | null;
    row?: StylePlayer;
    war?: PlayerWarData;
    isLoading: boolean;
}) => {
    if (isLoading) return <LoadingBar label="Loading style profile…" />;
    if (!data || !row) return <EmptyState>{`No style profile available for ${player.name}.`}</EmptyState>;

    const archetype = row.archetype ? data.archetypes[row.archetype] : undefined;
    const runnerUp = row.runnerUp ? data.archetypes[row.runnerUp] : undefined;
    const rolePool = player.tRole === "AWPer" ? "AWPers" : "non-AWPers";
    const nameById = new Map(war?.players.map((p) => [p.steamid, p.name]));
    const teamById = new Map(war?.players.map((p) => [p.steamid, p.lpTeam]));
    const resolveComps = (items: StyleComp[]) =>
        items.flatMap((c) => {
            const name = nameById.get(c.steamid);
            return name ? [{ ...c, name }] : [];
        });
    const prodComps = resolveComps(row.comps?.production ?? []);
    const styleComps = resolveComps(row.comps?.style ?? []);
    const bars = (group: "production" | "style") =>
        Object.entries(data.metrics)
            .filter(([key, m]) => m.group === group && row.values[key])
            .map(([key, m]: [string, StyleMetric]) => {
                const { value, pct: pctVal } = row.values[key];
                const pool = m.pool === "role" ? rolePool : "all qualified players";
                const formatted = styleValue(key, value);
                return (
                    <PercentileRow
                        key={key}
                        label={m.label}
                        value={formatted}
                        pct={pctVal}
                        tone={group}
                        detail={`${formatted} ${m.unit}\nPercentile among ${pool}`}
                    />
                );
            });

    return (
        <Section
            title="Style"
            subtitle={`Percentiles among the ${data.players.length} players with ${data.minRounds}+ rounds. Style bars compare ${rolePool} only. Hover a metric for units.`}
        >
            {archetype && (
                <Inset className="p-4 sm:p-5 flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0 max-w-2xl">
                        <Label>Archetype</Label>
                        <div className="text-xl font-bold tracking-tight text-accent">{archetype.label}</div>
                        <div className="text-sm text-fg/90 leading-relaxed">{archetype.description}</div>
                    </div>
                    {runnerUp && (
                        <div className="space-y-1 shrink-0">
                            <Label>Next closest</Label>
                            <div className="text-xs font-mono text-fg">
                                <Badge tone="neutral" className="text-xs px-2 py-0.5 normal-case">
                                    {runnerUp.label}
                                </Badge>
                            </div>
                        </div>
                    )}
                </Inset>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Inset className="p-4 space-y-2">
                    <div className="flex items-baseline justify-between gap-2 pb-1.5 border-b border-line/70">
                        <Label>Production</Label>
                        <span className="text-[10px] font-mono text-muted">Value · 0–100 pct</span>
                    </div>
                    <div>{bars("production")}</div>
                </Inset>
                <Inset className="p-4 space-y-2">
                    <div className="flex items-baseline justify-between gap-2 pb-1.5 border-b border-line/70">
                        <Label>Style ({rolePool})</Label>
                        <span className="text-[10px] font-mono text-muted">Value · vs role median</span>
                    </div>
                    <div>{bars("style")}</div>
                </Inset>
            </div>

            {(prodComps.length > 0 || styleComps.length > 0) && (
                <div className="space-y-2.5 pt-2">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {prodComps.length > 0 && <CompList title="Production comps" items={prodComps} teamById={teamById} />}
                        {styleComps.length > 0 && <CompList title="Style comps" items={styleComps} teamById={teamById} />}
                    </div>
                    <div className="text-xs text-muted">
                        Similarity is 100 minus the RMS percentile gap; a random pair scores about 59.
                    </div>
                </div>
            )}
        </Section>
    );
};

const EquipShareBar = ({ eco, force, full }: { eco: number | null; force: number | null; full: number | null }) => {
    const e = eco ?? 0;
    const f = force ?? 0;
    const g = full ?? 0;
    const total = e + f + g;
    if (total <= 0) return null;
    return (
        <div className="h-1.5 w-full rounded-full bg-bg border border-line/70 overflow-clip flex" aria-hidden="true">
            <div className="h-full bg-muted/50" style={{ width: `${(e / total) * 100}%` }} />
            <div className="h-full bg-heat/75" style={{ width: `${(f / total) * 100}%` }} />
            <div className="h-full bg-accent/80" style={{ width: `${(g / total) * 100}%` }} />
        </div>
    );
};

const ProfileSection = ({
    player,
    availableMaps,
    onOpenMap,
}: {
    player: WarPlayer;
    availableMaps: Set<string>;
    onOpenMap: (map: string) => void;
}) => {
    const r = player.resources;
    return (
        <Section title="Profile" subtitle="Roles, CT positions, duels, box score and resources over the same window.">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Inset className="p-4 space-y-4">
                    <div className="space-y-1.5">
                        <Label>Roles</Label>
                        <dl className="divide-y divide-line/60">
                            <ProfileRow label="T / CT role">
                                {player.tRole} / {player.ctRole}
                            </ProfileRow>
                            <ProfileRow label="AWP buy share">{pct(player.awpShare)}</ProfileRow>
                            <ProfileRow label="Opening duel share">{pct(player.entryShare)}</ProfileRow>
                            <ProfileRow label="IGL rounds">{pct(player.iglShare)}</ProfileRow>
                        </dl>
                    </div>

                    <div className="space-y-1.5 pt-2 border-t border-line">
                        <div className="flex items-baseline justify-between gap-2">
                            <Label>CT positions by map</Label>
                            {availableMaps.size > 0 && <span className="text-[10px] font-mono text-muted">Click map for heatmap</span>}
                        </div>
                        {player.ctByMap.length === 0 ? (
                            <div className="text-xs font-mono text-muted">–</div>
                        ) : (
                            <dl className="divide-y divide-line/60">
                                {player.ctByMap.map((m) => {
                                    const hasHeatmap = availableMaps.has(m.map);
                                    const mapLabel = (
                                        <>
                                            <span>{formatMapName(m.map)}</span>
                                            <span className="ml-1 font-mono text-[11px] text-muted">{`(${m.maps}m)`}</span>
                                        </>
                                    );
                                    return (
                                        <ProfileRow
                                            key={m.map}
                                            label={
                                                hasHeatmap ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => onOpenMap(m.map)}
                                                        className="text-fg hover:text-accent hover:underline cursor-pointer text-left"
                                                    >
                                                        {mapLabel}
                                                    </button>
                                                ) : (
                                                    <span className="text-fg">{mapLabel}</span>
                                                )
                                            }
                                        >
                                            {m.role}
                                        </ProfileRow>
                                    );
                                })}
                            </dl>
                        )}
                    </div>
                </Inset>

                <Inset className="p-4 space-y-1.5">
                    <Label>Duels &amp; box score</Label>
                    <dl className="divide-y divide-line/60">
                        <ProfileRow label="Kills above expected">
                            {signed(player.killsAbove, 1)} <span className="text-muted">({signed(player.killsAbovePer100)} / 100)</span>
                        </ProfileRow>
                        <ProfileRow label="Gun duels">{player.duels.toLocaleString("en-US")}</ProfileRow>
                        <ProfileRow label="HLTV Rating 3.0">{player.rating3 !== null ? player.rating3.toFixed(2) : "–"}</ProfileRow>
                        <ProfileRow label="Rating 2.0 (approx)">{player.rating2Approx !== null ? player.rating2Approx.toFixed(2) : "–"}</ProfileRow>
                        <ProfileRow label="HLTV Swing">{player.swing !== null ? signed(player.swing) : "–"}</ProfileRow>
                        <ProfileRow label="K/D · ADR">
                            {player.kd !== null ? player.kd.toFixed(2) : "–"} · {player.adr !== null ? player.adr.toFixed(1) : "–"}
                        </ProfileRow>
                    </dl>
                </Inset>

                <Inset className="p-4 space-y-1.5">
                    <Label>Resources &amp; support</Label>
                    {!r ? (
                        <div className="text-xs font-mono text-muted">–</div>
                    ) : (
                        <dl className="divide-y divide-line/60">
                            <div className="py-1.5 space-y-1.5">
                                <div className="flex items-baseline justify-between gap-3">
                                    <dt className="text-xs text-muted shrink-0">Equip (eco / force / full)</dt>
                                    <dd className="text-xs font-mono tabular-nums text-fg text-right">
                                        {pct(r.equipShare.eco)} / {pct(r.equipShare.force)} / {pct(r.equipShare.full)}
                                    </dd>
                                </div>
                                <EquipShareBar eco={r.equipShare.eco} force={r.equipShare.force} full={r.equipShare.full} />
                            </div>
                            <ProfileRow label="AWP rounds">{pct(r.awpRate)}</ProfileRow>
                            <ProfileRow label="Drops rec / given (per 100)">
                                {r.dropsReceivedPer100?.toFixed(1) ?? "–"} / {r.dropsGivenPer100?.toFixed(1) ?? "–"}
                            </ProfileRow>
                            <ProfileRow label="Team flash / smoke duels">
                                {pct(r.flashSupportShare)} / {pct(r.smokeSupportShare)}
                            </ProfileRow>
                            <ProfileRow label="Deaths traded">{pct(r.tradedDeathRate)}</ProfileRow>
                            {r.flashGift !== null && <ProfileRow label="Kills from team flashes">{signed(r.flashGift, 1)}</ProfileRow>}
                        </dl>
                    )}
                </Inset>
            </div>
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
            <Inset className="p-4 grid grid-cols-2 sm:grid-cols-3 gap-4 items-center">
                <div>
                    <Label>Clutches</Label>
                    <div className="text-lg font-mono font-semibold tabular-nums text-fg mt-0.5">{row.entries}</div>
                </div>
                <div>
                    <Label>Per 100 (90% CI)</Label>
                    <div className="text-base font-mono mt-0.5" title={clutchTooltip("Clutch rounds won above expectation", meta)}>
                        <RateCell rate={row.clutch} label="Clutch conversion" unit="clutches" />
                    </div>
                </div>
                <div className="col-span-2 sm:col-span-1 sm:text-right">
                    <Link to="/players?view=clutch" className="text-xs font-mono text-accent hover:underline">
                        Clutch leaderboard →
                    </Link>
                </div>
            </Inset>
        </Section>
    );
};

const TeammatesSection = ({ player, data }: { player: WarPlayer; data: PlayerWarData }) => {
    const mates = data.players
        .filter((p) => p.lpTeam !== null && p.lpTeam === player.lpTeam && p.steamid !== player.steamid)
        .sort((a, b) => waaRate(b, data.replacementRate) - waaRate(a, data.replacementRate));
    if (!player.lpTeam || mates.length === 0) return null;
    return (
        <Section
            title="Teammates"
            subtitle={
                <>
                    Other qualified players currently on <TeamLink team={player.lpTeam} logoSize={13} />.
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
                    <Th>{data.metric} / 100</Th>
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
                                <WaaRateValue player={p} replacementRate={data.replacementRate} />
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
    const [queryParams, setQueryParams] = useQueryParams();
    const requestedView = queryParams.get("view") as View | null;
    const view: View = requestedView && VIEWS.includes(requestedView) ? requestedView : "overview";
    const selectedMap = queryParams.get("map") ?? undefined;

    const { data, isLoading, error } = useQuery(playerWarQuery);
    const { data: styleData, isLoading: styleLoading } = useQuery(styleQuery);
    const player = useMemo(() => (data ? findPlayer(data.players, param) : undefined), [data, param]);

    const { data: heatmapIndex } = useQuery({
        ...heatmapIndexQuery(player?.steamid ?? ""),
        enabled: Boolean(player?.steamid),
    });

    const availableMaps = useMemo(
        () => new Set((heatmapIndex?.maps ?? []).map((m) => m.map)),
        [heatmapIndex]
    );

    const { rank, of } = useMemo(() => {
        if (!data || !player) return { rank: undefined, of: 0 };
        const { igls, nonIgls } = rankPlayers(data);
        const group = player.isIgl ? igls : nonIgls;
        return { rank: group.find((r) => r.player.steamid === player.steamid)?.rank, of: group.length };
    }, [data, player]);

    const styleRow = useMemo(
        () => (player ? styleData?.players.find((p) => p.steamid === player.steamid) : undefined),
        [styleData, player]
    );

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

    const handleViewChange = (next: View) => {
        setQueryParams({
            view: next === "overview" ? null : next,
            map: next === "maps" ? selectedMap ?? null : null,
        });
    };

    const handleOpenMap = (map: string) => {
        setQueryParams({ view: "maps", map });
    };

    return (
        <div className="space-y-8">
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
                    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                        {player.lpTeam ? <TeamLink team={player.lpTeam} logoSize={14} /> : <span>No current team</span>}
                        <span aria-hidden="true" className="text-line">·</span>
                        <span>
                            {player.tRole} (T) / {player.ctRole} (CT)
                        </span>
                        <span aria-hidden="true" className="text-line">·</span>
                        <span>
                            {player.maps} maps ({player.rounds.toLocaleString("en-US")} rds)
                        </span>
                        {player.lpPlayer && (
                            <>
                                <span aria-hidden="true" className="text-line">·</span>
                                <a href={liquipediaUrl(player.lpPlayer)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                                    Liquipedia ↗
                                </a>
                            </>
                        )}
                    </span>
                }
                actions={
                    <Segmented
                        aria-label="Player section"
                        options={VIEW_OPTIONS}
                        value={view}
                        onChange={handleViewChange}
                    />
                }
            />

            {view === "overview" && (
                <div className="space-y-10">
                    <HeroStrip
                        player={player}
                        data={data}
                        rank={rank}
                        of={of}
                        styleData={styleData}
                        styleRow={styleRow}
                        onOpenStyle={() => handleViewChange("style")}
                    />
                    <MetricsSection player={player} data={data} />
                    <ProfileSection player={player} availableMaps={availableMaps} onOpenMap={handleOpenMap} />
                    <ClutchSection steamid={player.steamid} />
                    <TeammatesSection player={player} data={data} />
                </div>
            )}

            {view === "style" && (
                <StyleSection
                    player={player}
                    data={styleData}
                    row={styleRow}
                    war={data}
                    isLoading={styleLoading}
                />
            )}

            {view === "maps" && (
                <Suspense fallback={<LoadingBar label="Loading map tendencies…" />}>
                    <MapTendencies
                        steamid={player.steamid}
                        selectedMap={selectedMap}
                        onSelectMap={(map) => setQueryParams({ view: "maps", map })}
                        showEmpty
                    />
                </Suspense>
            )}

            <div className="space-y-1 pt-2 border-t border-line/60">
                <LiquipediaCredit what="Team, roster and player page data" />
                <div className="text-xs text-muted">Match demos from HLTV.org, parsed with awpy.</div>
            </div>
        </div>
    );
};
