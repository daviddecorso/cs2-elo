# Build spec

## Overview

This is the 10 Oct 2026 build plan (`old-spec.md`) with its full content kept, updated to 5 Nov 2026. Each phase has its original plan, then **Status** with what was built, what changed and what was confirmed. Detail lives in the topic docs ([overview.md](overview.md) is the index).

Build team-level features first, then player WAR. Team Elo, tournament forecasts and VRS projections need only match results. Player WAR needs a demo pipeline and a trained win-probability model, which is several times the work.

Phase 4 could start once Phase 2's Liquipedia sync existed, because demos join to Liquipedia matches and the win-probability model uses team Elo.

Real dates: Valve published the PGL Major Singapore invitation snapshot on 2 Nov 2026, and the Major runs 25 Nov to 13 Dec 2026. FiRe Major Buenos Aires runs 31 May to 20 June 2027.

| Phase | Status |
| --- | --- |
| 0. Setup and API access | Liquipedia access working; GRID not recorded |
| 1. Reproduce Valve's standings | Built, **gate not passed** |
| 2. Team Elo | **Gate passed** |
| 3. Simulator, VRS projections, Major odds | Built and live; Singapore participants pending |
| 4. Demo pipeline | **Gate passed**; backfill in progress |
| 5. Win probability and WPA | Built, **gate not run** (needs 2025 demos) |
| 6. Player WAR | Items 1–8 built; WAA live at `/war` with provisional dry-run notice |

### Changes from the old plan

- **Stack.** Not Astro. The site is a Vite + React app deployed as a Cloudflare Worker (`wrangler.jsonc`, esports.daviddecorso.com). It reads static JSON from `public/data/`, written by the nightly `Update data` workflow. D1 isn't used.
- **Liquipedia request limits are the binding constraint.** Limits are hourly, per wiki and table, and a 429 body echoes the API key. All calls go through `scripts/lib/liquipedia/client.ts`, which fails fast and redacts the key. "Don't re-fetch history" became a three-tier store: committed `data/history/`, a raw archive, and a 190-day hot store.
- **HLTV access is a headed browser profile**, cleared by hand once, with no fingerprint spoofing, on the user's own machine under launchd.

## Phase 0: Setup and API access

Apply to Liquipedia and GRID in week 1, right after the repo goes public. Liquipedia's free tier requires open-source code, so the public repo has to exist before you apply.

1. Create a public GitHub repo (MIT) and scaffold the site from your Astro starter. Point esports.daviddecorso.com at it.
2. Write a README that names the data sources, states the site is non-commercial, and lists the features Liquipedia doesn't have: Elo, VRS projections, player WAR.
3. Apply for Liquipedia LPDB access using the [API form](https://liquipedia.net/api). Request matches, tournaments (with placements and prize distribution) and squads/transfers.
4. Apply for [GRID Open Access](https://grid.gg/open-access/).
5. Clone [Valve's VRS repo](https://github.com/ValveSoftware/counter-strike_regional_standings). No application needed, and Phase 1 runs entirely on it.

| Source | Used in | When to apply | Terms |
| --- | --- | --- | --- |
| Liquipedia LPDB | Phases 2 and 3: results, brackets, prize splits, rosters | Week 1, after the repo is public | Free only for open-source, non-commercial projects that don't replicate Liquipedia, usually time-limited. Paid fallback is $49/month per data type at 1,000 requests/hour. Attribute under CC BY-SA. |
| GRID Open Access | Phase 5, optional cross-check | Week 1 | Free for fans and pre-revenue projects. Historical official data from select CS2 events, no live feed. |
| Valve VRS repo | Phases 1 and 3 | Never | Public code, standings and match data |
| HLTV | Phase 4 demos | Never (no API) | Scrape behind bot protection; rate-limit politely |

**Hard parts**

- **Betting framing.** Liquipedia never approves betting-related projects. Present forecasts as ranking projections, with no odds formats, sportsbook links or gambling ads. Most CS stats sites monetize through gambling ads, so this rules out that revenue path.
- **Time-limited free access.** Ask for extended access as a community contribution. If it lapses, three data types on the paid plan is $147/month.
- **Don't re-fetch history.** Store every API response in your own database. Historical Elo recomputes then run against your copy, and a lapse in access doesn't take the site down.

**Status**

- Public MIT repo exists and the site is at esports.daviddecorso.com.
- Liquipedia free-plan API access is working. Terms in `AGENTS.md`: key only in `scripts/`, never `VITE_`-prefixed, CC-BY-SA credit next to Liquipedia data, API only, repo stays open source. Once a page showing Liquipedia data is live, send Liquipedia the project link.
- Valve's repo is vendored at `vendor/counter-strike_regional_standings` (model commit `eec4853`).
- History is committed in `data/history/`, so a lapse in access doesn't force a re-backfill.
- GRID isn't mentioned anywhere in the repo. It was optional and nothing depends on it.
- Not recorded: the time limit on Liquipedia's free access, and whether the nightly workflow has run end to end with the `LIQUIPEDIA_API_KEY` secret.

## Phase 1: Reproduce Valve's standings

The gate is exact: your run of Valve's code must match the published 5 Oct 2026 snapshot to the point. Then publish your own prediction of the 2 Nov snapshot before Valve does.

1. Clone the repo and run Valve's model unmodified on its own data. Diff your output against the published 5 Oct standings file for each region.
2. Pin the commit you ran. Valve changes the model between Majors, so every standings number on your site records which model version produced it.
3. Wrap the model as a function: (match data, event data, snapshot date) → standings. Phase 3 calls it thousands of times with simulated results appended.
4. Run it nightly in a scheduled job (GitHub Actions is the simplest fit) and write the output as JSON for the site.
5. Ship the first public page: current VRS by region with each roster's factor breakdown.

**Hard parts**

- **Two-stage model.** Each roster is first seeded from weighted modifiers (bounty offered, bounty collected, opponent network, LAN factor). A Glicko rating then runs over actual match results starting from that seed. Small input differences cascade through the Glicko pass, so an off-by-one match shows up as a rank change several places away.
- **Roster identity.** The model ranks five-player rosters, not organizations. A lineup keeps its identity only while at least three of its five players remain. Your player-to-roster mapping must reproduce Valve's exactly, including stand-ins.
- **Event eligibility.** Since 2025 only Valve-ranked events count. Event prize pools are capped at $1,000,000 inside the model, and rosters with no wins are dropped entirely.
- **Age weighting.** Results are scaled by how recent they are, so the same match data produces different standings on different dates. Always pass the snapshot date explicitly; never default to today.

**Status**

Built: `computeStandings` (`scripts/lib/vrs/valveModel.ts`) runs Valve's unmodified model with an explicit date on matchdata built from Liquipedia. The commit is pinned, `update-data` writes live standings with each roster's `previousRank`, and the site shows them by default. See [valve-model.md](valve-model.md), [matchdata-pipeline.md](matchdata-pipeline.md), [vrs-verification.md](vrs-verification.md).

**The gate was redefined.** Matching to the point isn't reachable from Liquipedia data, because Valve's inputs come from HLTV. The gate is now, on at least three calibrated snapshots: every published top-50 roster within ±2 ranks, mean points error under 5, and exact invite-cutoff membership in each region.

**Result: not passed.** Four snapshots are calibrated (2026-07-06 to 2026-10-05):

- Within ±2: 42–47 of 50.
- Mean points error: 6.8–57.6, against a target under 5.
- Cutoff membership: exact on 08-03 and 10-05, one Asian roster wrong on 07-06 and 09-07.

Learned along the way:

- The 180-day window ends at the latest match in Valve's pull, not midnight. Each snapshot's window end is calibrated from the age weights in Valve's details files (`calibrate-window`).
- Valve's per-roster details files are the ground truth. `diff-details` diffs matches, lineups, prizes and weights against them, and match IDs (`umid`) give exact counts of what Valve had.
- Majors must be split into stages. Valve treats each stage as its own event.
- Remaining error is systematic: tier-3 Central Asian LAN matches Valve doesn't have inflate the LAN and opponent-network references, Esports Nations Cup 2026 qualifiers are only partly covered by HLTV, and IEM Rio and Atlanta prize splits differ from Liquipedia's.
- Invite cutoffs in `src/vrs/inviteCutoffs.ts` (16/8/8) don't match what Cologne 2026 or Singapore invited.

Not recorded: whether the 2026-11-02 snapshot has been calibrated and verified, or whether a prediction was published ahead of it.

## Phase 2: Team Elo

Starts the day Liquipedia approves you. The gate: on held-out 2026 matches, your Elo beats a baseline that predicts from VRS point differences, measured by log loss.

1. **Sync.** Nightly incremental pull of matches with map-level scores, tournaments (tier, LAN or online, prize pool) and squads. Store raw responses, then normalize into tables: rosters, players, matches, maps.
2. **Entity resolution.** Key everything on player IDs. A roster is a set of five player IDs. Map Liquipedia teams to Valve's roster names once, and keep that mapping table in the repo.
3. **Map-level Elo.** Rate each map, not each series. Use round differential as margin of victory (MR12: 13-x, overtime capped), a LAN vs. online adjustment, and a per-team map offset shrunk toward zero.
4. **Roster continuity.** Carry a roster's rating forward while three of five players remain, same rule as Valve. Partial changes regress the rating toward a tier mean in proportion to players replaced.
5. **Series probabilities.** Convert map win probability into Bo1, Bo3 and Bo5 series probability. Version 1 averages over the active map pool. Version 2 models the veto.
6. **Backtest.** Same loop as your football sites: tune K, regression and margin weight on 2024-2025, then score 2026 by log loss and Brier. Publish a calibration chart on the methodology page.
7. **Ship:** team Elo rankings page with an Elo vs. VRS comparison column. Disagreement between the two is the interesting content.

**Hard parts**

- **Inter-regional calibration.** Regions mostly play themselves, so ratings drift apart between continents. International LAN results are the only bridge; weight them up and check calibration on cross-region matches separately.
- **Stand-ins.** Pre-match lineups are uncertain, and post-match Liquipedia data shows who actually played. Your CFB backtest found lineup adjustments only help with near-perfect starter information. Start without stand-in adjustments, then flag stand-in matches and down-weight them if the backtest supports it.
- **Veto modeling.** Map-pool strength drives real upsets, but a veto model needs each team's ban and pick tendencies. Liquipedia match pages usually record vetoes; confirm the field exists in the API before building on it.
- **New rosters.** A fresh roster has no history. Seed it from the average rating of its players' previous rosters, not a flat default.

**Status: gate passed.** On 8,490 2026 series where both rosters have VRS points, Elo log loss is 0.6135 against 0.6489. Cross-region is 0.6271 against 0.6505 (651 series). Calibration slope is 0.993 and ECE is 0.008. The feed has 67,857 series from 2023-10 to 2026-10, keyed on Liquipedia page names. See [elo-model.md](elo-model.md) and [elo-experiments.md](elo-experiments.md).

Where the build departs from the plan:

- **Stand-ins are up-weighted, not down-weighted.** Tuning settled on `standInK` 1.2.
- **Partial-change regression tuned to 0** for both `regress` and `newRosterRegress`. New lineages seed from the mean of their players' last lineage ratings, with unrated players at the tier mean.
- **Lineages** follow a core of the five most-seen players across org changes, so one-off stand-ins don't change identity.
- **Bo3/Bo5 needed a fix.** Maps in a series aren't independent, so `seriesMapTemp` 0.8 shrinks the map logit before converting.
- `tierGap` settled at 475 after widening its search range. Tuning is coordinate descent on 2024–2025, excluding the scale, which is redundant with K.
- **Vetoes: Liquipedia's API has none.** No veto field exists in match or map `extradata` across 11,462 stored matches. v2 is blocked; options are HLTV match pages or a map-play-share proxy, which must beat v1 first.
- Rankings page at `/elo` with VRS columns, and methodology at `/methodology`.

Open: tier 2 calibration (slope 0.54 on 377 series), hand-checking `data/elo/vrsTeamMap.json`, the veto proxy.

## Phase 3: Tournament simulator, VRS projections and Major odds

This phase joins the first two: Elo predicts each match, the simulator plays out each bracket, and Valve's code turns simulated results into projected standings. The target is an invite-odds page live before the snapshot for FiRe Major Buenos Aires (31 May to 20 June 2027). Valve hasn't announced that snapshot date; Cologne 2026's invites went out 6 April for a 2 June start, so expect early April.

**Simulator**

1. Encode each bracket format as a spec built from Liquipedia bracket data: Swiss, GSL groups, double elimination, single elimination, round robin.
2. Implement Major Swiss exactly as the rulebook sets it: three wins advance, three losses eliminate, opponents share a win-loss record, and advancement or elimination matches are Bo3 while all others are Bo1.
3. Run 10,000+ simulations per event. Output each team's probability of reaching each placement.
4. Ship tournament prediction pages. PGL Major Singapore (25 Nov to 13 Dec 2026) is the first live test if Phase 2 is ready.

**VRS projections**

1. Map each simulated placement to prize money from the event's prize distribution. The model's bounty factors run on prize money, so placements alone aren't enough.
2. For each simulation, append the simulated matches and prizes to Valve's data and run the Phase 1 function at the snapshot date.
3. Aggregate into a distribution of regional rank per roster.

**Major invite odds**

1. Apply the regional invite structure: 16 teams to Stage 1, 8 to Stage 2 and 8 to Stage 3, filled from the Europe, Americas and Asia lists.
2. Allocate Stage 3 slots by the rule: one per region for each of that region's teams that reached the previous Major's playoffs.
3. Fill invites in order (Stage 3, then 2, then 1), skipping rosters that aren't intact. A skipped slot passes to the next-ranked roster.
4. Output P(Stage 3), P(Stage 2), P(Stage 1) and P(miss) per roster.

**Hard parts**

- **Compute cost.** Valve's model runs once per simulation. If one run takes seconds, 10,000 runs per snapshot is too slow for a nightly job. Run fewer simulations for the VRS layer (around 1,000), and only re-run events whose results changed.
- **Unscheduled events.** Teams add small LAN events late to farm points. You can only simulate announced brackets, so label projections as "announced events only" and show the as-of date.
- **Stage 1 regional split.** Valve's rulebook doesn't specify how the 16 Stage 1 places divide across regions, and Liquipedia's slot map is provisional. Read the split from the current rulebook each cycle and keep it as config, never code.
- **Roster region.** A roster's region is the one most of its players represent. A single transfer can move a roster between regional lists, so recompute region from the current lineup on every run.
- **Prize data quality.** Liquipedia prize tables sometimes land after the event. Block projections for any event without a prize distribution rather than guessing.

**Status**

Built and running in the nightly job. See [simulator.md](simulator.md). Pages: `/events`, `/events/:slug`, `/major-invites`.

- All five formats are implemented. Major Swiss reproduces every Cologne 2026 pairing.
- **Rating noise:** per-event form was rejected. Ratings drift as a random walk (58 Elo² per day) from the as-of date to each event's start.
- **VRS layer:** a round trip on Cologne 2026 matches exactly (150/150 ranks) when given the event's real lineups. That's why current squads override last-played lineups.
- **Compute:** one model run takes about 0.75 s. Worker threads give about 4 runs per second, so 1,000 runs take about 4 minutes. The plan's ~1,000-run estimate for the VRS layer held.
- **Blocking:** events with no prize distribution are left out of the projection and listed with the reason.
- **Stage 1 split is still inferred, not read from the rulebook.** It's derived from Cologne 2026's results, and Singapore's 32 slots split exactly as predicted (Stage 3: EU 6 / Am 2 / Asia 0; Stage 2: EU 6 / Am 1 / Asia 1; Stage 1: EU 6 / Am 6 / Asia 4). The page flags it until `verified` is set. Buenos Aires uses an inferred rule too. The split lives in config (`data/events/invites-*.json`).
- **Buenos Aires snapshot date** is estimated at 2027-04-05 (first Monday of April).
- **Roster region** is recomputed from the projected roster on each run.

Open:

- **Singapore can't be simulated until its `invited` lists are filled** from the 2 Nov snapshot. It must be live before 25 Nov, and the Buenos Aires projection waits on it.
- `squads.json` needs a refetch (a query bug kept one player per team), so the intact-roster rule is off until then.
- Several announced events lack participants or a usable format (list in [roadmap.md](roadmap.md)).
- Whether Valve counts the IEM Cologne 2026 Germany v Betclic showmatch.

## Phase 4: Demo pipeline

The gate: one full event downloaded, parsed and stored, with every map's round count matching the official score. Start with top-tier LAN events from 2025 and 2026, then backfill.

1. **Find demos.** HLTV match pages link a demo archive per series, one demo per map. Use a headless browser (Playwright or Camoufox) with a slow, polite rate limit.
2. **Run it off Cloudflare.** Bot protection and 50 to 150 MB downloads per map rule out Workers. Run the scraper and parser on your own machine or a cheap VPS on a schedule.
3. **Match to Liquipedia.** Join each HLTV match to its Liquipedia match by team names and date, so demos inherit tier, event and roster data.
4. **Parse.** Use awpy or demoparser2 to produce tables: rounds, kills, damages, grenades, flashes, bomb events, and player snapshots every few ticks (position, health, weapon, callout name).
5. **Store.** Write Parquet to Cloudflare R2, then delete the raw demo. Parquet is a small fraction of the raw size.
6. **Validate.** Check round counts, team sides and player count per map. Quarantine any map that fails rather than fixing it by hand.

**Hard parts**

- **Player identity.** Demos identify players by SteamID; Liquipedia identifies them by page name. Build a SteamID-to-player mapping table: auto-match on in-demo names first, then hand-fix the leftovers once. This is one of the few lasting manual tables.
- **Broken demos.** Technical pauses, server restarts and replayed rounds produce duplicate or partial rounds. Rebuild rounds from round-end events, and drop restarted rounds that the official score doesn't count.
- **Parser breakage.** CS2 updates change the demo format. Pin parser versions, keep raw demos for the most recent month, and re-parse after each parser upgrade.
- **Scraper fragility.** HLTV's bot protection changes without notice. Keep the scraper isolated so a failure stops new demos without touching anything else on the site.

**Status: gate passed (22 Oct 2026).** Thunderpick World Championship 2026: 37/37 maps, with round counts, halves, sides and 5v5 matching Liquipedia. R2 holds 296 tables (78 MB Parquet from 8.2 GB raw). See [demo-pipeline.md](demo-pipeline.md).

- `demos/` is a self-contained Python project (uv) that reads Liquipedia from the local store and makes no API calls. It runs locally, outside CI, so a broken scraper stops nothing else.
- All 919 archive series have HLTV links (`backfill-hltv-links`, 2 Liquipedia requests). `cs2demos auto` runs under launchd, fed by the nightly `lan-series` artifact.
- Maps that fail validation are quarantined. A truncated multipart archive has a repair path. HLTV's RAR5 archives need `unar`.
- Schema 2 added utility counts and defuse state to `ticks` for Phase 5.
- Raw demos are pruned (`cs2demos prune`) and maps can be reparsed after parser upgrades.

Open: the 2025–2026 tier-1 LAN backfill, about 1,346 series left at 60 requests a night. Install the launchd agent and watch `cs2demos status`.

## Phase 5: Win-probability model and WPA

Replicate Xenopoulos et al. (2020) on CS2 data, then extend it. The gate: on a later-dated test set, the model matches or beats the paper's XGBoost log loss of 0.535, with a calibration curve close to the diagonal.

1. **Game states.** Build a state at each event tick: alive count, total HP, and equipment value per side; time since round start; bomb planted and site; each side's distance to each bombsite.
2. **CS2 additions.** Add defuse-kit count, remaining utility per side, and team Elo difference from Phase 2. The paper's model assumed evenly matched teams; Elo fixes that.
3. **Train.** Use XGBoost with a time-based split: train on older matches, test on newer ones. Adjacent states are highly correlated, so a random split leaks.
4. **Credit.** Value each action as the change in win probability it causes. The actor gets the change; the victim gets its negative.
5. **Extend credit beyond damage.** The paper credited damage only. Add bomb plants and defuses, flash assists (split the kill's value between flasher and killer), and trades (return part of a traded death's cost to the dead player).
6. **Two versions.** Compute WPA (leverage-weighted, clutches count heavily) and a context-neutral version that values each event at its average change for that event type and state bucket. Publish both.
7. **Validate** with the paper's tests: month-to-month correlation (WPA scored 0.40 vs. 0.29 for Rating 2.0) and correlation with K/D (0.73 vs. 0.93).

**Hard parts**

- **Calibration in rare states.** 1v4 retakes and late post-plant states have few examples, so the model is least reliable exactly where swings are largest. Check calibration by state bucket, not just overall.
- **Bomb plant attribution.** When a plant drops CT win probability, it's unclear which CTs caused it. Start with an even split among alive CTs, and mark it in the methodology as a known simplification.
- **Distance features.** Graph distance over the navigation mesh beats straight-line distance. awpy shipped navigation-mesh tooling for CS:GO; confirm current CS2 support before relying on it, and fall back to straight-line distance if needed.
- **Format shift.** CS2 runs MR12 with different economy pacing than CS:GO. Train only on CS2 data; don't port the paper's coefficients.

**Status: pipeline built, gate not run.** `wp/` (Python, uv) has nav-mesh distances, event and 4 Hz game states, the model grid, credit (WPA plus two context-neutral versions), validation and publish. See [win-probability.md](win-probability.md) and [wp-experiments.md](wp-experiments.md).

- **Gate, as defined now:** on maps after the training window (train 2025, test 2026+), log loss ≤ 0.535, every calibration bin with 1,000+ states within a noise-aware limit, and calibration slope in [0.95, 1.05]. The limit is the larger of the paper's 0.03 and a round-bootstrap p95, because states in a round share one outcome and a flat 0.03 would fail even a perfect model.
- **Not run:** 2025 has 5 of about 1,730 maps parsed. A 2026-only dry run (train H1, test H2) gets log loss 0.452 and slope 1.037 but fails the bin gate (max gap 0.077 against a 0.070 limit), and XGBoost loses to logistic regression at that data size.
- **awpy supports CS2 nav meshes** (3.1.1, release 2000934 pinned). Awpy has no bombsite polygons, so a site is the set of nav areas containing finished plants. Distances are Dijkstra path lengths over centroid distances. Coverage is 99.5–100% of positions on Thunderpick.
- **Splits:** train 2025, test 2026+, grid-search validation on the latest third of training maps. Elo parameters were tuned pre-2026, so no leakage.
- **Smoke run (Thunderpick only, not a gate result):** WPA month-to-month r 0.388 (paper 0.40) and K/D r 0.745 (paper 0.73), but Rating 2.0 was more stable (0.447), unlike the paper. HLTV Rating 3.0 and Swing were added as comparisons.
- Bomb plant attribution and the rest of the credit rules are in the win-probability doc.

Open: the full gate run after the 2025 backfill (`cs2wp train --ablations`, then `credit` and `validate`), rare-state calibration, and a site page for player WPA with the Liquipedia credit.

## Phase 6: Player WAR

Better players must make teams win more. Every modeling choice answers to that test, and any tuning that breaks it means the model is wrong. WAR is a player's output above a replacement in the same role, given the resources they received, plus a positional adjustment.

The gate has three parts. WAR-based seeding predicts teams after roster moves better than Elo averaging. Month-to-month correlation is at least 0.40. Correlation with K/D is lower than HLTV rating's.

1. **CT positions.** Take each player's most common callout 15 to 25 seconds into CT rounds. Map callouts to positions with a small table per map (Connector and Jungle become "Mirage connector", for example).
2. **T roles.** Entry = share of rounds where the player makes first contact, counting opening kills and opening deaths. AWPer = share of buy rounds holding the AWP.
3. **Validate roles** against Harry Richards' (NER0cs) positions database and the CS2 Playstyle Dataset (2024), which is built from it.
4. **Role baselines.** For each map, side and role, compute the average WPA per round. Shrink small samples toward the role mean (partial pooling) so one tournament can't dominate.
5. **Expected duels.** Model the probability of winning a duel from weapon matchup, peeker vs. holder, flashed or not, HP and distance. Kills above expected separates AWP volume from entry-rifle difficulty.
6. **IGL adjustment.** Tag IGLs, then set the positional adjustment so the average IGL lands at league average. Individual IGLs still vary around it.
7. **Replacement level.** Ship wins above average first. Add replacement level once you have tier-2 demos to define it.
8. **Uncertainty.** Bootstrap each player's rounds and show an interval next to every WAR value.

**Resources: usage and conversion**

Players get unequal shares of the team's resources. Publish two numbers per player so receiving resources is never penalized, only failing to use them.

- **Usage:** share of team resources. Equipment value and buy priority (who gets the rifle or AWP on force-buys, who receives drops), teammate flashes that blinded the player's opponent before a duel, smokes thrown within a few seconds of their fights, and how often their deaths get traded.
- **Conversion:** output per unit of resource, compared with a replacement-level player in the same role given the same resources. High usage with low conversion comes out negative.
- **Replacement baseline, never their own.** Teams give the best players the most because they convert best. Base each role's expectation on replacement-level players at that role so stars aren't penalized for being trusted.
- **Usage-efficiency tradeoff.** Conversion usually falls as usage rises, as in basketball. Treat "this team should reallocate resources" as a hypothesis to watch, never a conclusion.

**Team factor**

Compare each team's results with what its players' summed WAR predicts. The residual is the team factor: tactics, chemistry, calling, and players setting up plays for themselves.

- Teams that consistently beat their prediction carry tactical value that box-score output misses (the apEX case).
- Teams with strong individual stats that consistently fall short point to self-serving setups (the Twistzz and NiKo pattern).
- Follow the residual through roster moves to attribute part of it to individual players, the way basketball uses adjusted plus-minus. CS rosters change rarely, so shrink these estimates heavily. For IGLs, this is the only data-driven handle on calling, and it eventually replaces the fixed IGL adjustment.

**Validation: the roster-change test**

Teams with better players win more, and winning teams create better looks for their players, so plain correlations are circular. Roster moves break the circle: a player's WAR was earned on their old team, and their new team's results haven't happened yet.

1. On each roster change, seed the new roster's Elo two ways: from its players' WAR, and from Phase 2's averaging of old roster ratings.
2. Score both on the new roster's first three months of maps by log loss.
3. If WAR seeding wins, adopt it in Phase 2's roster-continuity step. If it loses, find out why before changing any weights.

The test is paired, so the roster change is the unit, not the map. Detecting a 0.01 per-map log-loss gap needs roughly 80–150 changes where every incoming player has prior demo history. As of 2026-11-06 the archive has about 13. Most incoming players have no demos from before their move, so the 2025 backfill and tier-2 coverage raise the count faster than waiting does.

**Validation: checks that don't need roster moves**

Built (`cs2wp validate-war`, results in [war.md](war.md#war-validation)):

- **Out-of-sample lineup WAR vs Elo.** Build each player's WAR from maps before an event, then predict that event's maps from the Elo logit plus the lineups' WAR difference. WAR passes if it lowers leave-one-event-out log loss. Team strength persists, so this is weaker evidence than the roster test.
- **Split-half reliability.** Correlate each player's WAR across alternating series. This gives the rounds needed for reliability 0.5, which sets the shrinkage.
- **Team-context leakage.** Correlate player WAR with team Elo, and check whether players' WAR ranks within a team hold as the team's form changes. A whole roster near the top suggests team strength is being credited to players.

Candidates, not built:

- **Movers at the player level.** For every player who changed teams, correlate WAR before and after the move. This uses the same movers as the roster test, without its three-month window or the Elo seeding step. Low correlation means WAR carries team context.
- **Interval calibration.** Check that the 90% bootstrap intervals cover the player's next-period WAR about 90% of the time, allowing for real change. Intervals that are too narrow mean round resampling ignores dependence between rounds, and resampling whole maps would fix that.
- **Comparison with known judgements.** Correlate WAR with HLTV's top-20 rankings and event MVP/EVP awards. This is a face-validity check only, since those lists reward star stats.

**Manual work that remains**

| Table | Size | Updates when |
| --- | --- | --- |
| Callout-to-position map | About 10 to 20 rows per map | A map enters the pool or is reworked |
| IGL tags | One per active roster | Roster moves |
| SteamID-to-player map | Leftovers after auto-matching | New players appear |

**Hard parts**

- **Role drift.** Players rotate positions between matches and within halves. Assign roles per map played, not per season, then aggregate.
- **IGL tags from data.** Check whether Liquipedia's squad data carries a role field. If it does, IGL tagging becomes automated and drops off the manual list.
- **Sample size.** Splitting by player, map, side and role empties cells fast. Report WAR only above a minimum round count, and let pooling do the rest.

**Status: items 1–8 built.** Baselines and WAA are on dry-run credits until the Phase 5 gate runs. The public page is live at `/war` reading static JSON `public/data/war/players.json`. See [war.md](war.md).

- **CT positions** (`cs2wp positions`): callouts map to per-map positions through `data/war/ct-positions.json`, each round votes once, and the map takes the most-voted position. On 1,312 maps the median vote share is 0.57–0.74 per map, and 0.66–0.89 of a player's maps match their usual position. Two players often share one nav area, and the table can't split them, so doubled positions stay.
- **T roles** (`cs2wp roles`): per team per map, the top AWP share (AWP in hand during buy time, on 20k+ buys) is the AWPer if it's at least 0.3, the top entry share of the rest is the Entry, and the others are Riflers. AWP share is reliable per map (0.94); entry share isn't (0.38, about 12 T rounds), so role baselines should pool it across maps.
- **Role validation** (`cs2wp validate-roles`): against NER0cs's 2024 labels (via the CS2 Playstyle Dataset), AWPer agrees on 117/120 players, with the misses being role changes since. Pooled entry share orders Spacetaker > Half-Lurker > Lurker (AUC 0.77, Spacetaker vs Lurker), and CT site share separates Anchors from Rotators (AUC 0.77).
- **Role baselines** (`cs2wp baselines`): WPA per round per map, side and role, shrunk by empirical Bayes. T roles and the CT AWPer shrink toward the role's all-map mean; CT positions toward the map's CT mean. The Entry is picked by entry share on the player's other maps, because the map's own label leaks the outcome. CT AWPers are their own role. On dry-run credits, dropping any one event moves a shrunk cell by at most 0.004 (0.046 raw), and split-half cell correlation is 0.82 (raw 0.11).
- **Expected duels** (`cs2wp duels`): every gun kill gets P(killer wins) from both players' weapon, top speed in the second before the fight (peeker vs holder), flash blindness, HP and armor, plus distance and side. It's an antisymmetric XGBoost, out of fold by event. Log loss is 0.599 against 0.661 for weapons alone, AUC 0.73, calibrated. Role gaps in raw duel win rate (CT AWPer 0.590, T Entry 0.451) are almost all expected: every role is within ±0.8 kills above expected per 100 duels.
- **IGL tags** (`cs2wp igls`): `data/war/igls.json` maps 61 teams to stint-bounded callers, covering 2,595/2,624 (98.9%) team-maps with 0 collisions. Liquipedia `squads.json` Captain role covered 77.8% with 81 misattributions across caller swaps; `players.json` had 237 collisions with 2+ career IGLs. IGL raw deficit is -0.75 WPA / 100 rds (CT -0.83, T -0.67).
- **WAA & IGL adjustment** (`cs2wp war`): centers IGLs and non-IGLs at 0.0000 / 100 rds per side (CT IGL +0.83, non-IGL -0.20; T IGL +0.67, non-IGL -0.20), preserving caller variance (huNter- +6.10, xertioN +5.62 vs apEX -2.47, karrigan -12.04). Empirical OLS gives 5.38 round-wins per map win. `--replacement-rate` hooks into linear WAR shifts.
- **Bootstrap uncertainty & publishing** (`cs2wp war --publish`): 1,000 multinomial round resamples generate 90% (p5, p95) intervals. Live at `/war` with provisional dry-run banner, client-side role/credit filters, IntervalBar, expandable details, and CC-BY-SA Liquipedia credits. WAA correlates only 0.498 with K/D (vs HLTV 3.0 at 0.880 and Rating 2.0 at 0.946).

- **Liquipedia squad data has only a free-text `role`/`position` field** (for example `Captain`). IGL tagging probably can't be fully automated; check how reliable `Captain` is first.
- Phase 4 already covers the SteamID-to-player table's auto-matching, and Phase 5's states carry the position and utility data that roles and usage need.
- The roster-change test needs Phase 5's WPA and Phase 2's lineage logic, both in place.

## Site architecture

Only the demo parser runs off Cloudflare. The nightly `Update data` workflow fetches Liquipedia, builds matchdata, publishes VRS standings, freezes history, builds Elo, fetches upcoming events and simulates. Output is static JSON in `public/data/`, deployed with `wrangler deploy`.

Local only: the demo pipeline (`demos/`), the win-probability model (`wp/`) and the Elo backfill. Training runs locally and publishes finished tables, so the site never runs a model at request time. Elo feeds the tournament simulations, and parsed demos feed model training.

## Risks and open questions

The biggest risk is Liquipedia access: Phases 2 and 3 depend on it, and free access is discretionary and usually time-limited.

| Risk | Effect | Fallback |
| --- | --- | --- |
| Liquipedia rate limit exceeded | A 429 echoes the key; repeated overruns risk losing access | Client fails fast and redacts; incremental fetch; never run fetches back to back |
| Liquipedia denies or ends free access | Phases 2 and 3 stall | Committed `data/history/`; paid plan at $49/month per data type |
| Valve changes the VRS model | Phase 1 diff breaks | Pinned commit; re-run `verify-vrs --all-calibrated` on each repo update |
| HLTV bot protection changes | No new demos | Phases 1 to 3 unaffected; WAR updates pause |
| CS2 patch breaks the demo parser | Parse failures | Pinned parser; re-parse from the last month of raw demos |
| Too few 2025 demos | Phase 5 gate can't run | Finish the backfill; the 2026-only dry run isn't a gate result |
| Inferred invite rule is wrong | Wrong Major odds | Flagged on the page until checked against the rulebook |

- [ ] When does Valve publish the FiRe Major Buenos Aires 2027 invitation snapshot date? Still unannounced; estimated 2027-04-05.
- [ ] Does Valve's repo carry prize data for events still in progress, or only completed ones? Not recorded in the docs.
- [x] Do Liquipedia's API match records include map vetoes? **No.**
- [~] Does Liquipedia's squad data include an IGL role field? Only a free-text `role`/`position` field.
- [x] Does current awpy support CS2 navigation meshes? **Yes**, awpy 3.1.1.
- [ ] Does Valve count showmatches? IEM Cologne 2026's Germany v Betclic is unresolved.
- [ ] Which Esports Nations Cup 2026 qualifier matches does Valve have?

Next steps are tracked in [roadmap.md](roadmap.md).

## Sources

- [ValveSoftware/counter-strike\_regional\_standings](https://github.com/ValveSoftware/counter-strike_regional_standings)
- [Counter-Strike Team Rankings Explained (CSDB)](https://csdb.gg/counter-strike-team-rankings/)
- [Next CS2 Major: PGL Major Singapore 2026 (Timesaver)](https://timesaver.gg/news/next-cs2-major-pgl-singapore-2026-dates-format-qualification)
- [Liquipedia API](https://liquipedia.net/api)
- [GRID Open Access](https://grid.gg/open-access/)
- Xenopoulos, Doraiswamy, Silva, "Valuing Player Actions in Counter-Strike: Global Offensive", IEEE Big Data 2020
