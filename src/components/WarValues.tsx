import { Link } from "react-router-dom";
import { Tooltip } from "./ui.tsx";
import { playerPath } from "../utils/players.ts";
import { HLTV_GAP_LABEL, WAA_CREDIT, signed, waaRate } from "../war/players.ts";
import type { HltvGap, WarEstimate, WarPlayer, WarRate } from "../war/types.ts";

export const PlayerLink = ({ name }: { name: string }) => (
    <Link to={playerPath(name)} className="font-medium text-fg hover:text-accent transition-colors">
        {name}
    </Link>
);

/** Symmetric clamp bound in map-win units so zero sits at 50% width across every row. */
const IntervalBar = ({ p5, point, p95, bound }: { p5: number; point: number; p95: number; bound: number }) => {
    const toPct = (v: number) => Math.min(100, Math.max(0, 50 + (v / bound) * 50));
    const left = toPct(p5);
    const right = toPct(p95);
    const dot = toPct(point);
    return (
        <span aria-hidden="true" className="relative hidden sm:inline-block w-16 h-2 align-middle ml-2">
            <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-line" />
            <span className="absolute left-1/2 top-0 bottom-0 w-px bg-muted/40" />
            <span
                className="absolute top-1/2 -translate-y-1/2 h-1 rounded-full bg-accent/40"
                style={{ left: `${left}%`, width: `${Math.max(2, right - left)}%` }}
            />
            <span
                className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${
                    point > 0 ? "bg-up" : point < 0 ? "bg-down" : "bg-muted"
                }`}
                style={{ left: `${dot}%` }}
            />
        </span>
    );
};

export const WaaRateValue = ({ player, replacementRate }: { player: WarPlayer; replacementRate: number }) => {
    const est = player.metrics[WAA_CREDIT];
    const tone = est.per100P5 > 0 ? "text-up" : est.per100P95 < 0 ? "text-down" : "text-fg";
    const unshrunk = `${signed(est.per100)} (${signed(est.per100P5)}, ${signed(est.per100P95)})`;
    return (
        <Tooltip
            content={`Round-wins above average per 100 rounds, shrunk for sample size\nUnshrunk over ${player.rounds.toLocaleString("en-US")} rounds: ${unshrunk}`}
        >
            <span className={`font-semibold tabular-nums ${tone}`}>{signed(waaRate(player, replacementRate))}</span>
        </Tooltip>
    );
};

export const MapWinsValue = ({ est, bound }: { est: WarEstimate; bound?: number }) => (
    <Tooltip content={`Total over the window, unshrunk: ${signed(est.waa)} map wins\n90% round bootstrap: (${signed(est.waaP5)}, ${signed(est.waaP95)})`}>
        <span className="tabular-nums">
            <span className="text-fg">{signed(est.waa)}</span>
            <span className="text-muted text-[10px] ml-1">{`(${signed(est.waaP5)}, ${signed(est.waaP95)})`}</span>
            {bound !== undefined && <IntervalBar p5={est.waaP5} point={est.waa} p95={est.waaP95} bound={bound} />}
        </span>
    </Tooltip>
);

export const RateValue = ({ est, label = "Round-wins above average per 100 rounds" }: { est?: WarRate; label?: string }) =>
    est ? (
        <Tooltip content={`${label}\n90% round bootstrap: (${signed(est.per100P5)}, ${signed(est.per100P95)})`}>
            <span className="tabular-nums">
                <span className="text-fg">{signed(est.per100)}</span>
                <span className="text-muted text-[10px] ml-1">{`(${signed(est.per100P5)}, ${signed(est.per100P95)})`}</span>
            </span>
        </Tooltip>
    ) : (
        <span className="text-muted">–</span>
    );

export const HltvGapValue = ({ gap }: { gap?: HltvGap | null }) =>
    gap ? (
        <Tooltip content={`${HLTV_GAP_LABEL}\n90% round bootstrap: (${signed(gap.zP5)}, ${signed(gap.zP95)})`}>
            <span className={`tabular-nums ${gap.z > 0 ? "text-up" : gap.z < 0 ? "text-down" : "text-fg"}`}>{signed(gap.z)}</span>
        </Tooltip>
    ) : (
        <span className="text-muted">–</span>
    );
