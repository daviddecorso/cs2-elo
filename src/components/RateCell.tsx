import { Tooltip } from "./ui.tsx";
import type { Rate } from "../war/types.ts";

const signed = (n: number) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

/** A per-100 rate with its 90% interval, colored when the interval excludes zero. */
export const RateCell = ({
    rate,
    label,
    unit,
}: {
    rate?: Rate & { per100_rounds?: number };
    label: string;
    unit: string;
}) =>
    rate ? (
        <Tooltip
            content={`${label} per 100 ${unit}\n90% series bootstrap: (${signed(rate.p5)}, ${signed(rate.p95)})${
                rate.per100_rounds !== undefined ? `\nPer 100 rounds: ${signed(rate.per100_rounds)}` : ""
            }`}
        >
            <span className="tabular-nums">
                <span className={rate.p5 > 0 ? "text-up" : rate.p95 < 0 ? "text-down" : "text-fg"}>{signed(rate.per100)}</span>
                <span className="text-muted text-[10px] ml-1">{`(${signed(rate.p5)}, ${signed(rate.p95)})`}</span>
            </span>
        </Tooltip>
    ) : (
        <span className="text-muted">–</span>
    );
