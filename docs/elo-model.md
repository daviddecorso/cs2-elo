# Elo model

## Overview

A map-level team Elo built on the normalized Liquipedia feed. It has to pass one gate: on held-out 2026 series, its log loss beats a baseline that predicts from VRS point differences. Code lives in `scripts/lib/elo/`. `npm run backtest-elo` scores it, `npm run build-elo` publishes `public/data/elo/latest.json`, and the site shows it at `/elo` and `/methodology`.

## Data

- **Feed** (`history.ts`, `normalize.ts`): series keyed by `<tournament page>:<match2id>`, with teams and players keyed on Liquipedia page names. A series carries its date, best-of, LAN flag (match `type`, falling back to the tournament), Liquipedia tier, prize pool, listed lineups, winner, forfeit flag, and every scored map with rounds per side. No VRS rules, aliases or overrides apply here.
- **Sources**: each month comes from exactly one place. Committed `data/history/YYYY-MM.json` comes first. Next is the raw archive in `data/raw/archive/`, filled by `npm run backfill-liquipedia`. Last is the hot store in `data/raw/` (`fetch-liquipedia`'s 190-day window).
- **CS:GO warmup**: 38,016 CS:GO series from 2022-01 to 2023-09 sit in `data/history/csgo/` and run before the CS2 feed, so ratings and new lineages' seeds aren't cold in 2023-10 (elo-experiments.md, 2026-11-21). `npm run backfill-liquipedia -- --game csgo` fetched them into `data/raw/archive-csgo/` (matches and tournaments only, about 5–6 requests a month), and `npm run freeze-history -- --game csgo` froze them. VRS and the hot store never read either directory. CS:GO maps count only if the winner reached 16. `loadFeed({ csgo: false })` or `--no-csgo` gives the cold-start feed.
- **Freezing**: `npm run freeze-history` writes every month that a source covers completely and that ended more than 60 days ago. History is committed, so losing the CI cache never forces a re-backfill. The nightly job freezes from the hot store.
- **Backfill**: one month per chunk (about 4 `/match` pages and 1 `/tournament` page), resumable, stopping at the first 429. Each run is capped by `--max-requests` (default 30), so a full backfill from 2023-10 spans several hourly runs. It uses a `query` field list to drop streams, icons and links. Don't run it back to back with `fetch-liquipedia`.
- **Maps**: a map counts only if its winner reached 13 rounds. `np` (not played), defaulted and abandoned maps are skipped. Forfeit series aren't rated or scored.
- **Lineups**: rosters of 6+ or fewer than 5 players resolve to 5 with the same ±21-day pool rule VRS uses (`scripts/lib/lineups.ts`). The resolver looks at nearby series on both sides of the date. That is identity resolution only and never uses outcomes.
- **Squads**: `fetch-liquipedia` refreshes active `/squadplayer` rows weekly for teams with a tier 1–3 series in the last 90 days (`data/raw/squads.json`). They're used only to flag core players who have left the squad.

## Model (`engine.ts`)

- **Map updates.** Each map is rated: `Δ = K · margin · provisional · (result − expected)`. Expected score is `1/(1+10^(−(Rₐ+offₐ[map]−R_b−off_b[map])/scale))`.
- **Margin.** `1 + marginWeight · ln(1 + rounds)` times 538's autocorrelation damping. An overtime win (loser on 12+) counts as `otMargin` rounds. CS:GO margins are scaled by 12/15, and their overtime starts with the loser on 15.
- **Game switch.** At the first CS2 series, every lineage moves `gameRegress` of the way to its tier mean (tuned to 0).
- **K multipliers.** `onlineK` for online maps, `tierK^(tier−1)` by Liquipedia tier (missing tier counts as 4), `crossRegionK` when the rosters' Valve regions differ, and `standInK` when a lineup has a player outside the core. The region is the majority of core players' countries, through Valve's own `region.js`.
- **Burst damping.** K divides by `1 + load / burstMaps`, where `load` is the lineage's earlier maps decayed with a `burstDays` time constant. A run of maps at one event counts for less than the same maps spread out, because short-term results revert (elo-experiments.md, 2026-11-18).
- **Map offsets.** `kMap` per map. After each update, a roster's offsets are re-centred on the active pool and shrunk by `mapShrink`, so they show map preference, never overall strength.
- **Lineages.** A rating belongs to a lineage. The lineage's core is the 5 players seen most often in its last `coreWindow` series, with ties going to current core members, so a one-off stand-in doesn't change it. A lineup joins whichever candidate lineage (the team's current one, or any player's) it shares 3+ core players with. This follows a roster across org changes.
- **Partial changes.** When the core changes by k players, the rating moves `regress · k/5` of the way to the tier mean. The tier mean is the mean rating of rosters active in the last 120 days whose median tier of their last 10 series matches. With fewer than 5 such rosters, it falls back to `1500 − tierGap·(tier−1)`.
- **New lineages.** The seed is the mean of each player's last core lineage rating (unrated players get the tier mean), then regressed by `newRosterRegress`. `provisionalK` boosts K for a new lineage's first `provisionalMaps` maps.
- **Oceania.** A lineage with 3+ AU/NZ core players is Oceania, split out of Valve's Asia.
  - Against other regions, Oceania's rating gap gets `regionPriorOceania`, in both predictions and the update's expected score.
  - Oceania v Oceania series odds multiply the map logit by `oceaniaTemp`.
  - The pool's internal gaps are compressed, because its travellers pay the pool's inflated level abroad (elo-experiments.md, 2026-11-20).
  - Oceania's raw ratings carry the prior, so `build-elo` and `simulate` publish rating plus prior.
- **Series probability (v1).** The map probability is averaged over the active pool (maps with at least 3% of plays in the trailing 60 days), then converted to Bo1/Bo3/Bo5. Bo2 counts as Bo3. For Bo3 and Bo5, the map logit is first multiplied by `seriesMapTemp`, because maps within a series aren't independent. Without that step, Bo3 forecasts were overconfident while maps and Bo1 were calibrated.

## Vetoes

The Liquipedia API has no veto data, but HLTV vetoes parse for about 1,400 tier-1 series. Pricing those series on their actual veto's maps (v2) loses to v1 on 2026 (−0.0017, CI −0.0047 to +0.0010), and weighting the pool by play share is flat, so series odds stay v1. See the 2026-11-19 entry in [elo-experiments.md](elo-experiments.md). `cs2wp veto` reruns the veto check in its "Series gate" section.

## Backtest and gate (`scripts/backtest-elo.ts`)

- Ratings warm up on CS:GO from 2022-01. `--tune` runs coordinate descent on series log loss from the latest full year before the test year (2025), because recent-only tuning beats all-history tuning out of sample (elo-experiments.md, 2026-11-19). It covers every parameter except `scale`, which is redundant with K. `--write` saves the result to `scripts/lib/elo/params.json`, which overrides `STARTING_PARAMS`. `--set key=value` overrides one parameter for a single run. The report ends with calibration slope and ECE by slice (Bo1/3/5, provisional, idle, tier, LAN), plus a post-hoc temperature that serves as a reference point for calibration.
- Every experiment, kept or rejected, goes in [elo-experiments.md](elo-experiments.md).
- `--region-residual` prints residuals on cross-region maps by Valve region pair and calibration by how stale each side's last cross-region series is. Asia sits about 23 points overrated against the rest, steadily, but correcting it doesn't lower gate log loss enough to keep (2026-11-19). The flag also splits that residual by venue, Oceania, insularity, tier and rating, and reports new lineages' seed error by region. Most of the bias is Oceania (about −130). `--region-walk` scores region priors walk-forward under the region pass rule in [elo-experiments.md](elo-experiments.md). Only `regionPriorOceania` is on; the Americas and Asia priors stay 0.
- **VRS baseline** (`vrsBaseline.ts`): uses the latest Valve global snapshot published strictly before the series' UTC day, from the `invitation/` and `live/` tables. Each side's roster is found by 3+ of 5 player overlap, matching Liquipedia page name, display nick or VRS alias nick against Valve's nicks. `p = 1/(1+10^(−Δpoints/s))`, with `s` fit on training series. Snapshots start 2024-08-06.
- **HLTV baseline** (`hltvBaseline.ts`): uses pre-match HLTV world ranks and points exported from cached match pages and weekly ranking pages (`data/demos/hltv/ranks.jsonl`, via `cs2demos match-pages` and `cs2demos rankings`). `write_ranks` verifies each team's ranking-page position against its match-page badge rank (`points: null` on missing or mismatched teams). Joined by `match2id` on tier-1 LAN series where both HLTV ranks, HLTV points (when any are present) and a VRS points difference exist. Fits one-parameter logistic links on the training series in that set for HLTV rank (`ln rank_b − ln rank_a`), VRS rank, and HLTV points (selecting between `ln pts_a − ln pts_b` and `(pts_a − pts_b) / 100` by training log loss). Reported with event-resampled 90% CIs and a calibration curve on `/model` (`calibration.json` preserves the `hltv` block across CI runs when `ranks.jsonl` is absent) and never gated.
- **Gate**: 2026 series where both rosters have VRS points; Elo series log loss must be below VRS. `--gate` exits non-zero on failure. The report also covers Brier, accuracy, all 2026 series, map log loss, stand-in series and cross-region series. `public/data/elo/calibration.json` holds the scores and calibration bins for the methodology page.

## Rankings output (`scripts/build-elo.ts`)

Lists rosters with 15+ rated maps and a series in the last 90 days. VRS columns come from the latest snapshot, joined by player overlap first and then by `data/elo/vrsTeamMap.json` (Liquipedia team page → Valve team name). `--update-team-map` adds overlap matches to that file.

It also writes a game log per ranked team to `public/data/elo/games/<teamSlug>.json`: every rated series in the last 180 days, newest first, with each side's pre-series rating, the pre-series win probability and the rating change. Logs for teams that drop out of the rankings are deleted. The team page shows it as "Game log". Every entry carries a `reason`, and hand fixes go there. `teamAliases` in `data/overrides.json` stays VRS-only.

## Results

**The gate passes.** The feed held 107,631 series from 2022-01-01 to 2026-11-19, with CS:GO through 2023-09. Parameters were tuned on 2025 (20,934 series) and scored on 2026 series.

| Set | Series | Elo log loss | VRS log loss |
| --- | --- | --- | --- |
| Both rosters VRS-ranked (gate) | 9,375 | **0.6090** | 0.6491 |
| Cross-region | 719 | 0.6274 | 0.6506 |
| Every 2026 series | 18,424 | 0.5926 | – |
| Every 2026 map | 39,018 | 0.6247 | – |

These figures are after the CS:GO warmup and its retune (2026-11-21). Test series calibration slope is 0.964 and ECE is 0.009. The VRS baseline's fitted scale is 880 points for 10:1 odds. The HLTV table below predates the warmup.

Tier-1 LAN series with both teams ranked in HLTV's weekly table (with points) and VRS (651 test series through 2026-11-12, fit on 776 training series; HLTV points `(pts_a − pts_b) / 100` `β = 0.26`, HLTV rank `β = 0.70`, VRS rank `β = 0.67`):

| Model | Series | Log loss | Brier | Accuracy |
| --- | --- | --- | --- | --- |
| Elo | 651 | **0.6078** | 0.2098 | 67.7% |
| HLTV points | 651 | 0.6298 | 0.2190 | 65.6% |
| HLTV rank | 651 | 0.6244 | 0.2169 | 65.6% |
| VRS points | 651 | 0.6265 | 0.2182 | 65.6% |
| VRS rank | 651 | 0.6317 | 0.2197 | 65.7% |

Elo − HLTV points log-loss gain is +0.0220 (90% CI +0.0023 to +0.0381, events resampled); Elo − HLTV rank gain is +0.0166 (90% CI +0.0024 to +0.0306). HLTV adds no detectable information beyond Elo: the encompassing λ is 0.11 (90% CI −0.20 to 0.47) for points and 0.14 (−0.15 to 0.45) for rank ([elo-experiments.md](elo-experiments.md), 2026-11-18).

Current parameters (`scripts/lib/elo/params.json`):

- K is 12 per map.
- `seriesMapTemp` is 0.8. `seriesMapTempOnline` overrides it for online series but isn't set, so it follows `seriesMapTemp` (a split was rejected 2026-11-18).
- `marginWeight` is 0.75, and OT wins count as a 1-round margin.
- `onlineK` is 1, `tierK` is 0.9, `crossRegionK` is 1.25 and `standInK` is 1.2.
- `regress` and `newRosterRegress` are 0.
- `tierGap` is 750, and `provisionalK` 2 applies over 100 maps (the search bound).
- `burstMaps` is 24 and `burstDays` is 12.
- `kMap` is 6, `mapShrink` is 0.01 and `coreWindow` is 7.
- `regionPriorOceania` is −175 and `oceaniaTemp` is 1.5 (tuned on 2025 alone; 2026 had already been looked at, so they need a recheck on 2027).

How each value was reached, and what was rejected, is in [elo-experiments.md](elo-experiments.md). `tierGap`, `kMap` and `seriesMapTemp` move a lot between years, so treat their exact values as soft (2026-11-19 entries).
