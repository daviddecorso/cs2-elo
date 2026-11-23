import { Badge, Inset, Label } from "../ui.tsx";
import { formatCallout } from "../../war/heatmap.ts";
import type {
    GrenadeType,
    HeatmapCallout,
    HeatmapIndexMap,
    HeatmapLayer,
    HeatmapPhase,
    HeatmapSide,
    HeatmapUtilZone,
} from "../../war/heatmapTypes.ts";

const PHASE_LABEL: Record<HeatmapPhase, string> = {
    setup: "Setup (0–20s)",
    mid: "Mid (20–50s)",
    late: "Late (50s+)",
    post: "Post-plant",
};

const ALL_PHASES: HeatmapPhase[] = ["setup", "mid", "late", "post"];

const pct = (v: number) => `${Math.round(v * 100)}%`;

const SummaryRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
        <dt className="text-xs text-muted shrink-0">{label}</dt>
        <dd className="text-xs font-mono tabular-nums text-fg text-right min-w-0 truncate">{children}</dd>
    </div>
);

const CalloutBars = ({ items, emptyText = "No callout samples." }: { items: HeatmapCallout[]; emptyText?: string }) => {
    if (items.length === 0) return <div className="text-xs font-mono text-muted">{emptyText}</div>;
    const top = Math.max(items[0].share, 0.01);
    return (
        <ul className="space-y-2.5">
            {items.map((item) => (
                <li key={item.callout} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-fg font-medium truncate">{formatCallout(item.callout)}</span>
                        <span className="font-mono text-muted tabular-nums shrink-0">
                            {item.n !== undefined ? `${item.n} · ` : ""}
                            <span className="text-fg">{pct(item.share)}</span>
                        </span>
                    </div>
                    <div className="h-1.5 w-full bg-surface-2 rounded-full overflow-clip" aria-hidden="true">
                        <div
                            className="h-full bg-accent/75 rounded-full"
                            style={{ width: `${Math.max(4, Math.round((item.share / top) * 100))}%` }}
                        />
                    </div>
                </li>
            ))}
        </ul>
    );
};

export interface CalloutListProps {
    mapSummary: HeatmapIndexMap;
    side: HeatmapSide;
    layer: HeatmapLayer;
    phase: HeatmapPhase;
    grenadeType: GrenadeType;
    lineups?: HeatmapUtilZone[];
}

export const CalloutList = ({
    mapSummary,
    side,
    layer,
    phase,
    grenadeType,
    lineups = [],
}: CalloutListProps) => {
    const s = mapSummary.sides[side];
    const rounds = mapSummary.rounds[side];
    const openTotal = s.openings.wins + s.openings.losses;
    const openPct = openTotal > 0 ? Math.round((s.openings.wins / openTotal) * 100) : null;

    const otherPhases = ALL_PHASES.filter((p) => p !== phase && (s.presence[p]?.length ?? 0) > 0);

    return (
        <div className="space-y-5 min-w-0">
            <Inset className="p-3.5 space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={mapSummary.scope.type === "team" ? "accent" : "neutral"}>
                        {mapSummary.scope.type === "team" && mapSummary.scope.team
                            ? mapSummary.scope.team
                            : "All teams"}
                    </Badge>
                    {mapSummary.lowSample && <Badge tone="heat">Low sample</Badge>}
                </div>
                <dl className="divide-y divide-line/60">
                    <SummaryRow label="Sample">
                        {mapSummary.maps} maps · {rounds} {side.toUpperCase()} rds
                    </SummaryRow>
                    <SummaryRow label="Opening duels">
                        {s.openings.wins}–{s.openings.losses}
                        {openPct !== null ? ` (${openPct}%)` : ""}
                    </SummaryRow>
                    <SummaryRow label="Traded deaths">
                        {s.tradedDeathShare !== null ? pct(s.tradedDeathShare) : "–"}
                    </SummaryRow>
                </dl>
            </Inset>

            {layer === "positions" && (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label>{PHASE_LABEL[phase]} callouts</Label>
                        <CalloutBars items={s.presence[phase] ?? []} emptyText="No alive time in this phase." />
                    </div>
                    {otherPhases.length > 0 && (
                        <div className="space-y-1.5 pt-3 border-t border-line">
                            <Label>Other phases</Label>
                            <div className="space-y-1.5 text-xs text-muted">
                                {otherPhases.map((p) => {
                                    const top2 = (s.presence[p] ?? []).slice(0, 2);
                                    return (
                                        <div key={p} className="flex items-baseline justify-between gap-2">
                                            <span className="text-fg font-medium shrink-0">{PHASE_LABEL[p].split(" ")[0]}</span>
                                            <span className="font-mono tabular-nums truncate text-right">
                                                {top2.map((c) => `${formatCallout(c.callout)} ${pct(c.share)}`).join(" · ")}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {layer === "kills" && (
                <div className="space-y-2">
                    <Label>Top kill callouts ({side.toUpperCase()})</Label>
                    <CalloutBars items={s.kills} emptyText="No kills recorded." />
                </div>
            )}

            {layer === "deaths" && (
                <div className="space-y-2">
                    <Label>Top death callouts ({side.toUpperCase()})</Label>
                    <CalloutBars items={s.deaths} emptyText="No deaths recorded." />
                </div>
            )}

            {layer === "openings" && (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label>Top kill callouts ({side.toUpperCase()})</Label>
                        <CalloutBars items={s.kills.slice(0, 3)} emptyText="No kills recorded." />
                    </div>
                    <div className="space-y-2">
                        <Label>Top death callouts ({side.toUpperCase()})</Label>
                        <CalloutBars items={s.deaths.slice(0, 3)} emptyText="No deaths recorded." />
                    </div>
                </div>
            )}

            {layer === "utility" && (
                <div className="space-y-4">
                    <div className="space-y-1.5">
                        <Label>Repeated {grenadeType} zones</Label>
                        {lineups.length === 0 ? (
                            <div className="text-xs font-mono text-muted">
                                Fewer than 2 repeated throws on this level.
                            </div>
                        ) : (
                            <div className="text-xs text-muted leading-relaxed">
                                <span className="font-mono text-fg">
                                    {lineups.length} landing zone{lineups.length === 1 ? "" : "s"}
                                </span>{" "}
                                shown (top:{" "}
                                <span className="font-mono text-fg">
                                    {lineups[0].n}×, {pct(lineups[0].share)}
                                </span>
                                , median <span className="font-mono text-fg">{lineups[0].tMed.toFixed(1)}s</span>). Rings mark landing zones, dots mark throw spots; hover or focus a zone for details.
                            </div>
                        )}
                    </div>
                    <div className="space-y-2">
                        <Label>Setup presence ({side.toUpperCase()})</Label>
                        <CalloutBars items={(s.presence.setup ?? []).slice(0, 4)} />
                    </div>
                </div>
            )}

            {layer === "plants" && (
                <div className="space-y-2">
                    <Label>Post-plant callouts (T)</Label>
                    <CalloutBars items={s.presence.post ?? []} emptyText="No post-plant samples." />
                </div>
            )}
        </div>
    );
};
