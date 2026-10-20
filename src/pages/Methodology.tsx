import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { CalibrationChart } from "../components/CalibrationChart.tsx";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { EmptyState, LoadingBar, PageHeader, Section } from "../components/ui.tsx";
import type { EloCalibration, EloScore } from "../elo/types.ts";

const fetchCalibration = async (): Promise<EloCalibration> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/elo/calibration.json`);
    if (!res.ok) throw new Error(`Failed to load calibration: HTTP ${res.status}`);
    return res.json();
};

const ScoreRow = ({ label, s }: { label: string; s: EloScore }) => (
    <Row>
        <Td className="font-sans">{label}</Td>
        <Td align="right">{s.n}</Td>
        <Td align="right">{s.logLoss.toFixed(4)}</Td>
        <Td align="right">{s.brier.toFixed(4)}</Td>
        <Td align="right">{(s.accuracy * 100).toFixed(1)}%</Td>
    </Row>
);

const Prose = ({ children }: { children: React.ReactNode }) => <div className="max-w-3xl space-y-3 text-sm leading-relaxed text-fg">{children}</div>;

export const Methodology = () => {
    const { data, isLoading, error } = useQuery({ queryKey: ["elo", "calibration"], queryFn: fetchCalibration });

    if (isLoading) return <LoadingBar label="Loading methodology…" />;
    if (error || !data) {
        return (
            <EmptyState className="text-down">
                Error loading calibration: {error instanceof Error ? error.message : "Unknown error"}
            </EmptyState>
        );
    }

    return (
        <div className="space-y-10">
            <PageHeader title="Elo methodology" subtitle={`Backtest scored on series from ${data.testFrom}`} />

            <Section title="The model">
                <Prose>
                    <p>
                        Every map is rated, not every series. The update scales with round margin (an overtime win counts as a fixed small
                        margin), counts online maps for less than LAN maps, and counts lower-tier events for less. Results between rosters from
                        different regions count for more, because international matches are the only thing tying regional ratings together.
                        Each roster also carries a small rating offset per map, kept centred on zero and shrunk toward it.
                    </p>
                    <p>
                        A rating belongs to a roster, which is a set of five players. It carries over while three of the five remain, the same
                        rule Valve uses. Replacing one or two players pulls the rating part of the way back toward the average for the
                        roster&apos;s tier. A new roster starts from the average rating of its players&apos; previous rosters.
                    </p>
                    <p>
                        A series forecast averages the map win probability over the active map pool and converts it into a Bo1, Bo3 or Bo5
                        probability, softened for Bo3 and Bo5 because maps in the same series aren&apos;t independent. Liquipedia&apos;s API doesn&apos;t expose map vetoes, so the model doesn&apos;t try to predict them. Parameters
                        are tuned on 2024–2025 and scored on later series that tuning never saw.
                    </p>
                </Prose>
            </Section>

            <Section
                title="Elo vs. VRS"
                subtitle={`The baseline predicts from VRS point differences in the last snapshot before each series (scale ${data.vrsScale}). Lower log loss is better.`}
                actions={
                    <span className={`text-xs font-mono ${data.gate.passed ? "text-up" : "text-down"}`}>
                        {data.gate.passed ? "Elo beats VRS" : "Elo does not beat VRS"}
                    </span>
                }
            >
                <DataTable>
                    <TableHead>
                        <Th align="left">Model / set</Th>
                        <Th>Series</Th>
                        <Th>Log loss</Th>
                        <Th>Brier</Th>
                        <Th>Accuracy</Th>
                    </TableHead>
                    <TableBody>
                        <ScoreRow label="Elo, both rosters VRS-ranked" s={data.gate.elo} />
                        <ScoreRow label="VRS, both rosters VRS-ranked" s={data.gate.vrs} />
                        <ScoreRow label="Elo, cross-region" s={data.crossRegion.elo} />
                        <ScoreRow label="VRS, cross-region" s={data.crossRegion.vrs} />
                        <ScoreRow label="Elo, every series" s={data.all} />
                        <ScoreRow label="Elo, every map" s={data.maps} />
                    </TableBody>
                </DataTable>
            </Section>

            <Section title="Calibration" subtitle="Forecasts are folded onto the favourite and binned by predicted win probability.">
                <CalibrationChart
                    series={[
                        { label: "Elo, every series", color: "var(--accent)", shape: "circle", bins: data.bins.elo },
                        { label: "VRS, ranked pairs", color: "var(--series-2)", shape: "square", bins: data.bins.vrs },
                    ]}
                />
                <LiquipediaCredit what="Match and map results" />
            </Section>
        </div>
    );
};
