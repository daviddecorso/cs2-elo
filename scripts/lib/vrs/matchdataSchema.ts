import fs from "node:fs";
import vm from "node:vm";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const regionUtilPath = path.resolve(
    currentDir,
    "../../../vendor/counter-strike_regional_standings/model/util/region.js"
);

interface RegionModule {
    getCountryRegion: (countryIso: string) => number;
}

let regionModule: RegionModule | null = null;
const getRegionModule = (): RegionModule => {
    if (!regionModule) {
        try {
            const req = createRequire(import.meta.url);
            const loaded = req(regionUtilPath) as RegionModule;
            if (typeof loaded?.getCountryRegion === "function") {
                regionModule = loaded;
                return regionModule;
            }
        } catch {
            // Node treats .js as ESM under type: module packages; use vm loader below
        }
        const code = fs.readFileSync(regionUtilPath, "utf8");
        const wrapper = Module.wrap(code);
        const script = new vm.Script(wrapper);
        const fn = script.runInThisContext();
        const mod = { exports: {} as RegionModule };
        fn(mod.exports, createRequire(import.meta.url), mod, regionUtilPath, path.dirname(regionUtilPath));
        regionModule = mod.exports;
    }
    return regionModule;
};

export interface ValidationResult {
    errors: string[];
    warnings: string[];
}

export const validateMatchdata = (json: unknown): ValidationResult => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!json || typeof json !== "object") {
        errors.push("Root payload must be an object");
        return { errors, warnings };
    }

    const { matches, events } = json as { matches?: unknown; events?: unknown };

    if (!Array.isArray(matches)) {
        errors.push("Missing or invalid 'matches' array");
    }
    if (!Array.isArray(events)) {
        errors.push("Missing or invalid 'events' array");
    }

    if (errors.length > 0) {
        return { errors, warnings };
    }

    const eventList = events as Array<Record<string, unknown>>;
    const matchList = matches as Array<Record<string, unknown>>;

    const eventMap = new Map<string, Record<string, unknown>>();
    const region = getRegionModule();

    eventList.forEach((ev, idx) => {
        const id = String(ev.eventId ?? "");
        if (!id) {
            errors.push(`events[${idx}]: missing eventId`);
            return;
        }
        eventMap.set(id, ev);

        const prizePool = ev.prizePool;
        if (typeof prizePool !== "string") {
            errors.push(`events[${id}]: prizePool must be a string`);
        } else {
            const stripped = prizePool.replaceAll(",", "").replace("$", "");
            if (!/^[0-9]+$/.test(stripped)) {
                errors.push(`events[${id}]: malformed prizePool "${prizePool}"`);
            }
        }

        if (ev.finished === false) {
            warnings.push(`events[${id}]: event is unfinished`);
        }

        const name = String(ev.eventName ?? "");
        if (name.toLowerCase().includes("showmatch")) {
            warnings.push(`events[${id}]: event "${name}" is a showmatch`);
        }

        const prizeDist = ev.prizeDistribution;
        if (!Array.isArray(prizeDist)) {
            errors.push(`events[${id}]: prizeDistribution must be an array`);
        } else {
            prizeDist.forEach((item, pIdx) => {
                if (!item || typeof item !== "object") {
                    errors.push(`events[${id}].prizeDistribution[${pIdx}]: item must be an object`);
                    return;
                }
                const teamPrize = item as Record<string, unknown>;
                if (typeof teamPrize.clubShare !== "number") {
                    errors.push(`events[${id}].prizeDistribution[${pIdx}]: missing numeric clubShare`);
                }
                if (!Array.isArray(teamPrize.qualifiedEvents)) {
                    errors.push(`events[${id}].prizeDistribution[${pIdx}]: missing qualifiedEvents array`);
                }
            });
        }
    });

    const isValidCountry = (iso: unknown): boolean => {
        if (typeof iso !== "string" || !iso.trim()) return false;
        if (iso.toLowerCase() === "world") return true;
        try {
            return typeof region.getCountryRegion(iso) === "number";
        } catch {
            return false;
        }
    };

    matchList.forEach((m, idx) => {
        const eventId = String(m.eventId ?? "");
        if (!eventId || !eventMap.has(eventId)) {
            errors.push(`matches[${idx}]: eventId "${eventId}" has no matching event`);
        } else {
            const ev = eventMap.get(eventId)!;
            if (ev.finished === false) {
                warnings.push(`matches[${idx}]: associated event "${eventId}" is unfinished`);
            }
            const evName = String(ev.eventName ?? "");
            if (evName.toLowerCase().includes("showmatch")) {
                warnings.push(`matches[${idx}]: associated event "${eventId}" is a showmatch`);
            }
        }

        if (m.winningTeam !== 1 && m.winningTeam !== 2) {
            errors.push(`matches[${idx}]: winningTeam must be 1 or 2, got ${String(m.winningTeam)}`);
        }

        const team1Players = Array.isArray(m.team1Players) ? m.team1Players : [];
        const team2Players = Array.isArray(m.team2Players) ? m.team2Players : [];

        if (team1Players.length !== 5 || team2Players.length !== 5) {
            warnings.push(
                `matches[${idx}]: incomplete team roster (${team1Players.length} vs ${team2Players.length} players)`
            );
        }

        [...team1Players, ...team2Players].forEach((p, pIdx) => {
            if (!p || typeof p !== "object") return;
            const player = p as Record<string, unknown>;
            if (!isValidCountry(player.countryIso)) {
                errors.push(
                    `matches[${idx}].player[${pIdx}]: countryIso "${String(player.countryIso)}" absent from region.js`
                );
            }
        });

        const startTime = typeof m.matchStartTime === "number" ? m.matchStartTime : 0;
        if (startTime >= 1735689600) {
            if (m.valveRanked === undefined) {
                warnings.push(`matches[${idx}]: missing valveRanked after 2025`);
            } else if (!m.valveRanked) {
                warnings.push(`matches[${idx}]: unranked match after 2025 (valveRanked=false)`);
            }
        }
    });

    return { errors, warnings };
};
