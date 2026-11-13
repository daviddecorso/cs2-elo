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
- [ ] **Tier 2 calibration.** Slope 0.54 on 377 series; check the tier classification first.
- [ ] **Veto proxy (v2).** Blocked on missing veto data. Try the map-play-share proxy only after v1 passes.
- [ ] **Hand-check `data/elo/vrsTeamMap.json`.** It was generated from player overlap on the 2026-10-05 snapshot.

## VRS to the gate

- [x] **Make the gate the pass/fail.** `compareStandings` reports the gate, `verify-vrs` exits on it, and `--all-calibrated` runs every calibrated date. Every snapshot fails today on points error.
- [x] **More snapshots.** Four snapshots are calibrated and verified (2026-07-06 to 2026-10-05). Verifying 2026-07-06 needs `data/raw/` to reach back to 2026-01-07 (`fetch-liquipedia --from 2026-01-01`). 2026-11-02 uses `calibrate-window` once it's published.
- [ ] **Esports Nations Cup 2026 qualifiers.** Work out which of these matches HLTV, and so Valve, has, using the match ID gaps in the details files. Drop the rest. They make Echo and Bulgaria unranked on 2026-08-03.
- [ ] **Fix only what moves the top 50.** Point `diff-details` at the top-50 rosters and their opponents. Allow a per-event override only when it improves every calibrated snapshot.
- [x] **Split Majors into stages.** Cologne's event weights and Stage 2 prize dates now match Valve.
- [ ] **Tier-3 LAN coverage.** DEPO, Omega and other Central Asian rosters have LAN matches Valve doesn't, which inflates the LAN and opponent-network references for every team (vrs-verification.md). Find the events with `diff-details` and work out the rule HLTV follows.
- [ ] **IEM prize distribution.** Valve's IEM Rio and Atlanta 2026 payouts differ from Liquipedia's with the same total (1st 295k vs 285k, 2nd 170k vs 150k, 9th–12th 20k vs 25k). Add overrides, and a rule if future IEMs follow the same split.
- [ ] **Generated prize overrides.** Build a script that compares the Bounty Offered tables across all calibrated snapshots and proposes `prizeDistributionOverrides` where they agree, for one-offs like NODWIN Clutch Series #12.

## Simulator and Major invites

See [simulator.md](simulator.md).

- [x] **Simulator core.** Swiss, single and double elimination, GSL and round robin. Major Swiss reproduces every Cologne 2026 pairing.
- [x] **Rating noise.** Per-event form rejected; horizon drift kept (elo-experiments.md).
- [x] **VRS layer.** Round trip on Cologne 2026 is exact with the event's lineups. Runs in parallel on worker threads.
- [x] **Invite allocation** and the `/events` and `/major-invites` pages.
- [x] **Live standings and Singapore invite odds.** `update-data` writes daily model standings, and `simulate` projects every upcoming invite snapshot. Singapore's (2026-11-02) uses Cologne's fixed slot split.
- [ ] **Refetch squads.** `squads.json` kept one player per team, because the query lacked `objectname`. The next `fetch-liquipedia` refetches it; until then the intact rule and squad lineups are off.
- [ ] **PGL Major Singapore participants.** The config is in place with empty `invited` lists. Fill them once Liquipedia lists the 2026-11-02 VRS invites; it must be live before 25 November 2026.
- [ ] **Buenos Aires invite rule.** Check the inferred split (Stage 3 and 2 from the previous Major's top 8 and 9th–16th, Stage 1 fixed at 6/6/4) and `minRetained` against the rulebook, then set `verified`.
- [ ] **Configure the other announced events before the snapshot**, each with a prize table. Live: PGL Masters Bucharest 2026, Stake Ranked Episode 5, IEM Beijing 2026. Waiting on participants or the group draw (empty `invited`): BLAST Rivals Fall 2026, PGL Bucharest, Cluj-Napoca and Łódź 2027, ESL Pro League S25, BLAST Open Spring 2027. Not configured:
  - Stake Ranked Episode 6: no draw yet.
  - IEM Kraków 2027: its play-in feeds the groups, and which play-in results go where isn't on Liquipedia yet.
  - BLAST Bounty Winter 2027: the format isn't clear from the brackets.
  - EXTREMESLAND 2026: Liquipedia shows its groups twice.
  - Tier 3 events.
- [ ] **Showmatches in matchdata.** IEM Cologne 2026's Team Germany v Betclic showmatch is `valveRanked` in `data/matchdata.json`. Check whether Valve counts it; if not, add it to `excludedMatches`.
- [ ] **Close the bounty gaps first** (below). Simulated prize money feeds exactly the factors our reproduction is weakest on.

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

- [x] **Run `cs2wp duels` on the GPU machine** for the smoke-support experiment and flash-gift values, then log the result in `docs/war.md`. (Smoke experiment rejected: +0.00003, 90% CI −0.00001 to +0.00008; teammate flashes worth 4,504 kills / 0.67 per 100 player-rounds; `flashGift` published to `players.json`.)
- [x] **Fold support into the split?** No, for now. Smoke support is rejected (+0.00003 log loss). Teammate flashes (4,504 kills, 0.67 per 100 player-rounds) stay a descriptive `flashGift` stat beside usage and conversion, not part of the split.
- [ ] **Replacement pool for usage.** `cs2wp usage` compares with the average tier-1 player at each role. Refit the expectations on replacement-level players once tier-2 demos exist.
- [ ] **Re-run team factor and APM gates after backfill (`cs2wp team-factor`).** Stage 1 (`r = 0.239`, 90% CI `−0.017` to `+0.467`) and Stage 2 (`89` lineup-change maps, 90% CI `−0.805` to `+5.160 × 1e-4`) cross zero on today's archive; re-test after 2025 backfill and tier-2 coverage grow before publishing Teams to `/war` or switching `--igl-adjustment` default from `fixed` to `apm`.

## Open items

- Confirm invite cutoffs against Valve's rulebook. `src/vrs/inviteCutoffs.ts`' 16/8/8 doesn't match what Cologne 2026 invited.
- Once a page showing Liquipedia data is live, send the project link to Liquipedia for verification.
