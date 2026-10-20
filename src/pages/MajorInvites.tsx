import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useQueryParams } from "../hooks/useQueryParams.ts";
import { useTableSort } from "../hooks/useTableSort.ts";
import { columnOrder } from "../utils/tableSort.ts";
import { DataTable, Row, SortHeader, TableBody, TableHead, Td } from "../components/DataTable.tsx";
import { EmptyState, Inset, Label, LoadingBar, PageHeader, Section, Segmented } from "../components/ui.tsx";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";
import { TeamLogo } from "../components/TeamLogo.tsx";
import { liquipediaUrl } from "../utils/liquipedia.ts";
import { percent } from "../utils/format.ts";
import { fetchSimJson } from "../sim/fetch.ts";
import type { InviteIndexEntry, InviteOdds, InviteOddsRoster } from "../sim/types.ts";
import type { Region } from "../vrs/types.ts";

const REGIONS: Region[] = ["Europe", "Americas", "Asia"];
const SORT_KEYS = ["rank", "team", "invited", "stage3", "stage2", "stage1", "miss"] as const;
type SortKey = (typeof SORT_KEYS)[number];


const invited = (r: InviteOddsRoster) => r.stage3 + r.stage2 + r.stage1;

const Pct = ({ p, strong = false }: { p: number; strong?: boolean }) => (
    <span className={p === 0 ? "text-muted/50" : strong ? "text-fg" : "text-muted"}>{percent(p)}</span>
);

const RankRange = ({ rank }: { rank: InviteOddsRoster["rank"] }) => {
    const fmt = (n: number) => (n >= 999 ? "unranked" : String(n));
    return (
        <span title="Median projected regional rank, with the 10th–90th percentile range">
            <span className="text-fg">{fmt(rank.p50)}</span>
            <span className="text-muted text-[10px]">
                {" "}
                ({fmt(rank.p10)}–{fmt(rank.p90)})
            </span>
        </span>
    );
};

export const MajorInvites = () => {
    const [queryParams, setQueryParams] = useQueryParams();
    const requested = queryParams.get("region") as Region | null;
    const region = requested && REGIONS.includes(requested) ? requested : "Europe";
    const { sort, onSort } = useTableSort<SortKey>(SORT_KEYS);
    const indexQuery = useQuery({ queryKey: ["sim", "invites"], queryFn: () => fetchSimJson<InviteIndexEntry[]>("invites/index.json") });
    const majors = indexQuery.data ?? [];
    const major = majors.find((m) => m.slug === queryParams.get("major")) ?? majors[0];
    const oddsQuery = useQuery({
        queryKey: ["sim", "invites", major?.slug],
        queryFn: () => fetchSimJson<InviteOdds>(`invites/${major!.slug}.json`),
        enabled: !!major,
    });
    const data = major ? oddsQuery.data : indexQuery.data === undefined ? undefined : null;
    const isLoading = indexQuery.isLoading || (!!major && oddsQuery.isLoading);
    const error = indexQuery.error ?? oddsQuery.error;

    const rosters = useMemo(() => {
        const list = (data?.rosters ?? []).filter((r) => r.region === region);
        const value = (r: InviteOddsRoster): number | string => {
            switch (sort.key) {
                case "team":
                    return r.teamName;
                case "invited":
                    return invited(r);
                case "rank":
                    return r.rank.p50;
                default:
                    return r[sort.key];
            }
        };
        const ascending = sort.key === "rank" || sort.key === "team" || sort.key === "miss";
        return [...list].sort(
            (a, b) => columnOrder(value(a), value(b), { ascending, reversed: sort.reversed }) || invited(b) - invited(a)
        );
    }, [data, region, sort]);

    if (isLoading) return <LoadingBar label="Loading invite odds…" />;
    if (data === null) {
        return <EmptyState>Major invite odds start once the previous Major's participants are announced.</EmptyState>;
    }
    if (error || !data) {
        return <EmptyState className="text-down">Error loading invite odds: {error instanceof Error ? error.message : "Unknown error"}</EmptyState>;
    }

    const included = data.events.filter((e) => e.included);
    const blocked = data.events.filter((e) => !e.included);
    const slots = (r: Region) => `${data.slots.stage3[r]} / ${data.slots.stage2[r]} / ${data.slots.stage1[r]}`;

    return (
        <div className="space-y-10">
            <PageHeader
                eyebrow="Announced events only"
                title={`${data.name} invite odds`}
                subtitle={
                    <>
                        VRS snapshot {data.snapshotDate}
                        {data.snapshotEstimated && " (estimated)"} / Elo and results as of {data.asOf} /{" "}
                        {data.n.toLocaleString("en-US")} simulations /{" "}
                        <Link to="/methodology" className="text-accent hover:underline">
                            methodology
                        </Link>
                    </>
                }
                actions={
                    <div className="flex flex-wrap gap-2">
                        {majors.length > 1 && (
                            <Segmented
                                aria-label="Major"
                                options={majors.map((m) => ({ value: m.slug, label: m.name }))}
                                value={data.slug}
                                onChange={(slug) => setQueryParams({ major: slug === majors[0].slug ? null : slug })}
                            />
                        )}
                        <Segmented
                            aria-label="Region"
                            options={REGIONS}
                            value={region}
                            onChange={(r) => setQueryParams({ region: r === "Europe" ? null : r })}
                        />
                    </div>
                }
            />

            <Inset className="text-xs space-y-2">
                <p>
                    Each simulation plays out the announced events below, adds their results and prize money to the match data, and
                    runs Valve's Regional Standings model at the snapshot date. Events added later aren't counted, and our VRS
                    reproduction isn't exact yet, so treat close calls as close.
                </p>
                <p>
                    {region} slots (Stage 3 / 2 / 1): {slots(region)}. Stage 3 and Stage 2 follow the regions of the previous
                    Major's playoff teams and its 9th–16th places, averaged over simulations; Stage 1 is fixed. This split is{" "}
                    {data.slots.verified ? "from" : "inferred from past invites and not yet checked against"} the rulebook (
                    {data.slots.source}).
                </p>
                <div className="font-mono">
                    <Label>Events simulated</Label>
                    {included.length === 0 ? (
                        <div className="text-muted">None</div>
                    ) : (
                        included.map((e) => (
                            <div key={e.slug}>
                                <Link to={`/events/${e.slug}`} className="text-accent hover:underline">
                                    {e.name}
                                </Link>
                            </div>
                        ))
                    )}
                    {blocked.length > 0 && (
                        <>
                            <Label className="mt-2">Not counted</Label>
                            {blocked.map((e) => (
                                <div key={e.slug} className="text-muted">
                                    <a href={liquipediaUrl(e.liquipedia)} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                        {e.name}
                                    </a>
                                    : {e.reason}
                                </div>
                            ))}
                        </>
                    )}
                </div>
            </Inset>

            <Section title={`${region} invites`} actions={<span className="text-xs font-mono text-muted">{rosters.length} rosters</span>}>
                <DataTable>
                    <TableHead>
                        <SortHeader sortKey="rank" sort={sort} onSort={onSort} ascending className="w-px">
                            Rank
                        </SortHeader>
                        <SortHeader sortKey="team" sort={sort} onSort={onSort} ascending align="left">
                            Team
                        </SortHeader>
                        <SortHeader sortKey="invited" sort={sort} onSort={onSort}>
                            Invited
                        </SortHeader>
                        <SortHeader sortKey="stage3" sort={sort} onSort={onSort}>
                            Stage 3
                        </SortHeader>
                        <SortHeader sortKey="stage2" sort={sort} onSort={onSort}>
                            Stage 2
                        </SortHeader>
                        <SortHeader sortKey="stage1" sort={sort} onSort={onSort}>
                            Stage 1
                        </SortHeader>
                        <SortHeader sortKey="miss" sort={sort} onSort={onSort} ascending className="hidden sm:table-cell">
                            Miss
                        </SortHeader>
                    </TableHead>
                    <TableBody>
                        {rosters.length === 0 ? (
                            <tr>
                                <td colSpan={7}>
                                    <EmptyState>No rosters</EmptyState>
                                </td>
                            </tr>
                        ) : (
                            rosters.map((r) => (
                                <Row key={r.rosterKey}>
                                    <Td align="right" className="font-mono">
                                        <RankRange rank={r.rank} />
                                    </Td>
                                    <Td className="font-sans">
                                        <div className="inline-flex items-center gap-2">
                                            <TeamLogo team={r.teamName} />
                                            <span className="font-medium text-fg">{r.teamName}</span>
                                        </div>
                                        {r.intact === false && (
                                            <span className="ml-1.5 text-[10px] font-mono text-heat" title="No current squad holds three of these players, so the invite passes down">
                                                not intact
                                            </span>
                                        )}
                                        <span className="block pl-[28px] text-[10px] font-mono text-muted whitespace-normal">{r.players.join(", ")}</span>
                                    </Td>
                                    <Td align="right">
                                        <Pct p={invited(r)} strong />
                                    </Td>
                                    <Td align="right">
                                        <Pct p={r.stage3} />
                                    </Td>
                                    <Td align="right">
                                        <Pct p={r.stage2} />
                                    </Td>
                                    <Td align="right">
                                        <Pct p={r.stage1} />
                                    </Td>
                                    <Td align="right" className="hidden sm:table-cell">
                                        <Pct p={r.miss} />
                                    </Td>
                                </Row>
                            ))
                        )}
                    </TableBody>
                </DataTable>
                <LiquipediaCredit what="Brackets, results, rosters, prize and team logo data" />
            </Section>
        </div>
    );
};
