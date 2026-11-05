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

**Status (2026-11-04):** not run yet. All 2026 events are parsed, but 2025 (the training window) has 5 of about 1,730 maps. A 2026-only dry run (train H1, test H2) fails calibration: XGBoost memorizes rounds and loses to logistic regression ([wp-experiments.md](wp-experiments.md)).

## Commands

```bash
npm run export-map-elo          # data/wp/elo-maps.jsonl: pre-map Elo for every played map
cd wp
uv sync
uv run pytest
uv run cs2wp sync               # mirror maps at the current parser version into data/demos/mirror/
uv run cs2wp states [--map 2399384/m1]
uv run cs2wp train [--test-from 2026-01-01] [--model latest] [--ablations]
uv run cs2wp credit [--model latest]
uv run cs2wp validate [--test-from 2026-01-01]
uv run cs2wp publish [--model latest] [--upload]
```

`train` exits 0 on a gate pass and 2 on a fail. `publish` refuses a model that hasn't passed.

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
- **Coverage:** on Thunderpick, 99.5–100% of positions resolve per map. `cs2wp states` writes per-map coverage to `data/wp/states/coverage.json`. Straight-line distance to the site's mean plant position is kept for the ablation.

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

All three versions are published.

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

`cs2wp publish` writes `public/data/wpa/players.json` with a source block crediting Liquipedia and the HLTV demos. `--upload` also puts the Parquet in R2 under `wp/<model>/`. There's no site page yet. When one ships:

- it needs the Liquipedia credit beside the data
- the project link goes to Liquipedia for verification (`AGENTS.md`)
- these numbers come from HLTV-hosted demos, so check that publishing them is acceptable before the page goes live
