# Win probability and WPA

## Overview

`wp/` is a Python (uv) project. It reproduces Xenopoulos et al. (2020) on CS2 demos, then extends it.

- **Model:** a round win-probability model, P(CT wins the round | game state).
- **Credit:** every action is valued by the change in win probability it causes (WPA). Two context-neutral versions are also produced.
- **Inputs:** it reads the Parquet tables that `demos/` writes to R2 ([demo-pipeline.md](demo-pipeline.md)) and the pre-map Elo from the Elo engine ([elo-model.md](elo-model.md)). It makes no Liquipedia or HLTV requests.

**Gate.** On maps dated after the training window, the `full` XGBoost model must meet all three:

- test log loss ≤ 0.535 (the paper's 0.5353)
- every 1/100-wide calibration bin with at least 1,000 states within the bin-gap limit of the diagonal
- a logistic calibration slope in [0.95, 1.05]

The bin-gap limit is the larger of the paper's 0.03 and the noise limit (`evaluate.bin_gap_noise`). States in a round share one outcome, so a bin's gap carries round-level noise far beyond what its state count suggests. The noise limit resamples whole test rounds 200 times, centres each bin's gap on the observed one, and takes the p95 of the max gap. That's the largest gap a perfectly calibrated model would show 95% of the time. On the 2026 H2 dry run (9,564 rounds) the limit is 0.070. Under a flat 0.03, even a perfect model would fail.

**Status (2026-11-12):** the walk-forward gate passes with the base `full_plant_clock_bomb_dist`: log loss 0.4483 against 0.535, max bin gap 0.034 against a 0.039 limit, slope 1.029. The fixed 2025 → 2026 split failed narrowly on base-rate drift, which monthly retraining with recency weighting absorbs.

- Credit is out of sample, from the `production` models, with a model version on every row.
- 5v3 and 5v4 post-plant still undervalue CT by 6–7 points.
- The conservation check shows a CT bias in plain WPA from uncredited drift.
- Nothing is published.

See [wp-experiments.md](wp-experiments.md).

## Commands

```bash
npm run export-map-elo          # data/wp/elo-maps.jsonl: pre-map Elo for every played map
cd wp
uv sync
uv run pytest
uv run cs2wp sync               # mirror maps at the current parser version into data/demos/mirror/
uv run cs2wp states [--map 2399384/m1] [--force]
uv run cs2wp train [--test-from 2026-01-01] [--model latest] [--ablations]
uv run cs2wp walk-forward [--variant full_plant_clock_bomb_dist] [--model production]
uv run cs2wp cross-fit [--model production]
uv run cs2wp monthly [--model production] [--today YYYY-MM-DD] [--force]
uv run cs2wp credit [--model production] [--recredit]
uv run cs2wp validate [--test-from 2026-01-01]
uv run cs2wp publish [--model production] [--upload]
```

Training runs (`train`, `walk-forward`, `cross-fit`, `monthly`, `credit --recredit`, `duels`) go on the GPU machine. Push the code, pull it there and run them. Don't run them on the dev Mac.

`train`, `walk-forward` and `monthly` exit 0 on a gate pass and 2 on a fail. `publish` refuses a model that hasn't passed.

**Monthly job.** Run `npm run export-map-elo`, `cs2wp sync`, `cs2wp states`, `cs2wp monthly`, then `cs2wp credit` early each month. `monthly` does three things:

- It trains the current month's fold on everything before the month. That fold is the live model for new maps.
- It gates the previous month on all its maps with that month's fold, and appends the result to `data/wp/models/production/monthly.json`.
- On a fail it prints `FLAG` and exits 2.

**Patches.**

- **Candidates.** `cs2wp patch-candidates` reads CS2's Steam announcements (app 730, no key needed) and writes `wp/patches.candidates.json`: date, title, URL, type and the matching changelog lines.
- **Types.** Each update is typed from the changelog lines that mention a gameplay keyword: economy over map_pool over mechanics. Lines about items, tooling, scripting, audio, UI or non-competitive modes count as cosmetic.
- **Approval.** Entries are approved by hand into `wp/patches.json` as `{"date": "YYYY-MM-DD", "name": "...", "type": "economy" | "mechanics" | "map_pool"}`.
- **Economy patches** turn on the intercept fallback. From the patch date, for 31 days, `credit` shifts each map's predictions by a weekly logistic intercept, refit on the 1,500 rounds before the map's week, each valued by its own month's model.
- **Mechanics patches** get `cs2wp patch-report`: post-plant calibration (all, early, late) in the 30 days before and after. Pass `--candidates` to run it on every mechanics candidate before approval.

## Data and split

- **Maps:** tier-1 LAN maps parsed at the current parser version, joined to `elo-maps.jsonl` on match2id and map name. The join uses play order when a map repeats in a series. The map date is the series start from Liquipedia.
- **Split:**
  - Train: 2025-01-01 to 2025-12-31.
  - Test: 2026-01-01 onward.
  - Grid-search validation: the latest third of the training maps by date. This replaces the paper's random 2/3–1/3 split, because adjacent states are near-copies, and a map never straddles a cut.
- **No leakage from Elo:** ratings come only from earlier maps. Elo's parameters were tuned on 2024–2025 series, so they never saw a test-window result. Keep any Elo retune pre-2026.
- **Training states:** the 4 Hz `ticks` grid from freeze end until the round is decided. That's about 300 states per round, close to the paper's footstep density.

## Features (`wp/src/cs2wp/states.py`)

| Group | Columns | Definition |
| --- | --- | --- |
| Paper | `map`, `seconds`, `bomb_planted`, `bomb_site`, `ct/t_equip`, `ct/t_alive`, `ct/t_hp`, `ct/t_graph_a`, `ct/t_graph_b` | `seconds` counts from freeze end at 64 ticks/s. Equipment is each side's total of every player's highest `equipment_value` during the 20 s buy window, so late buys count. HP sums alive players. Distances are the nearest alive player's nav-mesh path length to each site. |
| CS2 | `ct_kits`, `ct/t_util`, `elo_diff_ct` | Alive CTs with a kit. Smokes, flashes, HEs and molotovs held by alive players. Map-adjusted pre-map Elo of the CT team minus the T team, so it flips at halftime. |
| Experiments | `since_plant`, `ct_defusing`, per-type utility, `*_euclid_*` | Fit with `train --ablations`, logged in [wp-experiments.md](wp-experiments.md). |

**Distances** (`nav.py`):

- awpy 3.1.1 reads CS2 nav meshes from `awpy-data`. Release 2000934 (patch 1.41.9.1) is pinned in `NAV_RELEASE`, and it has every pool map.
- **Site areas:** awpy has no bombsite polygons. A site is the set of nav areas containing a finished plant on that map. That's geometry only, so plants from every window count.
- **Path length:** one multi-source Dijkstra per site over the reversed area graph, with edges weighted by centroid distance. The paper used hop count, which is `weight="hops"` here.
- **Off-mesh positions:** a position off the mesh snaps to the nearest area centroid within 96 units, or is left NaN.
- **Coverage:** across all 3,015 maps, 99.88% of positions resolve on average, and only one map misses more than 1% (an Ancient map from January 2025 at 1.1%). Early-2025 map versions resolve as well as 2026 ones, so the pinned release covers the whole training window. `cs2wp states` writes per-map coverage to `data/wp/states/coverage.json`. Straight-line distance to the site's mean plant position is kept for the ablation.
- **Maps without a mesh** (the de_contact showmatch at the StarLadder 2025 Major) are skipped with a warning and listed under `skipped` in `coverage.json`.

**Caching.** `states` rebuilds a map only when an input changes: its mirrored tables, its Elo row, its site areas, `NAV_RELEASE`, or the source of `states.py` or `nav.py`. The key is stored in each map's `meta.json`. Site centroids are rounded to 1 unit in the key, so new plants don't invalidate every earlier map; the `euclid_*` ablation features can lag by up to 1 unit. `states --force` rebuilds everything.

## Event states

Every damage, plant and defuse between freeze end and round end gets a state just before it and just after it.

- **HP and alive** come from the event log (`health_post` per hit), so same-tick hits, such as one HE hitting three players, each get their own state.
- **Position, utility and kit** come from the latest snapshot at or before the tick, at most 250 ms old.
- **Excluded events:**
  - bomb explosion damage, which is the outcome rather than an action
  - post-round exit frags
- **The post-state value is pinned** once the round is decided:
  - all CTs dead → 0
  - all Ts dead with no plant → 1
  - a defuse → 1

## Model (`pipeline.py`)

The paper's grid: XGBoost with 100 trees, `hist`, `max_depth` in {6, 8, 10, 12} and `min_child_weight` in {1, 3, 5, 7}. Map and site are native categoricals. It's scored next to these baselines:

- a map-average baseline
- unpenalized logistic regression on the paper's features (saga, one-hot map and site, missing distances at the training median)

Two XGBoost models are fit:

- `replication`: the paper's 14 inputs on the paper's grid
- `full`: the paper's 14 inputs plus the CS2 additions

To prevent round memorization:
- **Constant weighting**: every state is weighted rounds ÷ states, so the weights sum to the round count and `min_child_weight` reads on a per-round scale. Weighting by 1/states-in-round was tried and dropped: T-won rounds are longer (392 vs 340 states), so it biased the model toward CT ([wp-experiments.md](wp-experiments.md)).
- **Regularized grid with early stopping (`GRID_FULL`)**: `max_depth` in {3, 4, 5, 6}, `min_child_weight` in {1, 5, 20, 50} (on the weighted scale), `learning_rate` 0.05, `subsample` 0.5, `colsample_bytree` 0.8, and `n_estimators` 2000 with `early_stopping_rounds=50` on the validation fold. The final model refits on all of train with the best iteration tree count.
- **Monotone constraints**: `ct_alive`, `ct_hp`, `ct_kits` are +1; `t_alive`, `t_hp` are −1; all others 0.
- **Scope**: `full` and every ablation use this recipe. `replication` keeps the paper's grid, unweighted with 100 trees.
- **Map exposure**: test maps with fewer than 500 training rounds are reported next to unseen test maps, along with an informational secondary gate readout excluding them.

The test report (`data/wp/models/<model>/report.json`) has:

- log loss, Brier and AUC
- 95% intervals from a round-level bootstrap
- the 100-bin calibration curve, its ECE and slope
- calibration per (CT alive, T alive, planted) bucket, flagged under 50 rounds or with a gap over 0.05
- per-map scores
- maps missing from train and low-exposure test maps (<500 training rounds)
- gain importance normalized to 100, to compare with the paper's Figure 7

**Walk-forward (`walkforward.py`)** is the gate for drift. For each test month, it trains on every earlier map and scores that month. Weights decay exponentially by age, with the half-life chosen from {365, 180, 90} days on the 90 days before the month. Tree settings are fixed at the fixed-split grid pick. The gate runs on all months' predictions pooled, plus a gap and noise limit per month.

The run writes these files to `data/wp/models/<model>/`:

- `walkforward.json` and `walkforward.parquet` (per-state predictions)
- each fold's model under `folds/<month>.json`
- `index.json`, which `credit` reads
- `report.json`, the pooled gate that `publish` and `war` check

It also reports a weekly intercept recalibration as a fallback for sudden patch shifts: a logistic intercept refit on the trailing 1,500 out-of-sample rounds. The recalibration is applied only inside an economy patch's window (see Patches above).

Pooled calibration is also read out by map, by buy type and by Elo gap, flagged at |gap| > 0.05 with 50+ rounds:

- **Buy type:** each side's equipment is eco under $5k, force under $20k, full otherwise. Pistol rounds (1 and 13) are counted on their own.
- **Elo gap:** the CT team's pre-map Elo minus the T team's, in bins at ±50, ±100 and ±200.

The base feature set is `full_plant_clock_bomb_dist`: `full` plus `since_plant` and `ct_bomb_graph`. `ct_bomb_graph` is the nearest alive CT's nav distance to the planted site, derived from `ct_graph_a/b` and `bomb_site` in `features.py`.

**Out-of-sample models for credit (`book.py`).** Every map is valued by a model that never saw it:

- From 2026 on, by its month's walk-forward fold.
- Before that, by its month's cross-fit model (`cs2wp cross-fit`). Each cross-fit model trains on every other month, decayed by distance from the held-out month, with the half-life and tree count of the latest fold. These models see later months, so the 2025 cross-fit calibration is a check, not a gate.

Every credit row carries `model_version` (`production/folds/2026-03@<sha8>`, plus `+shift…` when the patch intercept applied). Credited maps are frozen: `credit` only values maps without a versioned credit file, and `credit --recredit` redoes everything and refits the neutral tables.

Fixes to try if rare buckets are miscalibrated are listed in [wp-experiments.md](wp-experiments.md).

## Credit (`credit.py`)

V is the change in the actor's side's win probability, post − pre.

| Event | Credit |
| --- | --- |
| Damage or kill on an enemy | Attacker +V, victim −V |
| Flash-assisted kill (`assist_flash`, a teammate flasher) | Killer 0.5·V, flasher 0.5·V, victim −V |
| Traded death (`victim_traded`) | Victim also gets back 0.5·V, half its cost. This isn't zero-sum. |
| Team damage | Attacker gets V for their own side, usually negative. The victim gets nothing. |
| Self or world damage | Victim gets V for their own side |
| Plant | Planter +V. Alive CTs share −V evenly. |
| Defuse | Defuser +V. Alive Ts share −V evenly, or nobody if none are alive. |
| Time expiry, explosion | Not credited |

Known simplifications:

- The even split on plants and defuses doesn't model which defender let the plant happen.
- The flash share and trade return are both 0.5 (`FLASH_SHARE`, `TRADE_RETURN`), set by convention rather than fit.
- Win probability that moves between events (movement, time) isn't credited to anyone, as in the paper.

**Conservation check.** `credit` tests each round: does each side's summed WPA equal its outcome minus its win probability at the first state? It writes `data/wp/reports/conservation.json` and a per-round `conservation.parquet`. In CT terms, `ct_win − p0 = events + drift + end` holds exactly, where:

- `events` sums each event's change.
- `drift` is what moved between events.
- `end` is the outcome minus the last event's post-state, nonzero when the bomb explodes or time runs out.

Credit covers only `events`, minus attribution leaks (trade returns, self, team and world damage). So a round fails the strict test for one of these named reasons, and the report gives how much of the total each part carries.

**Context-neutral versions.** Each event's V is replaced by the mean V of its bucket over training-window events. The same splits then apply.

- `nwpa_event` buckets by event × actor side × planted. The events are:
  - non-lethal damage in bands of 1–24, 25–49, 50–99
  - kill
  - team damage
  - self damage
  - plant
  - defuse

  Man-advantage leverage drops out, so a clutch kill is worth an average kill.
- `nwpa_mancount` adds the actor's own and the opponent's alive counts. It strips time, economy and HP context but keeps the man count.
- A bucket with under 200 training events falls back to the coarser key.

**Own team at average Elo (`wpa_opp`).** Plain WPA uses the model's `elo_diff_ct`, so players on a strong team get little credit for rounds Elo expected them to win, including the part of that strength they're responsible for. `wpa_opp` re-evaluates each event twice: once with the CT team at league-average Elo (the mean pre-map rating over training-window maps) and the T team at its own, and once the other way round. Each player's share is valued with their own team at average, so the opponent's strength still counts. It's no longer zero-sum between the two teams. See [war.md](war.md#war-validation) for why it was added.

All four versions are published. `wpa_opp` is the default on `/war`. `public/data/wpa/players.json` still carries only the original three.

## Validation (`validate`)

Validation runs on the test window, so the credit is out of sample. It compares WPA and both neutral versions against:

- **Approximate Rating 2.0** (`ratings.py`). HLTV now shows Rating 3.0, so this rebuilds 2.0 from the community regression on our kills, deaths, assists, ADR and KAST.
- **Rating 3.0 and Swing**, parsed from the HLTV match pages the demo pipeline already cached. Rows are joined to SteamIDs by nick, against the in-demo name or the Liquipedia page. Swing is HLTV's own win-probability measure.
- K/D and ADR.

The tests:

- **Month-to-month:** Pearson r between a player's per-round value in consecutive months, for players with 100+ rounds in both. Paper: WPA 0.40, Rating 2.0 0.29.
- **Correlation with K/D:** over the window, for players with 300+ rounds. Paper: WPA 0.73, Rating 2.0 0.93.
- **Bootstrap:** 100 resamples of each player's rounds give p5/p50/p95 per version.

Outputs are `data/wp/reports/validation.json` and `player_wpa.parquet`.

## Publishing

**Don't publish raw WPA compared across sides.** Event credit favors CT by about 0.07 a round, which drift takes back without crediting anyone (see the conservation check). So CT-only against T-only WPA, or role comparisons that split by side, are biased. Per-player totals over both halves, and WAR after role baselines, are the publishable forms.

**Time-and-position value** is the team stat for that drift. `credit` writes it per team per map to `data/wp/reports/team_drift.parquet`, total and by side. It's the win probability that moved toward the team between events, which is zero-sum between the two teams in each round. WPA stays as the paper defines it, and drift isn't given to players.

`cs2wp publish` writes `public/data/wpa/players.json` with a source block crediting Liquipedia and the HLTV demos. `--upload` also puts the Parquet in R2 under `wp/<model>/`. There's no site page yet. When one ships:

- it needs the Liquipedia credit beside the data
- the project link goes to Liquipedia for verification (`AGENTS.md`)
- these numbers come from HLTV-hosted demos, so check that publishing them is acceptable before the page goes live
