# Build spec

## Overview

This is the 10 Oct 2026 build plan (`old-spec.md`) with its full content kept, updated to 13 Nov 2026 (Phases 0–4 as of 5 Nov 2026). Each phase has its original plan, then **Status** with what was built, what changed and what was confirmed. Detail lives in the topic docs ([overview.md](overview.md) is the index).

Build team-level features first, then player WAR. Team Elo, tournament forecasts and VRS projections need only match results. Player WAR needs a demo pipeline and a trained win-probability model, which is several times the work.

Phase 4 could start once Phase 2's Liquipedia sync existed, because demos join to Liquipedia matches and the win-probability model uses team Elo.

Real dates: Valve published the PGL Major Singapore invitation snapshot on 2 Nov 2026, and the Major runs 25 Nov to 13 Dec 2026. FiRe Major Buenos Aires runs 31 May to 20 June 2027.

| Phase | Status |
| --- | --- |
| 0. Setup and API access | Liquipedia access working; GRID not recorded |
| 1. Reproduce Valve's standings | **Gate passed** on 3 of 5 calibrated snapshots (2026-09-07 to 2026-11-02) |
| 2. Team Elo | **Gate passed** |
| 3. Simulator, VRS projections, Major odds | Built and live; Singapore and Buenos Aires projecting |
| 4. Demo pipeline | **Gate passed**; backfill in progress |
| 5. Win probability and WPA | **Walk-forward gate passed** (2026-11-12); out-of-sample credit & monthly job built; WPA page not yet live |
| 6. Player WAR | Items 1–8 built; WAA, usage, conversion, and `vs HLTV` gap live at `/players` on `production`; team factor & APM built (`cs2wp team-factor`, gates not passed at 90% CI); roster-change test open |
| 7. Team and tactics metrics | Orders 1–2 built. Duel execution and quality (`cs2wp duel-stats`) is published as descriptive. Round stats (`cs2wp team-stats`): time-and-position value, RW over expected (economy) and adjusted T/CT are published; conversion and the player version fail persistence. Orders 3–4 built (see Status). Order 5: T-side predictability fails; clutch (`cs2wp clutch`, players and stints) and man-disadvantage conversion pass year-to-year and are published; man advantage fails |
| 8. VRS simulator and schedule optimizer | Steps 1–7 built: exact rerun and one-team model **gate passed**; invite projection on `rerun`, event impact on `/events/:slug`, season simulation and schedule optimizer in the nightly job, at `/vrs-sim`; focal-team plans for teams on the invite bubble in a weekly job, at `/vrs-sim?view=plan` |

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
- Valve's VRS repo is vendored at `vendor/counter-strike_regional_standings` (model commit `eec4853`), and Valve's rules repo (`major-supplemental-rulebook.md`, `tournament-operation-requirements.md`, `tournament-operation-requirements-exceptions.md`) is vendored at `vendor/counter-strike_rules_and_regs`.
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

**Result: gate passed (3/5 calibrated snapshots).** Five snapshots are calibrated (`2026-07-06` to `2026-11-02`), passing the gate on `2026-09-07`, `2026-10-05`, and `2026-11-02`:

- `2026-09-07` to `2026-11-02`: 50/50 within ±2, mean points error 2.45–3.38 (< 5), exact invite-cutoff membership in every region.
- `2026-07-06` and `2026-08-03`: 43–48 of 50 within ±2, mean points error 8.92–11.46 (pre-May placements aren't archived separately in `data/raw/archive/`).

Learned along the way:

- The 180-day window ends at the latest match in Valve's pull, not midnight. Each snapshot's window end is calibrated from the age weights in Valve's details files (`calibrate-window`).
- Valve's per-roster details files are the ground truth. `diff-details` diffs matches, lineups, prizes and weights against them, and match IDs (`umid`) give exact counts of what Valve had.
- Majors must be split into stages. Valve treats each stage as its own event.
- Linking qualifiers via `/placement` `qualifierpage` plus ancestor-page fallback populates `qualifiedEvents`, fixing `$0` qualifier weighting (`0.143` → `0.769`+).
- Remaining exclusions/overrides in `data/overrides.json` close the systematic gaps: IEM Cologne's Team Germany v Team Poland (Betclic) showmatch (not counted by Valve), `PARIVISION`'s missing Cologne Stage 3 lineups, untracked `Esports_Nations_Cup/2026` early rounds and `Stake_Pulse` / `RLG/RES` qualifiers, Central Asian `matchlist` group stages (`FRAG.gg`, `BRO_*`, `CYBERLAND_Cup`), IEM Rio/Atlanta ESL prize splits, and post-Oct-5 team rebrands (`PVISION`, `GOSH`, `The One`, `BB Team`).
- Invite cutoffs in `src/vrs/inviteCutoffs.ts` now follow `major-supplemental-rulebook.md` via `cutoffsForSnapshot` (`16/10/6` pre-Cologne 2026, `18/9/5` post-Cologne 2026).

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

Built and running in the nightly job. See [simulator.md](simulator.md). Pages: `/events`, `/events/:slug`, `/major`.

- All five formats are implemented. Major Swiss reproduces every Cologne 2026 pairing.
- **Rating noise:** per-event form was rejected. Ratings drift as a random walk (58 Elo² per day) from the as-of date to each event's start.
- **VRS layer:** a round trip on Cologne 2026 matches exactly (150/150 ranks) when given the event's real lineups. That's why current squads override last-played lineups.
- **Compute:** one model run takes about 0.75 s. Worker threads give about 4 runs per second, so 1,000 runs take about 4 minutes. The plan's ~1,000-run estimate for the VRS layer held.
- **Blocking:** events with no prize distribution are left out of the projection and listed with the reason.
- **Major invite split is verified against Valve's rulebook** (`vendor/counter-strike_rules_and_regs/major-supplemental-rulebook.md`): Stage 1 is fixed at EU 6 / Am 6 / Asia 4 (16 total), Stage 2 follows previous-Major Stage 3 regions (8 total), Stage 3 follows previous-Major Playoff regions (8 total), and `minRetained: 3` matches the Core Lineup rule.
- **3-month regional lock:** rosters that appeared on another region's VRS list in the preceding 3 calendar months are skipped by `allocateInvites` unless exempted in `regionExceptions` (e.g., `BC.Game` at Singapore 2026 per `tournament-operation-requirements-exceptions.md`).
- **Buenos Aires snapshot date** is estimated at 2027-04-05 (first Monday of April).
- **Roster region** is recomputed from the projected roster on each run.

Open:

- Several announced events lack participants or a usable format (list in [roadmap.md](roadmap.md)).

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

**Production decisions (November 2026)**

The fixed 2025-train, 2026-test split failed calibration narrowly (worst bin 0.045 against a 0.043 limit, log loss 0.4519, slope 1.042) because CT round win rate drifted from 50.9% in 2025 to 53.7% in 2026 (a within-map shift starting mid-2025). The model was fine; the data moved.

- **Gate by walk-forward.** Retrain monthly on all prior data, test on each 2026 month, and gate on the pooled predictions. Current `production` result (`full_plant_clock_bomb_dist`, 2026-11-12, 11.0M states across 2026-01 to 2026-10): log loss **0.4483** against the paper's 0.535, worst bin **0.038** (`0.0376`) against a **0.039** (`0.0387`) limit, slope **1.026** (`1.0265`).
- **Recency weighting.** Mild exponential decay over `HALF_LIVES = (365, 180, 90)` days, tuned on the 90-day in-window validation fold only, never on test months. Most folds (6 of 10 test months) picked a 365-day half-life (3 picked 180, 1 picked 90); `None` (no decay) was dropped on 2026-11-12 so near-tied validation scores can't revert 2026 folds to unweighted early-2025 data.
- **Feature promotion rule.** Promote a feature if it lowers log loss by > 0.001, or if log loss is non-worse within the base's 95% round-bootstrap confidence interval and calibration improves in at least one flagged bucket without worsening any other flagged bucket. Log loss is dominated by common states, while WPA credit depends on rare post-plant states where swings are largest. Adopted so far: `since_plant` (seconds since plant) and `ct_bomb_graph` (CT graph distance to the planted bomb).
- **5v4 post-plant diagnostic and `defuse_margin` (rejected).** The 5v4 post-plant miss (0.309 predicted vs. 0.375 observed, 405 rounds) sits in the first 20 seconds after the plant and grows with defuse kits (CT under-predicted by 13 points with 2 kits, 22 with 3 or more). `defuse_margin` (bomb time remaining minus the fastest possible defuse among alive CTs: graph travel time plus 5 seconds with a kit, 10 without) was tested and **rejected** on 2026-11-12: log loss moved −0.0002 inside the CI, max bin gap hit 0.040 vs. 0.039 (fail), and both 5v3 and 5v4 remained flagged. Next candidate to try: a `kits × CTs alive` or `kits × time left` interaction.
- **Out-of-sample crediting.** Credit 2026+ maps with their month's walk-forward fold (`production/folds/<YYYY-MM>@<sha8>`) and 2025 maps with a cross-fit model trained on every other month (`cs2wp cross-fit`). Store `model_version` on every credit row, and keep credits frozen unless a deliberate `cs2wp credit --recredit` runs. The current month's recency-weighted fold (`index["live"]`, trained on all prior data) is the live model for new maps. A fourth credit version (`wpa_opp`, evaluating each event with the player's own team at league-average Elo) was added alongside `wpa`, `nwpa_event` and `nwpa_mancount`.
- **Conservation.** Event credits do not sum to the round outcome (`ct_win − p0 = events + drift + end`), because drift between events (time passing, movement) takes back about 0.076 per round (`events` +0.074, `drift` −0.076) that nobody is credited for. CT players gain about 0.07 per round from events that T players only lose through uncredited drift. Keep WPA as the paper defines it — spreading drift across alive players would reward surviving, the KAST problem. WAR/WAA's per-map, per-side, per-role baselines cancel the offset, so check that WAR/WAA summed by map and side is near zero after baselines. Publish drift per team (`data/wp/reports/team_drift.parquet`) as time-and-position value, and never publish raw WPA comparisons across sides.
- **Monitoring.** A monthly job (`cs2wp monthly`) trains the new month's live fold and gates the previous month (2026-10 passed on 2026-11-12 at 0.080 vs. 0.096 limit across 5,014 rounds). Calibration is read by map, buy type and Elo gap, not just by man count. Patch candidates come from Valve's Steam News feed (`cs2wp patch-candidates` → `wp/patches.candidates.json`) and are approved by hand into `wp/patches.json`. Economy patches enable a weekly logistic intercept correction for 31 days, and mechanics patches get a before-and-after post-plant calibration check (`cs2wp patch-report`).

**Status: walk-forward gate passed (2026-11-12).** `wp/` (Python, uv) has nav-mesh distances, event and 4 Hz game states, regularized XGBoost with monotone constraints, walk-forward and cross-fit training, out-of-sample credit (`wpa`, `wpa_opp`, `nwpa_event`, `nwpa_mancount`), conservation checks, validation and publish. See [win-probability.md](win-probability.md) and [wp-experiments.md](wp-experiments.md).

- **Gate, as defined now:** on out-of-sample predictions, log loss ≤ 0.535, every calibration bin with 1,000+ states within `max(0.03, p95 round-bootstrap noise)`, and calibration slope in [0.95, 1.05].
- **awpy supports CS2 nav meshes** (3.1.1, release 2000934 pinned). Awpy has no bombsite polygons, so a site is the set of nav areas containing finished plants. Distances are Dijkstra path lengths over centroid distances; coverage averages 99.88% across 3,015+ maps (and `de_contact` showmatch without a mesh is skipped).
- **Validation (2026 window, 1,404 maps, 192 players with 300+ rounds):** WPA month-to-month `r = 0.439` (paper 0.40) and `r = 0.818` with K/D (paper 0.73), compared with approximate Rating 2.0 (`0.466` / `0.945`) and HLTV Rating 3.0 (`0.448` / `0.877`).

Open: schedule `cs2wp monthly` under launchd, populate `wp/patches.json` with verified economy patch dates, test `kits × CTs alive` / `kits × bomb time` for the 5v4 post-plant miss, and ship a site page for player WPA (with Liquipedia credit, link sent to Liquipedia, and HLTV-demo publishing terms checked).

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

**Validation beyond roster moves**

Roster changes are too rare, and they bundle role changes together, so add tests that fire more often:

- **WAR plus Elo only where Elo is stale.** On a roster that has played together for six months, summed WAR and Elo measure the same thing, so WAR cannot add anything. Test only new rosters, stand-ins and the weeks after a break, and measure how many maps each method needs before its predictions settle. *(Not yet split out separately from the all-maps `validate-war` check below.)*
- **Stand-ins.** They happen far more often than transfers and isolate one player. Predicted drop equals the starter's WAR minus the stand-in's. *(Not built.)*
- **Role-transition cost.** Players change roles after moves, so measure the average WAR drop in a player's first maps in a new role. For prediction, use each player's history in the role they will actually play. *(Not built.)*
- **Split-half reliability.** WAR on odd maps (or alternating series) against WAR on even maps. If it disagrees with itself, it cannot predict anything. *(Built in `cs2wp validate-war` across alternating series.)*
- **IGL changes.** When an IGL arrives or leaves, measure the shift in their teammates' role-adjusted WAR and conversion, and compare it with the shift after non-IGL roster changes. If teammates consistently improve under certain IGLs, that is the closest data-driven measure of IGL impact. If it is noise, the honest conclusion is that IGLs make teams better. *(Not built.)*
- **HLTV as a check and a baseline.** Compute approximate Rating 2.0 from parsed demos (since HLTV now displays Rating 3.0 and Swing, which are parsed from cached HLTV match pages for the same maps); agreement confirms kill, death, damage and KAST parsing. Use HLTV rating seeding as a second baseline in the roster-change test. Publish the per-player gap between WAR and HLTV 3.0 (`z(WAA/100) − z(HLTV 3.0)` with 90% intervals, live as `vs HLTV` on `/war`) to surface role and resource context.
- **Descriptive is a legitimate goal.** HLTV rating is useful without predicting games better than Elo. WAR can ship as a descriptive stat if it passes split-half reliability and sense checks (support anchors rise, high-usage low-conversion players fall). Its opponent adjustment comes from the Elo difference in the win-probability model, with no top-15 filter.

Built (`cs2wp validate-war`, results in [war.md](war.md#war-validation)):

- **Out-of-sample lineup WAR vs Elo.** Build each player's WAR from maps before an event, then predict that event's maps from the Elo logit plus the lineups' WAR difference. On 1,161 test maps from 2026-03-01, no WAA variant or box-score comparator (HLTV 3.0, K−D) improves leave-one-event-out log loss over Elo alone (gains −0.0002 to −0.0011, 90% CIs straddling or below zero). `wpa_opp` (evaluating each event with the player's own team at league-average Elo) was added to remove plain WPA's under-crediting of stars on strong teams and is the most reliable WAA variant (`k = 984` rounds).
- **Split-half reliability.** Correlate each player's WAA across alternating series (267 players with 300+ rounds): half-split `r = 0.312` (`k = 1,852` rounds for reliability 0.5) for plain WPA WAA and `0.461` (`k = 984`) for `wpa_opp`, vs. `0.538` (`k = 702`) for HLTV 3.0.
- **Team-context leakage.** Correlate player stint WAA with team Elo and check whether within-team ranks hold as team form changes (310 stints). Plain WPA WAA has low team share (`0.089`, `r = 0.076` with team Elo), neutral-event WAA carries heavy team context (`0.381`, `r = 0.495`), and `wpa_opp` sits in between (`0.263`, `r = 0.449`, matching HLTV 3.0's `0.179` / `0.306`).

Candidates, not built:

- **Movers at the player level.** For every player who changed teams, correlate WAR before and after the move. This uses the same movers as the roster test, without its three-month window or the Elo seeding step. Low correlation means WAR carries team context.
- **Interval calibration.** *(Done 2026-11-23, in `cs2wp validate-war`.)* The `wpa_opp` round-bootstrap intervals cover 90% between alternating-series halves and 87% across periods, and whole-map resampling gives the same, so the bootstrap stays per round ([war.md](war.md#interval-calibration)).
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

**Status: items 1–8 built; WAA live at `/players` (with a page per player) on `production`.** The public page reads `public/data/war/players.json` (`model: "production"`, `provisional: false`, 3,112 maps across 53 events, 267 players with 300+ rounds). See [war.md](war.md).

- **CT positions** (`cs2wp positions`): callouts map to per-map positions through `data/war/ct-positions.json`, each round votes once, and the map takes the most-voted position. Across 3,113 maps the median vote share is 0.55–0.89 per map (Inferno 0.55 and Ancient 0.56 sit below 0.60), and 0.64–0.90 of a player's maps match their usual position. Gated `(x, y)` KMeans clustering across 22 doubled positions passed Gates 1–3 on `de_dust2` `B` (`B Doors` vs `B Tunnels`: pair sep `0.701`, `+0.207` lift, `2.26 SE` / `2.44 SE`, split-half `r = 0.982`, `wpa_opp` `k = 984`), committed in `data/war/ct-subpositions.json` and enabled by default in `baselines`; the other 21 candidates missed Gate 1 and stay unsplit.
- **T roles** (`cs2wp roles`): per team per map, the top AWP share (AWP in hand during buy time, on 20k+ buys) is the AWPer if it's at least 0.3, the top entry share of the rest is the Entry, and the others are Riflers. AWP share is reliable per map; entry share isn't, so role baselines pool it across maps.
- **Role validation** (`cs2wp validate-roles`): against NER0cs's 2024 labels (via the CS2 Playstyle Dataset), AWPer agrees on 159/160 players (the one miss is FalleN, who moved off the AWP). Pooled entry share orders Spacetaker > Half-Lurker > Lurker (AUC 0.83, Spacetaker vs Lurker; `r = 0.77` with 2024 opening-attempt rate), and CT site share separates Anchors from Rotators (AUC 0.79).
- **Role baselines** (`cs2wp baselines`): WPA per round per map, side and role, shrunk by empirical Bayes across all four credit versions (`wpa`, `wpa_opp`, `nwpa_event`, `nwpa_mancount`). T roles and the CT AWPer shrink toward the role's all-map mean; CT positions toward the map's CT mean. The Entry is picked by entry share on the player's other maps, because the map's own label leaks the outcome. CT AWPers are their own role. Dropping any one of 53 events moves a shrunk cell by at most 0.0017 (0.0251 raw), and split-half cell correlation is 0.98 (raw 0.73).
- **Expected duels** (`cs2wp duels`): 437,356 gun kills across 3,123 maps (55 events) get P(killer wins) from both players' weapon, top speed in the second before the fight (peeker vs holder), flash blindness, HP and armor, plus distance and side. Antisymmetric XGBoost, out of fold by event: log loss 0.6050 against 0.6626 for weapons alone, AUC 0.726, slope 0.995. Role gaps in raw duel win rate (CT AWPer 0.583, T Entry 0.459) are almost all expected: every role is within ±0.8 kills above expected per 100 duels. Smoke support was tested and rejected (+0.00003 log-loss gain, 90% CI −0.00001 to +0.00008); teammates' flashes on the opponent are worth 4,504 kills (0.67 per 100 player-rounds).
- **IGL tags** (`cs2wp igls`): `data/war/igls.json` maps 82 teams to stint-bounded callers, covering 6,164/6,224 (99.0%) team-maps with 0 collisions. Liquipedia `squads.json` `Captain` covered 58.4% (with mismatches across mid-year caller swaps); `players.json` had 1,008 team-maps with 2+ career IGLs sharing a lineup. IGL raw deficit is −0.83 WPA / 100 rds (CT −0.82, T −0.84).
- **WAA & IGL adjustment** (`cs2wp war`): centers IGLs and non-IGLs at 0.0000 / 100 rds per side (CT IGL +0.82, non-IGL −0.21; T IGL +0.84, non-IGL −0.23), preserving caller variance (bLitz +8.13, huNter +7.71 vs FalleN −6.84, karrigan −22.37). Empirical OLS gives 5.68 round-wins per map win. `--replacement-rate` hooks into linear WAR shifts.
- **Bootstrap uncertainty & publishing** (`cs2wp war --publish`): 1,000 multinomial round resamples generate 90% (p5, p95) intervals. Live at `/players` as one rating, `wpa_opp` shrunk by sample size ([war.md](war.md#shrinkage)), with role filters, `vs HLTV` gap column (`z(WAA/100) − z(HLTV 3.0)`), IntervalBar, expandable details, and CC-BY-SA Liquipedia credits. WAA (WPA) correlates 0.467 with K/D (vs HLTV 3.0 at 0.870 and Rating 2.0 at 0.945), split-half `r = 0.312` (Spearman-Brown 0.476), and 300+-round month-to-month `r = 0.401`.
- **Resources: usage and conversion** (`cs2wp usage`): each player-round's credit above the role baseline splits exactly into team context, usage (the player's own equipment, gun, utility and inferred drops, valued by a cross-fit model) and conversion. Conversion's split-half `k` is 1,042 rounds against 984 for `wpa_opp` WAA, so it shipped to `/war` with 90% intervals. Usage is a stable role trait (`k` 94). Flash, smoke and trade support are reported beside the split, not in it. Details in [war.md](war.md#resources-usage-and-conversion).
- **Team factor & APM (`cs2wp team-factor`, gates not passed):** out-of-sample `wpa_opp` expectation residuals, Ridge team factors (`lp_team × IGL stint`), sparse player/calling APM (`--igl-adjustment apm`), and Stage 1–2 validation built, staying off `/war` and behind the `fixed` default until 90% CIs clear zero (see [war.md](war.md#team-factor)).
- **Not yet built:** replacement-level baseline from tier-2 demos, roster-change Elo-seeding test, stand-in and role-transition checks, and IGL-change teammate deltas.

## Phase 7: Team and tactics metrics

Every round outcome splits into four layers: economy and map, duel execution (aim), duel selection (tactics), and leftover (luck and what cannot be measured). Each stat below isolates one layer. The gate for publishing any of them: it passes split-half reliability and adds information beyond Elo, or it ships labeled as descriptive.

| Stat | What it measures | Test before publishing | Order |
| --- | --- | --- | --- |
| Duel execution | Actual duel wins minus expected; individual aim | Split-half reliability | 1 |
| Duel quality | Average expected win probability of the duels a team takes; tactics | Stability; independence from execution | 1 |
| Time-and-position value | Win probability a team gains from positioning and time between events | Descriptive | 2 |
| Round wins over expected, economy version | Overall strength from map, side and both buys, with no Elo in the expectation | Descriptive | 2 |
| Round wins over expected, player version | Team factor: expectation from prior-window summed WAR | Residual persists across windows | 2 |
| Round conversion over duel expectation | Rounds won beyond what duels predict: trades, timing, post-plant setups | Persistence | 2 |
| Adjusted T and CT win rate | Ridge-adjusted offense and defense ratings, controlling for map, opponent and economy | Beats raw T win rate at predicting rounds | 2 |
| Luck-adjusted Elo | Elo updated on a blend of actual and expected margin | Walk-forward log loss; hot-hand check | 3 |
| Veto value lost | Decision quality at each veto step | Persistence; hidden-information test | 3 |
| Execute success and post-plant conversion | Structure on T side | Noise check by season | 4 |
| Map control | Territory share at 30, 45 and 60 seconds | Adds beyond WAR? | 4 |
| Numbers at contact | Defenders present at first contact, against the map-and-site baseline | Signal in modern CT play? | 4 |
| T-side predictability | Spread of site choices, timings and executes, given economy | Correlates with underperforming prepared opponents | 5 |
| Clutch and man-advantage conversion | Wins in XvY states over expected | Year-to-year stability, otherwise label as fun | 5 |

**Definitions that need detail**

- **Round wins over expected, two versions.** The economy version measures overall strength, skill plus tactics. The player version uses summed out-of-sample `wpa_opp` WAR as the strength term (`cs2wp team-factor`), so the residual is the team factor. Neither includes team Elo, because Elo absorbs whatever tactics produce and the stat would drift to zero. Stage 1 split-half reliability across alternating series currently yields `r = 0.239` (90% CI `-0.017` to `+0.467`), so it stays gated behind more demo coverage.
- **Luck-adjusted Elo.** Re-score each map with every duel credited at its expected win probability instead of its outcome, sum per team into an expected round margin, and feed the Elo update a weighted blend of actual and expected margin. Tune the weight with the football-site backtest loop. Check whether a player's duel results above expectation carry from one map to the next within an event: if they do, part of the residual is form, and actual results deserve more weight. Expected goals predicts future results better than actual goals in hockey; this is the same idea for CS.
- **Veto value lost.** At each veto step, compute the team's series win probability for every option still available using map-specific Elo, then take the best option's probability minus the chosen option's. Sum per team per season. Judge by expected value at the time, never by results. Separately, test hidden information: if below-model picks keep beating map Elo, the team knows something the model does not.
- **Execute detection.** Three or more Ts entering a site within a few seconds with utility thrown into it. Measure site take success and post-plant conversion, controlling for economy and Elo.
- **Numbers at contact.** At first contact on the site Ts actually hit, count defenders against the average for that map and site. Normalizing per map and site handles maps where retake is the norm.

**Hard parts**

- **Skill versus tactics.** Each stat is only a tactics signal after player skill is removed. Tie it to the duel models, or it rediscovers Elo.
- **Elo circularity.** Keep team Elo out of any expectation that is supposed to measure what Elo itself absorbs.
- **Thin sample.** Each month has about 100 to 240 maps, so monthly limits are wide. Prefer season-level aggregates, and shrink small samples.
- **Modern CT play.** CTs push for information far more than in 2015 to 2018, so numbers at contact and map control may carry little signal. Build them cheaply and drop them if they are noise.
- **Luck adjustment mechanics.** Rounds chain, so a proper expected-outcome simulation is hard. The expected-margin version avoids it. Build it after duel execution exists.
- **Veto data.** Map Elo for rarely played maps is thin, which is often why a team permabans a map. Shrink those estimates hard, or the model will recommend maps teams never practice. Coaches share veto decisions, so label the stat a team decision, not pure IGL.
- **Clutch noise.** In most sports clutch is mostly noise. Check stability before publishing.

**Status: orders 1 to 5 built.**

Order 1 is `cs2wp duel-stats` ([war.md](war.md#duel-execution-and-quality)). It scores duel execution (`win − p`) and duel quality (`p − p_base`, split into positioning, flash and HP parts) per player and per team. Player execution passes its gate. Team quality passes stability and independence, but no team stat adds to Elo, so all are descriptive.

Order 2 is `cs2wp team-stats` ([war.md](war.md#team-round-stats)), with stints as the unit:

- **Time-and-position value and RW over expected (economy)** pass split-half and are published as descriptive. The economy version is r 0.93 with Elo. Time-and-position value inherits Elo through the WP model's drift (r −0.48).
- **Adjusted T and CT ratings** beat raw win rates walk-forward: +0.00023 log loss per round, 90% CI +0.00008 to +0.00039. They are published as descriptive.
- **Round conversion over duels** passes split-half (0.32) but fails quarter-to-quarter persistence (0.065, CI −0.066 to 0.194). It does pass by `lp_team` (0.162).
- **The player version** (team factor) fails both tests.

Conversion and the player version stay off the site until more archive accumulates.

Order 3 ([war.md](war.md#luck-adjusted-elo)):

- **Luck-adjusted Elo** (`cs2wp luck`, `backtest-elo --luck`) fails. 2026 treated series lose 0.0010 log loss at the tuned w = 0.2 (90% CI −0.0037 to +0.0019). The hot-hand check finds no form between series, but duel execution is mostly skill, so discounting it costs Elo real signal. `luckWeight` stays 0.
- **Veto value lost** (`cs2wp veto`) has its own map model. It beats Elo's series-start map probability on all 2026 maps (+0.0009, CI +0.0005 to +0.0013), but not within the CI on vetoed series alone. Value lost persists: stint split-half r 0.64, quarter r 0.50. The hidden-information slope is −0.98 (CI −2.65 to +0.84), so nothing suggests teams know better. It's unpublished until HLTV's terms are checked.

Order 4 is `cs2wp tactics` ([war.md](war.md#tactics-stats)). Its expectations use economy and men alive only. The execute row asks to control for Elo, but that breaks the Elo-circularity rule, so Elo is left out.

- **Post-plant conversion** passes split-half and season persistence (T r 0.37). It's published as descriptive.
- **Numbers at contact** passes split-half (0.35), and the defender excess predicts rounds beyond economy. It's published as descriptive.
- **Map control** is reliable at 30 and 45 s but adds nothing beyond WAR, so it isn't published.
- **Execute success** is noise on the T side (split-half 0.03). Defending executes is stable (CT split-half 0.50).

Order 5 ([war.md](war.md#t-side-predictability)):

- **T-side predictability** (`cs2wp predictability`) fails.
  - A scout using a team's own earlier T rounds (site, timing and execute, given map and buy) does no better than the league prior: −0.006 nats per round.
  - Stint split-half is 0.10 (CI −0.15 to 0.34).
  - With prepared defined as a rematch within 60 days, the predictability × prepared interaction has the wrong sign and no gain over Elo: −0.0006 (CI −0.0014 to +0.0002).
  - Bo3+ can't serve as the proxy because 94% of demo maps are multi-map series.
- **Clutch and man-advantage conversion** (`cs2wp clutch`) uses entries valued with the out-of-sample WP fold at even Elo, centred per X v Y.
  - Clutch passes year-to-year for players (r 0.15), stints (0.27) and teams (0.25), and barely tracks Elo (0.13–0.21).
  - Man disadvantage passes (stint r 0.36), but it's mostly strength (r 0.70 with Elo).
  - Man advantage fails (stint r 0.26, CI from −0.09).
  - Passing classes are published: stints on the Tactics tab, players on `/players`.

## Phase 8: VRS simulator and schedule optimizer

Three features on top of the Phase 3 simulator:

1. **Event impact.** For an active or confirmed event, how many VRS points each team gains or loses at each placement (if Vitality win, how many points do they likely gain?).
2. **Season projection.** Upcoming LANs and who attends them, played out with Elo, giving projected standings at each VRS publication date up to the next Major invite snapshot.
3. **Schedule optimizer.** Teams choose which events to attend. For each team, find the schedule that maximizes expected VRS points, or that maximizes its Major invite odds, at low, average and high volume. A low-Elo team may do best at events with good prize pools and weaker fields; a high-Elo team at the events with the biggest prize pools and best-ranked opponents.

Two things make this hard:

- **Cost.** One full run of Valve's model takes about 0.8 s. Nearly all of it is loading (JSON, filters, roster linking); seeding and the Glicko pass take about 6 ms. Even so, 9M schedule scores can't each be a rerun.
- **Unknown futures.** Many upcoming events have no field, bracket or prize table yet.

**Decisions**

- Score what-ifs with exact incremental reruns of Valve's model (load a window once, about 25 ms per rerun) for standings and invite projections. Event impact takes one rerun per checkpoint and run, then removes each team's event with the one-team model (the gate's remove case, mean error 0.65 points). The optimizer searches with the one-team model and re-scores its recommended schedules with reruns.
- Cover all LANs. Events without a hand-written config get a generic format, marked as assumed.
- Precompute nightly, plus a build-your-own schedule picker on the site.

**Reused from Phase 3:** `runEvent` and `simulateEvents` (`scripts/lib/sim/simulate.ts`), `Predictor` with shared rating drift (`predict.ts`), `simulationDelta`, `applyDelta`, `latestLineups`, `preferSquads` and `prizeTable` (`vrsProjection.ts`), `projectOnce` and the worker pool (`vrsPool.ts`, `vrsWorker.ts`; step 2 moves `projectOnce` onto one `loadWorld` per worker), `allocateInvites`, `makeIntactCheck` and `makeRegionEligibleCheck` (`invites.ts`), `cutoffsForSnapshot` (`src/vrs/inviteCutoffs.ts`). Liquipedia placement rows already list announced teams and each slot's source in `qualifier` (PGL Łódź 2027: `VRS Global (Dec. 2026)` × 14, `Closed Qualifier` × 2), and `participants.ts` already reads them.

### 1. Fast what-if scoring

Built first; everything else depends on it. Details and results are in [vrs-simulator.md](vrs-simulator.md).

- **Exact rerun** (`scripts/lib/vrs/valveWorld.ts`). `loadWorld` loads a window once. `rerun(world, delta)` adds matches, replaces events or excludes matches, then replays Valve's own seeding, Glicko and ranking code. The output is identical to `computeStandings` on the combined input. Each rerun checks every match side against Valve's roster-linking rule, and returns `exact: false` when a delta would relink rosters; callers then fall back to a full run.
- **One-team model** (`scripts/lib/vrs/oneTeam.ts`, no Node imports). `freeze` a rerun's state, then `scoreTeam(world, ledger)` re-derives one roster's points with Valve's formulas while other rosters stay frozen. It corrects for the moved 5th-highest references, re-derives the top seeds and shifts opponents' ratings with the seed range. It's exact on an unchanged ledger.
- **Gate** (`npm run backtest-vrs-whatif`). Reruns must match full runs. The one-team model's mean error must be ≤ 5 points and p95 ≤ 15, separately for removing played events and for adding replayed future ones. Mean schedule regret must be ≤ 5.

### 2. Event catalog

- `EventConfig` (`scripts/lib/sim/config.ts`) gains optional fields:
  - `location: { region, country }` from the tournament row's `locations`;
  - `invites: { slots: [{ list, month, count, startRank? }], qualifiers: [{ label, count }], verified }`;
  - `prizeEstimate` (label → USD) for events with no Liquipedia prize table;
  - `assumed: string[]` naming what was guessed (`format`, `prizes`, `field`).
- `scripts/lib/sim/catalog.ts`:
  - `inviteRuleFromPlacements(rows)` parses the `qualifier` strings into `invites`. A hand-keyed `invites` in the config wins.
  - `genericEvent(tournamentRow, placementRows)` builds a config for each unconfigured offline tournament in `upcoming.tournaments` that isn't a qualifier or showmatch: 4 or 8 teams single elimination, 16 double elimination, Bo3. Team counts with no template are listed on the calendar but not simulated.
  - A missing prize table uses a standard split by placement, fit once from finished events of the same tier in `data/raw/placements.json`.
- `fetchUpcoming` also takes the generic LAN parent pages, so their `/placement` and `/match` rows are fetched. About 45 pages today: one more batch of 50, so 5 requests per nightly run instead of 3. Capped at 100 pages.
- The Major invite projection keeps its "announced only, never guessed" rule. Assumed data is used only by the new season outputs, and is labelled there.

### 3. Season simulation

`scripts/lib/sim/season.ts`. Each checkpoint's base world (real matches only) is loaded once with `loadWorld` and shared by every run, since only the simulated matches differ. Per run, in date order:

1. Draw rating paths once (`Predictor.resample`), with the run's RNG seeded from `(seed, run)` so paths can be regenerated.
2. Checkpoints are the VRS publication dates (first Monday of each month, or the real `invitation/` list once published) through the next Major invite snapshot (`invites-*.json`, currently 2027-04-05, estimated).
3. Between checkpoints, play every event whose field is resolved (`runEvent`) and append its matches and prize table (`simulationDelta`).
4. At each checkpoint, `rerun` that checkpoint's world with the run's simulated matches so far and `freeze` the state once (impact and the optimizer read the frozen world), then resolve the field of each event that invites from that list (`scripts/lib/sim/attendance.ts`):
   - Announced teams are fixed.
   - Open direct-invite slots walk the list in rank order under the Tournament Operation Requirements: start rank, sequential, pass down on decline, and Tier 2 invites only below global rank 12.
   - A team declines when the event conflicts with one it's already in (see travel buffers below) or it's over the average-volume cap.
   - Qualifier slots take the best-ranked remaining teams from the qualifier's region, marked `assumed: field`.
   - Seeds follow list rank.
5. For each candidate (team, event) pair where the team isn't in the field, replay the event once with the team added under the same rating path, and keep only that team's matches and placement.

Cost: 6 world loads (about 0.4 s each) plus 300 runs × about 6 checkpoints × (25 ms rerun + one `freeze`, measured in step 2) is about a minute on one thread; the rare inexact rerun falls back to a full run, and the count is reported. `--season-n` sets the run count.

### 4. Outputs

`npm run simulate-season` (`scripts/simulate-season.ts`) writes `public/data/sim/season/`:

- **`index.json`**: as-of date, target date, run count, checkpoints, volume baselines, the one-team gate numbers, and the calendar: each event's dates, location, tier, prize pool, `assumed` flags and field (team, attendance probability, source: announced, VRS invite or qualifier).
- **`standings.json`** (feature 2): per checkpoint and roster, points and global and regional rank at p10 / p50 / p90, beside today's points.
- **`impact/<slug>.json`** (feature 1): per team and placement, the probability and the mean points change at the first checkpoint after the event. The change is the team's points in that checkpoint's rerun minus `scoreTeam(frozen, withoutEvents(ledger, event))` in the same run, split into starting-value and head-to-head parts from `scoreTeam`'s seed value. That's one rerun per checkpoint and run rather than two per team: exact per-team reruns would cost about 50 CPU-minutes a night (~25 LANs × 16 teams × 300 runs). `index.json` carries the remove-case gate numbers beside it. Placements reached in under 20 runs are marked low-confidence.
- **`teams/<team>.json`** (feature 3), for the top 60 global rosters:
  - candidate events: announced for the team, or with open direct-invite slots its projected rank reaches in at least 10% of runs. Events it could only reach through a qualifier are listed separately as "requires qualifying";
  - recommended schedules for low, average and high volume × two goals: maximize expected points at the target date, and maximize Major invite probability (ties broken by points);
  - a table of every non-overlapping subset of its candidates (bitmask → expected points, p10, p90, invite probability), capped at 12 candidates. The picker reads this, so the browser needs no model.
- Size budget: under 1 MB for the folder, checked by the script. `public/data` is 2.5 MB and committed nightly.

### 5. Optimizer

`scripts/lib/sim/schedule.ts`.

- **Conflicts.** Two events conflict when the gap from one's end to the next's start is under the travel buffer: 2 days within a region, 4 days across regions (region from `location`).
- **Volume baselines.** Computed each run from `data/matchdata.json`: LAN events per 180 days at p25 / p50 / p75 among top-40 rosters, with a Major's stages counted as one event, scaled to the horizon length. A first count (2026-11-17) gives 8 / 9 / 10 for ranks 1–20 and 7 / 8 / 9 for 21–40, before merging Major stages. These cap low, average and high schedules, so the optimizer never suggests attending everything.
- **Search.** Enumerate non-overlapping subsets within the cap and score each over all runs with `scoreTeam` (`rank: false`, about 50 µs each, so about 8 CPU-minutes for 9M scores). Invite probability re-runs `allocateInvites` with the team's points swapped in.
- **Re-score.** The recommended schedules (up to 6 per team, deduplicated) are re-run with `rerun` on 50 runs, on the worker pool: at most 60 × 6 × 50 × 25 ms ≈ 7.5 CPU-minutes. Their shown expected points and invite probability come from these reruns, which also fixes the one-team model's weak spot (global rank agrees only 85% when adding events). The gap to the one-team estimate goes into `index.json` as nightly regret. The picker's subset table stays one-team and is labelled as an estimate.
- **Announced commitments** are in the baseline. A recommendation that drops one says so.
- **Known limit:** candidates come from the baseline world, so a schedule that lifts a team's rank doesn't earn it extra invites to later events.

### 6. Site

- `/vrs-sim` with `?view=` tabs, following `Rankings.tsx`:
  - **Calendar**: upcoming LANs on a timeline with fields, attendance probabilities and assumed-data badges.
  - **Projections**: standings at each checkpoint with rank ranges (`DataTable`, `SeriesLineChart`).
  - **Schedules**: team select, the six recommended schedules, and the picker (toggle events, read the subset table, show buffer violations).
- `/events/:slug` gets a VRS impact table from `impact/<slug>.json`.
- `/teams/:team` links to its schedule view.
- Types in `src/sim/types.ts`, fetchers in `src/data/queries.ts`, `LiquipediaCredit` beside every table, nav entry in `AppShell.tsx`.

### 7. Pipeline and docs

- The nightly workflow runs `npm run simulate-season` after `npm run simulate`.
- A weekly `Plan schedules` workflow runs `npm run plan-batch`: the focal planner for up to 8 teams whose season-rules invite share is nearest even, round-robin across regions, within a 4-hour budget. It reuses the nightly's Liquipedia cache without fetching, and prunes plans older than 14 days. Plans live on their own cadence because one takes about 10 minutes, against the nightly's 30-minute budget for the whole season run.
- [vrs-simulator.md](vrs-simulator.md) covers the exact rerun, the one-team model and gate results, and, as they're built, season simulation, attendance rules, optimizer, baselines and every assumption. It's added to [overview.md](overview.md) and the CLAUDE.md doc list.

### Build order

Each step is usable on its own:

1. Exact rerun, one-team model, exactness tests, gate. Done.
2. Move the invite projection (`projectOnce`) onto `rerun`: one world per invite snapshot per worker, with a full-run fallback when inexact. That turns 1000 × 0.8 s per snapshot into about 25 s, so raise the `--vrs-n` default (1000 → 5000) if CI time allows. Then event impact for already-configured events (feature 1), computed in `npm run simulate` from the same runs, and its table on `/events/:slug`.
3. Catalog and fetch change.
4. Season simulation, calendar and projections (feature 2). `backtest-vrs-whatif` gains an add-case section fed by `simulateEvents` output instead of replayed past LANs.
5. Optimizer with exact re-scoring, team files and the Schedules view (feature 3).
6. Nightly job and docs.

### Verification

- Unit tests: `valveWorld.test.ts` (reruns identical to the full model after adding, excluding and finishing events; relinks flagged) and `oneTeam.test.ts` (exact on an unchanged ledger), `catalog.test.ts` (`qualifier` strings → invite rule; generic configs for 4, 8 and 16 teams), `attendance.test.ts` (sequential invites, pass-down on decline, the Tier 2 rank-12 rule), `schedule.test.ts` (buffers, caps, subset enumeration).
- `npm run backtest-vrs-whatif` passes the gate.
- With a fixed seed, `public/data/sim/invites/*.json` is identical before and after the step 2 port.
- Impact for a sample of (team, event, run) is checked against two exact reruns and stays within the remove-case gate.
- `index.json` carries the optimizer's re-score regret.
- `npm run simulate-season -- --season-n 50`, then check that the checkpoint nearest an existing invite snapshot roughly agrees with `public/data/sim/invites/*.json` for events both include, that an event winner's impact is positive and larger than the runner-up's, and that output stays under the size budget.
- Walk `/vrs-sim` (three views, picker) and an event's impact table in the browser.

**Status:** step 1 built and its gate passed (2026-11-17). On 50 random deltas, reruns are identical to the full model, at about 25 ms each. One-team error: removing an event, mean 0.65 points and p95 2.3; adding one, mean 3.6 and p95 9.7. Schedule regret has a mean of 0.04 points. Step 3 built (2026-11-17), ahead of step 2: `npm run catalog` lists 43 LANs on the 2026-11-12 store, 6 simulated and 37 listed. Events with no invite rows are listed, not simulated, rather than given a guessed field; attendance rules for open-field LANs are on the roadmap. Step 4 built (2026-11-17): `npm run simulate-season`, `/vrs-sim` Calendar and Projections, and the backtest's simulated add case (n 80, mean 4.10, p95 10.32; gate passed). Per-checkpoint `freeze` and the item 5 candidate replays moved to step 5, which reads them; the nightly job is step 6. Step 5 built (2026-11-17): optimizer (`optimizer.ts`), a worker pool sharding runs, `teams/<team>.json` and the Schedules view. 300 runs plus the re-score take about 2 minutes on 4 workers. Estimate error is a mean of 0.43 points and p95 2.9, and regret is 0. Today the volume caps (6 / 6 / 7) rarely bind against the 7 simulated LANs, so the low, average and high schedules mostly coincide. Step 6 built (2026-11-17): the nightly workflow runs `npm run simulate-season` after `npm run simulate`. Step 2 built (2026-11-17). The invite projection reruns a world loaded once per worker. With a fixed seed its output is byte-identical to full runs, and it takes 3 s instead of 70 s for 200 runs, so `--vrs-n` is now 5000. Event impact is computed in `npm run simulate-season` rather than `npm run simulate`, since the season runs already rerun every checkpoint and include the catalog LANs in between. It writes `season/impact/<slug>.json`, shown on `/events/:slug`. Step 7 built (2026-11-18): the focal planner (`plan-schedule`, `/vrs-sim?view=plan`) runs weekly for teams on the invite bubble through `npm run plan-batch` and the `Plan schedules` workflow ([vrs-simulator.md](vrs-simulator.md#focal-planner)).

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
| Economy or mechanics patch shifts WP base rate | Walk-forward fold drifts | Monthly gate flags misses; 31-day weekly intercept for economy patches, `patch-report` for mechanics |
| Inferred invite rule is wrong | Wrong Major odds | Flagged on the page until checked against the rulebook |
| One-team model drifts from Valve's | Wrong schedule scores or impact | Used only for search and the remove case (mean error 0.65); recommended schedules re-scored with `rerun`; gated nightly |
| Simulated lineups relink rosters | Inexact reruns fall back to full runs, slowing the sim | Count reported per run; 0 of 50 in the backtest |
| Guessed formats, prizes or fields | Rough season projections | Labelled as assumed on the site; kept out of the Major invite page |
| More upcoming pages to fetch | Liquipedia requests go from 3 to about 5 a night | Capped at 100 pages |

- [ ] When does Valve publish the FiRe Major Buenos Aires 2027 invitation snapshot date? Still unannounced; estimated 2027-04-05.
- [ ] Does Valve's repo carry prize data for events still in progress, or only completed ones? Not recorded in the docs.
- [x] Do Liquipedia's API match records include map vetoes? **No.**
- [x] Does Liquipedia's squad data include an IGL role field? Only a free-text `role`/`position` field (`Captain` covers 58.4% of team-maps and lags swaps); `data/war/igls.json` stays manual.
- [x] Does current awpy support CS2 navigation meshes? **Yes**, awpy 3.1.1.
- [x] Does Valve count showmatches? **No** — IEM Cologne 2026's Team Germany v Team Poland (Betclic) is absent from Valve's `2026-07-06` Betclic details and is excluded in `data/overrides.json`.
- [x] Which Esports Nations Cup 2026 qualifier matches does Valve have? Only the four `2026-07-19` `R04` qualifying deciders (`Belgium v Denmark`, `Serbia v Bulgaria`, `Kosovo v Poland`, `Serbia v Romania`); earlier rounds are excluded in `data/overrides.json`.

Next steps are tracked in [roadmap.md](roadmap.md).

## Sources

- [ValveSoftware/counter-strike\_regional\_standings](https://github.com/ValveSoftware/counter-strike_regional_standings)
- [Counter-Strike Team Rankings Explained (CSDB)](https://csdb.gg/counter-strike-team-rankings/)
- [Next CS2 Major: PGL Major Singapore 2026 (Timesaver)](https://timesaver.gg/news/next-cs2-major-pgl-singapore-2026-dates-format-qualification)
- [Liquipedia API](https://liquipedia.net/api)
- [GRID Open Access](https://grid.gg/open-access/)
- Xenopoulos, Doraiswamy, Silva, "Valuing Player Actions in Counter-Strike: Global Offensive", IEEE Big Data 2020
