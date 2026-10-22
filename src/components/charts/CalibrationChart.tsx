import {
    CartesianGrid,
    Line,
    LineChart,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type { EloCalibrationBin } from "../../elo/types.ts";
import { Card } from "../ui.tsx";

const AXIS_TICK = {
    fill: "var(--color-muted)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface CalibrationSeries {
    label: string;
    color: string;
    shape?: "circle" | "square";
    bins: EloCalibrationBin[];
}

interface CalibrationChartProps {
    series: CalibrationSeries[];
}

interface DataPoint {
    label: string;
    midpoint: number;
    [key: string]: string | number | undefined;
}

interface TooltipPayloadEntry {
    payload: DataPoint;
}

interface TooltipContentProps {
    active?: boolean;
    payload?: TooltipPayloadEntry[];
    series: CalibrationSeries[];
}

const TooltipContent = ({ active, payload, series }: TooltipContentProps) => {
    if (!active || !payload || !payload.length) return null;
    const item = payload[0].payload;
    return (
        <Card className="p-2 text-xs font-mono text-fg space-y-1.5 shadow-md">
            <div className="text-[11px] text-muted uppercase tracking-wider font-semibold">
                Favorites at {item.label}
            </div>
            {series.map((s, idx) => {
                const actual = item[`actual_${idx}`] as number | undefined;
                const pred = item[`pred_${idx}`] as number | undefined;
                const n = item[`n_${idx}`] as number | undefined;
                if (actual === undefined || n === undefined) return null;
                return (
                    <div key={s.label} className="pt-1 border-t border-line first:border-0 first:pt-0 space-y-0.5">
                        <div className="flex items-center gap-1.5 font-medium" style={{ color: s.color }}>
                            <span className="w-2 h-2 rounded-full inline-block" style={{ background: s.color }} />
                            {s.label}
                        </div>
                        <div className="flex justify-between gap-4 text-muted">
                            <span>Predicted</span>
                            <span className="text-fg tabular-nums">{pred !== undefined ? (pred * 100).toFixed(1) : "–"}%</span>
                        </div>
                        <div className="flex justify-between gap-4 text-muted">
                            <span>Won</span>
                            <span className="text-fg font-semibold tabular-nums">{(actual * 100).toFixed(1)}%</span>
                        </div>
                        <div className="flex justify-between gap-4 text-muted">
                            <span>Matches</span>
                            <span className="text-fg tabular-nums">{n.toLocaleString()}</span>
                        </div>
                    </div>
                );
            })}
        </Card>
    );
};

export const CalibrationChart = ({ series }: CalibrationChartProps) => {
    // Build combined points from bins
    const baseBins = series[0]?.bins ?? [];
    const data: DataPoint[] = baseBins
        .map((b, binIdx) => {
            const midpoint = (b.lo + b.hi) / 2;
            const pt: DataPoint = {
                label: `${pct(b.lo)}–${pct(b.hi)}`,
                midpoint,
            };
            let hasValidData = false;
            series.forEach((s, sIdx) => {
                const bin = s.bins[binIdx];
                if (bin && bin.n >= 20) {
                    pt[`actual_${sIdx}`] = bin.actual;
                    pt[`pred_${sIdx}`] = bin.predicted;
                    pt[`n_${sIdx}`] = bin.n;
                    hasValidData = true;
                }
            });
            return hasValidData ? pt : null;
        })
        .filter((pt): pt is DataPoint => pt !== null);

    return (
        <figure className="space-y-3">
            <div className="w-full aspect-square max-h-80 max-w-md">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 10, right: 16, left: -6, bottom: 16 }}>
                        <CartesianGrid stroke="var(--color-line)" />
                        <XAxis
                            type="number"
                            dataKey="midpoint"
                            domain={[0.5, 1]}
                            ticks={[0.5, 0.6, 0.7, 0.8, 0.9, 1]}
                            tickFormatter={pct}
                            stroke="var(--color-line)"
                            tick={AXIS_TICK}
                            label={{
                                value: "Predicted",
                                position: "insideBottom",
                                offset: -10,
                                fill: "var(--color-muted)",
                                fontSize: 11,
                                fontFamily: "var(--font-mono)",
                            }}
                        />
                        <YAxis
                            type="number"
                            domain={[0.4, 1]}
                            ticks={[0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]}
                            tickFormatter={pct}
                            stroke="var(--color-line)"
                            tick={AXIS_TICK}
                            label={{
                                value: "Actual",
                                angle: -90,
                                position: "insideLeft",
                                offset: 12,
                                fill: "var(--color-muted)",
                                fontSize: 11,
                                fontFamily: "var(--font-mono)",
                            }}
                        />
                        <ReferenceLine
                            segment={[
                                { x: 0.5, y: 0.5 },
                                { x: 1, y: 1 },
                            ]}
                            stroke="var(--color-muted)"
                            strokeDasharray="4 3"
                            ifOverflow="extendDomain"
                        />
                        <Tooltip content={<TooltipContent series={series} />} cursor={{ stroke: "var(--color-line)" }} />
                        {series.map((s, idx) => (
                            <Line
                                key={s.label}
                                type="linear"
                                dataKey={`actual_${idx}`}
                                name={s.label}
                                stroke={s.color}
                                strokeWidth={2}
                                dot={{ fill: s.color, r: s.shape === "square" ? 3.5 : 3 }}
                                activeDot={{ r: 5 }}
                                connectNulls
                            />
                        ))}
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-4 text-xs font-mono text-muted" aria-hidden="true">
                {series.map((s) => (
                    <span key={s.label} className="inline-flex items-center gap-1.5">
                        <span
                            className="inline-block w-2.5 h-2.5 rounded-xs"
                            style={{ background: s.color }}
                        />
                        {s.label}
                    </span>
                ))}
            </div>
        </figure>
    );
};
