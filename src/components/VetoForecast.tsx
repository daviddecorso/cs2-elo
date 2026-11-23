import type { MatchVeto, ScheduledMatch, VetoChance } from "../elo/types.ts";
import { DataTable, Row, TableBody, TableHead, Td, Th } from "./DataTable.tsx";
import { Badge, Label, type BadgeTone } from "./ui.tsx";

const CHANCE_TONE: Record<VetoChance, BadgeTone> = { likely: "accent", possible: "neutral", unlikely: "neutral" };

const Shortlist = ({ maps }: { maps: string[] }) => (
    <ol className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {maps.map((map, i) => (
            <li key={map} className="text-fg font-medium">
                <span className="font-mono text-muted mr-1.5">{i + 1}.</span>
                {map}
            </li>
        ))}
    </ol>
);

const Chances = ({ veto, teams }: { veto: Extract<MatchVeto, { kind: "chances" }>; teams: string[] }) => {
    const showPicks = veto.maps.some((m) => m.pickedBy);
    return (
        <DataTable>
            <TableHead>
                <Th align="left">Map</Th>
                <Th align="left">Played</Th>
                {showPicks && <Th align="left">Likeliest pick of</Th>}
            </TableHead>
            <TableBody>
                {veto.maps.map(({ map, chance, pickedBy }) => (
                    <Row key={map}>
                        <Td className={`font-sans font-medium ${chance === "unlikely" ? "text-muted" : "text-fg"}`}>{map}</Td>
                        <Td>
                            <Badge tone={CHANCE_TONE[chance]}>{chance}</Badge>
                        </Td>
                        {showPicks && (
                            <Td className="font-sans whitespace-normal text-fg">
                                {pickedBy?.map((side) => teams[side]).join(", ")}
                            </Td>
                        )}
                    </Row>
                ))}
            </TableBody>
        </DataTable>
    );
};

export const VetoForecast = ({ veto, sides }: { veto: MatchVeto; sides: ScheduledMatch["sides"] }) => (
    <div className="space-y-2">
        <Label>{veto.kind === "shortlist" ? `Predicted veto · top ${veto.maps.length} maps` : "Predicted veto"}</Label>
        {veto.kind === "shortlist" ? (
            <Shortlist maps={veto.maps} />
        ) : (
            <Chances veto={veto} teams={sides.map((s) => s.team)} />
        )}
        <p className="text-xs text-muted">
            Estimated from recent map play and map strength, assuming a standard veto. Win odds don't use it.
        </p>
    </div>
);
