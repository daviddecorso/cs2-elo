import { useQuery } from "@tanstack/react-query";
import { CalibrationChart } from "../components/charts/CalibrationChart.tsx";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import {
    Badge,
    Card,
    EmptyState,
    Inset,
    Label,
    LoadingBar,
    PageHeader,
    Section,
    StatTile,
    Tooltip,
} from "../components/ui.tsx";
import type { EloCalibration, EloScore } from "../elo/types.ts";

const fetchCalibration = async (): Promise<EloCalibration> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/elo/calibration.json`);
    if (!res.ok) throw new Error(`Failed to load calibration: HTTP ${res.status}`);
    return res.json();
};

const ScoreRow = ({
    label,
    s,
    highlight = false,
}: {
    label: string;
    s: EloScore;
    highlight?: boolean;
}) => (
    <Row highlighted={highlight}>
        <Td className="font-sans font-medium">{label}</Td>
        <Td align="right">{s.n.toLocaleString()}</Td>
        <Td align="right" className="font-semibold">{s.logLoss.toFixed(4)}</Td>
        <Td align="right">{s.brier.toFixed(4)}</Td>
        <Td align="right">{(s.accuracy * 100).toFixed(1)}%</Td>
    </Row>
);

export const Model = () => {
    const { data, isLoading, error } = useQuery({
        queryKey: ["elo", "calibration"],
        queryFn: fetchCalibration,
    });

    if (isLoading) return <LoadingBar label="Loading model validation data…" />;
    if (error || !data) {
        return (
            <EmptyState className="text-down">
                Error loading calibration: {error instanceof Error ? error.message : "Unknown error"}
            </EmptyState>
        );
    }

    const gateDiff = (data.gate.vrs.logLoss - data.gate.elo.logLoss).toFixed(4);

    return (
        <div className="space-y-10">
            <PageHeader
                title="Model Performance & Validation"
                subtitle={`Out-of-sample backtest evaluated on series from ${data.testFrom} onwards`}
                eyebrow="Empirical Verification"
                actions={
                    <Badge tone={data.gate.passed ? "up" : "down"} className="text-xs px-2.5 py-1">
                        {data.gate.passed ? "Gate Passed: Elo beats VRS" : "Gate Failed"}
                    </Badge>
                }
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card className="p-4">
                    <StatTile
                        label="Gate Series"
                        value={data.gate.n.toLocaleString()}
                        caption="Both rosters VRS-ranked"
                    />
                </Card>
                <Card className="p-4">
                    <StatTile
                        label="Log Loss Advantage"
                        value={`+${gateDiff}`}
                        caption="Elo vs. VRS baseline"
                    />
                </Card>
                <Card className="p-4">
                    <StatTile
                        label="Total 2026 Series"
                        value={data.all.n.toLocaleString()}
                        caption={`${data.maps.n.toLocaleString()} maps rated`}
                    />
                </Card>
                <Card className="p-4">
                    <StatTile
                        label="Elo Match Accuracy"
                        value={`${(data.all.accuracy * 100).toFixed(1)}%`}
                        caption={`Brier ${(data.all.brier).toFixed(4)}`}
                    />
                </Card>
            </div>

            <Section
                title="Elo vs. Valve Regional Standings (VRS)"
                subtitle={`The VRS baseline predicts series from points differences in the latest pre-match snapshot (scale: ${data.vrsScale}). Lower log loss indicates superior predictive calibration.`}
                actions={
                    <span className={`text-xs font-mono font-medium ${data.gate.passed ? "text-up" : "text-down"}`}>
                        {data.gate.passed ? "✓ Gate passed" : "✕ Gate failed"}
                    </span>
                }
            >
                <DataTable>
                    <TableHead>
                        <Th align="left">Evaluation slice</Th>
                        <Th>Series / Maps</Th>
                        <Th>
                            <Tooltip content="Binary cross-entropy loss. Heavily penalizes confident incorrect forecasts. Lower is better.">
                                Log loss
                            </Tooltip>
                        </Th>
                        <Th>
                            <Tooltip content="Mean squared error of probabilities. 0 is perfect prediction. Lower is better.">
                                Brier
                            </Tooltip>
                        </Th>
                        <Th>
                            <Tooltip content="Raw percentage of favorites that won the match.">
                                Accuracy
                            </Tooltip>
                        </Th>
                    </TableHead>
                    <TableBody>
                        <ScoreRow label="Elo: both rosters VRS-ranked (gate test)" s={data.gate.elo} highlight />
                        <ScoreRow label="VRS baseline: both rosters VRS-ranked" s={data.gate.vrs} />
                        <ScoreRow label="Elo: cross-region series" s={data.crossRegion.elo} highlight />
                        <ScoreRow label="VRS baseline: cross-region series" s={data.crossRegion.vrs} />
                        <ScoreRow label="Elo: all 2026 series" s={data.all} />
                        <ScoreRow label="Elo: all 2026 individual maps" s={data.maps} />
                    </TableBody>
                </DataTable>
            </Section>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
                <Section
                    title="Calibration Curves"
                    subtitle="Forecasts folded onto the favorite and binned by predicted win rate. Points on the diagonal represent perfect probabilistic calibration."
                >
                    <Card className="p-4">
                        <CalibrationChart
                            series={[
                                { label: "Elo (all series)", color: "var(--color-accent)", shape: "circle", bins: data.bins.elo },
                                { label: "VRS (ranked pairs)", color: "var(--color-series-2)", shape: "square", bins: data.bins.vrs },
                            ]}
                        />
                    </Card>
                </Section>

                <Section
                    title="Calibration Bins Breakdown"
                    subtitle="Favorite win rates by predicted probability band. Bins with sample size under 20 are omitted."
                >
                    <DataTable>
                        <TableHead>
                            <Th align="left">Favorite Band</Th>
                            <Th>Elo Pred.</Th>
                            <Th>Elo Won</Th>
                            <Th>Elo N</Th>
                            <Th>VRS Won</Th>
                            <Th>VRS N</Th>
                        </TableHead>
                        <TableBody>
                            {data.bins.elo.map((eb, i) => {
                                const vb = data.bins.vrs[i];
                                return (
                                    <Row key={eb.lo}>
                                        <Td className="font-mono text-muted">
                                            {(eb.lo * 100).toFixed(0)}%–{(eb.hi * 100).toFixed(0)}%
                                        </Td>
                                        <Td align="right">{(eb.predicted * 100).toFixed(1)}%</Td>
                                        <Td align="right" className="font-semibold text-fg">
                                            {(eb.actual * 100).toFixed(1)}%
                                        </Td>
                                        <Td align="right" className="text-muted">{eb.n.toLocaleString()}</Td>
                                        <Td align="right">
                                            {vb && vb.n > 0 ? `${(vb.actual * 100).toFixed(1)}%` : "–"}
                                        </Td>
                                        <Td align="right" className="text-muted">
                                            {vb && vb.n > 0 ? vb.n.toLocaleString() : "–"}
                                        </Td>
                                    </Row>
                                );
                            })}
                        </TableBody>
                    </DataTable>
                </Section>
            </div>

            <Section
                title="Model Parameters & Architecture"
                subtitle="Parameters tuned via coordinate descent on 2024–2025 series (42,074 series) and validated out-of-sample on 2026 matches."
            >
                <Inset className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono">
                    <div className="space-y-1">
                        <Label>Base K-Factor</Label>
                        <div className="text-sm font-semibold text-fg">12 per map</div>
                        <div className="text-muted">Scaled by round margin and provisional boost</div>
                    </div>
                    <div className="space-y-1">
                        <Label>Series Softening</Label>
                        <div className="text-sm font-semibold text-fg">0.8 exponent</div>
                        <div className="text-muted">Accounts for intra-series map correlation in Bo3/Bo5</div>
                    </div>
                    <div className="space-y-1">
                        <Label>Round Margin Weight</Label>
                        <div className="text-sm font-semibold text-fg">0.75 (log margin)</div>
                        <div className="text-muted">Overtime wins fixed at 1-round effective margin</div>
                    </div>
                    <div className="space-y-1">
                        <Label>VRS Baseline Scale</Label>
                        <div className="text-sm font-semibold text-fg">880 points</div>
                        <div className="text-muted">Fitted logistic scale for 10:1 win probability odds</div>
                    </div>
                </Inset>
            </Section>

            <LiquipediaCredit what="Match, map, and roster data" />
        </div>
    );
};
