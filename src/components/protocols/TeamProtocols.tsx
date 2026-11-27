import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { leagueProtocolsQuery, playerWarQuery, teamProtocolsQuery } from "../../data/queries.ts";
import { GRENADE_COLOR, formatMapName } from "../../war/heatmap.ts";
import type { HeatmapLevel, HeatmapSide } from "../../war/heatmapTypes.ts";
import type { ProtocolClass, ProtocolTeam } from "../../war/protocolTypes.ts";
import {
    MIN_OUTLIER_DIFF,
    MIN_OUTLIER_ROUNDS,
    binLabels,
    outlier,
    pct,
    pp,
    protocolRows,
    seconds,
    visibleRows,
    zoneTooltip,
    type Outlier,
    type ProtocolRow,
} from "../../war/protocols.ts";
import { playerPath } from "../../utils/players.ts";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../DataTable.tsx";
import { LiquipediaCredit } from "../LiquipediaCredit.tsx";
import { Badge, Button, EmptyState, Inset, Label, Section, Segmented, Tooltip } from "../ui.tsx";
import { RadarHeatmap, type RadarZone } from "../heatmap/RadarHeatmap.tsx";

const SIDE_OPTIONS: Array<{ value: HeatmapSide; label: string }> = [
    { value: "t", label: "T side" },
    { value: "ct", label: "CT side" },
];

const CLASS_OPTIONS: Array<{ value: ProtocolClass; label: string }> = [
    { value: "gun", label: "Gun rounds" },
    { value: "pistol", label: "Pistol" },
    { value: "light", label: "Eco / force" },
];

const LEVEL_OPTIONS: Array<{ value: HeatmapLevel; label: string }> = [
    { value: "upper", label: "Upper" },
    { value: "lower", label: "Lower" },
];

const OUTLIER_STROKE: Record<Outlier, string> = { more: "stroke-accent", less: "stroke-series-2" };
const OUTLIER_FILL: Record<Outlier, string> = { more: "fill-accent", less: "fill-series-2" };
const OUTLIER_ARROW: Record<Outlier, string> = { more: "▲", less: "▼" };
const arrowFor = (flag: Outlier | null | undefined): string => (flag ? OUTLIER_ARROW[flag] : "");

const vsLeagueText = (row: ProtocolRow, classRounds: number): string => {
    const base = `Team ${pct(row.rate)} (${row.hits} of ${classRounds} rounds), league ${pct(row.league)}`;
    if (row.diff === null) return base;
    const interval = row.lo !== null && row.hi !== null ? `, 90% interval ${pp(row.lo)} to ${pp(row.hi)} (resampling series)` : "";
    return `${base}. ${pp(row.diff)} points${interval}.`;
};

/** Team rate (dot) and league rate (tick) on one 0–100% scale, joined by a line coloured only for outliers. */
const VsLeague = ({ row, flag }: { row: ProtocolRow; flag: Outlier | null }) => {
    const x = (v: number) => 4 + Math.max(0, Math.min(1, v)) * 112;
    const [a, b] = [x(row.league), x(row.rate)].sort((p, q) => p - q);
    return (
        <span className="inline-flex items-center gap-2">
            <svg viewBox="0 0 120 14" className="w-28 h-3.5 shrink-0" aria-hidden="true">
                <line x1="4" x2="116" y1="7" y2="7" className="stroke-muted/30" strokeWidth="1" />
                <line x1={a} x2={b} y1="7" y2="7" className={flag ? OUTLIER_STROKE[flag] : "stroke-muted/60"} strokeWidth="3" strokeLinecap="round" />
                <line x1={x(row.league)} x2={x(row.league)} y1="1" y2="13" className="stroke-muted" strokeWidth="2" />
                <circle cx={x(row.rate)} cy="7" r="4" className={`${flag ? OUTLIER_FILL[flag] : "fill-fg"} stroke-surface`} strokeWidth="2" />
            </svg>
            <span className="tabular-nums text-fg w-9 text-right">{pct(row.rate)}</span>
            <span className="tabular-nums text-muted w-9 text-right">{pct(row.league)}</span>
            <span className={`tabular-nums w-14 text-right ${flag ? "text-fg font-semibold" : "text-muted"}`}>
                {flag && <span className="mr-0.5 text-[9px]">{OUTLIER_ARROW[flag]}</span>}
                {row.diff === null ? "—" : pp(row.diff)}
            </span>
        </span>
    );
};

const TimingStrip = ({ bins, labels }: { bins: number[]; labels: string[] }) => {
    const total = bins.reduce((a, b) => a + b, 0);
    if (total === 0) return <span className="text-muted">—</span>;
    const top = Math.max(...bins);
    const title = bins.map((b, i) => `${labels[i]}: ${pct(b / total)}`).join(", ");
    return (
        <span className="inline-flex items-end gap-px h-4" role="img" aria-label={`First throw timing: ${title}`} title={title}>
            {bins.map((b, i) => (
                <span
                    key={labels[i]}
                    className="w-1.5 bg-muted/70 rounded-t-[1px]"
                    style={{ height: `${Math.max(b > 0 ? 12 : 0, (b / top) * 100)}%` }}
                />
            ))}
        </span>
    );
};

const Throwers = ({ row, team, linkable }: { row: ProtocolRow; team: ProtocolTeam; linkable: Set<string> }) => {
    if (row.throwers.length === 0) return <span className="text-muted">—</span>;
    const name = (sid: string) => team.players[sid] ?? sid;
    const [sid, share] = row.throwers[0];
    const first = linkable.has(sid) ? (
        <Link to={playerPath(name(sid))} className="text-fg hover:text-accent">
            {name(sid)}
        </Link>
    ) : (
        <span className="text-fg">{name(sid)}</span>
    );
    const rest = row.throwers.slice(1);
    return (
        <span>
            {first} <span className="text-muted tabular-nums">{pct(share)}</span>
            {rest.length > 0 && (
                <Tooltip content={rest.map(([s, sh, rate]) => `${name(s)} ${pct(sh)} (${pct(rate)} of their rounds)`).join(" · ")}>
                    <span className="ml-1 text-muted">+{rest.length}</span>
                </Tooltip>
            )}
        </span>
    );
};

export const TeamProtocols = ({ team }: { team: string }) => {
    const { data } = useQuery(teamProtocolsQuery(team));
    const war = useQuery(playerWarQuery);
    const [selectedMap, setSelectedMap] = useState("");
    const [side, setSide] = useState<HeatmapSide>("t");
    const [cls, setCls] = useState<ProtocolClass>("gun");
    const [level, setLevel] = useState<HeatmapLevel>("upper");
    const [showAll, setShowAll] = useState(false);
    const [activeId, setActiveId] = useState<number | null>(null);

    const activeMap = data?.maps.find((m) => m.map === selectedMap) ?? data?.maps[0];
    const league = useQuery({ ...leagueProtocolsQuery(activeMap?.map ?? ""), enabled: Boolean(activeMap) });

    useEffect(() => {
        if (league.data && !league.data.levels.includes(level)) setLevel("upper");
    }, [league.data, level]);
    useEffect(() => setActiveId(null), [activeMap?.map, side, cls, level, showAll]);

    const teamSide = activeMap?.sides[side];
    const rows = useMemo(
        () => (league.data ? protocolRows(teamSide, league.data, side, cls) : []),
        [teamSide, league.data, side, cls]
    );
    const shown = useMemo(() => visibleRows(rows, showAll), [rows, showAll]);
    const radarRows = useMemo(() => shown.filter((r) => r.zone.level === level && r.hits > 0), [shown, level]);
    const classRounds = teamSide?.classes[cls]?.rounds ?? 0;
    const flags = new Map(rows.map((r) => [r.zone.id, outlier(r, classRounds)]));
    const radarZones: RadarZone[] = radarRows.map((r) => {
        const tip = zoneTooltip(r.zone);
        return {
            land: r.zone.land,
            r: r.zone.r,
            n: r.hits,
            share: r.rate,
            tMed: r.tMed ?? 0,
            level: r.zone.level,
            from: r.zone.from,
            color: GRENADE_COLOR[r.zone.type],
            weight: r.rate,
            label: `${Math.round(r.rate * 100)}${arrowFor(flags.get(r.zone.id))}`,
            description: `${r.label}: ${pct(r.rate)} of rounds (league ${pct(r.league)}) · median ${seconds(r.tMed)}${tip ? ` — ${tip}` : ""}`,
        };
    });
    const activeIndex = activeId === null ? null : radarRows.findIndex((r) => r.zone.id === activeId);
    const linkable = useMemo(() => new Set(war.data?.players.map((p) => p.steamid) ?? []), [war.data]);

    if (!data || !activeMap) return null;

    const labels = binLabels(league.data?.timeEdges ?? [5, 10, 20, 35, 50]);
    const hasLower = league.data?.levels.includes("lower") ?? false;
    const hidden = rows.length - shown.length;
    const outliers = rows
        .filter((r) => flags.get(r.zone.id))
        .sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));
    const windowText = data.stint
        ? `Since ${data.from}, when ${data.stint.label} began`
        : `Last ${data.window.months ?? 6} months (${data.from} to ${data.window.to})`;

    return (
        <Section
            title="Utility protocols"
            subtitle={`${windowText}. How often the team lands utility in each of the league's landing zones, how early, and who throws it.`}
        >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Segmented
                    aria-label="Map"
                    options={data.maps.map((m) => ({
                        value: m.map,
                        label: (
                            <span>
                                {formatMapName(m.map)} <span className="text-[11px] opacity-70 tabular-nums">{m.maps}</span>
                            </span>
                        ),
                    }))}
                    value={activeMap.map}
                    onChange={setSelectedMap}
                />
                {activeMap.lowSample && <Badge tone="heat">low sample</Badge>}
            </div>
            <Inset className="p-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <Segmented aria-label="Side" options={SIDE_OPTIONS} value={side} onChange={setSide} />
                <Segmented aria-label="Round type" options={CLASS_OPTIONS} value={cls} onChange={setCls} />
                {hasLower && <Segmented aria-label="Radar level" options={LEVEL_OPTIONS} value={level} onChange={setLevel} />}
                <Button type="button" size="sm" variant={showAll ? "primary" : "secondary"} aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
                    Show all zones
                </Button>
            </Inset>

            {teamSide && (
                <div className="text-xs font-mono text-muted">
                    {activeMap.maps} maps · {teamSide.rounds.gun} gun, {teamSide.rounds.pistol} pistol, {teamSide.rounds.light} eco/force rounds
                    {side === "t" && teamSide.fastShare !== null && (
                        <>
                            {" "}
                            · fast group hits (3+ in a site by 30s) in {pct(teamSide.fastShare)} of gun rounds
                            {league.data?.fastShare != null && <> (league {pct(league.data.fastShare)})</>}
                        </>
                    )}
                </div>
            )}

            {!teamSide || classRounds === 0 ? (
                <EmptyState>No {CLASS_OPTIONS.find((o) => o.value === cls)?.label.toLowerCase()} on this side in the window.</EmptyState>
            ) : (
                <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)] gap-6 items-start">
                    <RadarHeatmap
                        map={activeMap.map}
                        level={level}
                        rgba={null}
                        lineups={radarZones}
                        ariaLabel={`${formatMapName(activeMap.map)} ${side.toUpperCase()} utility protocols`}
                        loading={league.isLoading}
                        activeIndex={activeIndex === -1 ? null : activeIndex}
                        onActiveIndexChange={(idx) => setActiveId(idx === null ? null : (radarRows[idx]?.zone.id ?? null))}
                        legend={
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-muted">
                                {(["smoke", "flash", "molotov", "he"] as const).map((t) => (
                                    <span key={t} className="inline-flex items-center gap-1.5">
                                        <span className="w-2.5 h-2.5 rounded-full border-2 inline-block" style={{ borderColor: GRENADE_COLOR[t] }} aria-hidden="true" />
                                        {t === "he" ? "HE" : t.charAt(0).toUpperCase() + t.slice(1)}
                                    </span>
                                ))}
                                <span>Ring number: % of rounds</span>
                            </div>
                        }
                    />
                    <div className="space-y-2 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
                            <Label as="span">Stands out</Label>
                            {outliers.length === 0 ? (
                                <span className="text-muted">
                                    {classRounds < MIN_OUTLIER_ROUNDS
                                        ? `Too few rounds to call outliers (${classRounds}, need ${MIN_OUTLIER_ROUNDS}).`
                                        : "Nothing: every zone is within the league's normal range."}
                                </span>
                            ) : (
                                outliers.map((r) => {
                                    const flag = flags.get(r.zone.id) as Outlier;
                                    return (
                                        <button
                                            key={r.zone.id}
                                            type="button"
                                            className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono ${
                                                r.zone.id === activeId ? "border-fg/40 bg-surface-2" : "border-line"
                                            }`}
                                            onMouseEnter={() => setActiveId(r.zone.id)}
                                            onMouseLeave={() => setActiveId((cur) => (cur === r.zone.id ? null : cur))}
                                            onFocus={() => setActiveId(r.zone.id)}
                                            onClick={() => r.zone.level !== level && setLevel(r.zone.level)}
                                        >
                                            <span className={flag === "more" ? "text-accent" : "text-series-2"} aria-hidden="true">
                                                {OUTLIER_ARROW[flag]}
                                            </span>
                                            <span className="text-fg">{r.label}</span>
                                            <span className="text-muted tabular-nums">
                                                {pct(r.rate)} vs {pct(r.league)}
                                            </span>
                                            <span className="sr-only">{flag === "more" ? "more than the league" : "less than the league"}</span>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                        <DataTable>
                            <TableHead>
                                <Th align="right">When</Th>
                                <Th align="left">Utility</Th>
                                <Th align="left">
                                    <span className="inline-flex gap-2">
                                        <span className="w-28">Team vs league</span>
                                        <span className="w-9 text-right">Team</span>
                                        <span className="w-9 text-right">League</span>
                                        <span className="w-14 text-right">Diff</span>
                                    </span>
                                </Th>
                                <Th align="left">Timing</Th>
                                <Th align="left">Thrown by</Th>
                            </TableHead>
                            <TableBody>
                                {shown.map((r) => (
                                    <Row
                                        key={r.zone.id}
                                        highlighted={r.zone.id === activeId}
                                        onMouseEnter={() => setActiveId(r.zone.id)}
                                        onMouseLeave={() => setActiveId((cur) => (cur === r.zone.id ? null : cur))}
                                    >
                                        <Td align="right" className="tabular-nums">
                                            <Tooltip content={`Median first throw. League: ${seconds(r.leagueTMed)}`}>
                                                <span>{seconds(r.tMed)}</span>
                                            </Tooltip>
                                        </Td>
                                        <Td>
                                            <span className="inline-flex items-center gap-1.5">
                                                <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: GRENADE_COLOR[r.zone.type] }} aria-hidden="true" />
                                                {(() => {
                                                    const tip = zoneTooltip(r.zone);
                                                    return tip ? (
                                                        <Tooltip content={tip}>
                                                            <span className="text-fg">{r.label}</span>
                                                        </Tooltip>
                                                    ) : (
                                                        <span className="text-fg">{r.label}</span>
                                                    );
                                                })()}
                                                {r.zone.level === "lower" && <span className="text-[10px] text-muted uppercase">lower</span>}
                                            </span>
                                        </Td>
                                        <Td>
                                            <Tooltip content={vsLeagueText(r, classRounds)}>
                                                <VsLeague row={r} flag={flags.get(r.zone.id) ?? null} />
                                            </Tooltip>
                                        </Td>
                                        <Td>
                                            <TimingStrip bins={r.bins} labels={labels} />
                                        </Td>
                                        <Td>
                                            <Throwers row={r} team={data} linkable={linkable} />
                                        </Td>
                                    </Row>
                                ))}
                            </TableBody>
                        </DataTable>
                        {shown.length === 0 && <EmptyState>No zones above {pct(0.1)} of rounds.</EmptyState>}
                        <div className="text-xs text-muted space-y-1">
                            {hidden > 0 && !showAll && (
                                <div>
                                    {hidden} zones under 10% of rounds hidden; zones the team clearly over- or under-uses stay.
                                </div>
                            )}
                            <div>
                                <Label as="span">How to read</Label> Team (dot): share of this team's rounds with at least one of
                                its grenades landing in the zone. League (tick): every team in the last 6 months on the same map,
                                side and round type. The line is blue (▲) when the team uses the zone more than the league and
                                orange (▼) when less, only if the gap is at least {Math.round(MIN_OUTLIER_DIFF * 100)} points, its
                                90% interval (resampling series, in the tooltip) excludes zero, and the team has{" "}
                                {MIN_OUTLIER_ROUNDS}+ rounds of this type. When: median time from freeze end to the round's first throw into the zone. Thrown by: share of the
                                team's rounds in the zone each player threw into it.
                            </div>
                            <LiquipediaCredit what="Team pages, rosters and IGLs" />
                            <div>Match demos from HLTV.org, parsed with awpy.</div>
                        </div>
                    </div>
                </div>
            )}
        </Section>
    );
};

export default TeamProtocols;
