import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { leagueProtocolsQuery, teamProtocolsQuery } from "../../data/queries.ts";
import { GRENADE_COLOR, formatMapName } from "../../war/heatmap.ts";
import type { ProtocolLeagueZone } from "../../war/protocolTypes.ts";
import { MIN_PLAYER_RATE, pct, playerProtocolZones, seconds, zoneLabel, zoneTooltip } from "../../war/protocols.ts";
import { Section, Tooltip } from "../ui.tsx";

export const PlayerProtocols = ({ steamid, team }: { steamid: string; team: string }) => {
    const { data } = useQuery(teamProtocolsQuery(team));
    const zones = useMemo(() => (data ? playerProtocolZones(data, steamid) : []), [data, steamid]);
    const maps = useMemo(() => [...new Set(zones.map((z) => z.map))], [zones]);
    const leagues = useQueries({ queries: maps.map((m) => leagueProtocolsQuery(m)) });
    const zoneById = useMemo(() => {
        const out = new Map<string, ProtocolLeagueZone>();
        leagues.forEach((q, i) => q.data?.zones.forEach((z) => out.set(`${maps[i]}:${z.id}`, z)));
        return out;
    }, [leagues, maps]);

    if (zones.length === 0) return null;

    return (
        <Section
            title="Protocol utility"
            subtitle={`Gun-round utility ${team} lands in the same zone on ${pct(MIN_PLAYER_RATE)}+ of this player's rounds. Full tables on the team page.`}
        >
            <div className="text-xs font-mono text-muted">
                Per zone: share of this player's gun rounds with a throw there · share of the team's rounds there that they
                threw · team's median first throw.
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-5">
                {maps.map((m) => (
                    <div key={m} className="space-y-1.5">
                        <div className="text-xs font-semibold text-fg">{formatMapName(m)}</div>
                        <ul className="divide-y divide-line/60">
                            {zones
                                .filter((z) => z.map === m)
                                .map((z) => {
                                    const lz = zoneById.get(`${m}:${z.id}`);
                                    return (
                                        <li key={`${z.side}-${z.id}`} className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
                                            <span className="inline-flex items-center gap-1.5 min-w-0">
                                                <span className="text-[10px] font-mono text-muted uppercase w-5 shrink-0">{z.side}</span>
                                                {lz && (
                                                    <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: GRENADE_COLOR[lz.type] }} aria-hidden="true" />
                                                )}
                                                {(() => {
                                                    const tip = lz ? zoneTooltip(lz) : null;
                                                    const text = <span className="text-fg truncate">{lz ? zoneLabel(lz) : "…"}</span>;
                                                    return tip ? <Tooltip content={tip}>{text}</Tooltip> : text;
                                                })()}
                                            </span>
                                            <span className="font-mono tabular-nums text-muted shrink-0">
                                                <span className="text-fg">{pct(z.rate)}</span> · {pct(z.share)} · {seconds(z.teamTMed)}
                                            </span>
                                        </li>
                                    );
                                })}
                        </ul>
                    </div>
                ))}
            </div>
        </Section>
    );
};

export default PlayerProtocols;
