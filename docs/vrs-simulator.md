# VRS simulator

## Overview

Phase 8 of [spec.md](spec.md) scores many VRS what-ifs: a team's points with and without an event, over many simulated seasons and many schedules. Built so far: two fast ways to re-run Valve's model (step 1), the [event catalog](#event-catalog) of every upcoming ranked event (step 3), [field and activity models](#field-and-activity-models) learned from past editions, [projected editions](#projected-editions) of recurring series with a [hindcast](#hindcast), [qualifier links](#qualifier-links) that send simulated qualifiers' finishers to the events they feed, the [season simulation](#season-simulation) with its calendar and projections on `/vrs-sim` (step 4), the [schedule optimizer](#schedule-optimizer) with its Schedules view (step 5), the [focal planner](#focal-planner) that searches one team's events and qualifier routes for its best Major invite odds, and, from step 2, [event impact](#event-impact) on `/events/:slug` and the Major invite projection on reruns.

A full run of Valve's model (`computeStandings`) takes about 0.8 s. Almost all of that is loading. On the 2026-11-02 window (6,879 matches, 983 rosters):

| Part | Time |
| --- | --- |
| `DataLoader.loadData`: JSON, filters, roster linking | ~750 ms |
| `Team.initializeSeedingModifiers` for every roster | ~5 ms |
| Glicko pass over every match | ~1 ms |

That gives two layers:

| Layer | File | Cost | Accuracy |
| --- | --- | --- | --- |
| Exact rerun | `scripts/lib/vrs/valveWorld.ts` | ~0.4 s to load a window, then ~20–25 ms per rerun | Identical to `computeStandings`, or flagged |
| One-team model | `scripts/lib/vrs/oneTeam.ts` | ~50 µs per score (~95 µs with global rank) | Approximate; gated against the exact rerun |

Use the exact rerun for season standings and invite projections. Use the one-team model where the number of scores rules out reruns:

- **Event impact:** one rerun per checkpoint, frozen, then each team's event removed with `withoutEvents`. This is the gate's remove case, which is the most accurate.
- **Schedule search:** about 500 schedules × 300 runs × 60 teams is 9M scores. The recommended schedules are then re-scored with `rerun`.

`npm run backtest-vrs-whatif` checks both. Results are [below](#backtest).

## Exact rerun (`valveWorld.ts`)

`loadWorld(matches, events, snapshotDate, options)` applies Valve's snapshot and loader filters once. It keeps every complete, ranked, in-window match up to the pull, including matches of events still unfinished, and links rosters with a port of Valve's `insertTeam`.

`rerun(world, delta)` returns Valve's standings for the world's input plus `delta`:

- `delta.matches` are added;
- `delta.events` replace events by id, as `applyDelta` does;
- `delta.excludeMatch` drops input matches as if they were never pulled.

The result is the same as `computeStandings(applyDelta(...))` on the combined input. Each rerun:

1. Rebuilds every event with Valve's `Event` class. It re-derives `finished` the way `prepareSnapshotInput` does, then re-applies the linked-prize-pool loop. That loop is ported because it's an inline closure in `loadData`, and it mutates in `for…in` order, so event insertion order matters.
2. Re-filters matches: showmatches, unfinished events and exclusions. This is what brings back an in-progress event's played matches once a delta finishes it.
3. Links new matches to rosters, then checks the whole linking against Valve's rule (below).
4. Resets every roster and replays Valve's own code: `accumulateMatch`, `recordEventParticipation`, `setActiveRoster`, `setPluralityRegion`, `initializeSeedingModifiers`, `seedTeams`, `runMatches`, `applyRanking`.

Valve's module-private functions (`seedTeams`, `runMatches`, `applyRanking`, `Event`, `sortMatches` and the match filters) are exposed by `loadValveCjs`. It appends an `Object.assign(module.exports, …)` line to the module source, so the vendored code stays untouched.

`setPluralityRegion` scans a country table for every player and was most of a rerun's cost. Its result depends only on a roster's 10 newest matches, so it's cached per roster until those change.

A new match side joins the first base roster sharing 3 players with it. Valve finds that with `sharesRoster` over every roster, about 1,000 per window; `rerun` uses a per-world index from player to base roster instead (`firstBaseSharing`), which gives the same first roster. With projected editions a run adds about 3,200 matches, and the scan was half of a 260 ms rerun; with the index it's 135 ms.

**When a rerun isn't exact.** Valve links rosters newest match first, and a side joins the earliest-created existing roster that shares 3 players with it. A delta can change those links:

- A new newest lineup becomes a roster's identity.
- An exclusion removes the match that created a roster.
- A new lineup straddles two rosters.

After linking, `rerun` checks every side against that rule, using the lineup each roster held at that point, so forfeit-pending identity updates are covered too. If any side would link elsewhere, it returns `exact: false` and an `inexact` reason; fall back to `computeStandings`. The check is exact rather than conservative: it passes on every base window and in all 50 backtest deltas. The unit tests build a case that does relink, and there the full model really does differ.

`state` (rosters, ascending matches, events) is only valid until the next `rerun` on the same world, because rosters are reused objects.

## One-team model (`oneTeam.ts`)

`freeze(state)` takes a rerun's state and records:

- every roster's `scaledWinnings`, `distinctTeamsDefeated`, seed value, seed rating, final points, and rating after each match;
- a ledger per roster: its matches with the opponent's rating going in, and its winning events;
- the top 6 of each reference list (winnings, opponents defeated, LAN wins);
- the seed range ends.

`scoreTeam(world, ledger)` re-derives one roster's points with Valve's formulas while other rosters stay frozen, apart from three corrections. Each one fixed a measured error:

1. **References.** Valve normalizes `bountyOffered`, `ownNetwork` and `lanFactor` against the 5th-highest roster. The scored roster's new totals replace its old ones in that list. Opponents' `bountyOffered` and `ownNetwork` are rescaled against the moved references, because a big win can lift a team into the top 5.
2. **Top of the seed range.** Seed values are remapped to 400–2000 between the lowest and highest seed value. The highest belongs to a top roster that has usually played the scored roster. The 4 highest-seeded rosters are re-derived, with their matches against the scored roster mirrored from its ledger.
3. **Opponent shift.** When the seed range moves, every roster's starting rating moves with it. Each opponent's match-time rating, and each roster's points for the global rank, get that shift added.

With an unchanged ledger it reproduces every roster's points, starting value and global rank exactly.

`withEvent` adds an event the roster didn't play in the frozen world. Opponent ratings come from their timelines just before each match. `withoutEvents` removes events.

What it still ignores:

- Opponents don't react to the scored roster's results in the Glicko pass.
- Opponents' own seeds and networks don't update, beyond the top seeds and the reference rescale.
- Other rosters' reference totals stay as they were.

## Backtest

`npm run backtest-vrs-whatif [-- --seed N]` uses local data only. It takes about 80 s and has two windows:

- **Past:** the latest calibrated snapshot (2026-11-02).
- **Future:** a window 64 days after the last match, with `windowEndsAtPull`. Into it, the 6 biggest LANs of the last 75 days are replayed 9 days apart, with each team's latest lineup.

It checks four things:

1. **Rerun vs full model.** 25 random exclusions (one top-60 roster's matches at one event) and 25 random sets of replayed events. Every rerun must equal `computeStandings` on the same input.
2. **One-team vs rerun.** The error is in the roster's points.
   - *Remove*: every event each top-60 roster played.
   - *Add*: each top-60 roster at each replayed event. The rerun without its matches is frozen, then its matches are added back through `withEvent`.
   - *Add simulated*: one [season run](#season-simulation) (seed from `--seed`) at the target snapshot. Each simulated event that starts after as-of is added on top of every other simulated event, which is the optimizer's real case. Events split into Major stages are skipped, because `withEvent` adds one event.
3. **Regret.** For 20 top rosters, 30 random sets of played events are dropped. The set the one-team model scores best is compared with the best under the rerun.
4. **Below the top**, for the focal-team planner. Rosters ranked up to 150 on the past world, events whose last match is within 150 days. The rerun without a roster's matches in some events is frozen, and they're added back with chained `withEvent`, against the full rerun:
   - *One event* by category, up to 60 cases each: an online tier-3 main event, a tier 3–4 LAN, and a linked qualifier (prize rows with `qualifiedEvents`). Categories come from `tournaments.json`.
   - *A schedule*: 5–10 recent events at once, one case per roster ranked 15–80 with at least 5.
   - *Future-choice regret*: for 20 of those rosters, up to 8 recent events are removed; 30 random halves are added back. The half the chained estimate scores best is compared with the best under the rerun. The spread between the best and worst half is printed, so a zero regret isn't a choice between equals.

The gate: reruns identical. The one-team mean error must be ≤ 5 and p95 ≤ 15, separately for removing, adding replayed events, adding simulated ones, each lower-tier category and the schedule. Both mean regrets must be ≤ 5. The run takes about 110 s.

Results on 2026-11-17 data (seeds 1 and 7 gave the same numbers apart from regret):

| Check | Result |
| --- | --- |
| Rerun vs full model | 50 / 50 identical, none flagged, ~25 ms per rerun |
| One-team, remove an event (n 807) | mean 0.65, p95 2.28, max 8.50; global rank agrees 88% |
| One-team, add an event (n 87) | mean 3.59, p95 9.74, max 16.95; global rank agrees 85% |
| Starting value only | remove mean 0.20, p95 1.09; add mean 2.11, p95 7.89 |
| Regret (n 20) | mean 0.04 (seed 7: 0.00), max 0.36 |
| One-team, add a simulated event (n 80) | mean 4.10, p95 10.32, max 16.67; global rank agrees 84% |
| Add an online tier-3 main (n 57 of 358) | mean 0.49, p95 1.95, max 4.25; global rank agrees 90% |
| Add a tier 3–4 LAN (n 59 of 367) | mean 1.97, p95 6.58, max 8.23; global rank agrees 76% |
| Add a linked qualifier (n 56 of 711) | mean 0.35, p95 1.22, max 2.14; global rank agrees 93% |
| Add a 5–10 event schedule, ranks 15–80 (n 57, mean 7.5 events) | mean 4.57, p95 10.78, max 13.60; global rank agrees 51% |
| Future-choice regret (n 19) | mean 0.00, max 0.00; best − worst half mean 212, max 512 |

17 lower-tier cases were skipped because the rerun relinked a roster or an opponent wasn't in the frozen world.

**Gate passed.** The schedule case is closest to the limit: errors compound across chained events, and rank agreement is low because rosters ranked 15–80 sit a few points apart. Choosing among schedules is still exact in this sample, because the errors are shared across a roster's options. The focal search can lean on estimates, with exact re-scores of its top schedules as planned. How the add case got there:

| Version | Add mean | Add p95 |
| --- | --- | --- |
| Frozen opponents and seed range | 8.22 | 34.51 |
| + references rescale opponents | 7.66 | 30.09 |
| + re-derived top seeds | 5.45 | 15.76 |
| + opponent shift | 3.59 | 9.74 |

**Limits of the backtest:**

- Adding is the case the optimizer uses, and it has the fewest samples.
- Section 4 adds past events back on the past world. Simulated lower-tier events in a season run aren't checked until the field model simulates them.
- Rank agreement is lower than the point errors suggest, because top-60 rosters are often within a few points of each other.

## Event catalog

`scripts/lib/sim/catalog.ts` lists every upcoming LAN for the season simulation: the hand-written configs in `data/events/`, plus a generic config for every other one. `npm run catalog [-- --scope all]` prints it from local files only. Nothing here feeds `npm run simulate` or the Major invite projection, which keep their "announced only, never guessed" rule.

**Which events.** `buildCatalog` covers `/tournament` rows (`tournaments.json` plus `upcoming.tournaments`) that end on or after today and start within the 200-day upcoming window. With `scope: "lan"` (the `npm run catalog` default) they must be offline and not a `Qualifier`; with `scope: "all"` online events and qualifiers come in too. The season run and `fetchUpcoming` use `"all"`. `Showmatch` rows never do. It skips subpages of a configured or listed event, except qualifiers under `scope: "all"`. In-progress events stay in. A page is judged by its last row, so a fresh `upcoming` row beats a stale stored one.

**Metadata.** Every catalog event carries:

- `kind`: `lan` when the row's `type` contains "Offline" (so "Online/Offline" leagues with a LAN final count as LANs), else `online`.
- `role`: `qualifier` when `liquipediatiertype` is "Qualifier" or `publishertier` ends in "Qualifier", else `main`.
- `ranked`: Valve's rule below.
- `qualifies` (`qualifierTargets`): for a qualifier, the event whose participant rows name it in `qualifierpage`, with that many slots; else the nearest ancestor page with a tournament row, with 1 slot.
- `series`: the row's `seriespage`.
- `projection`: set on a [projected edition](#projected-editions), with its basis and the chance a run plays it.

On 2026-11-18 data, `--scope all` lists 78 events: the same 29 LANs plus 49 online events and qualifiers. ESEA Advanced and Intermediate leagues are "Tier 2 Qualifier" with no target, so they're qualifiers without a link.

`exclusionReason` then drops:

- `status` `cancelled` or `postponed`. A postponed event has no new dates. A hand-written config whose event is cancelled is skipped with a warning.
- Series no club can enter (`EXCLUDED_SERIES`, matched against the page and `seriespage`). Today that's the Esports Nations Cup, which is played by national teams. `npm run catalog` warns when at least half of an event's announced names are countries.
- Events Valve doesn't rank, using `buildMatchdata`'s rule: an empty `publishertier`, unless `overrides.rankedEvents` lists the page, or one in `overrides.unrankedEvents`. On 2026-11-18 data that's 13 tier-4 LANs. They can't move VRS points.

`npm run catalog` prints the exclusions by reason. `fetchUpcoming` applies the same filter, so excluded pages cost no `/match` or `/placement` requests.

**Generic format** (`genericEvent`), by `participantsnumber`. Every match is Bo3 unless noted, and each config has `assumed: ["format"]`. Tier 1–2 LAN main events with 4, 8 or 16 teams keep the templates, so today's simulated events don't move:

| Teams | Format | Placement labels |
| --- | --- | --- |
| 4 | single elimination | 1, 2, 3-4 |
| 8 | single elimination | 1, 2, 3-4, 5-8 |
| 16 | double elimination | 1, 2, 3, 4, 5-6, 7-8, 9-12, 13-16 |

Everything else uses `genericStages` (`formats/genericFormat.ts`):

- **2–3 teams:** one round robin.
- **Main events:** round-robin groups of about 4 (`round(n / 4)` groups), the top 2 of each into single elimination with byes. Labels follow positions, for example 5-6 and 7-8 for two groups' 3rd and 4th.
- **Qualifiers:** single elimination with byes down to `qualifies.slots`, rounded down to a power of two. Rounds of more than 8 matches are Bo1, and the qualified teams are placed with `exits.advance`.

Matches per team, from 200 coin-flip runs: main events 3.75 (8 teams) to 3.92 (24), against 3.4–3.7 observed for tier 3–4 LANs and online events. Qualifiers give 1.88 (32 teams) to 1.97 (128), against 2.0–2.3 observed.

A row with no team count (-1) takes the median of its series' finished editions (`pastTeamCounts`), else of finished events with the same tier, kind and role, and adds `assumed: teams`. An event with no count either way, or fewer than 2 teams, is listed and not simulated.

**Invite rule** (`inviteRuleFromPlacements`). It reads Liquipedia's participant rows: rows on the parent page with no `placement` yet.
- `VRS <list> (<Mon.> <year>)` becomes a slot. The list is `Global`, `Europe`, `Americas`, `Asia`, `North America` or `South America`, and the month is written `YYYY-MM`. Past editions use the looser `parseVrsLabel`, which also reads `VRS Oceania` (as Asia), `VRS North AM`, `VRS CIS` (as Europe) and labels without a month; country lists like `VRS Finland` count as VRS invites with no list.
- The `[[Category:…]]` suffix Liquipedia adds to one row is stripped.
- Any other label becomes a qualifier slot: `Closed Qualifier`, `European Qualifier`, `ECL S52 Europe`, `Global Qualifier`.
- A named team with no label counts as directly invited. An empty TBD row becomes `Unspecified`.
- Counts include slots already filled.
- A parsed rule has `verified: false`. A hand-keyed `invites` in the config wins, and has `verified: true` once checked against the organizer's announcement.

**Field.** An event is simulated when every open slot has a source: either all teams are announced, or the rule's slots and qualifiers cover the field with nothing `Unspecified`. Qualifier slots add `assumed: field`. Without a field model (`CatalogContext.learnsFields` unset, as in `npm run catalog`) anything else is listed as "field unknown". With one, as in the season run, it's simulated with `assumed: field` and the [field model](#field-and-activity-models) fills the open slots.

**Prizes.** Prizes come from the first of these that applies:
1. The Liquipedia prize table, re-cut to the template's labels by position. For example, a table's "5-8" pays positions 5–8.
2. The config's `prizeEstimate`.
3. The tournament's `prizepool` × a fitted split, stored as `prizeEstimate` with `assumed: prizes`.

The split (`fitPrizeSplits`) averages each finished offline event's per-position share of its total in `placements.json`. It uses events of the same tier and field size, then any tier of that size, then a 1/position fallback. On 2026-11-17 data, tier 1 with 16 teams (10 events) pays 1st 31%, 2nd 16%, 3rd 11%, 4th 8.6%, 5–6 5.8%, 7–8 4.4%, 9–12 2.2% and 13–16 1.1% each. A zero prize pool simulates with zero prizes.

**Location.** `location.country` is the row's `country1`. Its region comes from Valve's `getCountryRegion` (`region.js`): EU and MENA are Europe, NA and SA are Americas, and the rest are Asia. An online event without a country takes its region from its page or name (`regionFromName`: "Europe", "South_America", "Asia-Pacific", "Nordics"…). Africa, an unknown code and a missing country give `region: null`, which the optimizer treats as cross-region.

**Fetch.** `fetchUpcoming` builds its own parent list with `catalogParents` under `scope: "all"`: configured pages first, then catalog LANs by start date, then online events and qualifiers, capped at 100 pages. On 2026-11-18 data that's 78 pages instead of 29 LAN-only, so two batches of 50: one more `/match` request and one or two more `/placement` pages a night.

## Field and activity models

Who fills an event's open slots, and how much each team plays, learned from past editions (planner phase 2). Everything comes from local files: no Liquipedia requests.

**Past editions** (`history.ts`, `pastEditions`). Every finished ranked event (Valve's `publishertier` rule, `isRanked`) since August 2024, when Valve's published lists start. About 1,220 on 2026-11-12 data, built in under 2 s, so it isn't cached. Each has:

- page, `series` (`seriesKeyOf`: the page with every number replaced, so `CCT/2026/Europe/Series_14` joins `CCT/2025/Europe/Series_3`), kind, role, Liquipedia and Valve tier, prize pool, region, and the habit `category`: `lan1`, `lan2`, `lan34` by Liquipedia tier, `online`, or `qualifier`;
- attendees: every team with an unforfeited match in matchdata under the event's id;
- each attendee's global and regional rank on the latest published list before the start, matched by 3 or more shared nicks (55–99% matched by category; the rest are unranked), and its region (the list's, else most of its players' countries);
- each attendee's label from the archive's participant rows (2026 onward): `vrs` with list and month, `qualifier`, or `direct`. About half the editions are labeled.

**Field model** (`fieldModel.ts`, `fitFieldModel`). Ranks fall in 8 bands: 1–10, 11–20, 21–35, 36–60, 61–100, 101–150, 151–250, and 251+ or unranked. Editions weigh half as much per year of age.

- **Band histogram.** Shrunk level by level (κ = 16 attendees each): uniform → category → category × region → category × region × prize band (under $10k, $50k, $250k, above) → series. A second histogram counts only attendees labeled `qualifier`, shrunk from the open one.
- **Region.** An event's region is its location's, else its series' if 70% of past attendees came from one region. The share of attendees from that region is learned the same way; a global event has none.
- **VRS acceptance.** For each labeled edition and each Valve list it invited from, the cutoff is the worst list rank that accepted. Every team above it on the list that didn't attend declined, unless the top-12 rule barred it or it played an overlapping event (both are hard declines in the simulation). Acceptance by band is shrunk series → category → all, with a prior of 4 offers at 0.5.
- **Slot mix** (`learnedRule`). For an event with no rule from Liquipedia or a config, its series' latest labeled edition within 400 days: VRS slots by list, with the same month offset from the start (at most the start month), plus qualifier slots, scaled to the event's team count.

Precedence: announced teams, then the event's own rule, then the learned slot mix, then open draws for whatever is left.

**Activity model** (`activity.ts`). Events per day per team and category over the last 365 days, shrunk toward the mean of the team's rank band and region with 365 days of prior (both chosen by the backtest below). Each run draws a Poisson budget per team and category over the horizon (`Pacer`, seeded per team). A team's *pace* for an event is `(budget − used + 1) / (rate × days left + 1)`, clamped to [0.1, 2]: 1 on habit, lower past its budget, higher when behind. Caps (`capsFor`): LANs at the larger of the top-40 p75 (`volumeBaselines`) and the team's own p90 over the horizon, online events at the larger of 2 and its own p90.

**Draws** (`resolveField` with a `FieldSampler`):

- A VRS slot walks its list as before, but each eligible team accepts with probability `acceptance[band] × pace`, capped at 1. `cutoffs` records the last list rank that accepted.
- Qualifier slots and slots no rule explains are drawn without replacement (Efraimidis–Spirakis) from the latest list plus active unranked teams (5+ matches in 120 days, region from players). A team's weight is its band's probability, times the region share for its side, times its [affinity](#rival-affinity) divided by the summed affinity of the eligible teams sharing that band and side (their count, without affinity), times pace. Drawn teams have source `open`.
- Conflicts, caps and the top-12 rule stay hard declines.
- Draws are only from `drawable` teams. Valve names a roster after its newest lineup, so a simulated match by a lineup that shares 3 players with another roster's history, or fewer than 3 with some of its own, relinks rosters and forces a full rerun at every later checkpoint. `lineupKeepsLinks` checks each lineup against every checkpoint world at setup, and of two teams sharing 3 players only the one that played last stays. Today's top 80 and announced teams always stay. On 2026-11-12 data 87 of about 660 teams are kept out.

Each event draws its field from its own seed (`subSeed(run seed, "field|slug")`) and plays from another (`"play|slug"`), so changing one event leaves the rest of a run alone. Within the draw, each team's accept roll and draw key come from their own stream (`slot|team`), not from one sequence. `reach` replays an event's draw with the asked-for team accepting and the paces the real draw saw. It ignores that team's own declines (conflict, cap), so it would shift a shared sequence for everyone after it. With per-team streams it changes only that team and the one it displaces: 97% of reach fields differ from the real one by exactly that, and the rest by at most 4 more teams. The reach field keeps the real field's seed order, with the team in the displaced team's seed (`inPlaceOf`). That keeps every other pairing, at the cost of seeding a higher-ranked team a little low.

With a `seriesSeed`, `runEvent` gives each series its own stream keyed by stage, round and pairing. A replay with one team swapped then repeats every matchup it doesn't change. Season runs and optimizer replays use it; `npm run simulate` doesn't.

**Backtest** (`npm run backtest-fields`, about 2 s). Fields: each ranked event from January 2026 (697 events, 9,097 attendees), scored by the log loss of its attendees' bands under the model refit at the start of its month. Activity: each team's events in a half year, from the year before, for teams seen in the half year before the split (as the simulation only draws teams that exist), over two back-to-back half years so seasons cancel.

| Field log loss per attendee | Model | Without series | Uniform over the list | Best remaining |
| --- | --- | --- | --- | --- |
| All | 1.444 | 1.558 | 1.701 | 6.609 |
| Tier 1 LANs | 1.397 | 1.407 | 3.347 | 2.427 |
| Tier 3–4 LANs | 1.626 | 1.637 | 1.812 | 6.299 |
| Online | 1.441 | 1.508 | 1.648 | 7.050 |
| Qualifiers | 1.368 | 1.563 | 1.543 | 6.779 |

Activity deviance: 6,771 and 6,980 for the two half years, against 7,503 and 7,988 for the rank-band mean. Over both halves that's 13,751; a 180-day window does 14,359 at best, and priors of 90, 180 or 730 days with the 365-day window do 13,883–14,363.

The gate is: model below the fallback, the fallback below uniform, the model below best remaining, and activity deviance below the band mean in both halves. All pass.

Totals and shares are reported, not gated. A season run's attendance totals come from its calendar's slots, and pace only compares a team with its own budget. Over the year, predicted totals are ×0.99 (tier 1 LANs), ×1.00 (tier 2), ×0.79 (tier 3–4: 2026 held more of them), ×0.99 (online) and ×0.92 (qualifiers). Rank-group shares are within 15% except tier 2 LANs (1–20 at 42% vs 31%, 21–60 at 36% vs 46%; 106 attendances) and online (61–150 at 45% vs 39%, 151+ at 34% vs 51%).

## Projected editions

Liquipedia lists most online and tier 3–4 events only weeks ahead, so a season run to a target five months out would see points decay for teams that live on them. `series.ts` (planner phase 3) adds the editions recurring series haven't listed yet. Local files only.

**Series** (`seriesKey`, `seriesClusters`). A page's key replaces seasons (`Spring`, `Fall`…), Roman numerals and every number, so `Stake_Pulse/Beat_II` joins `Beat_III` and `BLAST/Bounty/2025/Spring` joins `…/Fall`. Keys are joined by `previous`/`next` links when both rows have the same organizer, kind and role (Galaxy Battle's "STARTER" → "Phase 1"). A cluster is then one key × kind × role × region. The field model's series level uses the same key; on 2026-11-18 data that moved its log loss from 1.444 to 1.439 (qualifiers 1.368 → 1.356, tier 3–4 LANs 1.626 → 1.630).

**Cadence** (`cadence`), from the editions that started by as-of:

- The gap is the median of the last 8 gaps between starts, at least 7 days: open qualifiers come in bursts a day or two apart, and a daily gap projected one qualifier a day for five months.
- A gap over twice the median is a *break*. A *run* is the editions between breaks. A series that has finished a run of its usual length (the median) waits its usual break before the next one: ESL Challenger League cups, a season's qualifiers.
- A date that falls in a break the series took one or two years before (shifted by 52 weeks) skips to where it resumed: the winter break.
- Duration is the median of the last 5, prize pool and team count the median of the last 3. Tier, `publishertier`, kind, location and series page come from the latest ranked edition.

**Which series** (`projectEditions`): at least 3 ranked editions, and the latest started within two gaps of as-of, or is inside its usual break, or inside last year's break, or a later edition is listed. Left out:
- Liquipedia tier 1. Those are announced well beyond the horizon, so a missing edition is news, not a gap, and a made-up one would pull top teams through its invites.
- More than 64 teams: open leagues (ESEA Open, 565 teams) and big open qualifiers are filled mostly by teams the field model never draws, through unranked Bo1 rounds. They took 3,800 matches a run.
- A series whose newest row is cancelled or postponed, and the catalog's exclusions.

**Dates.** Steps run from the latest edition by as-of through `PROJECTION_DAYS` (150). A step within half a gap of a listed edition re-anchors on it instead of adding one. The page moves on the number that changed between the last two editions (`ESEA/Season_58/Open10/Europe` → `Season_59`), else its last number, else its Roman numeral. A projection whose page exists in any status (a cancelled `Series_8`) is dropped.

**Catalog.** `buildCatalog({ projected })` gives each a generic event (`genericEvent` on the synthetic row), with `assumed` adding `dates`, and sets `projection`. The field model fills it like any event with no rule. Projections need learned fields, so only `loadSeasonSetup` with `learned` and scope `"all"` adds them; `npm run catalog`, `fetchUpcoming` and `npm run simulate` never see them.

**Chance.** Not every projected edition happens. `backtestProjections` projects 60 days from each of the last 10 month starts with only the rows that had started by then, and matches projections to actual editions in the same series, one to one, within half a gap (at least a week). A run plays a projected edition with its category's precision (`projectionChances`), drawn from `subSeed(run seed, "happens|slug")`. Its calendar row shows that chance.

**Backtest** (`npm run backtest-fields`, reported not gated), 60 days ahead from each month start 2026-01 … 2026-09, with nothing listed ahead, which is harder than a real run:

| Category | Projected | Precision | Recall, all ranked editions | Recall, in projected series | Median date error |
| --- | --- | --- | --- | --- | --- |
| All | 383 | 0.48 | 0.15 of 1,249 | 0.67 of 275 | 6 d |
| LANs | 62 | 0.47 | 0.09 of 315 | 0.67 of 43 | 7 d |
| Online main events | 175 | 0.62 | 0.34 of 316 | 0.71 of 152 | 5 d |
| Qualifiers | 146 | 0.32 | 0.07 of 618 | 0.57 of 80 | 6 d |

Most ranked editions aren't in a series with 3 editions: one-off tier 4 LANs and the qualifiers of single events. Misses are series that changed page scheme (CCT's `Season_#` pages became `#` in 2026), bursts of qualifiers on their first season, and series that stopped. Weekly stepping with runs and breaks beat a year-ago template (same dates as last year): precision 0.30 on the 176 editions that template could project.

On 2026-11-18 data, as-of 2026-11-12, it projects 133 editions: 110 online (53 qualifiers) and 23 LANs, 2 of them tier 2 (Stake Ranked), in 0.2 s.

## Unannounced events

Projections cover recurring series, but most ranked events mid-table teams play are one-offs listed a month or so ahead. Without them a season run starves ranks 15–80 of matches, and Valve's normalization against the top sinks their points (see [Hindcast](#hindcast)). That moves the Major invite cutoff, which matters to the focal team even though nobody can plan for these events. `unannounced.ts` fills them in as anonymous stand-ins. Local files only.

**Rate** (`unannouncedEvents`). Per category (tier 2 LANs, tier 3–4 LANs, online main events, qualifiers; never tier 1) and region (Valve's, or "global" for events without one), and per 30-day bucket from as-of to the target: the count that started in the 180 days before as-of, scaled to the bucket, minus the listed events and the projected editions' chances in it, at least 0. Counted rows are ranked, not cancelled, not showmatches, and top-level or qualifiers, like the catalog's. A rate over the past year lagged growth; over 180 days it had the lowest deviance (below).

**Events.** A bucket expecting x gets ⌈x⌉ stand-ins, each played with chance x / ⌈x⌉ through the same `happens|slug` draw as projections. Dates spread evenly through the bucket. Each copies team count, prize pool, venue and duration from a recent event in its cell, walking its prize quantiles, and gets a generic format; at most 64 teams. Its page (`Unannounced/lan34/Europe/2026-12-04/1`) matches no series, so the field model fills it from category, region and prize.

**Where they show.** Rivals play them. They're never schedule options (`teamUniverse` skips them), aren't in the calendar, and `index.json` carries only the expected count per category (`unannounced`), which the page states. `loadSeasonSetup({ unannounced: false })` leaves them out.

**Backtest** (`npm run backtest-fields`, reported not gated): 60 days from each month start 2026-01 … 2026-09, nothing listed ahead, against what started:

| Rate window | Poisson deviance | Tier 2 LANs | Tier 3–4 LANs | Online | Qualifiers |
| --- | --- | --- | --- | --- | --- |
| 180 days (kept) | 373 | ×0.72 | ×0.96 | ×0.92 | ×0.81 |
| 365 days | 413 | ×0.72 | ×0.77 | ×0.83 | ×0.69 |
| Half same window last year, half 365 days | 524 | ×0.69 | ×0.61 | ×0.74 | ×0.64 |
| 90 days | 939 | ×0.67 | ×0.94 | ×0.88 | ×0.80 |

Event counts grew through 2026, so every window still runs low; qualifiers and tier 2 LANs most. On 2026-11-18 data, as-of 2026-07-06 (the hindcast), about 180 stand-ins are expected per run, 41 of them tier 3–4 LANs.

## Rival affinity

Within a rank band and region, the draw used to pick teams at random. Real teams return to series they've played, favor organizers they know, and play at home; travel distance beyond Valve's region and visas also matter but aren't modeled. `affinity.ts` adds the first three (planner phase 3b).

**Features** (`AffinityIndex.pattern`), each 0 or 1, from attendance in the 400 days before the event:
- **repeat:** 3 or more of the lineup's players attended an edition of the series (`seriesKey`);
- **organizer:** not repeat, and 3 or more attended an event by the same first organizer;
- **home:** a LAN in the country 3 or more of the players come from.

Past attendees carry their players' nicks and countries (`PastAttendee.players`), and past editions their organizer and venue country.

**Model.** A team's weight in the draw is multiplied by exp(β·x) and divided by its cell's sum instead of its size, so affinity moves weight between teams of a cell, not between bands or regions. β is a conditional logit (`fitAffinity`, Newton with a N(0, 2²) prior): each attendee that didn't come through a VRS invite and was on the list, chosen from the list's rosters in its cell. The season setup fits it on the year before as-of. Stand-ins get no affinity; VRS acceptance doesn't use it yet.

**Backtest** (`npm run backtest-fields`), each 2026 month held out with β fit on the year before it, 2,932 attendees:

| Features | Mean log-likelihood |
| --- | --- |
| None (uniform in the cell) | −3.302 |
| Organizer | −3.276 |
| Repeat | −3.162 |
| Home | −3.151 |
| All but organizer | −3.062 |
| All but home | −3.037 |
| All | −2.980 |

Every feature helps on its own and on top of the others, so all three ship. Fit on the last year: repeat ×9.1, organizer ×4.4, home ×5.2.

## Qualifier links

Planner phase 4. A main event's qualifier slots used to be drawn from the qualifier histogram, while its simulated qualifiers sent their winners nowhere. Now a qualifier the run plays fills the slot it feeds with its own finishers. A team's path through a qualifier also gets odds in "Build a schedule".

**Links** (`qualifierLinks.ts`, `qualifierLinks`). These rules apply, in order, to the season's simulated events (stand-ins and fully announced fields excepted). A source must end before its target starts.

1. **`page`.** The target's participant rows give each slot label a `qualifierpage`. The source can be a main event: the "ECL S52 Europe" slot at ESL Pro League S25 is filled by ESL Challenger League S52 Europe.
2. **`ancestor`.** A qualifier whose `qualifies` target is the event, matched to a label no row claims. The match goes by the label's region (`qualifierList`), else to the only label left.
3. **`implicit`.** Otherwise the source gets a slot of its own, keyed by its page, with `qualifies.slots` places. That covers PGL Łódź's Qualifier ← Open/1 and Open/2, which has no participant rows.

The labels are those of the event's own invite rule, else its learned slot mix, less slots already announced. On 2026-11-18 data there are 38 links:
- PGL Cluj-Napoca and Łódź (via a closed qualifier fed by two opens);
- the four ECL S52 regions into ESL Pro League S25;
- CCT and NODWIN play-ins;
- RLG regional qualifiers;
- Stake Ranked and Fiesta qualifiers.

Many links are between projected editions: a projected feeder of a projected event uses that event's `happens` draw, so it plays exactly when the edition does.

**In a run** (`runSeason`, with `SeasonEvent.feeds`):

- **Target resolved before its feeder plays.** It resolves with that slot *reserved* (`LinkedSlots.reserved`): held out of `room()` and never offered or drawn.
- **Feeder already played.** Its qualified teams are already in the target (`LinkedSlots.filled`), with source `qualifier`.
- **When the feeder plays.** Its teams go by placement, then seed. The first `count` that aren't already in the target, fit its dates and caps, and aren't barred by the top-12 rule are committed to it.
  - If the target is already resolved, they join its field.
  - Teams that can't go pass the slot down, as 2.7% of past slots did.
- **Leftover places** are drawn at the target's start, on the streams the first draw would have used.
- **Who enters a feeder.** It declines a team already in its target, one whose target dates or LAN cap don't fit, or a top-12 team when the target is Valve Tier 2.
- **Feeder not in the run.** The slot falls back to the qualifier draw.
- **`reach(target)`** adds the run's linked fills, so a team can't take a linked slot through `reach`.
- **`RunResult.qualifiedFrom`** records who each feeder sent.

**Qualifying odds** (`qualifyPaths`, `tryQualify` in `optimizer.ts`).
- **Which events.** For each optimizer team, the not-yet-started simulated LANs, not announced for it, that a linked feeder in its region (or with none) qualifies for.
- **Each run.** When the event played without the team, the team enters the first feeder it can, in date order:
  - **Played it:** its actual placement counts.
  - **Has a slot in it** (`reach`): it's replayed with the team in it, on the run's `play|slug` streams.
  - **Neither:** the team climbs one level to that feeder's own feeders. If it qualifies there, it replays the feeder in place of the team that feeder really sent.
- **Qualifying** means finishing within the link's slot count.
- **Output.** `requiresQualifying` entries gain `via` and `qualified`, and their `reach` is the share of runs the team could enter. Paths entered in under 10% of runs, and events that are already candidates, are left out.
- **What isn't counted.** The odds aren't in the nightly optimizer's schedule points. The [focal planner](#focal-planner) builds qualify options on the same replays.

**History check** (`npm run backtest-fields`, reported). The rules are applied to ranked main events since 2025-06, with participant rows read as they stood before each event.

| Rule | Links | Result |
| --- | --- | --- |
| `page` | 323 | 1,092 slot fillers, 31 at sources with no placements. Of the rest, 90.4% finished within the source's slot count, 2.7% lower (the slot passed down), and 6.9% aren't in the source's placements (renamed teams, substitutes). |
| `implicit` | 151 | Untestable: 147 of the sources have no placements in the store. |
| `ancestor` | 0 | Never needed on past events: every label had a `qualifierpage` or none matched. |

Fillers average band 5.40 against 5.68 for their source's whole field: qualifying lifts a team's rank band only a little.

## Hindcast

`npm run hindcast-season [-- --as-of 2026-07-06] [--n 100] [--setup full|projected|listed|lan-only]` runs the season simulation from a past date to the next invite snapshot and compares the target checkpoint with Valve's published points. About 17 minutes for 100 runs of all four setups. Local files only.

**As of** (`loadSeasonSetup({ asOf })`). Elo, matchdata and the field and activity models stop at as-of; lists are Valve's published ones up to it, never `live.json`; lineups are the last played, not today's squads; no hand-written configs, whose fields were keyed after the fact. Events count as listed when they start within 30 days of as-of, or are tier 1–2 LANs. That matches what Liquipedia lists today, against the past year's monthly rate:

| Listed ahead / usual rate | Days 0–30 | 30–60 | 60–90 | 90–150 |
| --- | --- | --- | --- | --- |
| Tier 1–2 LANs | 0.35 | 0.35 | 1.04 | 0.35–1.74 |
| Tier 3–4 LANs | 0.66 | 0.12 | 0 | 0 |
| Online main events | 1.05 | 0.31 | 0 | 0 |
| Qualifiers | 0.25 | 0.16 | 0.10 | 0 |

Later events keep their participant rows' slot labels, which organizers announce early, with the teams, placements and prizes blanked. Projections use only those rows.

**Scored rosters.** Valve's global ranks 15–80 at the target that share 3 players with a roster ranked at as-of (55 of 66 for 2026-07-06 → 2026-11-02); a roster formed later has nothing to project from. Each roster's simulated points are those of the best simulated roster sharing 3 players, 0 when none is ranked. Valve's model on the real matches gives a median error of 1.4 for these rosters, so the comparison itself is sound.

**Gate:** the full setup's median error (simulated p50 − published) within ±30, 70–90% of rosters inside p10–p90, and the LAN-only setup decaying more.

**Result (2026-11-18 data, 100 runs, seed 1): FAIL.**

| Setup | Events | Median error | Inside p10–p90 |
| --- | --- | --- | --- |
| Full, with [qualifier links](#qualifier-links) (the nightly's setup) | 359 | −160 | 51% |
| Full before qualifier links: projections, [stand-ins](#unannounced-events), [affinity](#rival-affinity) | 359 | −147 | 58% |
| Stand-ins without affinity, year-based rate | 334 | −178 | 45% |
| Projected, no stand-ins | 170 | −342 | 29% |
| Listed only | 78 | −439 | 29% |
| LAN-only, no learned fields | 20 | −431 | 40% |
| No events after as-of | 0 | −251 | – |

Without stand-ins, mid-table teams sank below even the no-events floor: the simulated tier 1 LANs paid the top teams, and Valve's model normalizes bounty and network against the top while the middle played almost no LANs. Comparing one run with the real matches from 2026-07-07 to 2026-11-02, median per roster of ranks 15–80 at the target:

| | Real | Projected, no stand-ins | Full |
| --- | --- | --- | --- |
| Ranked matches, all ranks | 5,002 | 2,446 | 3,423 |
| LAN matches, all ranks | 1,588 | 489 | 1,285 |
| Ranks 15–30: matches / LAN | 33 / 23 | – | 34 / 15 |
| Ranks 31–50: matches / LAN | 36 / 21 | – | 38 / 14 |
| Ranks 51–80: matches / LAN | 39 / 14 | – | 35 / 14 |
| Ranks 15–80 with no match | 0 | 9 | 1 |

Volume is now right; what's left is the LAN share of ranks 15–50, about two thirds of real. Stand-in rates still run low for tier 2 LANs (×0.72) and qualifiers (×0.81), and those teams' real LANs were more often tier 2 and invitational. Not tuned to the hindcast: there's one target date with a published list, so a fit to it would test nothing.

Qualifier links cost 13 points and 7 points of coverage. The likely cause, not checked: a linked slot now goes to a team that already took the qualifier's points, so LAN places concentrate among fewer mid-table teams, where the old draw handed them to others. Links stay because they make each run consistent, which the qualifying odds need. Projected, listed and LAN-only moved by under 10.

## Season simulation

`npm run simulate-season [-- --season-n 300] [--seed 1] [--workers N] [--rescore-n 30] [--impact-check-n 20] [--out <dir>]` plays the catalog's events from Elo up to the next Major invite snapshot. It reruns Valve's model at every VRS publication date along the way, and writes `public/data/sim/season/` for `/vrs-sim`. It reads local files only. This is feature 2 of the spec. The [schedule optimizer](#schedule-optimizer) and [event impact](#event-impact) read the same runs.

**Workers** (`seasonPool.ts`, `seasonWorker.ts`, `seasonShard.ts`). Run r goes to worker r mod W. Each worker loads the setup once, about 7 s, and posts each run's season tally back. The main thread merges those in run order, so every output file is byte-identical for any W apart from `generatedAt`. `--workers` defaults to the core count minus one, up to 8, and no more than memory allows (see [Memory](#schedule-optimizer)). `--workers 1` runs in-process.

**Nightly.** The `Update data` workflow runs `npm run simulate-season` after `npm run simulate`, with default flags. On the 4-core, 16 GB runner that's 3 workers. The step has a 30-minute timeout and `continue-on-error`, so a failure leaves yesterday's season files in place and doesn't block the rest of the data.

**Setup** (`seasonSetup.ts`, `loadSeasonSetup`):

- **Target.** The first `invites-*.json` snapshot after as-of, today the FiRe Major Buenos Aires at 2027-04-05 (estimated).
- **Checkpoints** (`publicationDates`). The first Monday of each month after as-of, through the target. A month with a vendored `invitation/` list uses that list's date. One world per checkpoint is loaded once with `windowEndsAtPull` and shared by every run.
- **Catalog.** `scope: "all"` with `learnsFields`, built from hand-written configs after `resolveParticipants`, so a Major whose stages come from a published snapshot has a fixed field. Events ending before as-of are dropped. `loadSeasonSetup({ learned: false, scope: "lan" })` gives the old LAN-only, deterministic setup.
- **Today.** `public/data/vrs/live.json`, else Valve's latest published list. Every published list up to as-of is loaded once, for past-edition ranks and for slot months.
- **Lineups.** Only teams whose lineup shares 3 players with today's top 80 get their current Liquipedia squad (`preferSquads`); the rest keep their last-played lineup, since a swapped lineup relinks.
- **Field and activity models**, [above](#field-and-activity-models), fitted at setup.

**Which events play.** A catalog event is simulated when the catalog marks it simulated and it starts before the target. A generic event already under way is not: its played matches are in matchdata, and a generic bracket can't pick up the real one's pairings. Entry stages must be either all drawn or all open, and every announced team needs a match history. Open entry stages are sized from their bracket seeds, or split the field evenly when unsized. `listMonth` is the latest VRS slot month, of the event's rule or its learned slot mix, that still has open slots.

**One run** (`runSeason`; run `r` uses `makeRng(runSeed(seed, r))` for its rating paths, and per-event streams for draws and play, so any run can be regenerated alone):

1. One rating path per team (`Predictor.resample`) over every event's horizon.
2. Published lists resolve the fields of events whose `listMonth` has already been published.
3. Events and checkpoints go in date order. An event starting on a checkpoint's day plays after it.
   - **Checkpoint:** `rerun` the checkpoint's world with the run's simulated matches so far. If the rerun is inexact, fall back to `computeStandings`. Record the standings, turn them into that month's list, and resolve every event whose `listMonth` is now out.
   - **Event:** resolve its field if no list did. Play it with `runEvent`, with the field snaked across entry stages (1→A, 2→B, 3→B, 4→A). Append `simulationDelta` to the run's matches. An event already under way keeps its played matches as locks, and they stay in the base.

`simulationDelta` applies Valve's ranked rule as `buildMatchdata` does (`isRankedMatch`): every match of an unranked event is `valveRanked: false`, and so is a Bo1 elimination match in a round of more than 8 matches, or in any round of a "Tier 2 Qualifier". A qualifier's prize rows carry `qualifiedEvents: [target]`, so Valve adds half the target's prize pool (capped at $1M) once the target is finished.

Fields and runs use one name per team (`canonical`). Matchdata keys teams by `teamAliases` targets ("Vitality"), Liquipedia by pages ("Team Vitality"), and several pages can alias one id. The name kept is the alias page with the most recent Elo match, or a renamed team's current page. Without this, the same team could fill two slots.

**Attendance** (`attendance.ts`, `resolveField`):

- Announced teams are fixed. Each announced row's `qualifier` says which slot it fills (`announcedSlots`), so only the rest are open.
- A VRS slot walks its list from `startRank`: the global list by global rank, a region by regional rank. North and South America split the Americas list by the majority of the lineup's player countries.
- A team declines, and the slot passes down, when:
  - the event clashes with one it's already in (`conflicts`: two LANs need 2 clear days within a region, 4 across regions or with an unknown region; an online event clashes with a LAN only on shared days, and with other online events never);
  - it already holds its LAN cap, or for an online event its online cap ([`capsFor`](#field-and-activity-models); without learned fields, the average-volume LAN cap and no online cap), or the event would make a day with more than `ONLINE_CONCURRENCY` (2) online events (`fits`);
  - the event is a Valve Tier 2 tournament and the team is in the global top 12 (Tournament Operation Requirements §3.8.4). The tier is Liquipedia's `publishertier` ("Tier 2"); "Tier 1" and "Wildcard" events have no such limit. Liquipedia's own tier is the fallback only when `publishertier` is missing.
  - with learned fields, by chance: see [Draws](#field-and-activity-models).
- A qualifier slot a simulated event feeds takes that event's finishers ([qualifier links](#qualifier-links)).
- Other qualifier slots, and slots no rule explains, are drawn by the field model. Without it, qualifier slots take the best-ranked remaining roster on the qualifier's list (the label's region, else the event's, else global), and an event with unexplained slots isn't simulated.
- Seeds follow global rank on the latest list.
- When the lists can't fill every slot, the event isn't played in that run (`shortRuns`).

Commitments start with every announced and drawn field. Events resolve in list order, so an earlier list's event claims teams first. PGL Łódź (December list) takes the top teams before BLAST Open Spring (January list), which overlaps it. Its field comes mostly from outside the top 10.

**Rosters.** A roster is mapped to a team page through the lineup (`latestLineups` plus `preferSquads`) that shares at least 3 players with it. Results are tallied under a stable id: today's roster sharing 3 or more players, else the roster's own key. Valve gives a roster a new `rosterKey` when a new lineup links into it, so the raw key would split one team across checkpoints.

**Volume baselines** (`schedule.ts`, `volumeBaselines`). LAN events per team over the last 180 days for today's top 40, with a Major's stages counted once, at p25 / p50 / p75. They're scaled to the as-of → target horizon. p75 is the floor of every team's LAN cap; without learned fields, p50 is everyone's cap.

**Activity check.** The script prints, per rank band, the events per team (simulated) against habit in two 30-day windows: the next 30 days, mostly listed events, and days 60–90, where only projected editions fill in. Before projections, the first window was 0.48–0.94 of habit: the catalog only has what Liquipedia lists, and generic events already under way (ESEA, CCT Series 14) are skipped. With them, see below.

**Outputs.**

- `index.json`: target, checkpoints, run count, inexact reruns, volume baselines, unmatched top-80 rosters, and the calendar. Each event has dates, location, tier, prize pool and source, `assumed`, `simulated` or the reason it isn't, `shortRuns`, `fedBy` (the simulated events that fill its qualifier slots), and its field: the 24 likeliest teams for tier 1 events and 10 for the rest, with attendance share, usual source and win share.
- `standings.json`: rosters in the global top 60 today or at p50 at any checkpoint. Each has today's points and ranks, and per checkpoint points, global rank and regional rank at p10 / p50 / p90 plus the share of runs it's ranked. Unranked runs count as 0 points and as no rank, which is null in a percentile.
- The script refuses to write over 1 MB.
- **Budget:** at most 1 MB, and about 15 minutes for the nightly's 300 runs on 3 workers, inside the step's 30-minute timeout.

**Assumptions**, also stated on the page:

- Listed events, projected editions of recurring series, and anonymous stand-ins for events Liquipedia will list later, at the recent rate, add results.
- Open fields, the winners of qualifiers the run doesn't play, and who accepts an invite are drawn the way past editions went, not known, with teams' history at a series, an organizer or at home weighing in. A qualifier the run plays sends its own finishers.
- A schedule may include LANs with an assumed format and an assumed invitation.
- Announced attendance at later events is a commitment, even when a list run would have passed the team over.

**First run (2026-11-17, as-of 2026-11-12, 300 runs, seed 1).**

- The run simulated 7 of the 48 catalog LANs: BLAST Rivals Fall (under way), the Singapore Major, PGL Bucharest, PGL Cluj-Napoca, ESL Pro League S25, PGL Łódź and BLAST Open Spring.
- Checkpoints were 2026-12-07, 2027-01-04, 2027-02-01, 2027-03-01 and 2027-04-05.
- The volume cap was 6 LANs (p25 / p50 / p75 6 / 6 / 7 over 144 days). Only Luminosity, among the top 80, has no team page.
- It took 293 s, about 6 s of loading and then about 1 s per run, mostly the inexact first checkpoint (below). The output is 98 KB.
- At the target, regional ranks roughly agree with `npm run simulate`'s invite projection on the same snapshot. MOUZ is 2nd in Europe, Vitality 3rd and NaVi 5th (4th there). FURIA and The MongolZ are 1st in the Americas and Asia in both.

**With learned fields (2026-11-18, as-of 2026-11-12, 300 runs, seed 1, 3 workers).**

- 64 of 87 catalog events simulated, against 7 before. 214 unranked teams are drawable and 87 teams are kept out of draws to avoid relinks.
- 6 min 37 s in all: 257 s of season runs (about 2.5 s per run per worker), 131 s of exact re-scores. Output is 556 KB.
- The only inexact rerun is still FUT's, once per run. Before the drawable check, low-ranked teams' lineups relinked rosters in 63% of checkpoints.
- The optimizer's estimate error first rose to a mean of 7.9 and a p95 of 20.3 points (n 66), from 0.43 and 2.9, and regret to a mean of 1.0 and a max of 31.6.
  - **Cause.** Learned acceptance lets lists pass further down, so mid-table teams reach about 3 tier-1 LANs per run they didn't play. Replays went from 4.8k to 53k, and most recommended schedules add 1–2 events by replay.
  - **Why replays hurt.** A replay differed from the run far beyond the one team. It used its own stream, so every series was redrawn. Its field was re-sorted by rank. And the forced team shifted the shared field-draw sequence, which changed 3.7 more teams on average and up to 26. The exact re-score swaps in that whole replay, and the one-team estimate can't see any of it.
  - **Fix.** Per-team field draws, reach fields in the real seed order, and per-series streams (above).
  - **Decomposition** (20 runs, per run, schedules that add 1–2 events, n about 1,190). *Graft* keeps the real event and grafts in only the team's replayed matches and prize:

    | Mean per-run gap, points | Before | After |
    | --- | --- | --- |
    | Estimate vs graft (one-team model error) | 10.1 | 4.4 |
    | Graft vs exact (replay noise) | 23.0 | 17.0 |
    | Mean exact − estimate (bias) | +4.1 | −1.9 |

    The remaining noise is real: past the team's first match, Swiss pairings change, and opponents' prize and ratings at the event feed into the team's points. It averages out over runs.
  - **After the fix** (300 runs): estimate error mean 3.6 and p95 8.1 (n 66), inside the backtest's add gate. Regret mean 0.25 and max 14.4. The max is MIBR, whose points pick scores 14 below its invite pick exactly. The run took 6 min 32 s and wrote 555 KB.

**With projected editions (2026-11-18, as-of 2026-11-12, 300 runs, seed 1, 3 workers).**

- 194 of 220 calendar events simulated: 64 of the 87 catalog events as before, plus 130 of the 133 projected editions (3 start after the target). A run plays each projected one with its category's chance (0.32–0.62).
- 4:20 of season runs and 2:23 of exact re-scores, against 4:13 and 2:10 without projections: the [rerun index](#exact-rerun-valveworldts) paid for the extra matches. Output 825 KB.
- Optimizer estimate error mean 2.8, p95 6.7 (n 64); regret mean 0.27, max 15.9. Impact check mean 2.2, p95 8.9 (n 120).
- Activity, simulated / habit by band (1–10, 11–20, 21–35, 36–60, 61–100, 101–150, 151–250, 251+):

  | Window | Before projections | With projections |
  | --- | --- | --- |
  | Days 0–30 | 0.70, 0.63, 0.69, 0.80, 0.69, 0.51, 0.48, 0.94 | 0.70, 0.63, 0.88, 1.01, 0.93, 0.68, 0.62, 1.26 |
  | Days 60–90 | not printed | 1.12, 0.81, 0.74, 0.65, 0.63, 0.62, 0.53, 0.87 |

  Ranks 21–100 reach habit in the next 30 days. Further out, mid-table teams sit at about 0.6: projections cover two thirds of the editions of series they project, but most ranked editions mid-table teams play are one-offs (tier 4 LANs, qualifiers of single events) that no cadence predicts. The 0.8–1.2 the plan hoped for isn't reached past the listing horizon.

**With stand-ins, assumed invites and affinity (2026-11-18, as-of 2026-11-12, 300 runs, seed 1, 3 workers): over budget, nothing written.**

- 429 of 455 calendar events simulated, about 5,800 simulated matches a run against 3,100 without stand-ins.
- 529 s of season runs and 595 s of exact re-scores (5,550 jobs), about 19 minutes in all against 6:43 before. Per run in one process: 1.9 s of season, 3.1 s of optimizer. A 12-event universe took 13 + 9 minutes.
- Output 1.26 MB (index 399 KB, teams 568 KB, impact 228 KB), over the script's 1 MB budget.
- Optimizer estimate error mean 1.9, p95 5.3 (n 111); regret mean 0.18, max 3.0.
- Activity, simulated / habit, overshoots: days 0–30 at 0.67–1.35 for ranks 1–250, days 60–90 at 1.27–2.46. Monthly event counts match 2026's, but every slot goes to the drawable pool (about 580 teams plus 214 active unranked), while real events also draw teams outside it, so each pool team plays more than it used to. Habits also trail 2026's growth.

**With qualifier links and the budget trims (2026-11-18, as-of 2026-11-12, 300 runs, seed 1, 3 workers): within budget.**

- **Trims:**
  - field rows cut to 10 below tier 1;
  - `--rescore-n` 30;
  - the schedule subset table in whole points and invite shares to 0.01;
  - impact rows only for teams attending at least 1% of runs.
- **Time:** about 13 minutes, of which 470 s of season runs (47,409 of them qualifier replays for the odds) and 298 s of exact re-scores (3,240 jobs).
- **Output:** 983 KB written. It took four runs to fit: 1.14, 1.07, 1.01 and 1.006 MB before the last trim.
- **Optimizer:** estimate error mean 2.9 and p95 7.9 (n 108); regret mean 0.2, max 3.4.
- **Linked slots:** filled by their feeders' finishers in every run for listed events. For projected CCT and NODWIN editions in March the share falls to 0.26–0.57. By then teams near their online cap can't take the place, so it's drawn.
- **Qualifying odds** for mid-table teams, share of entered runs:

  | Event | Through | Qualifies |
  | --- | --- | --- |
  | PGL Cluj-Napoca | its closed qualifier | 0.40–0.84 |
  | ESL Pro League S25 | ECL S52 Europe | 0.13–0.22 |
  | PGL Łódź | its Qualifier, or the opens before it | 0.06–0.31 |

  Cluj's run high: 8 teams for 2 places, and Elo below tier 1 is overconfident (see the planner's risks).
- **Activity is unchanged from the run before:** days 60–90 at 1.16–1.44 for ranks 1–150.

**Known limits:**

- The first checkpoint is inexact in every run: FUT's current Liquipedia squad differs from its last lineup, so its simulated matches relink a June match (`BETBOOM vs FUT at 2026-06-15`). The full-model fallback costs about 0.8 s per run.

## Event impact

Feature 1 of the spec. For each simulated event with a config (`impactEvents`), which is every event with a page that shows it, it gives each team's VRS points change by placement: "if Vitality win, how many points do they gain?" It runs inside `simulate-season` on the same runs (`impact.ts`, wired in `seasonShard.ts`). It isn't in `npm run simulate`, because only the season run reruns Valve's model at every publication date with the catalog LANs in between.

**Per run:**

1. The event's checkpoint is the first publication date after it ends (`impactCheckpoint`). Events ending after the target have none.
2. At that checkpoint, `freeze` the run's rerun. When the rerun is inexact, freeze a world freshly loaded from the run's full input instead (`fullLoads` in `index.json`). Today that happens in every run at 2026-12-07, because of the FUT relink above.
3. Find each field team's roster through the event's matches in the rerun state (`teamIdOf` on the simulator team). Then `eventImpact` scores the roster's ledger with `withoutEvents` and `scoreTeam`. The change is the frozen points minus that score. The *starting-value* part is the change in the seed rating; *head to head* is the rest.
4. Tally by team and placement. Tallies merge in run order like the season tally.

**Check** (`--impact-check-n`, default 20 runs). For one random field team per event and run, an exact `rerun` at the checkpoint drops that team's matches at the event (and with them its prize) and compares the exact change with the one-team change. The checkpoint's delta is rebuilt from the run's events that started by that date. A debug pass showed the rebuilt "with" points are identical to the run's.

**Outputs.**

- `impact/<slug>.json`: checkpoint, run count, check error, and per team the attendance share, mean change, and per placement the share, run count, change and its two parts.
- `index.json` `impact`: events with a file, the check's error stats and `fullLoads`.
- Placements with under 20 runs are faded on the page.

**First run (2026-11-17, 50 runs, seed 1).**

- All 7 simulated LANs got a file.
- The check error is a mean of 3.0 and a p95 of 11.5 points (n 120). That's within the gate's ≤ 5 / ≤ 15, but above the backtest's remove case (0.65). A whole simulated LAN is worth 100–400 points to a team, more than most real events the backtest removed, and the one-team error grows with the size of the change.
- Every team that both won and finished second gains more from winning wherever both placements had more than 5 runs. The exceptions all come from 1–5 runs.
- The run took 57 s on 4 workers, against about 45 s without impact. Most of the extra is the full load at the first checkpoint.

**Known limits:**

- The change is measured against the same run without the event. Other teams' results at that event stay in their ledgers, and later events still happen.
- Placement averages are noisy below a few dozen runs. At 300 runs the long-shot placements still are, which is why the low-confidence fade exists.

## Schedule optimizer

Feature 3 of the spec. For each of today's top-60 rosters, it finds the LAN schedule that maximizes expected points at the target snapshot, or Major invite odds, at low, average and high volume. It runs inside `simulate-season` on the same runs. The code is `optimizer.ts`, plus `src/sim/schedule.ts` for conflicts and subset enumeration, which the site shares.

**Choices.** A team's *universe* (`teamUniverse`) is every simulated LAN that hasn't started where it's announced or that has open slots: a known invite rule, a learned slot mix, or a field the model draws. That includes generic events with an assumed format and projected editions; unannounced stand-ins and online events are left out. An open slot is one the team could ask its organizer for, when the organizer would plausibly say yes (`welcomes`): at least half of past open attendees (`WELCOME_SHARE`) ranked in the team's band or below. Then `reach` puts it in an open slot, even past qualifier slots; otherwise it can only qualify, which still doesn't count as a choice. The schedule page marks candidates "projected", "assumed format" and "assumed invite" (reached through an open slot in most runs). Before the runs, an event with no known rule only enters the universe when the team could plausibly be invited (`canEnter` in `seasonSetup.ts`): its band is welcome, the top-12 rule doesn't bar it, and the event draws at least 10% of its field from other regions when the team is from one. The universe is capped at 10 events: announced first, then by prize pool. With assumed invites nearly every top-60 team filled 12, which cost 69,760 scored subsets a run instead of about 1,440. At 10 it's about 22,000. Events already under way that it plays are *committed*: they're kept in every schedule and count toward the cap. Every subset of the universe with no travel-buffer conflict and at most `high − committed` events is scored. `feasibleMasks` keeps 32-bit masks for this universe; `feasibleSets` returns index arrays with separate LAN and online caps for larger option lists.

**Per run** (`optimizeRun`), after the season run:

1. Freeze the target checkpoint's rerun. When it's inexact, load a world from the run's full input and rerun that instead (`inexactTargets`).
2. Find the team's roster with `findRoster` on its lineup, and take its ledger without every universe event it played.
3. Build one ledger fragment per universe event:
   - **Played this run:** its own matches and prize, cut from the frozen ledger.
   - **Not played, but reachable:** `reach(team)` from the season run gives the field the event would have had if the team took a slot, with the lists and commitments as they stood when it resolved, and the Tournament Operation Requirements kept. Usually that means displacing the last invitee. The event is replayed with that field under the run's rating path, on the run's own per-series streams for the event (`"play|slug"`). Matchups the team doesn't touch come out as the run played them, so the exact re-score, which swaps in the whole replay, differs from the run only along the team's path. The team's ranked matches go in through `withEvent`, once per Valve event, so a split Major works. An event where none of its matches is ranked adds nothing, prize included, because Valve records prize participation only from loaded matches.
   - **Unreachable:** choosing it adds nothing.
4. Score every subset with `scoreTeam(…, { rank: false })`.
5. **Invite check.** The team is invited when it's ranked, intact and region-eligible, and fewer eligible rosters in its region have more points than it has slots. The slots are the previous Major's Stage 3 and 2 slots from this run's simulated Major, plus Stage 1. This is `allocateInvites` (any stage) by binary search, tested equal. Other rosters' points are frozen, without the one-team model's seed-range shift.

**Pick** (`pickSchedules`):
- Candidates are announced events plus events reachable in at least 10% of runs.
- An event the team only ever reaches through a qualifier slot is listed under "requires qualifying" and left out. When simulated qualifiers feed it, the entry carries the team's [qualifying odds](#qualifier-links) instead.
- For each volume cap, the points goal takes the best mean, and the invite goal the best invite share, with ties broken by mean.
- Duplicates merge, so there are at most 6 schedules.

**Exact re-score.** The recommended schedules are rerun exactly on the first `--rescore-n` runs (30; 50 before the nightly hit its time budget), on the worker that played each run. It still holds that run's delta and replays. The schedule's delta (`scheduleDelta`):
- drops the team's matches and prize row from events it played and didn't choose;
- swaps in the full replay for events it chose but didn't play.

The shown points and invite odds come from these reruns. The **rules** row is the same runs under the season's own attendance rules. `index.json` carries `optimizer.estimateError`, the gap in mean points between exact and one-team over the same runs. It also carries `optimizer.regret`, the best exact mean among a team's re-scored schedules within a cap minus the recommended one's.

**Outputs.**
- `teams/<team>.json` per team, where `<team>` is the page with spaces as `_`. Each holds:
  - candidates with reach and attend shares, `generic`, `projected` (chance) and `assumedInvite`, committed events and "requires qualifying" (with `via` and `qualified` for linked qualifiers);
  - the rules row;
  - the recommended schedules, with exact and one-team numbers;
  - every feasible candidate subset within the high cap as `[mask, mean, p10, p90, invite]`. The picker reads this table and labels it an estimate.
- `index.json` lists the teams under `schedules`.

**First run (2026-11-17, as-of 2026-11-12, 300 runs, seed 1, 4 workers).**

- **Cost.** 2:07 in all. The 300 runs took 102 s and the re-score 18 s, for 3,100 jobs at about 25 ms each on 4 workers.
  - That covered 59 teams, 1,440 subsets in all with at most 48 for one team, 432,000 one-team scores and 4,800 replays.
  - Nothing was skipped, every target was exact, and no rescore fell back.
  - The search adds almost nothing to a run: the season alone is about 1 s per run, mostly the inexact first checkpoint.
- **Accuracy.**
  - Estimate error: mean 0.43 points, p95 2.9 and max 5.0 over 62 re-scored schedules, inside the gate's add case.
  - Regret 0 for all 177 (team, volume) pairs.
- **Recommendations.**
  - 37 teams have at least one candidate. The other 22 can't reach any simulated LAN: their fields come from the top of the lists.
  - For 22 teams the best schedule equals the rules row, and Astralis beats it by 8 points.
  - 14 come in below it. 7 of those have a "requires qualifying" event; the rest choose between overlapping events, Łódź and BLAST Open Spring.
  - Only 3 teams get more than one distinct schedule, and one recommendation drops an announced event.
- **Size.** The output is 201 KB.

**Memory.** A loaded setup holds about 2 GB, so `--workers` defaults to at most one worker per 3 GB of RAM, minus one for the main thread. On this 16 GB machine, 8 workers swapped and took 301 s for the runs; 4 workers took 102 s.

**What the comparison with the rules row means:**
- For a team whose every event is a candidate, the rules schedule is one of the subsets. There, the best schedule matches or beats the rules row.
- The rules row can still come out ahead in two cases:
  - It includes events reached through a qualifier, which the rules assume the team wins and the search leaves out.
  - It adapts per run: it takes whichever of two overlapping events invites the team, while a schedule commits to one in advance.

**Known limits:**
- Candidates come from the baseline world. A schedule that lifts a team's rank doesn't earn it extra invites to later events, and dropping an event doesn't free the team for one it declined.
- Only simulated LANs can be chosen. The volume caps count every LAN a top-40 team plays (6 / 6 / 7 over this horizon), but only 7 LANs are simulated. So today the caps rarely bind, and the low, average and high schedules usually coincide. They'll separate as the catalog simulates more events (see the roadmap's open-field attendance item).
- A dropped event leaves a hole in the bracket the team played. The re-score doesn't replay the event without it.
- Schedules are fixed sets. There's no "Łódź, or BLAST Open Spring if Łódź doesn't invite", which is what the rules row does.

## Focal planner

Planner phase 5. For one team, of any rank, it finds the schedule of LANs, online events and qualifier routes that maximizes its Major invite odds at the target snapshot. It runs on demand or in the [weekly plans](#focal-planner) workflow, not in the nightly:

```
npm run plan-schedule -- --team "100 Thieves" [--n 300] [--holdout-n 300] [--exact-n 100] [--seed 1] [--workers N]
    [--lan-cap a,b,c] [--online-cap a,b,c] [--max-options 40] [--beam 16] [--restarts 4] [--check-exhaustive] [--out <dir>]
```

It reads local files only and writes `public/data/sim/plan/<team>.json` plus `plan/index.json`. The code is in `scripts/lib/sim/plan/`.

**Options** (`options.ts`, `buildOptions`). Every not-started simulated event, LAN or online, except stand-ins:

- **`event`:** a place at the event. It needs open slots and, without a known rule, an organizer that would plausibly invite the team (`canEnter`, as in the optimizer).
- **`qualify`:** for an event with linked feeders in the team's region where it can't get a place. The team enters the feeders in date order, climbing to their own feeders (`MAX_PATH_DEPTH`), and plays the event only if it qualifies.
- **`inviteOrQualify`:** the same route where a place is also possible. It takes the place when the run offers one, else it qualifies.
- An event that feeds another isn't an option on its own.
- Announced events are locked into every schedule, and events under way that the team plays count against its caps.

**Feasibility** (`feasible`). Options holding the same event exclude each other. A qualify option holds the main event's dates whether or not the team qualifies, plus every feeder it may enter. The main event and the first feeder count against caps (`fits`). The other feeders only have to avoid clashing with other options. Caps are the team's own habit at p50 / p75 / p90 (`capsFor` with a quantile, at least 1 LAN and 2 online events) for low, average and high volume, or `--lan-cap` / `--online-cap`.

**Per run** (`planShard.ts`, `planRun`). Each run is a season run with the team on its habitual policy, then:

1. Freeze the target checkpoint.
2. Walk each option on the run's own streams, like the optimizer's replays:
   - an event played → its matches as played;
   - a place → a replay with the team in the field;
   - a qualifier route → replays of the feeders the team enters, then of the main event with the team in place of the team the feeder really sent.
3. Turn the steps into one-team ledger fragments.
4. The base ledger drops every option event the team played this run.
5. The invite cutoff is the points of the n-th eligible rival in its region, other rosters frozen, with n the region's slots.
6. Keep a slim frozen world (`slimFrozen`) per run on the worker that played it.

**Objective.** Smoothed invite odds: the mean over runs with known slots of σ((points − cutoff) / 10) (`SMOOTH_POINTS`). The hard invite rate is too flat to search on, so it's reported and used to break ties only.

**Search** (`search.ts`):

1. Options reached, entered or played in under 10% of search runs are dropped.
2. Of the rest, the `--max-options` (40) with the best gain alone are searched. On 100 Thieves, 128 options pass step 1, mostly online cups and open qualifiers with nothing to gain.
3. For each volume: greedy adds, then beam search (16 wide) with adds, removes, and swaps into options that only fit once the removed one is gone, then 4 restarts from randomized greedy starts. A score cache shares every evaluated schedule across volumes.
4. Every evaluation scores the schedule on all search runs, batched across workers. Results don't depend on the worker count.

**Selection.**

- **Hold-out re-rank:** the 50 best schedules on the search runs, plus each volume's best, are scored on separate hold-out runs. Each volume's best hold-out schedule within its caps, and runners-up, up to 8 in all, are kept.
- **Exact re-score:** those are rerun exactly on the first `--exact-n` hold-out runs. `planDelta` swaps in the replays and drops the team's matches from option events it played but didn't choose.
- **Against habitual:** the paired hold-out difference from the habitual schedule, with a 95% interval, for hard and smoothed invites.
- **Marginal value:** the hold-out loss from dropping each option.
- **Branches:** per qualifier route, the share of runs with a place outright, with a feeder entered, and qualified.
- **`--check-exhaustive`** enumerates every feasible schedule when 14 options or fewer are searched (use `--max-options 12`), and reports the search's regret per volume.

**First run (2026-11-18, 100 Thieves, as-of 2026-11-12, seed 1, 3 workers).**

- **Setup:** 134 options, 128 reached in at least 10% of search runs, 40 searched. 1 announced event. Caps (LAN / online) 4 / 6, 6 / 7 and 7 / 9.
- **Cost:** about 10 minutes in all. The 600 runs took 439 s (41,940 replays), the search 78 s (5,760 schedules) and the exact re-score 78 s.
- **Hold-out results:**

  | Schedule | Invite | vs habitual (95%) | Exact invite (100 runs) | Points |
  | --- | --- | --- | --- | --- |
  | Habitual | 54.0% | | | 1,420 |
  | Low: Cluj (invite or qualify), EPL S25 (invite or qualify), BLAST Open Spring | 77.0% | +23.0 (17.9 to 28.1) | 81.0% | 1,544 |
  | Average: Low's LANs plus eXTREMESLAND and EPIC.LAN 50 | 80.0% | +26.0 (20.9 to 31.1) | 83.0% | 1,549 |

  The high-volume schedule adds a projected Roman Imperium Cup IX, which is worth −0.3% on hold-out.
- **Biggest single option:** BLAST Open Spring, worth 13–14% invite.
- **Qualifier routes:** in the low schedule, EPL S25 is a place in 81% of runs and its ECL route qualifies 32% of the rest. Cluj qualifies 81% of entered runs. That's high (8 teams for 2 places), and Cluj's closed qualifier isn't tier 2, so the tier temperature doesn't touch it.
- **Checks:**
  - Estimate error (exact vs one-team mean points over 8 schedules): mean 0.79, p95 1.18. No inexact reruns.
  - With `--max-options 12 --check-exhaustive` (12 + 12 runs), the search's regret is 0 at every volume.
  - 1 and 2 workers give identical output.

**Plan view** (planner phase 6, `/vrs-sim?view=plan&team=…&plan=…`). It reads `plan/index.json` and the team's file, nothing per run, so it's read-only: there's no free-form picker as in the Schedules view. The view model is in `src/sim/plan.ts`.

- **Schedules table:** the season rules and announced-only baselines, then the kept schedules from the lowest volume they're best for. Each shows hold-out invite odds, the paired difference from the season rules with its 95% interval, exact odds and points.
- **Route:** the selected schedule (by default the best for average volume) in date order, announced events included. Each qualifier route shows its branches. Each option shows its marginal value, and one worth under half a point either way (`NOISE_WORTH`) reads "no measurable gain" rather than a recommendation.
- **Staleness:** a badge when the plan's as-of date is more than 8 days older than the nightly season simulation's (`PLAN_MAX_AGE_DAYS`, a weekly cadence plus a day), or it targets another Major.
- **Links:** the Schedules view and the team page link to a team's plan when `plan/index.json` lists it.

**Weekly plans** (spec Phase 8, step 7). The `Plan schedules` workflow (`.github/workflows/plan-schedules.yml`) runs Mondays at 13:00 UTC, after the nightly, and commits `public/data/sim/plan/`:

```
npm run plan-batch -- [--max 8] [--budget-minutes 240] [--min-invite 0.1] [--max-invite 0.9] [--keep-days 14] [--dry-run] [plan-schedule options]
```

- **Which teams** (`selectTeams` in `plan/batch.ts`): those whose invite is most in doubt. It reads each nightly team file's season-rules invite share, keeps those in [0.1, 0.9] (40 of 59 on 2026-11-12), orders each region by distance from 0.5, and takes them round-robin across regions up to `--max`. That share comes from the nightly's LAN-and-habit world, not the planner's: 100 Thieves is 0.33 there and 0.54 under the planner's habitual schedule, which adds online events and qualifiers.
- **Runs:** each team is its own `plan-schedule` process, so its ~2 GB setups are freed before the next. A failed team is a warning, and the batch fails only if every team does. It starts no team once the elapsed time plus the slowest team so far would pass the budget. One team took about 10 minutes locally on 3 workers; the 4-core runner isn't timed yet.
- **Pruning:** index entries generated more than `--keep-days` (14) ago are dropped with their files, so teams that leave the bubble, and plans published by hand, last two weeks. It warns when the folder is over 1 MB (about 57 KB per team).
- **Data:** the workflow restores the nightly's `data/raw` cache without saving one, and rebuilds `matchdata.json` from it. It makes no Liquipedia requests and needs no API key.
- **Options:** any option the batch doesn't own (`--n`, `--workers`, `--out`…) is passed to every `plan-schedule` run. `--out` also moves the index it prunes.
- **By hand:** `plan-schedule` for one team, without `--out`, still writes into the same folder and index.

**Tests.** `options.test.ts`, `planShard.test.ts` (qualify fragments are the feeder plus the main event when qualified, the feeder only when not; the exact delta reruns identically to a full run), `search.test.ts` (matches the exhaustive optimum on random problems with interactions, deterministic), `batch.test.ts` (selection, pruning), `slimFrozen` in `oneTeam.test.ts`; the view in `src/sim/plan.test.ts` and `SimPages.test.tsx`, which also renders every published plan.

**Known limits:**

- Options come from the habitual world. A schedule that lifts the team's rank doesn't earn it later invites, and dropping an event doesn't free it for one it declined. Invites that respond to the schedule are phase 5b.
- Rivals are frozen at the habitual run. The team's added matches move opponents only through the one-team model's seed shift.
- A dropped event leaves a hole in its bracket, as in the optimizer.
- A route counts as qualified only when the feeder really sent a team the main event's field took. Otherwise there's no place to take, and `noSlot` counts those cases.
