import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "../components/DataTable.tsx";
import { Badge, EmptyState, Inset, LoadingBar, PageHeader, Section, Segmented } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLink } from "../components/TeamLink.tsx";
import { fetchSimJson } from "../sim/fetch.ts";
import type { MajorHistory as MajorHistoryData, PastMajor, PastMajorStage } from "../sim/types.ts";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { percent } from "../utils/format.ts";

const EXTERNAL = "Supercomputer";
const MODEL_ORDER = ["Elo", "VRS", EXTERNAL, "Coin"];

const OUTCOME_LABEL: Record<string, string> = {
    "3-0": "3-0",
    "3-X": "3-1 / 3-2",
    "0-3": "0-3",
    out: "1-3 / 2-3",
    "5-8": "Quarterfinal",
    "3-4": "Semifinal",
    "2": "Runner-up",
    "1": "Champion",
};
const outcomeLabel = (o: string) => OUTCOME_LABEL[o] ?? o;

const loss = (x: number | null) => (x === null ? "—" : x.toFixed(3));
const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(3)}`;
const shortName = (name: string) => name.replace(/\bMajor\b\s*/, "").trim();
const byModel = <T extends { model: string }>(xs: T[]) =>
    [...xs].sort((a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model));

const Comparison = ({ data }: { data: MajorHistoryData }) => {
    const models = byModel(data.models);
    const best = Math.min(...models.flatMap((m) => (m.logLoss === null ? [] : [m.logLoss])));
    const bestAdvance = Math.min(...models.map((m) => m.advanceLogLoss));
    const pairs = [...new Set(data.diffs.map((d) => `${d.a}|${d.b}`))].map((key) => {
        const [a, b] = key.split("|");
        const of = (metric: "stage" | "advance") => data.diffs.find((d) => d.a === a && d.b === b && d.metric === metric);
        return { a, b, stage: of("stage"), advance: of("advance") };
    });
    const Diff = ({ d }: { d?: MajorHistoryData["diffs"][number] }) =>
        d ? (
            <span className={d.hi < 0 ? "text-up" : d.lo > 0 ? "text-down" : "text-fg"}>
                {signed(d.diff)}
                <span className="text-muted text-[10px]">
                    {" "}
                    ({signed(d.lo)} to {signed(d.hi)})
                </span>
            </span>
        ) : (
            <span className="text-muted">—</span>
        );

    return (
        <Section title="Model comparison" subtitle="Every stage scored from its first day, earlier stages played. Lower log loss is better.">
            <DataTable>
                <TableHead>
                    <Th align="left">Model</Th>
                    <Th>Stages</Th>
                    <Th>Stage log loss</Th>
                    <Th>Advance log loss</Th>
                    <Th>Advance Brier</Th>
                    <Th>Pick'em</Th>
                </TableHead>
                <TableBody>
                    {models.map((m) => (
                        <Row key={m.model}>
                            <Td className="text-fg font-medium">{m.model}</Td>
                            <Td align="right">{m.stages}</Td>
                            <Td align="right" className={m.logLoss === best ? "text-up font-semibold" : ""}>
                                {loss(m.logLoss)}
                            </Td>
                            <Td align="right" className={m.advanceLogLoss === bestAdvance ? "text-up font-semibold" : ""}>
                                {loss(m.advanceLogLoss)}
                            </Td>
                            <Td align="right">{m.advanceBrier.toFixed(3)}</Td>
                            <Td align="right">
                                {m.pickem ? (
                                    <>
                                        {m.pickem.meanCorrect.toFixed(1)}/10
                                        <span className="text-muted text-[10px]">
                                            {" "}
                                            ({m.pickem.coins}/{m.pickem.stages} coins)
                                        </span>
                                    </>
                                ) : (
                                    <span className="text-muted">—</span>
                                )}
                            </Td>
                        </Row>
                    ))}
                </TableBody>
            </DataTable>

            <DataTable>
                <TableHead>
                    <Th align="left">Paired difference</Th>
                    <Th>Shared stages</Th>
                    <Th>Stage log loss</Th>
                    <Th>Advance log loss</Th>
                </TableHead>
                <TableBody>
                    {pairs.map(({ a, b, stage, advance }) => (
                        <Row key={`${a}-${b}`}>
                            <Td className="text-fg">
                                {a} − {b}
                            </Td>
                            <Td align="right">{(stage ?? advance)?.stages}</Td>
                            <Td align="right">
                                <Diff d={stage} />
                            </Td>
                            <Td align="right">
                                <Diff d={advance} />
                            </Td>
                        </Row>
                    ))}
                </TableBody>
            </DataTable>

            <Inset className="text-xs space-y-2">
                <p>
                    Stage log loss scores each team's result in the stage: its Pick'em bucket (3-0, 3-1 or 3-2, 1-3 or 2-3, 0-3) in a
                    Swiss stage, its placement in the playoffs. Advance log loss scores P(advance) alone, or P(title) in the playoffs.
                    Negative differences favour the first model; the bracket is a 90% interval from resampling stages, coloured when it
                    excludes zero. Pick'em is correct picks out of 10 per Swiss stage, and a coin needs 5.
                </p>
                <p>
                    <span className="text-fg">Elo</span> is this site's Major simulator, with ratings from the day before each stage.
                    Its parameters were tuned on {data.tuningYear} series, so {data.tuningYear} Majors are in-sample.{" "}
                    <span className="text-fg">VRS</span> turns Valve's points before the stage into series odds, scaled on the year
                    before. <span className="text-fg">Coin</span> gives every series 50%.
                    {data.external && (
                        <>
                            {" "}
                            <span className="text-fg">{EXTERNAL}</span> is the published stage forecasts and Pick'em from{" "}
                            {data.external.url ? (
                                <a href={data.external.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                                    {data.external.name}
                                </a>
                            ) : (
                                data.external.name
                            )}
                            , scored the same way on the Majors it covers. Only its scores are shown here; where a stage lacks its 0-3
                            column, only P(advance) is scored.
                        </>
                    )}
                </p>
            </Inset>
        </Section>
    );
};

const StageScores = ({ major }: { major: PastMajor }) => {
    const models = MODEL_ORDER.filter((m) => major.stages.some((s) => s.scores.some((x) => x.model === m)));
    const first = major.stages[0].scores.find((s) => s.model === "Elo");
    return (
        <div className="space-y-2">
            <DataTable>
                <TableHead>
                    <Th align="left">Stage</Th>
                    {models.map((m) => (
                        <Th key={m}>{m}</Th>
                    ))}
                </TableHead>
                <TableBody>
                    {major.stages.map((stage) => {
                        const best = Math.min(...stage.scores.flatMap((s) => (s.logLoss === null ? [] : [s.logLoss])));
                        return (
                            <Row key={stage.id}>
                                <Td className="text-fg">
                                    {stage.name}
                                    <span className="block text-[10px] text-muted">{stage.startDate}</span>
                                </Td>
                                {models.map((m) => {
                                    const s = stage.scores.find((x) => x.model === m);
                                    if (!s) return <Td key={m} align="right" className="text-muted">—</Td>;
                                    return (
                                        <Td key={m} align="right">
                                            <span className={s.logLoss === best ? "text-up font-semibold" : "text-fg"}>
                                                {s.logLoss === null ? `${loss(s.advanceLogLoss)} adv.` : loss(s.logLoss)}
                                            </span>
                                            {s.pickem !== null && <span className="block text-[10px] text-muted">{`${s.pickem}/10 Pick'em`}</span>}
                                        </Td>
                                    );
                                })}
                            </Row>
                        );
                    })}
                </TableBody>
            </DataTable>
            {first?.pChampion != null && (
                <p className="text-xs font-mono text-muted">
                    {`Before the event Elo gave ${major.champion} ${percent(first.pChampion)} to win, rank ${first.championRank} in the field.`}
                </p>
            )}
        </div>
    );
};

const PICK_BUCKETS = [
    ["threeZero", "3-0", "3-0 pick"],
    ["advance", "3-X", "advance pick"],
    ["zeroThree", "0-3", "0-3 pick"],
] as const;

const pickOf = (stage: PastMajorStage, team: string) => {
    for (const [key, outcome, label] of PICK_BUCKETS) if (stage.picks?.[key].includes(team)) return { outcome, label };
    return null;
};

const StageTeams = ({ stage, last }: { stage: PastMajorStage; last: boolean }) => {
    const teams = [...stage.teams].sort((a, b) => b.advance - a.advance);
    return (
        <DataTable>
            <TableHead>
                <Th align="left" sticky>
                    Team
                </Th>
                <Th align="left">Result</Th>
                {stage.outcomes.map((o) => (
                    <Th key={o}>{outcomeLabel(o)}</Th>
                ))}
                <Th>{last ? "Title" : "Advance"}</Th>
            </TableHead>
            <TableBody>
                {teams.map((t) => {
                    const pick = pickOf(stage, t.team);
                    return (
                        <Row key={t.team}>
                            <Td sticky className="font-sans">
                                <TeamLink team={t.team} />
                                {pick && (
                                    <Badge tone={pick.outcome === t.outcome ? "up" : "down"} className="ml-2">
                                        {pick.label}
                                    </Badge>
                                )}
                            </Td>
                            <Td className={t.advanced ? "text-up" : "text-muted"}>{outcomeLabel(t.outcome)}</Td>
                            {stage.outcomes.map((o) => (
                                <Td
                                    key={o}
                                    align="right"
                                    className={o === t.outcome ? "text-fg font-semibold bg-accent/10" : "text-muted"}
                                >
                                    {percent(t.p[o] ?? 0)}
                                </Td>
                            ))}
                            <Td align="right" className="text-fg">
                                {percent(t.advance)}
                            </Td>
                        </Row>
                    );
                })}
            </TableBody>
        </DataTable>
    );
};

export const MajorHistory = () => {
    const [queryParams, setQueryParams] = useQueryParams();
    const query = useQuery({ queryKey: ["sim", "past-majors"], queryFn: () => fetchSimJson<MajorHistoryData>("past-majors.json") });

    if (query.isLoading) return <LoadingBar label="Loading past Majors…" />;
    if (query.error) return <EmptyState className="text-down">Error loading past Majors: {query.error.message}</EmptyState>;
    const data = query.data;
    if (!data?.majors.length) return <EmptyState>The Major backtest hasn't been published yet.</EmptyState>;

    const latest = data.majors.at(-1)!;
    const major = data.majors.find((m) => m.slug === queryParams.get("major")) ?? latest;
    const stage = major.stages.find((s) => s.id === queryParams.get("stage")) ?? major.stages[0];

    return (
        <div className="space-y-10">
            <PageHeader
                eyebrow="Major backtest"
                title="Past Majors"
                subtitle={
                    <>
                        {data.majors.length} Majors / {data.n.toLocaleString("en-US")} simulations per forecast / generated{" "}
                        {data.generatedAt.slice(0, 10)} /{" "}
                        <Link to="/major" className="text-accent hover:underline">
                            upcoming Major
                        </Link>
                    </>
                }
            />

            <Comparison data={data} />

            <Section
                title={major.name}
                subtitle={
                    <>
                        {major.startDate} to {major.endDate} / won by {major.champion}
                        {major.inSample && (
                            <Badge tone="heat" className="ml-2">
                                Elo in-sample
                            </Badge>
                        )}
                    </>
                }
                actions={
                    <Segmented
                        aria-label="Major"
                        className="max-w-full overflow-x-auto"
                        options={data.majors.map((m) => ({ value: m.slug, label: shortName(m.name) }))}
                        value={major.slug}
                        onChange={(s) => setQueryParams({ major: s === latest.slug ? null : s, stage: null })}
                    />
                }
            >
                <StageScores major={major} />
            </Section>

            <Section
                title={`Elo's ${stage.name} forecast`}
                subtitle="Made on the stage's first day. The highlighted cell is what happened; badges mark Elo's Pick'em."
                actions={
                    <Segmented
                        aria-label="Stage"
                        options={major.stages.map((s) => ({ value: s.id, label: s.name.replace("Stage ", "S") }))}
                        value={stage.id}
                        onChange={(id) => setQueryParams({ stage: id === major.stages[0].id ? null : id })}
                    />
                }
            >
                <StageTeams stage={stage} last={stage === major.stages.at(-1)} />
                <LiquipediaCredit what="Brackets, results and team logo data" />
                <a
                    href={liquipediaUrl(major.liquipedia)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-mono text-accent hover:underline"
                >
                    {major.name} on Liquipedia
                </a>
            </Section>
        </div>
    );
};
