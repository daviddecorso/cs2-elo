import { Tooltip } from "./ui.tsx";

export interface PercentileRowProps {
    label: string;
    pct: number;
    detail: string;
    value?: string;
    /** `production` colors high/low percentiles as up/down; `style` marks deviation from the 50th percentile in accent. */
    tone?: "production" | "style";
}

/** `pct` runs 0 (lowest in the pool) to 100 (highest). */
export const PercentileRow = ({ label, pct, detail, value, tone = "style" }: PercentileRowProps) => {
    const clamped = Math.max(0, Math.min(100, pct));
    const prodHigh = tone === "production" && clamped >= 75;
    const prodLow = tone === "production" && clamped <= 25;

    const dotColor = prodHigh ? "bg-up" : prodLow ? "bg-down" : "bg-accent";
    const fillColor = prodHigh ? "bg-up/35" : prodLow ? "bg-down/35" : "bg-accent/35";
    const numColor = prodHigh ? "text-up font-semibold" : prodLow ? "text-down" : "text-fg";

    const fillStyle =
        tone === "style"
            ? {
                  left: `${Math.min(50, clamped)}%`,
                  width: `${Math.abs(clamped - 50)}%`,
              }
            : {
                  left: "0%",
                  width: `${clamped}%`,
              };

    return (
        <div
            className={`grid ${
                value !== undefined ? "grid-cols-[minmax(8.25rem,auto)_3.5rem_1fr_2.25rem]" : "grid-cols-[minmax(8.25rem,auto)_1fr_2.25rem]"
            } items-center gap-3 py-1.5 px-1.5 -mx-1.5 rounded-xs hover:bg-surface/70 transition-colors text-xs`}
        >
            <Tooltip content={detail} className="min-w-0">
                <span className="text-fg truncate block">{label}</span>
            </Tooltip>
            {value !== undefined && (
                <span className="text-right font-mono tabular-nums text-[11px] text-muted truncate">{value}</span>
            )}
            <span role="img" aria-label={`${label}: ${pct}th percentile`} className="relative h-3 flex items-center">
                <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-bg border border-line/70 overflow-clip">
                    <span className={`absolute inset-y-0 ${fillColor}`} style={fillStyle} />
                </span>
                <span className="absolute left-1/2 top-0 bottom-0 w-px bg-muted/40" aria-hidden="true" />
                <span
                    className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full border border-surface ${dotColor}`}
                    style={{ left: `${clamped}%` }}
                />
            </span>
            <span className={`text-right font-mono tabular-nums ${numColor}`}>{pct}</span>
        </div>
    );
};
