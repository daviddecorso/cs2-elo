import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { heatmapAverageQuery, heatmapIndexQuery, heatmapMapQuery } from "../../data/queries.ts";
import {
    GRID_SIZE,
    colorizeDiverging,
    colorizeHeat,
    colorizeOverlay,
    decodeGrid,
    diffGrid,
    formatMapName,
    gaussianBlur,
    perRound,
} from "../../war/heatmap.ts";
import type {
    GrenadeType,
    HeatmapLayer,
    HeatmapLevel,
    HeatmapPhase,
    HeatmapSide,
    LevelGrids,
    SparseGrid,
} from "../../war/heatmapTypes.ts";
import { Badge, Button, EmptyState, Inset, Label, LoadingBar, Section, Segmented, Tooltip } from "../ui.tsx";
import { CalloutList } from "./CalloutList.tsx";
import { RadarHeatmap } from "./RadarHeatmap.tsx";

const SIDE_OPTIONS: Array<{ value: HeatmapSide; label: string }> = [
    { value: "t", label: "T side" },
    { value: "ct", label: "CT side" },
];

const PHASE_OPTIONS: Array<{ value: HeatmapPhase; label: string }> = [
    { value: "setup", label: "Setup" },
    { value: "mid", label: "Mid" },
    { value: "late", label: "Late" },
    { value: "post", label: "Post-plant" },
];

const GRENADE_OPTIONS: Array<{ value: GrenadeType; label: string }> = [
    { value: "smoke", label: "Smoke" },
    { value: "flash", label: "Flash" },
    { value: "he", label: "HE" },
    { value: "molotov", label: "Molotov" },
];

const LEVEL_OPTIONS: Array<{ value: HeatmapLevel; label: string }> = [
    { value: "upper", label: "Upper" },
    { value: "lower", label: "Lower" },
];

const pickGrid = (
    levelGrids: LevelGrids | undefined,
    layer: HeatmapLayer,
    phase: HeatmapPhase,
    grenadeType: GrenadeType
): SparseGrid | undefined => {
    if (!levelGrids) return undefined;
    switch (layer) {
        case "positions":
            return levelGrids.presence?.[phase];
        case "kills":
            return levelGrids.kills;
        case "deaths":
            return levelGrids.deaths;
        case "plants":
            return levelGrids.plant;
        case "utility":
            return levelGrids[`util_land:${grenadeType}`];
        case "openings":
            return levelGrids.open_kill;
    }
};

export interface MapTendenciesProps {
    steamid: string;
    selectedMap?: string;
    onSelectMap?: (map: string) => void;
    showEmpty?: boolean;
}

export const MapTendencies = ({
    steamid,
    selectedMap: controlledMap,
    onSelectMap,
    showEmpty = false,
}: MapTendenciesProps) => {
    const { data: index, isLoading: indexLoading } = useQuery(heatmapIndexQuery(steamid));
    const [uncontrolledMap, setUncontrolledMap] = useState<string>("");
    const [side, setSide] = useState<HeatmapSide>("ct");
    const [layer, setLayer] = useState<HeatmapLayer>("positions");
    const [phase, setPhase] = useState<HeatmapPhase>("setup");
    const [grenadeType, setGrenadeType] = useState<GrenadeType>("smoke");
    const [level, setLevel] = useState<HeatmapLevel>("upper");
    const [vsAverage, setVsAverage] = useState(false);
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const selectedMap = controlledMap ?? uncontrolledMap;
    const setSelectedMap = (map: string) => {
        if (onSelectMap) onSelectMap(map);
        else setUncontrolledMap(map);
    };

    const maps = useMemo(() => index?.maps ?? [], [index]);
    const activeMap = useMemo(
        () => maps.find((m) => m.map === selectedMap) ?? maps[0],
        [maps, selectedMap]
    );
    const activeMapName = activeMap?.map ?? "";

    useEffect(() => {
        if (!activeMap) return;
        if (!activeMap.levels.includes(level)) setLevel("upper");
    }, [activeMap, level]);

    useEffect(() => {
        if (side === "ct" && layer === "plants") setLayer("positions");
    }, [side, layer]);

    const { data: mapData, isLoading: mapLoading } = useQuery({
        ...heatmapMapQuery(steamid, activeMapName),
        enabled: Boolean(activeMapName),
    });

    const { data: avgData, isLoading: avgLoading } = useQuery({
        ...heatmapAverageQuery(activeMapName),
        enabled: Boolean(activeMapName) && vsAverage,
    });

    const gridSize = mapData?.gridSize ?? GRID_SIZE;

    const rgba = useMemo(() => {
        if (!mapData) return null;
        const playerSide = mapData.sides[side];
        const rounds = mapData.rounds[side];
        if (!playerSide || rounds <= 0) return null;

        const lvlGrids = playerSide.grids[level];
        const avgLvlGrids = avgData?.sides[side]?.grids[level];
        const avgScale = avgData?.scale ?? 10_000;

        if (layer === "openings") {
            const pKills = gaussianBlur(perRound(decodeGrid(lvlGrids?.open_kill, gridSize), rounds), gridSize, 1.0);
            const pDeaths = gaussianBlur(perRound(decodeGrid(lvlGrids?.open_death, gridSize), rounds), gridSize, 1.0);
            if (vsAverage && avgData) {
                const aKills = gaussianBlur(perRound(decodeGrid(avgLvlGrids?.open_kill, gridSize), avgScale), gridSize, 1.0);
                const aDeaths = gaussianBlur(perRound(decodeGrid(avgLvlGrids?.open_death, gridSize), avgScale), gridSize, 1.0);
                const netPlayer = diffGrid(pKills, pDeaths);
                const netAvg = diffGrid(aKills, aDeaths);
                return colorizeDiverging(diffGrid(netPlayer, netAvg));
            }
            return colorizeOverlay(pKills, pDeaths);
        }

        const pRaw = decodeGrid(pickGrid(lvlGrids, layer, phase, grenadeType), gridSize);
        const pRate = gaussianBlur(perRound(pRaw, rounds), gridSize, 1.0);
        if (vsAverage && avgData) {
            const aRaw = decodeGrid(pickGrid(avgLvlGrids, layer, phase, grenadeType), gridSize);
            const aRate = gaussianBlur(perRound(aRaw, avgScale), gridSize, 1.0);
            return colorizeDiverging(diffGrid(pRate, aRate));
        }
        return colorizeHeat(pRate);
    }, [mapData, avgData, side, level, layer, phase, grenadeType, vsAverage, gridSize]);

    const lineups = useMemo(() => {
        if (layer !== "utility" || !mapData) return [];
        const all = mapData.sides[side]?.lineups[grenadeType] ?? [];
        return all.filter((l) => (l.level ?? "upper") === level);
    }, [layer, mapData, side, grenadeType, level]);

    if (indexLoading && showEmpty) return <LoadingBar label="Loading map tendencies…" />;
    if (!index || !activeMap) {
        return showEmpty ? (
            <EmptyState>No map tendency heatmaps available for this player in the current window.</EmptyState>
        ) : null;
    }

    const layerOptions: Array<{ value: HeatmapLayer; label: string }> = [
        { value: "positions", label: "Positions" },
        { value: "kills", label: "Kills" },
        { value: "deaths", label: "Deaths" },
        { value: "openings", label: "Opening duels" },
        { value: "utility", label: "Utility" },
        ...(side === "t" ? [{ value: "plants" as const, label: "Plants" }] : []),
    ];

    const hasLower = activeMap.levels.includes("lower");

    const selectTab = (nextIdx: number) => {
        const clamped = (nextIdx + maps.length) % maps.length;
        const target = maps[clamped];
        if (!target) return;
        setSelectedMap(target.map);
        const btn = tabRefs.current[clamped];
        btn?.focus();
        btn?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };

    const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
        if (e.key === "ArrowRight") {
            e.preventDefault();
            tabRefs.current[(idx + 1) % maps.length]?.focus();
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            tabRefs.current[(idx - 1 + maps.length) % maps.length]?.focus();
        } else if (e.key === "Home") {
            e.preventDefault();
            tabRefs.current[0]?.focus();
        } else if (e.key === "End") {
            e.preventDefault();
            tabRefs.current[maps.length - 1]?.focus();
        }
    };

    const windowLabel = index.window.months
        ? `Last ${index.window.months} months (${index.window.from} to ${index.window.to})`
        : `${index.window.from} to ${index.window.to}`;

    const legend = vsAverage ? (
        <div className="flex items-center gap-2 text-[11px] font-mono text-muted">
            <span>Less than avg</span>
            <div
                className="h-2 flex-1 rounded-xs border border-line"
                style={{
                    background:
                        "linear-gradient(to right, #bae6fd, #38bdf8, #2563eb 42%, transparent 50%, #ea580c 58%, #fb923c, #fef08a)",
                }}
                aria-hidden="true"
            />
            <span>More than avg</span>
        </div>
    ) : layer === "openings" ? (
        <div className="flex items-center gap-4 text-[11px] font-mono text-muted">
            <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-emerald-400 inline-block" aria-hidden="true" />
                Opening kills
            </span>
            <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-rose-500 inline-block" aria-hidden="true" />
                Opening deaths
            </span>
        </div>
    ) : (
        <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] font-mono text-muted">
                <span>Low</span>
                <div
                    className="h-2 flex-1 rounded-xs border border-line"
                    style={{
                        background:
                            "linear-gradient(to right, transparent, #26105c 18%, #7a1c72 40%, #d44242 62%, #f99b1e 82%, #fcffa8)",
                    }}
                    aria-hidden="true"
                />
                <span>High</span>
            </div>
            {layer === "utility" && (
                <div className="flex items-center gap-4 text-[11px] font-mono text-muted">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full border-2 border-zinc-300 inline-block" aria-hidden="true" />
                        Landing zones
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-zinc-300 inline-block" aria-hidden="true" />
                        Throw spots
                    </span>
                </div>
            )}
        </div>
    );

    const ariaLabel = `${formatMapName(activeMap.map)} ${level} ${side.toUpperCase()} ${layer}${
        layer === "positions" ? ` (${phase})` : layer === "utility" ? ` (${grenadeType})` : ""
    }${vsAverage ? " vs average" : ""} heatmap`;

    return (
        <Section
            title="Map tendencies"
            subtitle={`${windowLabel}. Current team when 3+ maps are available on that map, otherwise all teams in the window.`}
        >
            {/* Selection by activation because switching maps fetches grids on demand. */}
            <div
                role="tablist"
                aria-label="Maps"
                className="tab-scroller flex items-stretch gap-1 overflow-x-auto border-b border-line"
            >
                {maps.map((m, idx) => {
                    const selected = m.map === activeMap.map;
                    return (
                        <button
                            key={m.map}
                            ref={(el) => {
                                tabRefs.current[idx] = el;
                            }}
                            type="button"
                            role="tab"
                            id={`heatmap-tab-${m.map}`}
                            aria-selected={selected}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => selectTab(idx)}
                            onKeyDown={(e) => handleTabKeyDown(e, idx)}
                            className="relative shrink-0 snap-start px-3.5 py-2.5 text-xs font-mono cursor-pointer whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px] text-muted hover:text-fg aria-selected:text-fg aria-selected:after:content-[''] aria-selected:after:absolute aria-selected:after:inset-x-0 aria-selected:after:bottom-0 aria-selected:after:border-b-2 aria-selected:after:border-accent"
                        >
                            <span>{formatMapName(m.map)}</span>
                            <span className="ml-1.5 text-[11px] text-muted tabular-nums">{m.maps}m</span>
                            {m.scope.type === "all" && (
                                <span className="ml-1 text-[10px] text-muted uppercase">all</span>
                            )}
                            {m.lowSample && (
                                <Badge tone="heat" className="ml-1.5 px-1 py-0 text-[9px]">
                                    low
                                </Badge>
                            )}
                        </button>
                    );
                })}
            </div>

            <div
                role="tabpanel"
                aria-labelledby={`heatmap-tab-${activeMap.map}`}
                className="space-y-5 pt-1"
            >
                <Inset className="p-3 space-y-2.5">
                    <div className="flex flex-wrap-balance items-center gap-x-3 gap-y-2">
                        <Segmented
                            aria-label="Side"
                            options={SIDE_OPTIONS}
                            value={side}
                            onChange={setSide}
                        />
                        <Segmented
                            aria-label="Layer"
                            options={layerOptions}
                            value={layer}
                            onChange={setLayer}
                        />
                        {hasLower && (
                            <Segmented
                                aria-label="Radar level"
                                options={LEVEL_OPTIONS}
                                value={level}
                                onChange={setLevel}
                            />
                        )}
                        <Tooltip content="Diverging diff of this player's per-round rate against the average across all qualified players on this map.">
                            <Button
                                type="button"
                                size="sm"
                                variant={vsAverage ? "primary" : "secondary"}
                                aria-pressed={vsAverage}
                                onClick={() => setVsAverage((v) => !v)}
                            >
                                vs average
                            </Button>
                        </Tooltip>
                    </div>

                    {layer === "positions" && (
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line/60">
                            <Label as="span">Phase</Label>
                            <Segmented
                                aria-label="Round phase"
                                options={PHASE_OPTIONS}
                                value={phase}
                                onChange={setPhase}
                            />
                        </div>
                    )}

                    {layer === "utility" && (
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line/60">
                            <Label as="span">Grenade</Label>
                            <Segmented
                                aria-label="Grenade type"
                                options={GRENADE_OPTIONS}
                                value={grenadeType}
                                onChange={setGrenadeType}
                            />
                        </div>
                    )}
                </Inset>

                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,540px)_minmax(0,1fr)] gap-6 items-start">
                    <RadarHeatmap
                        map={activeMap.map}
                        level={level}
                        rgba={rgba}
                        gridSize={gridSize}
                        lineups={lineups}
                        grenadeType={grenadeType}
                        ariaLabel={ariaLabel}
                        loading={mapLoading || (vsAverage && avgLoading)}
                        legend={legend}
                    />
                    <CalloutList
                        mapSummary={activeMap}
                        side={side}
                        layer={layer}
                        phase={phase}
                        grenadeType={grenadeType}
                        lineups={lineups}
                    />
                </div>
            </div>
        </Section>
    );
};

export default MapTendencies;
