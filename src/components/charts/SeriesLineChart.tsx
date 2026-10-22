import type { ReactNode } from "react";
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
import { Card, Section } from "../ui.tsx";

export interface Series {
    key: string;
    label: string;
    color: string;
    dashed?: boolean;
    width?: number;
    hideFromLegend?: boolean;
}

export type SeriesPoint = { label: string } & Record<string, number | string | undefined>;

interface SeriesLineChartProps {
    title: string;
    actions?: ReactNode;
    data: SeriesPoint[];
    series: Series[];
    format: (value: number) => string;
    domain?: [number | "auto", number | "auto"];
    empty?: string;
    /** X-axis labels to tick; defaults to Recharts' own spacing. */
    ticks?: string[];
    tickFormatter?: (label: string) => string;
    /** X-axis labels that get a faint vertical rule. */
    dividers?: string[];
}

const AXIS_TICK = {
    fill: "var(--color-muted)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
};

interface TooltipContentProps {
    active?: boolean;
    label?: string;
    payload?: Array<{ dataKey: string; value: number }>;
    series: Series[];
    format: (value: number) => string;
}

const TooltipContent = ({ active, label, payload, series, format }: TooltipContentProps) => {
    if (!active || !payload?.length) return null;
    const values = new Map(payload.map((p) => [p.dataKey, p.value]));
    return (
        <Card className="p-2 text-xs font-mono text-fg">
            <div className="text-[11px] text-muted uppercase tracking-wider mb-1">{label}</div>
            {series
                .filter((s) => values.get(s.key) !== undefined)
                .sort((a, b) => values.get(b.key)! - values.get(a.key)!)
                .map((s) => (
                    <div key={s.key} className="flex items-center justify-between gap-4">
                        <span className="flex items-center gap-1.5 text-muted">
                            <span className="inline-block w-2 h-2 rounded-full" style={{ background: s.color }} />
                            {s.label}
                        </span>
                        <span className="font-semibold text-fg">{format(values.get(s.key)!)}</span>
                    </div>
                ))}
        </Card>
    );
};

export const SeriesLineChart = ({
    title,
    actions,
    data,
    series,
    format,
    domain = ["auto", "auto"],
    empty = "No data yet",
    ticks,
    tickFormatter,
    dividers = [],
}: SeriesLineChartProps) => (
    <Section title={title} actions={actions}>
        {data.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-xs font-mono text-muted">{empty}</div>
        ) : (
            <>
                <div className="w-full h-64">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                            <CartesianGrid stroke="var(--color-line)" vertical={false} />
                            <XAxis
                                dataKey="label"
                                stroke="var(--color-line)"
                                tick={AXIS_TICK}
                                tickLine={{ stroke: "var(--color-line)" }}
                                ticks={ticks}
                                tickFormatter={tickFormatter}
                            />
                            <YAxis
                                domain={domain}
                                stroke="var(--color-line)"
                                tick={AXIS_TICK}
                                tickLine={{ stroke: "var(--color-line)" }}
                                tickFormatter={format}
                            />
                            {dividers.map((d) => (
                                <ReferenceLine key={d} x={d} stroke="var(--color-line)" strokeDasharray="3 3" />
                            ))}
                            <Tooltip
                                content={<TooltipContent series={series} format={format} />}
                                cursor={{ stroke: "var(--color-line)" }}
                            />
                            {series.map((s) => (
                                <Line
                                    key={s.key}
                                    type="monotone"
                                    dataKey={s.key}
                                    name={s.label}
                                    stroke={s.color}
                                    strokeWidth={s.width ?? 2}
                                    strokeDasharray={s.dashed ? "4 4" : undefined}
                                    dot={{ fill: s.color, r: 2 }}
                                    activeDot={{ r: 4 }}
                                    connectNulls
                                />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs font-mono text-muted pt-2">
                    {series
                        .filter((s) => !s.hideFromLegend)
                        .map((s) => (
                            <span key={s.key} className="inline-flex items-center gap-1.5">
                                <span
                                    className="inline-block w-2.5 h-0.5 rounded-full"
                                    style={{ background: s.color }}
                                />
                                {s.label}
                            </span>
                        ))}
                </div>
            </>
        )}
    </Section>
);
