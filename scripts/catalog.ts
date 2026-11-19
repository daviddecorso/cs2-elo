import fs from "node:fs";
import path from "node:path";
import type { RawRow } from "./lib/elo/normalize.ts";
import { UPCOMING_DAYS, readUpcoming } from "./lib/liquipedia/upcoming.ts";
import { addDays } from "./lib/liquipedia/rawStore.ts";
import {
    buildCatalog,
    catalogExclusions,
    fitPrizeSplits,
    rankedRules,
    type CatalogEvent,
    type CatalogScope,
    type CountryRegion,
} from "./lib/sim/catalog.ts";
import { loadEventConfigs } from "./lib/sim/config.ts";
import { templatePages } from "./lib/sim/participants.ts";
import { normalizeCountryIso } from "./lib/vrs/buildMatchdata.ts";
import { loadValveCjs } from "./lib/vrs/valveModel.ts";

const readJson = <T>(file: string, fallback: T): T =>
    fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback;

const scopeArg = process.argv.indexOf("--scope");
const scope: CatalogScope = scopeArg >= 0 && process.argv[scopeArg + 1] === "all" ? "all" : "lan";
const today = new Date().toISOString().slice(0, 10);
const upcoming = readUpcoming();
const finishedPlacements = readJson<RawRow[]>("data/raw/placements.json", []);
const placementRows = [...finishedPlacements, ...(upcoming?.placements ?? [])];
const tournamentRows = [...readJson<RawRow[]>("data/raw/tournaments.json", []), ...(upcoming?.tournaments ?? [])];
const matchRows = [...readJson<RawRow[]>("data/raw/matches.json", []), ...(upcoming?.matches ?? [])];

const valveRegion = loadValveCjs(path.resolve("vendor/counter-strike_regional_standings/model/util/region.js")) as {
    getCountryRegion: CountryRegion;
};

const configs = loadEventConfigs();
const until = addDays(today, UPCOMING_DAYS);
const rules = rankedRules(readJson("data/overrides.json", {}));
const pages = templatePages(matchRows);
const catalog = buildCatalog({
    configs,
    tournamentRows,
    today,
    until,
    ctx: {
        placementRows,
        pages,
        countryRegion: valveRegion.getCountryRegion,
        prizeSplits: fitPrizeSplits(finishedPlacements),
        rankedRules: rules,
    },
    scope,
});
const excluded = catalogExclusions(tournamentRows, configs.map((c) => c.liquipedia), today, until, rules, scope);

/** Announced names that are countries, which suggests a national-team event. */
const countryShare = (names: string[]) => names.filter((n) => n.length > 2 && normalizeCountryIso(n)).length / names.length;

const inviteSummary = (e: CatalogEvent): string => {
    const rule = e.config.invites;
    if (!rule) return "no invite rule";
    const parts = [
        ...rule.slots.map((s) => `${s.count}× VRS ${s.list} ${s.month}${s.startRank ? ` from #${s.startRank}` : ""}`),
        ...rule.qualifiers.map((q) => `${q.count}× ${q.label}`),
    ];
    return `${parts.join(", ")}${rule.verified ? " (verified)" : ""}`;
};

const format = (e: CatalogEvent) => {
    const stages = e.config.stages;
    if (!e.generic) return `${stages.length} stages`;
    return stages.length ? stages.map((s) => s.format).join("→") : "none";
};

const noun = scope === "lan" ? "LANs" : "events";
console.log(`Catalog as of ${today} (upcoming store fetched ${upcoming?.fetched ?? "never"}): ${catalog.length} ${noun}`);
for (const e of catalog) {
    const c = e.config;
    const status = e.simulated ? "simulated" : `listed: ${e.reason}`;
    const assumed = c.assumed?.length ? ` assumed [${c.assumed.join(",")}]` : "";
    console.log(
        [
            `${c.startDate}…${c.endDate}`,
            `T${e.tier ?? "?"}`,
            ...(scope === "all" ? [`${e.kind} ${e.role}${e.qualifies ? ` → ${e.qualifies.page} ×${e.qualifies.slots}` : ""}`] : []),
            c.location?.region ?? "?",
            `${c.liquipedia}${e.generic ? " (generic)" : ""}`,
            format(e),
            `$${e.prizePool.toLocaleString("en-US")} ${e.prizeSource}`,
            `${e.announced.length}/${e.teams} announced`,
            inviteSummary(e),
            status + assumed,
        ].join(" | ")
    );
}
const simulated = catalog.filter((e) => e.simulated).length;
console.log(`${simulated} simulated, ${catalog.length - simulated} listed only.`);

const byReason = new Map<string, string[]>();
for (const { page, reason } of excluded) byReason.set(reason, [...(byReason.get(reason) ?? []), page]);
for (const [reason, list] of byReason) {
    const shown = reason === "not ranked by Valve" ? `${list.slice(0, 5).join(", ")}${list.length > 5 ? ", …" : ""}` : list.join(", ");
    console.log(`Excluded, ${reason}: ${list.length} (${shown})`);
}
for (const e of catalog) {
    if (e.announced.length >= 4 && countryShare(e.announced) >= 0.5) {
        console.warn(`Warning: ${e.config.liquipedia} looks like a national-team event; add it to EXCLUDED_SERIES in scripts/lib/sim/catalog.ts.`);
    }
}
