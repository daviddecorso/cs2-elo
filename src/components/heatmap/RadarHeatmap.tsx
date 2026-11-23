import { useEffect, useId, useRef, useState } from "react";
import type { GrenadeType, HeatmapLevel, HeatmapUtilZone } from "../../war/heatmapTypes.ts";
import { GRID_SIZE } from "../../war/heatmap.ts";

const RADAR_PX = 1024;
const CANVAS_PX = 512;

const GRENADE_COLOR: Record<GrenadeType, string> = {
    smoke: "#e4e4e7",
    flash: "#fde047",
    he: "#f87171",
    molotov: "#fb923c",
};

const GRENADE_NAME: Record<GrenadeType, string> = {
    smoke: "smoke",
    flash: "flash",
    he: "HE",
    molotov: "molotov",
};

export interface RadarHeatmapProps {
    map: string;
    level: HeatmapLevel;
    rgba: Uint8ClampedArray | null;
    gridSize?: number;
    lineups?: HeatmapUtilZone[];
    grenadeType?: GrenadeType;
    ariaLabel: string;
    loading?: boolean;
    legend?: React.ReactNode;
}

export const RadarHeatmap = ({
    map,
    level,
    rgba,
    gridSize = GRID_SIZE,
    lineups = [],
    grenadeType = "smoke",
    ariaLabel,
    loading = false,
    legend,
}: RadarHeatmapProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [activeIdx, setActiveIdx] = useState<number | null>(null);
    const markerId = useId();

    useEffect(() => {
        setActiveIdx(null);
    }, [map, level, grenadeType]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!rgba) return;

        const off = document.createElement("canvas");
        off.width = gridSize;
        off.height = gridSize;
        const offCtx = off.getContext("2d");
        if (!offCtx) return;
        const imgData = offCtx.createImageData(gridSize, gridSize);
        imgData.data.set(rgba);
        offCtx.putImageData(imgData, 0, 0);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    }, [rgba, gridSize]);

    const radarSrc = `${import.meta.env.BASE_URL}radar/${level === "lower" ? `${map}_lower` : map}.webp`;
    const color = GRENADE_COLOR[grenadeType];
    const maxN = lineups.reduce((m, z) => Math.max(m, z.n), 1);
    const hovered = activeIdx !== null ? lineups[activeIdx] : undefined;

    return (
        <div className="space-y-2">
            <div className="relative aspect-square w-full max-w-[540px] bg-zinc-950 border border-line rounded-sm overflow-hidden select-none">
                <img
                    src={radarSrc}
                    alt={`${map} ${level} radar`}
                    className="w-full h-full object-contain block"
                    draggable={false}
                />
                <canvas
                    ref={canvasRef}
                    width={CANVAS_PX}
                    height={CANVAS_PX}
                    role="img"
                    aria-label={ariaLabel}
                    className="absolute inset-0 w-full h-full pointer-events-none"
                />
                {lineups.length > 0 && (
                    <svg
                        viewBox={`0 0 ${RADAR_PX} ${RADAR_PX}`}
                        className="absolute inset-0 w-full h-full"
                        aria-label={`${GRENADE_NAME[grenadeType]} landing zones`}
                    >
                        <defs>
                            <marker
                                id={markerId}
                                viewBox="0 0 10 10"
                                refX="7.5"
                                refY="5"
                                markerWidth="5"
                                markerHeight="5"
                                orient="auto-start-reverse"
                            >
                                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill={color} stroke="#09090b" strokeWidth="1" />
                            </marker>
                        </defs>
                        {lineups.map((z, idx) => {
                            const [lx, ly] = z.land;
                            const isHot = activeIdx === idx;
                            const opacity = activeIdx === null ? 0.9 : isHot ? 1 : 0.2;
                            const weight = z.n / maxN;
                            const ringStroke = (2 + 3.5 * weight) * (isHot ? 1.2 : 1);
                            const arrowStroke = (2.2 + 3.8 * weight) * (isHot ? 1.2 : 1);
                            const primary = z.from[0];
                            const spotCount = z.from.length;
                            const label = `${z.n} ${GRENADE_NAME[grenadeType]}s (${Math.round(z.share * 100)}%), ${spotCount} ${spotCount === 1 ? "spot" : "spots"}, median ${z.tMed.toFixed(1)}s`;

                            let primaryLine: { x1: number; y1: number; ex: number; ey: number } | null = null;
                            if (primary) {
                                const [x1, y1] = primary;
                                const dx = lx - x1;
                                const dy = ly - y1;
                                const len = Math.hypot(dx, dy);
                                const trim = len > z.r + 14 ? z.r + 6 : len > 24 ? 10 : 0;
                                const ex = len > 0 ? lx - (dx / len) * trim : lx;
                                const ey = len > 0 ? ly - (dy / len) * trim : ly;
                                primaryLine = { x1, y1, ex, ey };
                            }

                            return (
                                <g
                                    key={`${lx}-${ly}-${idx}`}
                                    tabIndex={0}
                                    role="img"
                                    aria-label={label}
                                    style={{ opacity, cursor: "pointer" }}
                                    onMouseEnter={() => setActiveIdx(idx)}
                                    onMouseLeave={() => setActiveIdx((cur) => (cur === idx ? null : cur))}
                                    onFocus={() => setActiveIdx(idx)}
                                    onBlur={() => setActiveIdx((cur) => (cur === idx ? null : cur))}
                                    className="outline-none"
                                >
                                    {isHot &&
                                        z.from.slice(1).map(([ox, oy], oi) => {
                                            const dx = lx - ox;
                                            const dy = ly - oy;
                                            const len = Math.hypot(dx, dy);
                                            const trim = len > z.r + 6 ? z.r : 0;
                                            const ex = len > 0 ? lx - (dx / len) * trim : lx;
                                            const ey = len > 0 ? ly - (dy / len) * trim : ly;
                                            return (
                                                <g key={`ray-${oi}`}>
                                                    <line
                                                        x1={ox}
                                                        y1={oy}
                                                        x2={ex}
                                                        y2={ey}
                                                        stroke="#09090b"
                                                        strokeWidth={3.6}
                                                        strokeLinecap="round"
                                                        strokeOpacity={0.75}
                                                    />
                                                    <line
                                                        x1={ox}
                                                        y1={oy}
                                                        x2={ex}
                                                        y2={ey}
                                                        stroke={color}
                                                        strokeWidth={1.8}
                                                        strokeLinecap="round"
                                                        strokeOpacity={0.85}
                                                    />
                                                </g>
                                            );
                                        })}
                                    {primaryLine && (
                                        <>
                                            <line
                                                x1={primaryLine.x1}
                                                y1={primaryLine.y1}
                                                x2={primaryLine.ex}
                                                y2={primaryLine.ey}
                                                stroke="#09090b"
                                                strokeWidth={arrowStroke + 3}
                                                strokeLinecap="round"
                                            />
                                            <line
                                                x1={primaryLine.x1}
                                                y1={primaryLine.y1}
                                                x2={primaryLine.ex}
                                                y2={primaryLine.ey}
                                                stroke={color}
                                                strokeWidth={arrowStroke}
                                                strokeLinecap="round"
                                                markerEnd={`url(#${markerId})`}
                                            />
                                            <line
                                                x1={primaryLine.x1}
                                                y1={primaryLine.y1}
                                                x2={lx}
                                                y2={ly}
                                                stroke="transparent"
                                                strokeWidth={24}
                                            />
                                        </>
                                    )}
                                    {z.from.map(([ox, oy, on], oi) => {
                                        const isPrimary = oi === 0;
                                        const dotR = isHot
                                            ? Math.min(14, 3.5 + Math.sqrt(on) * 2.5)
                                            : isPrimary
                                              ? 5
                                              : 4;
                                        const dotOpacity = isHot || isPrimary ? 1 : 0.35;
                                        return (
                                            <g key={`orig-${oi}`}>
                                                <circle
                                                    cx={ox}
                                                    cy={oy}
                                                    r={dotR}
                                                    fill={color}
                                                    fillOpacity={dotOpacity}
                                                    stroke="#09090b"
                                                    strokeOpacity={dotOpacity}
                                                    strokeWidth={isPrimary || isHot ? 2 : 1.5}
                                                />
                                                <circle cx={ox} cy={oy} r={14} fill="transparent" />
                                            </g>
                                        );
                                    })}
                                    <circle
                                        cx={lx}
                                        cy={ly}
                                        r={z.r}
                                        fill={color}
                                        fillOpacity={isHot ? 0.14 : 0.06}
                                        stroke="#09090b"
                                        strokeWidth={ringStroke + 2.5}
                                    />
                                    <circle
                                        cx={lx}
                                        cy={ly}
                                        r={z.r}
                                        fill="none"
                                        stroke={color}
                                        strokeWidth={ringStroke}
                                    />
                                    <circle cx={lx} cy={ly} r={Math.max(z.r + 6, 16)} fill="transparent" />
                                    <text
                                        x={lx}
                                        y={ly}
                                        textAnchor="middle"
                                        dominantBaseline="central"
                                        fill="#fafafa"
                                        stroke="#09090b"
                                        strokeWidth={4}
                                        paintOrder="stroke"
                                        fontSize={16}
                                        fontWeight={700}
                                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                                        className="pointer-events-none"
                                    >
                                        {z.n}
                                    </text>
                                </g>
                            );
                        })}
                    </svg>
                )}
                {hovered && (
                    <div
                        role="tooltip"
                        style={{
                            left: `${Math.min(72, Math.max(28, (hovered.land[0] / RADAR_PX) * 100))}%`,
                            top: `${Math.min(84, Math.max(12, (hovered.land[1] / RADAR_PX) * 100))}%`,
                        }}
                        className="absolute -translate-x-1/2 -translate-y-full -mt-2 z-20 pointer-events-none bg-surface border border-line rounded-sm px-2 py-1 text-[11px] font-mono text-fg shadow-md whitespace-nowrap"
                    >
                        {hovered.n}× {GRENADE_NAME[grenadeType]} ({Math.round(hovered.share * 100)}%) ·{" "}
                        {hovered.from.length} {hovered.from.length === 1 ? "spot" : "spots"} · median{" "}
                        {hovered.tMed.toFixed(1)}s
                    </div>
                )}
                {loading && (
                    <div className="absolute inset-0 bg-zinc-950/45 flex items-center justify-center pointer-events-none">
                        <span className="text-xs font-mono text-zinc-200 bg-zinc-900/90 border border-zinc-700 px-2.5 py-1 rounded-sm">
                            Loading grid…
                        </span>
                    </div>
                )}
            </div>
            {legend && <div className="max-w-[540px]">{legend}</div>}
            <div className="text-xs text-muted">
                Positions from HLTV demos parsed with awpy · Radar images &copy; Valve
            </div>
        </div>
    );
};
