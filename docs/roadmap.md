# Roadmap

## Overview

VRS is close but not at the gate defined in [vrs-verification.md](vrs-verification.md). The shared infrastructure is in place and Elo is built. What's left for Elo is the 2024–2025 backfill, tuning, and its own gate.

## Before Elo

- [x] **Commit on a branch.** Everything up to the Liquipedia pipeline, agy's work included, plus these docs (`vrs-liquipedia-matchdata`).
- [ ] **Run the nightly job end to end once.** It needs `LIQUIPEDIA_API_KEY` as a repo secret. The `/player` fetch hit Liquipedia's hourly limit locally. Skip players already in `data/raw/players.json`, and persist `data/raw/players.json` and `.cache/liquipedia/` across runs with `actions/cache`.
- [x] **Split the match feed from the VRS projection.** Elo reads `normalizeMatches` in `scripts/lib/elo/normalize.ts` (page-name keyed, no coverage rules). `buildMatchdata` keeps `valveRanked`, the qualifier rule, aliases and prize overrides. Lineup resolution is shared through `scripts/lib/lineups.ts`.
- [x] **Settle identity.** Elo keys on page names. Aliases apply only in the VRS projection and the VRS baseline's nick lookup.

## Elo

See [elo-model.md](elo-model.md).

- [x] **Finish the backfill** for 2023-10 → 2026-04 and freeze it into `data/history/`.
- [x] **Tune and run the gate.** It passes: 0.6135 vs 0.6489 on 8,490 2026 series (elo-model.md).
- [x] **Check cross-region calibration.** Tuned Elo beats VRS there too (0.6271 vs 0.6505, 651 series).
- [x] **Stand-in down-weighting.** Tuning settled on `standInK` 1.2, so stand-in series get slightly more weight, not less.
- [x] **Widen `tierGap`'s search range.** With an 800 ceiling it settled at 475.
- [x] **Fix Bo3/Bo5 overconfidence** with `seriesMapTemp` (elo-experiments.md).
- [x] **Tier 2 calibration:** classification sound; Elo-side temperature rejected. The 2026 slope is 0.597 on 401 series, almost all from online tier-1 qualifiers (160 series, slope 0.32; LAN tier 2 is 0.89). A tier-2 `tier2Temp` (τ 0.7375, fit on 2024–25) lifts the tier-2 slope to 0.82 but moves the gate only 0.6132 → 0.6129. The simulator keeps `TIER_TEMP` ([elo-experiments.md](elo-experiments.md)).
- [x] **Veto-aware series odds (v2):** rejected. On 608 vetoed 2026 series, the actual veto's maps under the map model lose to v1 (−0.0017, CI −0.0047 to +0.0010), and play-share pool weights are flat ([elo-experiments.md](elo-experiments.md)).
- [x] **Elo over-reaction lead.** Partly fixed 2026-11-18 ([elo-experiments.md](elo-experiments.md)). `backtest-elo --residual-lead` reproduces it (−6.4 ± 0.5 on all 2026 maps) and puts it in results from the last 7 days. Burst-damped K (`burstMaps` 64, `burstDays` 14) is kept: gate 0.6149 → 0.6132, coefficient −5.1. `provisionalK`, `k` and `marginWeight` were rejected: lower `k` or `marginWeight` helps 2026 but not 2024–25.
- [x] **Walk-forward validation.** Params drift between years, and tuning on the latest full year beats all history on 2025 H2 (gate set 0.6029 vs 0.6083). `--tune` now trains on 2025 only, and the gate moved 0.6132 → 0.6116 ([elo-experiments.md](elo-experiments.md)).
- [ ] **Declared slower-Elo test.** 2026 keeps preferring a slower Elo than 2024–25 (lower `k`, `marginWeight` or `burstMaps`). Score `k` 10 against 12, on top of burst damping, on 2027 series only.
- [ ] **Hand-check `data/elo/vrsTeamMap.json`.** It was generated from player overlap on the 2026-10-05 snapshot.

## VRS to the gate

- [x] **Make the gate the pass/fail.** `compareStandings` reports the gate, `verify-vrs` exits on it, and `--all-calibrated` runs every calibrated date. Three of five snapshots (`2026-09-07`, `2026-10-05`, `2026-11-02`) now pass the gate.
- [x] **More snapshots.** Five snapshots are calibrated and verified (`2026-07-06` to `2026-11-02`).
- [x] **Esports Nations Cup 2026 qualifiers.** Only the four `2026-07-19` `R04` qualifying deciders are in Valve's details; the rest are excluded in `data/overrides.json`, restoring Echo and Bulgaria on `2026-08-03`.
- [x] **Fix only what moves the top 50.** Added `qualifiedEvents` linking, `PARIVISION` Cologne Stage 3 lineup fixes, and untracked `Stake_Pulse` / `RLG/RES` / `CS_Asia_Championships` qualifier exclusions.
- [x] **Split Majors into stages.** Cologne's event weights and Stage 2 prize dates now match Valve.
- [x] **Tier-3 LAN coverage.** Excluded Central Asian `matchlist` group stages (`FRAG.gg`, `BRO_*`, `CYBERLAND_Cup`) and untracked `Tier 2 Qualifier` sub-qualifiers in `data/overrides.json`, fixing `referenceLanWins` on `2026-09-07`.
- [x] **IEM prize distribution.** Added `prizeDistributionOverrides` for IEM Rio and Atlanta 2026.
- [x] **Generated prize overrides.** `scripts/propose-prize-overrides.ts` (`npm run propose-prize-overrides`) compares Bounty Offered tables across all calibrated snapshots and proposes `prizeDistributionOverrides` where Valve and Liquipedia differ.

## Simulator and Major invites

See [simulator.md](simulator.md).

- [x] **Simulator core.** Swiss, single and double elimination, GSL and round robin. Major Swiss reproduces every Cologne 2026 pairing.
- [x] **Rating noise.** Per-event form rejected; horizon drift kept (elo-experiments.md).
- [x] **VRS layer.** Round trip on Cologne 2026 is exact with the event's lineups. Runs in parallel on worker threads.
- [x] **Invite allocation** and the `/events` and `/major-invites` pages.
- [x] **Live standings and Singapore/Buenos Aires invite odds.** `update-data` writes daily model standings, and `simulate` projects Buenos Aires (`2027-04-05`) with Singapore (`bracket` playoffs with 3rd-place decider) included.
- [x] **Refetch squads.** `squads.json` now holds full active squads; `simulate.ts` excludes coaching roles so `preferSquads` and `makeIntactCheck` apply cleanly to coached teams.
- [x] **PGL Major Singapore participants.** `participants.ts` auto-resolves all 32 teams from the `2026-11-02` snapshot and `previousNames` maps renamed orgs (`PVISION`, `GOSH`, `The One`, `BB Team`).
- [x] **Buenos Aires invite rule.** Verified Stage 1 (`6/6/4`), Stage 2/3 dynamic slots, `minRetained: 3`, and the 3-month regional eligibility lock against `vendor/counter-strike_rules_and_regs/major-supplemental-rulebook.md` (`verified: true`).
- [ ] **Configure the other announced events before the snapshot**, each with a prize table. Live: BLAST Rivals Fall 2026 (draw auto-resolved from matchlist IDs), PGL Major Singapore 2026, IEM Beijing 2026, PGL Masters Bucharest 2026, Stake Ranked Episode 5. Waiting on participants or the group draw (empty `invited`): PGL Bucharest, Cluj-Napoca and Łódź 2027, ESL Pro League S25, BLAST Open Spring 2027. Not configured:
  - Stake Ranked Episode 6: no draw yet.
  - IEM Kraków 2027: its play-in feeds the groups, and which play-in results go where isn't on Liquipedia yet.
  - BLAST Bounty Winter 2027: the format isn't clear from the brackets.
  - EXTREMESLAND 2026: Liquipedia shows its groups twice.
  - Tier 3 events.
- [x] **Showmatches in matchdata.** Confirmed Valve does not count IEM Cologne 2026's Team Germany v Team Poland (Betclic) showmatch and added it to `excludedMatches`.
- [x] **Close the bounty gaps first.** `qualifiedEvents` and Rio/Atlanta prize overrides are live.

## VRS simulator (Phase 8)

See [vrs-simulator.md](vrs-simulator.md) and Phase 8 in [spec.md](spec.md).

- [x] **Fast what-if scoring.** `valveWorld.ts` reruns are identical to the full model at about 25 ms. `oneTeam.ts` passes the `backtest-vrs-whatif` gate.
- [x] **Invite projection on `rerun`, then event impact** (spec Phase 8, step 2).
- [x] **Event catalog** (spec Phase 8, step 3). `npm run catalog`; generic 4/8/16-team configs, parsed invite rules, fitted prize splits.
- [x] **Season simulation** (spec Phase 8, step 4). Also re-runs the add-case backtest on `simulateEvents` output.
- [x] **Schedule optimizer, team files and the Schedules view** (spec Phase 8, step 5).
- [x] **Nightly job** (spec Phase 8, step 6): `npm run simulate-season` after `npm run simulate`.
- [x] **Catalog hygiene.** Cancelled, postponed, national-team (Esports Nations Cup) and Valve-unranked LANs are left out, and the top-12 invite rule follows Valve's `publishertier` ([vrs-simulator.md](vrs-simulator.md#event-catalog)).
- [ ] **Focal-team schedule planner** (`npm run plan-schedule -- --team "100 Thieves"`). It finds a mid-tier team's best route to a Major invite through tier 2–4 LANs, online series and qualifiers. Phases, in order:
  - [x] Plumbing and gate: event kind and role, generic formats for any field size, Valve's ranked rule and qualifier prize links in `simulationDelta`, online-aware conflicts, and new `backtest-vrs-whatif` cases (online, tier 3–4, linked qualifier, multi-event schedule). Gate passed; the schedule case is closest at mean 4.6 ([vrs-simulator.md](vrs-simulator.md#backtest)). The nightly and `fetchUpcoming` stay on LANs until phase 2.
  - [x] Field and activity models learned from past editions: rank-band histograms per series, VRS acceptance by band, learned slot mixes, and per-team habits with paced budgets and caps. The nightly season run now plays online events and qualifiers too (64 of 87 events). `backtest-fields` passes: field log loss 1.44 against 1.56 without the series level and 6.61 for best remaining ([vrs-simulator.md](vrs-simulator.md#field-and-activity-models)). Learned start ranks were folded into acceptance by band.
  - [x] Projected editions of recurring series (CCT, Stake Pulse, Parken…), labeled on `/vrs-sim` and played in as many runs as past projections came true (precision 0.48 in `backtest-fields`). `npm run hindcast-season` checks against Valve's 2026-11-02 list and fails: past the ~45 days Liquipedia lists ahead, mid-table teams' one-off tier 3–4 LANs are missing ([vrs-simulator.md](vrs-simulator.md#hindcast)).
  - [x] Unannounced stand-ins at each region and category's last-180-day rate, for rivals' points only; assumed-format and projected LANs as schedule options with assumed invitations; series, organizer and home affinity in field draws (held-out log-likelihood −3.30 → −2.98). The hindcast improves from −328 to −147 points and 29% to 58% coverage, but still fails: ranks 15–50 play about two thirds of their real LAN matches ([vrs-simulator.md](vrs-simulator.md#hindcast)).
  - [x] Affinity and strength against the field in VRS-offer acceptance, fit and held out on offers like the draw: held-out log-likelihood −0.493 → −0.460. Strength doesn't help free choices once an attendee is left out of its own field ([vrs-simulator.md](vrs-simulator.md#value-in-attendance)).
  - [ ] Stand-in rates that follow growth: every 2026 window under-predicted, tier 2 LANs and qualifiers most (×0.72, ×0.81).
  - [x] Qualifiers linked to main events: 38 links (`qualifierpage`, ancestor page or a slot of its own), feeders' finishers fill the slots, feeders skip teams that can't attend, and "Build a schedule" shows each team's odds of qualifying. On past events 90.4% of linked slot fillers came from the source's top places. The hindcast moved from −147 / 58% to −160 / 51%. The nightly fits its budget again: 983 KB, about 13 minutes ([vrs-simulator.md](vrs-simulator.md#qualifier-links)).
  - [x] The focal search: `npm run plan-schedule`, beam search over events and qualifier routes, smoothed invite odds as the objective, a hold-out re-rank and exact re-scores ([vrs-simulator.md](vrs-simulator.md#focal-planner)).
  - [ ] Invites that respond to the schedule (phase 5b): a schedule that lifts the team's rank should earn it later invites.
  - [x] Plan view on `/vrs-sim` (`?view=plan`), linked from the Schedules view and the team page ([vrs-simulator.md](vrs-simulator.md#focal-planner)).
  - [x] Weekly plans for teams on the invite bubble: `npm run plan-batch` in the `Plan schedules` workflow, Mondays ([vrs-simulator.md](vrs-simulator.md#focal-planner)).
  - [x] Tier temperature: tier 2 series play at τ 0.905. Tiers 1 and 3+ were already calibrated ([elo-experiments.md](elo-experiments.md)).
- [x] **Full history for the season models.** `data/matchdata.json` only holds the hot store's ~190 days; history now comes from `build-matchdata-full` locally and committed `data/history/sim/` months in CI ([vrs-simulator.md](vrs-simulator.md#hindcast)).
- [x] **Rolling hindcast and oracle ladder.** `npm run hindcast-rolling` scores 5 origins × 1–4 months against Valve's lists, persistence and a regression; the ladder shows attendance is the lever and the calendar isn't ([vrs-simulator.md](vrs-simulator.md#rolling-hindcast)).
- [x] **Calibrated display.** Standings ranges and invite shares are shrunk and widened by factors fit on the rolling hindcast (`data/sim/season-calibration.json`).
- [ ] **Who attends.** Real participants instead of drawn ones cut CRPS by 18 for ranks 15–80, and ranks 31–50 run 100–200 points low at 2–4 months. Band totals of LAN places are right, and per-team volume adds nothing to the choice model ([vrs-simulator.md](vrs-simulator.md#who-attends)). Next suspect: how LAN qualifiers are decided. Teams that really played more LANs than simulated won their qualifiers, so check simulated qualifier winners against real ones (does Elo underrate rising mid-table teams, are qualifier formats right).
- [ ] **Event gains are too spread.** Realized on predicted slope 0.6–0.7 over about 670 team-events: the planner's "why" gains should shrink toward their mean until attendance improves ([vrs-simulator.md](vrs-simulator.md#planner-against-reality)).
- [ ] **Configs for big catalog events on the generic format**, e.g. IEM Kraków 2027 (24 teams), whose real format the groups-then-playoffs default doesn't match.
- [ ] **Country and sub-region VRS lists** in upcoming invite rules: `parseVrsLabel` reads them for past editions (Oceania as Asia, CIS as Europe, country lists as list-less), but `inviteRuleFromPlacements` still only takes the six main lists with a month. None are in upcoming events today.
- [ ] **Underway online events** (ESEA leagues, CCT series in progress) aren't simulated: a generic bracket can't continue the real one. Their remaining matches need the real format or a config.

## Demo pipeline

See [demo-pipeline.md](demo-pipeline.md).

- [x] **Pipeline.** `demos/` downloads, parses, rebuilds rounds, validates, and stores in R2.
- [x] **Gate.** Thunderpick World Championship 2026: 37/37 maps in R2, with round counts, halves, sides and 5v5 matching Liquipedia.
- [x] **Matches without an HLTV link.** `backfill-hltv-links` linked all 919 archive series; HLTV's per-day results cover future gaps.
- [x] **Schedule.** `cs2demos auto` under launchd, fed by the nightly `lan-series` artifact.
- [x] **Schema 2.** The utility counts and defuse state in `ticks`, for the win-probability model. Thunderpick has been reparsed. This had to land before the backfill.
- [x] **Backfill** 2025–2026 tier-1 LANs: 3,113/3,140 maps parsed as of 2026-11-11, 27 quarantined.

## Win probability and WPA

See [win-probability.md](win-probability.md).

- [x] **Pipeline.** `wp/`: nav-mesh distances, game states, the model grid, credit (WPA plus two neutral versions), validation and publish. It runs end to end on Thunderpick.
- [x] **Gate run** (2026-11-11): FAIL on max bin gap, 0.045 vs a 0.043 limit; log loss and slope pass. The cause is a CT win-rate shift from 2025 to 2026, not overfitting ([wp-experiments.md](wp-experiments.md)).
- [x] **Base-rate drift.** The CT shift is within-map and dates from mid-2025. Walk-forward with recency weighting passes the gate with `full_plant_clock` (0.040 vs 0.041).
- [x] **Adopt `ct_bomb_graph`** under the amended protocol (log loss non-worse within CI, and a flagged bucket improves).
- [x] **Out-of-sample credit.** 2026 maps use their month's walk-forward fold and 2025 maps a monthly cross-fit. Every row carries `model_version`, and credit is frozen until a `--recredit`.
- [x] **Monthly job and patch file** (`cs2wp monthly`, `wp/patches.json`).
- [ ] **Schedule `cs2wp monthly`** (launchd, like `cs2demos auto`) and fill in `wp/patches.json` with verified economy patch dates.
- [ ] **Rare-state calibration.** 5v4 post-plant undervalues CT only with 2+ kits (−13 to −22 points). Try a kits × CTs-alive or kits × bomb-time interaction.
- [ ] **Uncredited drift.** Events credit CT about +0.07 a round and drift takes it back uncredited, so side- and role-split WPA is biased. Decide whether to spread drift across alive players.
- [ ] **Full states rebuild.** The PGL Masters plants moved the site centroids, so `euclid_*` is stale on older maps. The production model doesn't use it; `cs2wp states` refreshes it in about 3 hours.
- [ ] **Site page** for player WPA, with the Liquipedia credit, then send the link to Liquipedia for verification.

## Player WAR

- [x] **WAA vs HLTV 3.0 gap** (`vs HLTV` on `/war`): z-score difference `z(WAA/100) − z(HLTV 3.0)` over qualified players with 90% intervals (`r = 0.722` for `wpa_opp`; IGLs average `+1.086` SD, AWPers `−0.588` SD).
- [x] **CT doubled-position x, y clustering** (`cs2wp positions --subpositions`, Gates 1–3): `de_dust2` `B` passed all three gates (`B Doors` vs `B Tunnels`: pair sep `0.701`, lift `+0.207`, `2.26 SE` / `2.44 SE`, `r = 0.982`, `k = 984`) and is now default in `baselines`; the 21 other doubled positions missed Gate 1 and stay unsplit.
- [ ] **Run `cs2wp usage --device cuda` on the GPU machine** after pushing CT sub-position defaults, then `cs2wp war --model production --publish`, `cs2wp validate-war`, and `cs2wp team-factor`. Don't publish `war` before `usage` reruns: `role-rounds.parquet` is newer than `usage.parquet`, so context + usage + conversion would miss the rate by up to 0.032. The publish also fills in WAA's K/D row on the Validation tab.
- [x] **Run `cs2wp duels` on the GPU machine** for the smoke-support experiment and flash-gift values, then log the result in `docs/war.md`. (Smoke experiment rejected: +0.00003, 90% CI −0.00001 to +0.00008; teammate flashes worth 4,504 kills / 0.67 per 100 player-rounds; `flashGift` published to `players.json`.)
- [x] **Fold support into the split?** No, for now. Smoke support is rejected (+0.00003 log loss). Teammate flashes (4,504 kills, 0.67 per 100 player-rounds) stay a descriptive `flashGift` stat beside usage and conversion, not part of the split.
- [ ] **Replacement pool for usage.** `cs2wp usage` compares with the average tier-1 player at each role. Refit the expectations on replacement-level players once tier-2 demos exist.
- [ ] **Re-run team factor and APM gates after backfill (`cs2wp team-factor`).** Stage 1 (`r = 0.239`, 90% CI `−0.017` to `+0.467`) and Stage 2 (`89` lineup-change maps, 90% CI `−0.805` to `+5.160 × 1e-4`) cross zero on today's archive; re-test after 2025 backfill and tier-2 coverage grow before publishing Teams to `/war` or switching `--igl-adjustment` default from `fixed` to `apm`.

## Team and tactics metrics

See [war.md](war.md#duel-execution-and-quality).

- [x] **Duel execution and quality** (`cs2wp duel-stats`): nested `p_base` / `p_pos` / `p_flash` cross-fits in `cs2wp duels`, player and team split-half, independence and beyond-Elo gates.
- [x] **Team gates and Teams table on `/war`**: quality over all duels passes stability and independence, opening-only fails; no team stat adds to Elo, so all are descriptive ([war.md](war.md#duel-execution-and-quality)).
- [ ] **Player execution column on `/players`**, using the opponent-adjusted `exec_adj_per100` (kept: +0.038 split-half r, 90% CI +0.025 to +0.052).
- [x] **Order 2 round stats** (`cs2wp team-stats`): time-and-position value, RW over expected (economy) and adjusted T/CT are published as descriptive. Conversion fails quarter persistence on stints, and the player version fails both tests ([war.md](war.md#team-round-stats)).
- [ ] **Re-run `cs2wp team-stats` after the backfill.** Conversion persistence is 0.065 on stints (CI −0.066 to 0.194) and 0.162 by team, so it may pass with more archive.
- [ ] **Rework time-and-position value** (hidden on the site since 2026-11-22, [war.md](war.md#team-round-stats)). First recompute drift with `elo_diff_ct` held at 0, so the stat stops inheriting Elo (r −0.48). That may not be enough, because drift also runs against event value (r −0.42). To show it again, add `tpv` back to `ROUND_ORDER` in `src/war/teamColumns.ts` and rewrite its tooltip.
- [x] **Luck-adjusted Elo** (`cs2wp luck`, `backtest-elo --luck`): the raw variant is rejected (−0.0010 on 2026 treated series). The skill-adjusted variant shows Elo carrying luck forward (carryover coefficient −0.17, CI −0.31 to −0.04) and gains +0.0013 at w = 0.5, but the CI (−0.0047 to +0.0076) fails the gate, and a round-margin score doesn't resolve it either, so `luckWeight` stays 0 ([war.md](war.md#luck-adjusted-elo)). Parked: the run already uses the full tier-1 LAN archive, and the series gate would need about 20 times the series. Reopen only if demo coverage widens to tier 2 or online events. The value-weighted variant (each duel's luck times the round win probability riding on it) is the best form: +0.0036 at w = 0.6, CI −0.0034 to +0.0106, still short of the gate. Adding round-conversion luck (`full`) fits 2025 better but is level on 2026 (+0.0034), and a skill-only control puts about a third to a half of the gain down to player skill entering Elo.
- [x] **Player-skill term in Elo** (`skillWeight`, `backtest-elo --skill`): alone it gains +0.0008 on 2026 treated series (CI −0.0006 to +0.0022, FAIL). Combined with value-weighted luck at w = 0.6 it fits 2025 better than either alone and gains +0.0060 (CI −0.0022 to +0.0144, FAIL), the best of any variant ([war.md](war.md#player-skill-term)).
- [ ] **Registered test: skill + value-weighted luck on 2024 treated series**, declared 2026-11-15 before any 2024 demo was downloaded. It replaces the pooled 2026 + 2027 test declared 2026-11-14. No weight, variant or rule was chosen on 2024 ([elo-experiments.md](elo-experiments.md)).
  - **Data:** tier-1 LAN demos from 2023-10-01 to 2024-12-31 (23 events in the local store less the Match of LeGGends showmatch), run through `cs2demos run` and the `cs2wp` chain to `cs2wp luck` with code as it stood at registration. Q4 2023 maps only count toward the treated rule's 120-day history; Elo is still warming up there, so those series aren't scored. A pipeline bug fix is allowed only if it's logged before the result is read.
  - **Run, once:** `npm run backtest-elo -- --skill --skill-weight 8458 --luck-weight 0.6 --luck-variant value --test-from 2024-01-01 --test-years 2024 --set burstMaps=0`. `--set burstMaps=0` restores the base params as they stood at registration (params.json as of 0176598), before burst damping was kept on 2026-11-18. Frozen: `skillWeight` 8,458, `luckWeight` 0.6, variant `value`, teammate-mean rule, treated rule 5+ luck maps in 120 days.
  - **Primary, the decision:** the `Encompassing` line. Pass if the 90% event-bootstrap CI for λ is above 0 and the treated-series gain point estimate is above 0. Simulated on 2025 treated series, this has a 5.3% false-pass rate at λ = 0 and 87% power at λ = 1 (the current gain gate: 43%).
  - **Secondary, not the decision:** pooled 2024 + 2026 under the old gain gate, `--test-from 2024-01-01 --test-years 2024,2026`, reported with the caveat that the form was the best of seven variants on 2026.
  - **A fail parks the term for good.** No reruns with other weights, variants or rules.
  - **If it passes:** set the weights live, add the term to [elo-model.md](elo-model.md), and have the nightly build refresh `luck-maps.jsonl` and `player-skill.json` from `cs2wp luck`.
- [x] **Veto value lost** (`cs2wp veto`): the map model passes its gate on all maps, and value lost persists (stint r 0.64). No hidden-information signal ([war.md](war.md#veto-value-lost)).
- [x] **T-side predictability** (`cs2wp predictability`): fails. A team's own T history predicts site, timing and execute no better than the league prior, and predictable teams don't underperform rematch opponents ([war.md](war.md#t-side-predictability)).
- [x] **Clutch and man-advantage conversion** (`cs2wp clutch`): clutch (player, stint) and man-disadvantage (stint) pass year-to-year and are published. Man advantage fails ([war.md](war.md#clutch-and-man-advantage-conversion)).
- [ ] **WP calibration in late man-count states.** Before centring, 1v1 wins run 6–10 points above the WP model, and 2v1 and 3v2 advantages convert 4–6 points below it. Check whether that's a model miss or an artifact of valuing the state right after the kill.
- [ ] **Re-run `cs2wp predictability` and `cs2wp clutch` after the backfill.** Man advantage (year r 0.26, CI from −0.09) may pass with more archive.
- [ ] **Publish veto value lost** once HLTV's publishing terms are checked: `cs2wp veto --publish`, then a column in the Teams tables on `/rankings`.

## Open items

- Once a page showing Liquipedia data is live, send the project link to Liquipedia for verification.
