import { useLayoutEffect, useRef, useState } from "react";

interface SparklineProps {
    data: number[];
    minWidth?: number;
    height?: number;
    className?: string;
}

export const Sparkline = ({
    data,
    minWidth = 96,
    height = 24,
    className = "",
}: SparklineProps) => {
    const svgRef = useRef<SVGSVGElement>(null);
    const [width, setWidth] = useState(minWidth);
    const hasData = data.length > 0;

    useLayoutEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;
        const observer = new ResizeObserver(([entry]) => {
            setWidth(Math.max(minWidth, entry.contentRect.width));
        });
        observer.observe(svg);
        return () => observer.disconnect();
    }, [minWidth, hasData]);

    if (!hasData) return null;

    const first = data[0];
    const last = data[data.length - 1];
    const delta = last - first;

    const color =
        Math.abs(delta) < 1
            ? "var(--color-muted)"
            : delta > 0
              ? "var(--color-up)"
              : "var(--color-down)";

    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min;
    const mid = (min + max) / 2;

    const yMin = span < 40 ? mid - 20 : min;
    const yMax = span < 40 ? mid + 20 : max;
    const yRange = yMax - yMin || 1;

    const padX = 3;
    const padY = 3;
    const innerWidth = width - padX * 2;
    const innerHeight = height - padY * 2;

    const points = data.map((val, idx) => {
        const x =
            data.length === 1
                ? width / 2
                : padX + (idx / (data.length - 1)) * innerWidth;
        const y = padY + (1 - (val - yMin) / yRange) * innerHeight;
        return { x, y };
    });

    const pointsString = points
        .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
        .join(" ");

    const baseY = padY + (1 - (first - yMin) / yRange) * innerHeight;
    const lastPoint = points[points.length - 1];
    const deltaSign = delta > 0 ? "+" : "";
    const tooltip = `${Math.round(first)} → ${Math.round(last)} (${deltaSign}${Math.round(delta)})`;

    return (
        <div className={`relative ${className}`} style={{ minWidth, height }}>
            <svg
                ref={svgRef}
                viewBox={`0 0 ${width} ${height}`}
                className="absolute inset-0 w-full h-full overflow-visible"
            >
                <title>{tooltip}</title>
                <line
                    x1={padX}
                    y1={baseY}
                    x2={width - padX}
                    y2={baseY}
                    stroke="var(--color-muted)"
                    strokeDasharray="2 2"
                    strokeOpacity={0.35}
                    strokeWidth={1}
                />
                {data.length > 1 && (
                    <polyline
                        fill="none"
                        stroke={color}
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        points={pointsString}
                    />
                )}
                <circle
                    cx={lastPoint.x}
                    cy={lastPoint.y}
                    r={2}
                    fill={color}
                />
            </svg>
        </div>
    );
};
