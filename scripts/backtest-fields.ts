import path from "node:path";
import type { Region, Roster } from "../src/vrs/types.ts";
import { ACTIVITY_PRIOR_DAYS, ACTIVITY_WINDOW_DAYS, fitActivity, type ActivityTeam, type Rates } from "./lib/sim/activity.ts";
import { BAND_LABELS, BANDS, bandOf, fitFieldModel } from "./lib/sim/fieldModel.ts";
import { CATEGORIES, HISTORY_FROM, loadHistory, readHistoryRows } from "./lib/sim/history.ts";
import { AFFINITY_FEATURES, AffinityIndex, affinityLogLikelihood, affinitySamples, fitAffinity, nickCountries, type AffinityFeature } from "./lib/sim/affinity.ts";
import { unannouncedCell, unannouncedEvents } from "./lib/sim/unannounced.ts";
import { locationOf, parseVrsLabel, qualifierTargets, rankedRules, roleOf } from "./lib/sim/catalog.ts";
import { qualifierLinks, type LinkEnd } from "./lib/sim/qualifierLinks.ts";
import { readJson } from "./lib/sim/inputs.ts";
import { backtestProjections } from "./lib/sim/series.ts";
import { addDays } from "./lib/liquipedia/rawStore.ts";

/** Leave-future-out gate for the season simulation's field and activity models; see `docs/vrs-simulator.md`, "Field and activity models". */

const VALVE_ROOT = path.resolve("vendor/counter-strike_regional_standings");
const TEST_FROM = "2026-01-01";
const MIN_ATTENDEES = 4;
/** Probability floor that keeps the best-remaining rule's log loss finite for bands its top-N never reaches. */
const RULE_FLOOR = 0.01;
const WINDOW_DAYS = 180;
const TOLERANCE = 0.15;
const PROJECTION_WINDOW = 60;

const started = Date.now();
const { editions, lists, lastDay, countryRegion } = loadHistory(VALVE_ROOT);
console.log(`${editions.length} ranked editions ${editions[0]?.startDate} … ${lastDay}, loaded in ${((Date.now() - started) / 1000).toFixed(1)} s.`);

const months = [...new Set(editions.filter((e) => e.startDate >= TEST_FROM).map((e) => e.startDate.slice(0, 7)))].sort();
const listByDate = new Map(lists.map((l) => [l.date, l.rosters]));
const regional = (region: Region | null) => (r: Roster) => !region || r.region === region;

// --- Fields: log loss of attendee bands

const loss = { model: 0, fallback: 0, uniform: 0, rule: 0, n: 0, events: 0 };
const byCategory = new Map<string, typeof loss>();
for (const month of months) {
    const model = fitFieldModel(editions, lists, { asOf: `${month}-01` });
    for (const e of editions.filter((x) => x.startDate.startsWith(month) && x.attendees.length >= MIN_ATTENDEES && x.listDate)) {
        const ev = { page: e.page, name: e.name, category: e.category, region: e.region, prizePool: e.prizePool, publisherTier: e.publisherTier, startDate: e.startDate };
        const withSeries = model.forEvent(ev, e.teams);
        const fallback = model.forEvent(ev, e.teams, { series: false });
        const pool = listByDate.get(e.listDate!)!.filter(regional(withSeries.region)).filter((r) => r.globalRank !== null);
        const poolBands = new Array<number>(BANDS).fill(0);
        for (const r of pool) poolBands[bandOf(r.globalRank)]++;
        // Off-list attendees outnumber the list's tail; give the last band at least as many teams as the attendees it took.
        poolBands[BANDS - 1] += e.attendees.filter((a) => a.globalRank === null).length;
        const poolTotal = poolBands.reduce((a, b) => a + b, 0);
        const top = pool.sort((a, b) => a.globalRank! - b.globalRank!).slice(0, e.attendees.length);
        const ruleBands = new Array<number>(BANDS).fill(RULE_FLOOR);
        for (const r of top) ruleBands[bandOf(r.globalRank)]++;
        const ruleTotal = ruleBands.reduce((a, b) => a + b, 0);
        const cat = byCategory.get(e.category) ?? { model: 0, fallback: 0, uniform: 0, rule: 0, n: 0, events: 0 };
        for (const into of [loss, cat]) into.events++;
        for (const a of e.attendees) {
            const b = bandOf(a.globalRank);
            for (const into of [loss, cat]) {
                into.model -= Math.log(withSeries.open[b]);
                into.fallback -= Math.log(fallback.open[b]);
                into.uniform -= Math.log(Math.max(poolBands[b], 1) / poolTotal);
                into.rule -= Math.log(ruleBands[b] / ruleTotal);
                into.n++;
            }
        }
        byCategory.set(e.category, cat);
    }
}
const per = (x: typeof loss) => ({ model: x.model / x.n, fallback: x.fallback / x.n, uniform: x.uniform / x.n, rule: x.rule / x.n });
const fmt = (x: typeof loss) => {
    const p = per(x);
    return `model ${p.model.toFixed(3)}, fallback ${p.fallback.toFixed(3)}, uniform ${p.uniform.toFixed(3)}, best remaining ${p.rule.toFixed(3)} (${x.events} events, ${x.n} attendees)`;
};
console.log(`\nField log loss per attendee band, ${months[0]} … ${months.at(-1)}, refit monthly:`);
console.log(`  all        ${fmt(loss)}`);
for (const [category, x] of [...byCategory].sort()) console.log(`  ${category.padEnd(10)} ${fmt(x)}`);
const f = per(loss);
const fieldPass = f.model < f.fallback && f.fallback < f.uniform && f.model < f.rule;

// --- Activity: each team's events in a half year, predicted from before it; two back-to-back half years so seasons cancel

const day = (date: string, offset: number) => new Date(Date.parse(date) + offset * 86400000).toISOString().slice(0, 10);
const splits = [day(lastDay, -2 * WINDOW_DAYS), day(lastDay, -WINDOW_DAYS)].map((testFrom) => {
    const testTo = day(testFrom, WINDOW_DAYS);
    // The simulation only draws teams that exist at its start, so the population is teams seen in the half year before the split, at their last rank.
    const population = new Map<string, ActivityTeam>();
    for (const e of editions) {
        if (e.startDate < day(testFrom, -WINDOW_DAYS) || e.endDate > testFrom) continue;
        for (const a of e.attendees) population.set(a.teamId, { teamId: a.teamId, globalRank: a.globalRank, region: a.region });
    }
    const actual = new Map<string, Rates>();
    for (const e of editions) {
        if (e.startDate <= testFrom || e.endDate > testTo) continue;
        for (const a of e.attendees) {
            const c = actual.get(a.teamId) ?? { lan1: 0, lan2: 0, lan34: 0, online: 0, qualifier: 0 };
            c[e.category]++;
            actual.set(a.teamId, c);
        }
    }
    return { testFrom, testTo, population, actual };
});
/** Coarse rank groups for the share check: top 20, 21–60, 61–150, below or unranked. */
const GROUPS = [20, 60, 150, Infinity];
const GROUP_LABELS = ["1-20", "21-60", "61-150", "151+"];
const groupOf = (rank: number | null) => (rank === null ? GROUPS.length - 1 : GROUPS.findIndex((g) => rank <= g));
/** Groups below this share of a category's attendances in both half years are too thin to check. */
const MIN_GROUP_SHARE = 0.1;
const deviance = (y: number, mu: number) => 2 * ((y > 0 ? y * Math.log(y / Math.max(mu, 1e-9)) : 0) - (y - mu));
const score = (windowDays: number, priorDays: number) => {
    const dev = { model: 0, band: 0 };
    const devBySplit: Array<{ model: number; band: number }> = [];
    const totals = new Map(CATEGORIES.map((c) => [c, { predicted: 0, actual: 0 }]));
    const groups = new Map(CATEGORIES.map((c) => [c, GROUPS.map(() => ({ predicted: 0, actual: 0 }))]));
    for (const { testFrom, population, actual } of splits) {
        const activity = fitActivity(editions, [...population.values()], { asOf: testFrom, windowDays, priorDays });
        const split = { model: 0, band: 0 };
        for (const t of population.values()) {
            const own = activity.rates(t.teamId);
            const band = activity.bandRates(t.globalRank, t.region);
            const y = actual.get(t.teamId);
            const g = groupOf(t.globalRank);
            for (const c of CATEGORIES) {
                const yc = y?.[c] ?? 0;
                split.model += deviance(yc, own[c] * WINDOW_DAYS);
                split.band += deviance(yc, band[c] * WINDOW_DAYS);
                totals.get(c)!.predicted += own[c] * WINDOW_DAYS;
                totals.get(c)!.actual += yc;
                groups.get(c)![g].predicted += own[c] * WINDOW_DAYS;
                groups.get(c)![g].actual += yc;
            }
        }
        devBySplit.push(split);
        dev.model += split.model;
        dev.band += split.band;
    }
    return { windowDays, priorDays, dev, devBySplit, totals, groups };
};
const shareMisses = (s: ReturnType<typeof score>) =>
    [...s.totals].flatMap(([c, t]) =>
        s.groups.get(c)!.filter((x) => {
            const observed = x.actual / Math.max(1, t.actual);
            return observed >= MIN_GROUP_SHARE && Math.abs(x.predicted / Math.max(1e-9, t.predicted) / observed - 1) > TOLERANCE;
        })
    ).length;
console.log(
    `\nActivity, tested ${splits.map((s) => `${s.testFrom} … ${s.testTo} (${s.population.size} teams)`).join(" and ")}; deviance of own rates shrunk to the band (band mean alone):`
);
for (const windowDays of [180, 365]) {
    for (const priorDays of [90, 180, 365, 730]) {
        const s = score(windowDays, priorDays);
        const ratios = [...s.totals].map(([c, t]) => `${c} ×${(t.predicted / Math.max(1, t.actual)).toFixed(2)}`).join(", ");
        console.log(`  train ${windowDays} d, prior ${priorDays} d: ${s.dev.model.toFixed(0)} (${s.dev.band.toFixed(0)}), ${shareMisses(s)} share misses; totals ${ratios}`);
    }
}
const { devBySplit, totals, groups } = score(ACTIVITY_WINDOW_DAYS, ACTIVITY_PRIOR_DAYS);
console.log(
    `Chosen: train ${ACTIVITY_WINDOW_DAYS} d, prior ${ACTIVITY_PRIOR_DAYS} d: deviance ${devBySplit.map((d) => `${d.model.toFixed(0)} vs band mean ${d.band.toFixed(0)}`).join("; ")}`
);
console.log(
    `  A season run's attendance totals come from its calendar's slots, and habits only pace teams against their own budgets, so totals and rank-group shares (predicted/actual, ✗ past ±${TOLERANCE * 100}%) are reported, not gated:`
);
for (const [c, t] of totals) {
    const cells = groups.get(c)!.map((x, i) => {
        const predicted = x.predicted / Math.max(1e-9, t.predicted);
        const observed = x.actual / Math.max(1, t.actual);
        const flag = observed < MIN_GROUP_SHARE ? " –" : Math.abs(predicted / observed - 1) > TOLERANCE ? " ✗" : "";
        return `${GROUP_LABELS[i]} ${(predicted * 100).toFixed(0)}/${(observed * 100).toFixed(0)}%${flag}`;
    });
    console.log(`  ${c.padEnd(10)} total ${t.predicted.toFixed(0).padStart(5)} predicted, ${String(t.actual).padStart(5)} actual (×${(t.predicted / Math.max(1, t.actual)).toFixed(2)}); share ${cells.join(", ")}`);
}
const activityPass = devBySplit.every((d) => d.model < d.band);

// --- Projected editions: precision, recall and date error, reported not gated

const projectionStarts = months.filter((m) => addDays(`${m}-01`, PROJECTION_WINDOW) <= lastDay).length;
const scores = backtestProjections(readHistoryRows().tournamentRows, countryRegion, {
    asOf: lastDay,
    rules: rankedRules(readJson("data/overrides.json", {})),
    window: PROJECTION_WINDOW,
    months: projectionStarts,
});
console.log(`\nProjected editions, ${PROJECTION_WINDOW} days ahead from each of ${projectionStarts} month starts, nothing listed ahead:`);
for (const [category, s] of [...scores].sort()) {
    const sorted = [...s.dateErrors].sort((a, b) => a - b);
    console.log(
        `  ${category.padEnd(10)} ${String(s.projected).padStart(4)} projected, precision ${(s.matched / Math.max(1, s.projected)).toFixed(2)}; recall ${(s.matched / Math.max(1, s.actual)).toFixed(2)} of ${s.actual} ranked editions, ${(s.matched / Math.max(1, s.actualInSeries)).toFixed(2)} of ${s.actualInSeries} in projected series; date error median ${sorted[Math.floor(sorted.length / 2)] ?? "–"} d`
    );
}

// --- Unannounced stand-ins: expected volume vs what started, nothing listed ahead; reported not gated

const rules = rankedRules(readJson("data/overrides.json", {}));
const latestRows = [...new Map(readHistoryRows().tournamentRows.map((r) => [String(r.pagename), r])).values()];
const cells = latestRows.flatMap((r) => {
    const c = unannouncedCell(r, rules, countryRegion);
    return c ? [{ ...c, start: String(r.startdate) }] : [];
});
const volume = new Map<string, { predicted: number; average: number; actual: number }>();
let volumeDeviance = { model: 0, average: 0 };
for (const month of months.filter((m) => addDays(`${m}-01`, PROJECTION_WINDOW) <= lastDay)) {
    const from = `${month}-01`;
    const asOf = addDays(from, -1);
    const to = addDays(from, PROJECTION_WINDOW);
    const predicted = unannouncedEvents(
        latestRows.filter((r) => String(r.startdate) <= asOf),
        countryRegion,
        { asOf, until: to, rules }
    );
    const keys = new Set([...predicted.map((e) => `${e.category}|${e.region}`), ...cells.map((c) => `${c.category}|${c.region}`)]);
    for (const key of keys) {
        const [category, region] = key.split("|");
        const inCell = cells.filter((c) => c.category === category && c.region === region);
        const p = predicted.filter((e) => e.category === category && e.region === region).reduce((s, e) => s + e.chance, 0);
        const a = (inCell.filter((c) => c.start > addDays(asOf, -365) && c.start <= asOf).length * PROJECTION_WINDOW) / 365;
        const y = inCell.filter((c) => c.start >= from && c.start < to).length;
        volumeDeviance = { model: volumeDeviance.model + deviance(y, p), average: volumeDeviance.average + deviance(y, a) };
        const v = volume.get(category) ?? { predicted: 0, average: 0, actual: 0 };
        volume.set(category, { predicted: v.predicted + p, average: v.average + a, actual: v.actual + y });
    }
}
console.log(`\nUnannounced stand-ins, ${PROJECTION_WINDOW} days from each 2026 month start with nothing listed ahead (predicted / past-year average / actual):`);
for (const [category, v] of [...volume].sort()) {
    console.log(`  ${category.padEnd(10)} ${v.predicted.toFixed(0).padStart(5)} / ${v.average.toFixed(0).padStart(5)} / ${String(v.actual).padStart(5)} (×${(v.predicted / Math.max(1, v.actual)).toFixed(2)})`);
}
console.log(`  Poisson deviance per category and region: ${volumeDeviance.model.toFixed(0)} vs ${volumeDeviance.average.toFixed(0)} for the past-year average.`);

// --- Who attends: which team in its rank band and region cell, held out month by month; reported, features ship on improvement

const affinityIndex = new AffinityIndex(editions);
const affinityAll = affinitySamples(editions, lists, affinityIndex, nickCountries(editions), { from: HISTORY_FROM, to: addDays(lastDay, 1) });
const variants: Array<[string, AffinityFeature[]]> = [
    ["uniform", []],
    ...AFFINITY_FEATURES.map((f): [string, AffinityFeature[]] => [f, [f]]),
    ...AFFINITY_FEATURES.map((f): [string, AffinityFeature[]] => [`all but ${f}`, AFFINITY_FEATURES.filter((g) => g !== f)]),
    ["all", [...AFFINITY_FEATURES]],
];
const heldOut = new Map(variants.map(([name]) => [name, 0]));
let heldOutN = 0;
for (const month of months) {
    const from = `${month}-01`;
    const train = affinityAll.filter((s) => s.date >= addDays(from, -365) && s.date < from);
    const test = affinityAll.filter((s) => s.date.startsWith(month));
    if (test.length === 0) continue;
    heldOutN += test.length;
    for (const [name, use] of variants) heldOut.set(name, heldOut.get(name)! + affinityLogLikelihood(fitAffinity(train, use), test) * test.length);
}
const fullBeta = fitAffinity(affinityAll.filter((s) => s.date >= addDays(lastDay, -365)));
console.log(`\nWho attends within a band and region cell, ${heldOutN} held-out attendees, mean log-likelihood (higher is better):`);
for (const [name] of variants) console.log(`  ${name.padEnd(20)} ${(heldOut.get(name)! / heldOutN).toFixed(4)}`);
console.log(`  Coefficients on the last year: ${AFFINITY_FEATURES.map((f, i) => `${f} ${fullBeta[i].toFixed(2)} (×${Math.exp(fullBeta[i]).toFixed(1)})`).join(", ")}.`);

// --- Qualifier links: do the rules find who filled past qualifier slots? Reported, not gated

const linkRows = readHistoryRows();
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const cleanLabel = (q: unknown) => str(q).replace(/\[\[Category:[^\]]*\]\]/g, "").trim();
const tournamentByPage = new Map(linkRows.tournamentRows.map((r) => [str(r.pagename), r]));
// The rules read participant rows as they stand before an event, when nobody has a placement yet.
const asParticipants = linkRows.placementRows.map((r) => (r.pagename === r.parent ? { ...r, placement: "" } : r));
const placed = new Map<string, Map<string, number>>();
for (const r of linkRows.placementRows) {
    if (r.pagename !== r.parent || r.opponenttype !== "team" || !str(r.placement)) continue;
    const page = str(r.pagename);
    if (!placed.has(page)) placed.set(page, new Map());
    placed.get(page)!.set(str(r.opponentname), Number(/^(\d+)/.exec(str(r.placement))?.[1] ?? Infinity));
}
const labelRows = new Map<string, Array<{ label: string; team: string }>>();
for (const r of asParticipants) {
    const label = cleanLabel(r.qualifier);
    if (r.pagename !== r.parent || r.opponenttype !== "team" || !label || parseVrsLabel(label)) continue;
    const page = str(r.pagename);
    labelRows.set(page, [...(labelRows.get(page) ?? []), { label, team: str(r.opponentname) }]);
}
const linkFrom = "2025-06-01";
const linkPages = [...tournamentByPage.values()].filter((r) => str(r.startdate) >= addDays(linkFrom, -90) && str(r.enddate) <= lastDay);
const targetOf = qualifierTargets(asParticipants, new Set(tournamentByPage.keys()));
const ends: LinkEnd[] = linkPages.map((r) => {
    const page = str(r.pagename);
    const labels = new Map<string, number>();
    for (const { label } of labelRows.get(page) ?? []) labels.set(label, (labels.get(label) ?? 0) + 1);
    const qualifies = roleOf(r) === "qualifier" ? targetOf(page) : undefined;
    return {
        page,
        region: locationOf(r, countryRegion)?.region ?? null,
        startDate: str(r.startdate),
        endDate: str(r.enddate),
        ...(qualifies ? { qualifies } : {}),
        labels: [...labels].map(([label, count]) => ({ label, count })),
    };
});
const editionByPage = new Map(editions.map((e) => [e.page, e]));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const linkStats = new Map<
    string,
    { links: number; fillers: number; within: number; passedDown: number; absent: number; unplaced: number; fillerBand: number[]; fieldBand: number[] }
>();
for (const link of qualifierLinks(ends, asParticipants)) {
    const target = tournamentByPage.get(link.to)!;
    if (str(target.startdate) < linkFrom || !str(target.publishertier) || roleOf(target) !== "main") continue;
    const s = linkStats.get(link.rule) ?? { links: 0, fillers: 0, within: 0, passedDown: 0, absent: 0, unplaced: 0, fillerBand: [], fieldBand: [] };
    linkStats.set(link.rule, s);
    s.links++;
    const finishes = placed.get(link.from) ?? new Map<string, number>();
    const attended = new Set((labelRows.get(link.to) ?? []).map((x) => x.team).concat([...(placed.get(link.to)?.keys() ?? [])]));
    // An implicit slot has no label, so its fillers are the source's top finishers that attended.
    const fillers =
        link.rule === "implicit"
            ? [...finishes].filter(([team, pos]) => pos <= link.count && attended.has(team)).map(([team]) => team)
            : (labelRows.get(link.to) ?? []).filter((x) => `qualifier:${x.label}` === link.slotKey && x.team && x.team.toUpperCase() !== "TBD").map((x) => x.team);
    if (link.rule === "implicit") {
        if (finishes.size === 0) {
            s.unplaced++;
            continue;
        }
        const top = [...finishes].filter(([, pos]) => pos <= link.count).length;
        s.fillers += top;
        s.within += fillers.length;
        s.absent += top - fillers.length;
        continue;
    }
    for (const team of fillers) {
        s.fillers++;
        const pos = finishes.get(team);
        if (pos === undefined && finishes.size === 0) s.unplaced++;
        else if (pos === undefined) s.absent++;
        else if (pos <= link.count) s.within++;
        else s.passedDown++;
    }
    const targetEdition = editionByPage.get(link.to);
    const sourceEdition = editionByPage.get(link.from);
    const qualifiedIds = new Set(targetEdition?.attendees.filter((a) => a.label === "qualifier").map((a) => a.teamId) ?? []);
    if (sourceEdition && targetEdition) {
        s.fillerBand.push(...sourceEdition.attendees.filter((a) => qualifiedIds.has(a.teamId)).map((a) => bandOf(a.globalRank)));
        s.fieldBand.push(...sourceEdition.attendees.map((a) => bandOf(a.globalRank)));
    }
}
console.log(`\nQualifier links on ranked main events since ${linkFrom}, rules applied to participant rows as listed before each event:`);
for (const [rule, s] of [...linkStats].sort()) {
    const band = s.fillerBand.length ? `; mean band of fillers ${mean(s.fillerBand).toFixed(2)} vs the source's field ${mean(s.fieldBand).toFixed(2)}` : "";
    if (rule === "implicit") {
        console.log(`  implicit  ${String(s.links).padStart(4)} links (${s.unplaced} sources without placements): ${s.within} of ${s.fillers} top finishers attended`);
        continue;
    }
    const known = s.fillers - s.unplaced;
    const share = (k: number) => (k / Math.max(1, known)).toFixed(3);
    console.log(
        `  ${rule.padEnd(9)} ${String(s.links).padStart(4)} links, ${s.fillers} slot fillers (${s.unplaced} at sources without placements); of the rest ${share(s.within)} finished in the source's top slots, ${share(s.passedDown)} lower (passed down), ${share(s.absent)} not in the source${band}`
    );
}

console.log(`\nBands: ${BAND_LABELS.join(", ")}.`);
console.log(`Gate: fields ${fieldPass ? "PASS" : "FAIL"} (model < fallback < uniform, model < best remaining); activity ${activityPass ? "PASS" : "FAIL"} (deviance below the band mean in both half years).`);
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
if (!fieldPass || !activityPass) process.exit(1);
