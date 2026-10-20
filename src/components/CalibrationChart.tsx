import { useState } from "react";
import type { EloCalibrationBin } from "../elo/types.ts";

interface Series {
    label: string;
    color: string;
    shape: "circle" | "square";
    bins: EloCalibrationBin[];
}

const W = 360;
const H = 300;
const PAD = { top: 12, right: 12, bottom: 36, left: 44 };
const LO = 0.5;
const HI = 1;
const TICKS = [0.5, 0.6, 0.7, 0.8, 0.9, 1];
const MIN_BIN = 20;

const x = (v: number) => PAD.left + ((v - LO) / (HI - LO)) * (W - PAD.left - PAD.right);
const y = (v: number) => H - PAD.bottom - ((v - LO) / (HI - LO)) * (H - PAD.top - PAD.bottom);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Predicted favourite win rate vs. observed; points on the diagonal are perfectly calibrated. Bins under 20 series are hidden. */
export const CalibrationChart = ({ series }: { series: Series[] }) => {
    const [hover, setHover] = useState<{ s: Series; b: EloCalibrationBin } | null>(null);

    return (
        <figure className="space-y-2">
            <div className="flex flex-wrap gap-4 text-xs font-mono text-muted" aria-hidden="true">
                {series.map((s) => (
                    <span key={s.label} className="inline-flex items-center gap-1.5">
                        <svg width="10" height="10">
                            {s.shape === "circle" ? <circle cx="5" cy="5" r="4" fill={s.color} /> : <rect x="1" y="1" width="8" height="8" rx="1" fill={s.color} />}
                        </svg>
                        {s.label}
                    </span>
                ))}
            </div>
            <div className="relative max-w-md">
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Calibration chart: predicted versus actual win rate">
                    {TICKS.map((t) => (
                        <g key={t}>
                            <line x1={x(LO)} x2={x(HI)} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
                            <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">
                                {pct(t)}
                            </text>
                            <text x={x(t)} y={H - PAD.bottom + 14} textAnchor="middle" fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">
                                {pct(t)}
                            </text>
                        </g>
                    ))}
                    <line x1={x(LO)} y1={y(LO)} x2={x(HI)} y2={y(HI)} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
                    <text x={(x(LO) + x(HI)) / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">
                        Predicted (favourite)
                    </text>
                    <text transform={`translate(10 ${(y(LO) + y(HI)) / 2}) rotate(-90)`} textAnchor="middle" fontSize={10} fill="var(--muted)" fontFamily="var(--font-mono)">
                        Actual
                    </text>
                    {series.map((s) => {
                        const bins = s.bins.filter((b) => b.n >= MIN_BIN);
                        return (
                            <g key={s.label}>
                                <polyline
                                    points={bins.map((b) => `${x(b.predicted)},${y(b.actual)}`).join(" ")}
                                    fill="none"
                                    stroke={s.color}
                                    strokeWidth={2}
                                    strokeLinejoin="round"
                                />
                                {bins.map((b) => {
                                    const cx = x(b.predicted);
                                    const cy = y(Math.max(LO, b.actual));
                                    const active = hover?.s === s && hover.b === b;
                                    return (
                                        <g key={b.lo} onMouseEnter={() => setHover({ s, b })} onMouseLeave={() => setHover(null)}>
                                            <circle cx={cx} cy={cy} r={12} fill="transparent" />
                                            {s.shape === "circle" ? (
                                                <circle cx={cx} cy={cy} r={active ? 6 : 4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                                            ) : (
                                                <rect
                                                    x={cx - (active ? 6 : 4.5)}
                                                    y={cy - (active ? 6 : 4.5)}
                                                    width={active ? 12 : 9}
                                                    height={active ? 12 : 9}
                                                    rx={1.5}
                                                    fill={s.color}
                                                    stroke="var(--surface)"
                                                    strokeWidth={2}
                                                />
                                            )}
                                        </g>
                                    );
                                })}
                            </g>
                        );
                    })}
                </svg>
                {hover && (
                    <div
                        className="pointer-events-none absolute z-10 rounded-sm border border-line bg-surface px-2 py-1 text-[11px] font-mono text-fg shadow-sm"
                        style={{ left: `${(x(hover.b.predicted) / W) * 100}%`, top: `${(y(Math.max(LO, hover.b.actual)) / H) * 100}%`, transform: "translate(-50%, -130%)" }}
                    >
                        <div className="font-semibold">{hover.s.label}</div>
                        <div>
                            {pct(hover.b.lo)}–{pct(hover.b.hi)}: predicted {pct(hover.b.predicted)}, actual {pct(hover.b.actual)}
                        </div>
                        <div className="text-muted">{hover.b.n} series</div>
                    </div>
                )}
            </div>
            <details className="text-xs font-mono">
                <summary className="cursor-pointer text-muted hover:text-fg">Table view</summary>
                <div className="overflow-x-auto">
                    <table className="mt-2 border-collapse">
                        <thead>
                            <tr className="text-muted">
                                <th className="pr-4 text-left font-medium">Model</th>
                                <th className="pr-4 text-left font-medium">Bin</th>
                                <th className="pr-4 text-right font-medium">Series</th>
                                <th className="pr-4 text-right font-medium">Predicted</th>
                                <th className="text-right font-medium">Actual</th>
                            </tr>
                        </thead>
                        <tbody>
                            {series.flatMap((s) =>
                                s.bins
                                    .filter((b) => b.n > 0)
                                    .map((b) => (
                                        <tr key={`${s.label}-${b.lo}`}>
                                            <td className="pr-4">{s.label}</td>
                                            <td className="pr-4">
                                                {pct(b.lo)}–{pct(b.hi)}
                                            </td>
                                            <td className="pr-4 text-right">{b.n}</td>
                                            <td className="pr-4 text-right">{pct(b.predicted)}</td>
                                            <td className="text-right">{pct(b.actual)}</td>
                                        </tr>
                                    ))
                            )}
                        </tbody>
                    </table>
                </div>
            </details>
        </figure>
    );
};
