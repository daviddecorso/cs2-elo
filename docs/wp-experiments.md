# Win-probability experiments

## Overview

A log of every change tried on the win-probability model ([win-probability.md](win-probability.md)), kept or rejected, newest first.

**Protocol:**

1. Gate with `uv run cs2wp walk-forward --variant <name> --model <dir>`, which retrains monthly with recency weighting and pools the 2026+ months. `uv run cs2wp train --ablations` still runs the fixed 2025 → 2026 split for comparison.
2. Judge on pooled walk-forward log loss.
3. Check calibration by bucket, map, buy type and Elo gap as well as overall.

A variant replaces the base when either holds, without worsening any other flagged bucket:

- It lowers log loss by more than 0.001.
- Its log loss is non-worse within the base's 95% round-bootstrap CI, and calibration improves in at least one flagged bucket.

Moves under 0.001 count as noise. The second rule was added on 2026-11-12, because a feature can fix calibration in rare states without moving pooled log loss.

**Paired comparison (from 2026-11-13).** Judge a variant against the base with `uv run cs2wp compare --base production --model <dir>`. It needs no training. It resamples rounds once for both runs and gives 95% intervals on Δ log loss, Δ max bin gap, and Δ|gap| per bucket and per kit slice of the flagged post-plant buckets. This replaces the unpaired "non-worse within the base's CI" check, which is about ±0.004 wide, and the bin-gap pass or fail on a 0.001 margin. The gate itself still runs in `walk-forward`.

## 2026-11-13: deeper trees for the 5v4 kit slope (pending GPU run, latest)

**Question:** is the 5v4 post-plant miss a capacity problem? The kit gap is in the training data and stable (table below). Fitting it needs planted × CT alive × T alive × kits, which takes a whole depth-4 tree for about 0.4% of rounds. `PARAMS` was picked on the 2025-only grid for `full` and never re-tuned under walk-forward.

**Variants** (`walkforward.PARAM_SETS`, base features, only `max_depth` and `min_child_weight` change):

- `d5w10`: depth 5, min child weight 10.
- `d6w20`: depth 6, min child weight 20.

Child weight rises with depth, so the extra splits can't isolate a handful of rounds.

**Runs** (GPU machine, then `compare` locally after copying the model directories back):

```
uv run cs2wp walk-forward --params d5w10 --model depth5
uv run cs2wp walk-forward --params d6w20 --model depth6
uv run cs2wp compare --base production --model depth5
uv run cs2wp compare --base production --model depth6
```

**Decision rule, fixed before the run.** Adopt a depth variant only if all of these hold:

- The Δ log loss interval does not sit above 0.
- 5v4 post-plant |gap| improves, and the kits 2 and 3+ slices both move toward observed.
- No bucket's |gap| worsens by more than 0.005 with an interval excluding 0.
- The Δ max bin gap interval does not sit above 0.

The 0.005 floor was added after a dry run of `compare`, before any depth result existed. Paired intervals on big buckets exclude 0 for changes of 0.0001: `base_kit_time`, which moved nothing, had six buckets "worse" by +0.0001 to +0.0018 without it.

If neither passes, log both as rejected and stop feature work on these buckets. At 300–400 test rounds, a third round of features would be fitting the test set.

5v3 post-plant is left alone. Its miss is not monotone in kits (−0.10, −0.19, −0.03, +0.07 for 0, 1, 2, 3+) and sits almost entirely in 2026 H2 (−0.102 against −0.023 in H1). At 313 rounds that reads as noise.

**Results:** pending.

## 2026-11-13: man-advantage × kits features, both rejected

**Question:** can 5v4 and 5v3 post-plant borrow strength from the common man-up retakes? The 5v4 miss is in kits (see the 2026-11-12 diagnostic below). At depth 4, the trees need `bomb_planted`, `ct_alive` and `t_alive` splits before `ct_kits` can split, and 400 rounds barely move pooled loss. `defuse_margin` described only the nearest CT, so it pooled nothing.

**Variants** (derived in `features.py`, no state rebuild, all monotone +1):

- `base_alive_kits`: base + `alive_diff` (CT alive − T alive) + `kit_frac` (kits ÷ CT alive). One split puts 5v4 with 4v3, 3v2 and 2v1.
- `base_kit_time`: base + `kit_time` (kits × bomb seconds left, null before the plant). Targets the early post-plant miss.

**Results** (pooled walk-forward, base `0.44830`, CI `[0.4443, 0.4524]`, max bin gap `0.0376` vs limit `0.0387`):

| Variant | Log loss | Max bin gap / limit | 5v4 post | 5v3 post | Newly flagged |
|---|---|---|---|---|---|
| base | `0.44830` | `0.0376 / 0.0387` | `0.309` vs `0.375`* | `0.633` vs `0.694`* | none |
| `base_alive_kits` | `0.44918` | `0.0500 / 0.0417` (fail) | `0.383` vs `0.375` | `0.735` vs `0.694` | `5v2` post `0.947` vs `0.891`* |
| `base_kit_time` | `0.44806` | `0.0474 / 0.0388` (fail) | `0.310` vs `0.375`* | `0.633` vs `0.694`* | none |

- **`base_alive_kits` rejected.** It did not confirm the pooling diagnosis (corrected below). `alive_diff` shifts every man-up state toward CT. It overshoots `5v2` post-plant (flagged), `4v2` post-plant (`0.839` vs `0.804`), `5v3` late (`0.50` vs `0.37`, 53 rounds) and pre-plant `1v2` (`0.198` vs `0.161`). Log loss worsened by `0.0009`. The paired interval is `[+0.0003, +0.0013]`, so that is a real loss, not noise. The pooled bin-gap gate fails.
- **`base_kit_time` rejected.** It changed nothing: all buckets and clock phases are within `0.002` of base. The bin-gap fail at `0.0474` comes with essentially unchanged log loss. The paired interval on Δ max bin gap is `[−0.020, +0.024]`, so the move from `0.0376` cannot be told from noise. The gate's pass or fail on a 0.001 margin is not evidence either way.

**Correction: `base_alive_kits` level-shifted 5v4; it did not fix the kit slope.** 5v4 post-plant, predicted − observed by CT kits:

| Kits | Rounds | base | `base_alive_kits` |
|---|---|---|---|
| 0 | 171 | −0.010 | +0.061 |
| 1 | 92 | −0.026 | +0.048 |
| 2 | 54 | −0.115 | −0.044 |
| 3+ | 88 | −0.198 | −0.111 |

The bucket mean lands on target because the low-kit overshoot cancels the high-kit undershoot. The same level shift is what overshoots 5v2, 4v2 and late 5v3. Those are all post-plant, so `alive_diff × bomb_planted` would keep them and spare only pre-plant 1v2.

`kit_frac` pools in the wrong direction. Round-level CT win rate, kits ≥ 2 against kits < 2:

| Bucket | 2025 H1 | 2025 H2 | 2026 H1 | 2026 H2 |
|---|---|---|---|---|
| 5v4 post | 0.55 / 0.38 | 0.59 / 0.40 | 0.62 / 0.35 | 0.66 / 0.37 |
| 4v3 post | 0.55 / 0.49 | 0.61 / 0.49 | 0.62 / 0.46 | 0.65 / 0.47 |

Kits are worth about 23 points at 5v4 and 13 at 4v3. `kit_frac` scores three kits as 0.60 at 5v4 and 0.75 at 4v3, so it tells the model kits matter less at 5v4. The gap shows in every half-year, so this is not 2026 drift, and bucket win rates are flat across the four half-years too. The signal is in the training data; the model under-fits it.

How much this matters: 5v4 post is −0.066 at about 2.8 standard errors and 5v3 is 2.3. Unflagged buckets are further out in standard errors, such as 4v4 pre-plant at −0.025 on 13,533 rounds. The fixed 0.05 flag picks out small buckets.

`alive_diff`, `kit_frac` and `kit_time` were removed from the code. The `alive_kits` and `kit_time` model directories stay for `compare`.

- Next: deeper trees (entry above).

## 2026-11-12: `defuse_margin` rejected; drop `None` from `HALF_LIVES`

**`defuse_margin` rejected.** Tested `base_defuse_margin` (`full_plant_clock_bomb_dist` plus `defuse_margin` = `40 - since_plant - min(ct_bomb_graph/250 + 10, ct_kit_bomb_graph/250 + 5)`):

- Pooled walk-forward log loss moved from `0.4482` to `0.4480` (−0.0002, well inside the 95% CI `[0.4445, 0.4518]`), and max bin gap was `0.040` vs `0.039` (fail).
- Both flagged post-plant buckets remained flagged: `5v3` at `0.637` vs `0.694` (gap `−0.057`, 313 rounds) and `5v4` at `0.311` vs `0.375` (gap `−0.065`, 405 rounds).
- Removed `base_defuse_margin` and `defuse_margin` from `walkforward.py` and `features.py`.

**`HALF_LIVES` changed from `(None, 365, 180, 90)` to `(365, 180, 90)`.** Re-running `production` on CUDA failed the pooled bin-gap gate (`0.0496` vs `0.0392`, log loss `0.4482`) because CUDA's quantile sketch and `subsample=0.5` PRNG flipped three ~0.0001 validation ties (`2026-06`: `0.44579` vs `0.44592`; `2026-07`: `0.44532` vs `0.44542`; `2026-09`: `0.44781` vs `0.44799`) to `half_life=None` (zero decay, weighting early-2025 pre-shift rounds equally with 2026). Even on CPU, `None` vs `365` sat within `0.00003–0.00015` on the 90-day validation slice across four folds. Dropping `None` enforces at least mild recency decay on every fold so validation noise cannot revert a 2026 fold to unweighted early-2025 data, keeping GPU training reliable. Also fixed `duels.py` (`--device`, default `auto`), pinned `seed=0` in `_train_booster` / `_fit_xgb`, and reset `XGBClassifier` to `cpu` after CUDA fit before DataFrame `predict_proba`.

*Pending re-run on CUDA:* `walk-forward`, `cross-fit`, `monthly --force`, `credit --recredit`, `validate`, `baselines`, `war --publish`, `validate-war`.

## 2026-11-12: `ct_bomb_graph` adopted; production models and out-of-sample credit

**Adoption.** `ct_bomb_graph` passes the amended protocol above: log loss +0.0002, inside the CI, and 2v1 and 4v3 cleared. The base is now `full_plant_clock_bomb_dist` (`walkforward.BASE`).

**Production run** (`--model production`): 97 PGL Masters Bucharest 2026 maps (2026-10-24 to 31) got Elo rows from a fresh Liquipedia fetch and are now included, 3,112 maps in all.

| | Log loss | Max bin gap (limit) | Slope | Gate |
| --- | --- | --- | --- | --- |
| Walk-forward, 2026-01 to 2026-10 (11.0M states) | 0.4483 | 0.034 (0.039) | 1.029 | **PASS** |
| + weekly intercept | 0.4484 | 0.033 (0.039) | 1.025 | PASS |
| Cross-fit, 2025 (a check, not a gate: each model saw later months) | 0.4459 | 0.041 (0.033) | 0.995 | fail |

- **Per month:** 9 of 10 months are within their own limit. October misses by 0.001 (0.095 vs 0.094). It's 5,014 rounds, the largest month, and includes PGL Masters. The first `cs2wp monthly` run (2026-11-12) flagged this miss as designed and trained the November live fold (no decay, 564 trees). October's readouts show nothing flagged; Anubis (−0.044) is the largest gap.
- **Half-life picks:** 365 days in 6 folds, 180 in 3, 90 in 1 (May).
- **Cross-fit:** the 2025 miss is one bin over the floor. Cross-fit models use a fixed tree count and half-life from the latest fold, with no per-month tuning. 5v3 and 5v4 sit within 2.5 points there, against 6–7 in 2026.
- **Readouts** (pooled walk-forward, flagged at |gap| > 0.05 with 50+ rounds): nothing is flagged.
  - By map, every gap is under 0.012, and all are slightly negative (CT under-predicted). Nuke (−0.012) and Mirage (−0.011) are the largest, the two maps whose CT rate rose most.
  - By buy type, every cell is within 0.02. Pistols are +0.002; full/force is −0.016 on 5,003 rounds.
  - By Elo gap, every bin is within 0.013. The 50–200 bins (CT favored) under-predict CT by 0.013.

**5v3 / 5v4 post-plant diagnostic** (walk-forward predictions, by time left on the bomb and CT kits; no new features tried):

- **5v4:** the miss is in kits. With 0–1 kits CT is within 4 points. With 2 kits it's −13 points, with 3+ it's −22. As kits rise, the prediction only goes from 0.19 to 0.44, while the observed rate goes from 0.20 to 0.66.
- **5v3:** no clean slice. It's off most with 0–1 kits (−9 and −17), and observed rates don't rise with kits (0.80 at 1 kit, 0.65 at 3+). That looks like noise on about 100 rounds per slice.
- **Both:** the miss sits in the first 20 s after the plant (−5 to −10 points). The last 20 s are within 4 points with or without `ct_bomb_graph`.
- **Next to try:** an interaction the depth-4 trees can't build from `ct_kits` alone, such as kits × CTs alive or kits × time left on the bomb.

**Out-of-sample credit.** Every map is now credited by a model that never saw it: its month's walk-forward fold from 2026, its month's cross-fit model in 2025. Each row carries `model_version`, and credited maps are frozen.

Validation over the 2026 window (1,404 maps, 192 players with 300+ rounds):

| Metric | Month-to-month r | r with K/D |
| --- | --- | --- |
| WPA | 0.444 | 0.821 |
| nWPA (event) | 0.403 | 0.936 |
| nWPA (man count) | 0.403 | 0.898 |
| Rating 2.0 (approx.) | 0.466 | 0.945 |
| Rating 3.0 | 0.448 | 0.877 |

WPA month-to-month stability rose from 0.432 with the fixed-split `latest` model to 0.444.

**Conservation** (67,425 rounds): 2 rounds conserve exactly. Every other round has probability that moves between events, which nobody is credited for.

- **Accounting:** the decomposition ct_win − p0 = events + drift + end holds on every round (max error 1.5e-8, float32).
- **Sizes:** in absolute value, events carry 97% of the outcome-minus-start total, drift 21% and end 2%. Drift and events largely cancel.
- **CT bias:** per round, events move CT win probability +0.074 on average, and drift takes back −0.076. Rounds start calibrated (mean ct_win − p0 is −0.0002). So CT players collect about +0.07 a round from events, and T players lose it only through uncredited drift: as a round goes on without a kill, CT's chances fall.
- **Attribution leaks** on top of that: trade returns (+0.098 a round, both sides), self and team damage (34k rounds), and defuses with no T alive (7.6k rounds). CT's summed credit averages +0.112 a round and T's −0.014.
- **Impact:** each player plays both halves, so the side bias mostly washes out of per-player totals. It doesn't wash out of side-split or role comparisons; CT anchors versus T entries would be skewed.
- **Fix to consider:** spread drift across alive players, as a time-and-position term.

## 2026-11-11: Walk-forward gate with recency weighting

**Question:** the fixed 2025 → 2026 split fails on base-rate drift. Does a model retrained monthly with recency weighting stay calibrated through 2026? The fixed split is kept as it is. Moving it until the gate passes would be tuning to the test set.

**Cause first: the shift is within maps, not from the map pool.** CT round win rate rose on every map with real volume:

| Map | 2025 | 2026 | Δ |
| --- | --- | --- | --- |
| Mirage | 0.514 | 0.570 | +0.056 |
| Anubis | 0.443 | 0.478 | +0.035 |
| Nuke | 0.549 | 0.581 | +0.032 |
| Dust2 | 0.484 | 0.510 | +0.026 |
| Ancient | 0.502 | 0.526 | +0.024 |
| Inferno | 0.505 | 0.521 | +0.017 |
| Overpass | 0.547 | 0.557 | +0.009 |

Scoring 2025's per-map rates on 2026's map mix moves CT from 0.507 to only 0.511, against the observed 0.537, so the mix explains about 0.4 of the 2.9 points. By month, CT won 47–50% from January to May 2025 and 52–56% from June 2025 on. The change landed mid-2025, most likely with a patch, so the 2025-only model averaged two eras. A step that recent is what recency weighting handles, so no patch-era feature was tried.

**Method:** `cs2wp walk-forward` (`walkforward.py`).

- Each month of 2026 (2026-01 to 2026-10) is a fold. It trains on every map before the month and scores that month.
- Recency weighting decays each state's weight exponentially by age. The half-life is picked per fold from {none, 365, 180, 90} days on the last 90 days before the month. The test month is never used.
- Tree settings are fixed at the 2025-only grid pick: depth 4, child weight 5, learning rate 0.05, subsample 0.5, colsample 0.8. Tree count comes from early stopping on the same validation window.
- The gate runs on all ten months' predictions pooled. Each month also gets its own gap and noise limit.
- **Intercept recalibration** (reported, not adopted): every Monday, a logistic intercept is refit on the trailing 1,500 out-of-sample rounds and added to that week's logits. Two warm-up folds (2025-11, 2025-12) supply January's history and aren't scored.

**Results** (10.2M states, 2026-01-22 to 2026-10-18):

| Model | Log loss | 95% CI | Max bin gap (limit) | Slope | ECE | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| Fixed split, `full` (previous entry) | 0.4519 | 0.4483–0.4556 | 0.045 (0.043) | 1.042 | 0.013 | FAIL |
| Walk-forward, `full_plant_clock` | **0.4485** | 0.4451–0.4523 | 0.040 (0.041) | 1.023 | 0.011 | **PASS** |
| + weekly intercept | 0.4486 | | 0.039 (0.043) | 1.020 | | PASS |
| Walk-forward, `+ ct_bomb_graph` | 0.4487 | 0.4445–0.4530 | 0.040 (0.041) | 1.027 | 0.010 | PASS |
| + weekly intercept | 0.4488 | | 0.030 (0.044) | 1.024 | | PASS |

- **Gate: PASS, by a thin margin** (0.040 against 0.041). The pooled intercept falls from +0.064 to +0.039. Per-fold intercepts run −0.05 to +0.11.
- **Half-life:** seven of the ten `full_plant_clock` folds pick 365 days, one picks 180 days and two pick no decay. Mild decay is enough. The `ct_bomb_graph` run's picks are spread from 90 days to none.
- **Per month** (`full_plant_clock`): 8 of 10 months are within their own noise limit. The two misses are September (0.128 vs 0.124) and October (0.156 vs 0.120). The weekly intercept brings both under the limit but worsens January and April. Each month has only 100–240 maps, so monthly limits run 0.10–0.30 and are a coarse check.
- **Weekly intercept:** pooled it changes little (gap 0.040 → 0.039), because walk-forward already absorbs the drift. Keep it as a fallback for a sudden patch shift; don't adopt it.
- **Post-plant buckets** (CT alive v T alive; predicted vs observed):

  | Bucket | Rounds | Fixed split, plant clock | Walk-forward, plant clock | + `ct_bomb_graph` |
  | --- | --- | --- | --- | --- |
  | 2v1 | 2,488 | 0.771 vs 0.708 | 0.766 (flagged) | 0.746 (clear) |
  | 4v3 | 1,029 | 0.418 vs 0.494 | 0.435 (flagged) | 0.445 (clear) |
  | 5v3 | 298 | 0.616 vs 0.689 | 0.635 (flagged) | 0.624 (flagged) |
  | 5v4 | 386 | 0.295 vs 0.382 | 0.305 (flagged) | 0.311 (flagged) |

  The plant clock alone barely moves these. CT distance to the planted site (`ct_bomb_graph`, derived from `ct_graph_a/b` and `bomb_site` with no state rebuild) clears 2v1 and 4v3 and lowers ECE. Pooled log loss is unchanged (+0.0002). 5v3 and 5v4 still undervalue CT by 6–7 points, on under 400 rounds each, and the recalibration doesn't fix them.
- **Verdict:**
  - Walk-forward with recency weighting replaces the fixed split as the gate.
  - `full_plant_clock` is the base.
  - `ct_bomb_graph` doesn't clear the log-loss bar in the protocol, but it clears two flagged buckets at no cost. Adopting it needs a decision.

## 2026-11-11: First full-scale gate run

**Data:** `train --ablations` with the defaults.

- Train on 1,709 maps from 2025-01-23 to 2025-12-14 (13.5M states). Fit runs to 2025-08-23, and the grid-search validation fold covers 2025-08-24 to 12-14.
- Test on 1,307 maps from 2026-01-22 to 2026-10-18 (10.2M states).
- 3,015 of 3,113 parsed maps are used. The 97 PGL Masters 2026 maps have no Elo row yet, and the de_contact showmatch has no nav mesh.

| Model | Test log loss | 95% CI | AUC | Slope |
| --- | --- | --- | --- | --- |
| Map average | 0.6957 | 0.6946–0.6969 | 0.528 | 0.275 |
| Logistic | 0.4739 | 0.4702–0.4781 | 0.846 | 0.992 |
| XGBoost replication | 0.4684 | 0.4639–0.4725 | 0.846 | 0.860 |
| XGBoost full | **0.4519** | 0.4483–0.4556 | 0.858 | 1.042 |
| full_euclid | 0.4521 | 0.4476–0.4558 | 0.857 | 1.023 |
| full_no_elo | 0.4545 | 0.4501–0.4583 | 0.855 | 1.020 |
| full_no_kits | 0.4532 | 0.4493–0.4567 | 0.857 | 1.024 |
| full_no_util | 0.4519 | 0.4480–0.4556 | 0.858 | 1.027 |
| full_plant_clock | 0.4495 | 0.4457–0.4540 | 0.859 | 1.041 |
| full_defusing | 0.4519 | 0.4481–0.4562 | 0.858 | 1.036 |
| full_util_types | 0.4518 | 0.4480–0.4555 | 0.858 | 1.037 |

- **Gate: FAIL**, narrowly. Log loss is 0.4519 against 0.535, and the slope is 1.042. The max bin gap is 0.045 against a noise limit of 0.043. Excluding de_cache (under 500 training rounds), the secondary readout passes at 0.043 vs 0.043, slope 1.038. Grid pick: depth 4, child weight 5, 406 trees.
- **Cause: base-rate drift, not overfitting.** CTs won 50.9% of 2025 rounds (37,205) and 53.7% of 2026 rounds (28,103). Mean CT equipment also rose (22.0k → 22.6k) while T equipment fell, but the model already sees equipment. Every bin over the limit is CT under-predicted in the 0.20–0.75 range, by 0.035–0.045, and the intercept is +0.064 (dryrun-constant, trained on H1 2026, was −0.084). ECE improves from 0.018 to 0.013.
- **Rare states mostly fixed by scale.** Of the seven buckets flagged in dryrun-constant (50+ rounds), four clear: 1v1 and 1v2 without a plant, and 2v2 and 4v3 post-plant. Three remain:
  - 2v1 post-plant: 0.769 predicted vs 0.708 observed (2,488 rounds)
  - 5v3 post-plant: 0.611 vs 0.689 (298 rounds)
  - 5v4 post-plant: 0.272 vs 0.382 (386 rounds)

  The model still undervalues CT in man-up retakes, and now also overvalues CT in 2v1 retakes.
- **Ablations:**
  - Only `full_plant_clock` clears the 0.001 bar (−0.0024), but its CI overlaps `full`. Since it targets the post-plant buckets that remain flagged, it is the first candidate to adopt.
  - Dropping Elo (+0.0026) or kits (+0.0013) hurts, so both stay.
  - `full_euclid`, `full_no_util`, `full_defusing` and `full_util_types` are noise (|Δ| ≤ 0.0002).
- **Nav coverage:** 99.88% of positions resolve on average, and early-2025 versions resolve as well as 2026. The pinned release 2000934 covers the full window.
- **Validation** (1,307 test maps, 181 players with 300+ rounds):

  | Metric | Month-to-month r | r with K/D |
  | --- | --- | --- |
  | WPA | 0.432 | 0.816 |
  | nWPA event | 0.396 | 0.935 |
  | nWPA mancount | 0.395 | 0.893 |
  | Rating 2.0 (approx.) | 0.470 | 0.947 |
  | Rating 3.0 | 0.455 | 0.881 |
  | Swing | 0.432 | 0.886 |

  WPA stability (0.432) beats the paper's 0.40 and ties Swing, but stays below both HLTV ratings.

## 2026-11-05: Noise-aware bin gate

**Change:** the bin-gap limit is now max(0.03, the p95 noise limit from a round bootstrap). See the Gate section of [win-probability.md](win-probability.md). On synthetic calibrated data with round-shared outcomes, the false-fail rate is 2.5% over 40 seeds. The Platt recalibration path and the training recipe keyed on the model's name (`dryrun-*`) were removed. Every non-replication variant now uses constant weights, `GRID_FULL`, early stopping and monotone constraints.

**dryrun-constant rescored (no retrain):**

| Test set | Log loss | Max bin gap | Limit | Slope | Gate |
| --- | --- | --- | --- | --- | --- |
| All H2 2026 | 0.4520 | 0.077 | 0.070 | 1.037 | FAIL |
| Excluding de_cache | 0.4511 | 0.088 | 0.077 | 1.048 | FAIL |

The miss is small but real: 10 of the 17 bins over 0.03 sit beyond 2 SE. It lines up with the flagged clutch and post-plant buckets.

## 2026-11-05: Constant weights replace round weighting (dryrun-constant)

**Question:** the 1/states-in-round weights from step 1 depend on round length, and round length depends on the outcome. T-won rounds average 392 states, CT-won rounds 340. That shifts the effective CT rate from 0.501 (per state, how the test scores) to 0.537 (per round). Does a constant weight (rounds ÷ states) remove the CT lean that steps 1–3 show (intercept −0.148 to −0.159, against −0.094 before weighting)?

**Data:** `train --test-from 2026-07-01 --model dryrun-constant --ablations`, with the step 2 grid and step 3 monotone constraints, and only the weights changed.

| Model | Test log loss | 95% CI | AUC | Slope |
| --- | --- | --- | --- | --- |
| Map average | 0.6936 | 0.6918–0.6951 | 0.523 | 0.504 |
| Logistic | 0.4665 | 0.4591–0.4734 | 0.851 | 1.022 |
| XGBoost replication | 0.4782 | 0.4701–0.4868 | 0.843 | 0.785 |
| XGBoost full | **0.4520** | 0.4445–0.4593 | 0.858 | 1.037 |
| full_euclid | 0.4525 | 0.4453–0.4599 | 0.858 | 1.027 |
| full_no_elo | 0.4538 | 0.4466–0.4610 | 0.857 | 1.010 |
| full_no_kits | 0.4489 | 0.4422–0.4554 | 0.860 | 1.048 |
| full_no_util | 0.4514 | 0.4453–0.4582 | 0.859 | 1.053 |
| full_plant_clock | 0.4483 | 0.4413–0.4535 | 0.860 | 1.046 |
| full_defusing | 0.4514 | 0.4433–0.4576 | 0.859 | 1.043 |
| full_util_types | 0.4512 | 0.4436–0.4574 | 0.859 | 1.038 |

**Kept.** The weighting is now unbiased by construction, and the results are no worse.

- **Calibration improves:** intercept −0.155 → −0.084, ECE 0.025 → 0.018. Log loss 0.4509 → 0.4520 and max bin gap 0.074 → 0.077 are both within noise. Grid pick: depth 4, child weight 1, 345 trees.
- **The 0.03 bin gate is unreachable on this test set.** States in a round share one outcome, so each bin's gap has a round-bootstrap SE of about 0.018 (444 maps, 9,564 rounds, 366 states per round). Shifting the bootstrap to center on perfect calibration gives a max bin gap of 0.052 at the median and 0.070 at p95. The observed 0.077 is just past that. Of the 17 bins over 0.03, 10 are beyond 2 SE. All of 2026 as a test set (about 3× the rounds) would put the perfect-calibration median near 0.03, so a perfect model would fail about half the time. The criterion needs to become noise-aware before the real gate run.
- **Flagged buckets are unchanged:** 1v1 without a plant (0.658 predicted vs 0.577 observed), 1v2 without a plant (0.218 vs 0.119), 5v3 post-plant (0.640 vs 0.791), 5v4 post-plant (0.274 vs 0.399). These are the real remaining errors.
- **Ablations:** `full_plant_clock` (−0.004) and `full_no_kits` (−0.003) lead again, but both CIs overlap `full`.
- **Validation:** WPA month-to-month r is 0.428 (0.425 in step 3), above the paper's 0.40 but below Rating 2.0 (0.447) and Rating 3.0 (0.445). r with K/D is 0.779.

## 2026-11-04: Step 3 — Monotone constraints (dryrun-monotone)

**Question:** do monotone constraints (+1 on alive count, HP, kits; −1 on T alive, HP) regularize rare bucket predictions (1v1, 1v2, 5v3) and reduce max bin gap?

**Data:** `train --test-from 2026-07-01 --model dryrun-monotone --ablations`.

| Model | Test log loss | 95% CI | AUC | Slope |
| --- | --- | --- | --- | --- |
| Map average | 0.6936 | 0.6920–0.6948 | 0.523 | 0.504 |
| Logistic | 0.4665 | 0.4599–0.4739 | 0.851 | 1.022 |
| XGBoost replication | 0.4782 | 0.4710–0.4866 | 0.843 | 0.785 |
| XGBoost full | **0.4509** | 0.4437–0.4579 | 0.860 | 1.013 |
| full_euclid | 0.4509 | 0.4438–0.4582 | 0.860 | 1.002 |
| full_no_elo | 0.4525 | 0.4451–0.4606 | 0.859 | 0.975 |
| full_no_kits | 0.4509 | 0.4438–0.4577 | 0.860 | 1.007 |
| full_no_util | 0.4511 | 0.4436–0.4585 | 0.860 | 0.999 |
| full_plant_clock | 0.4481 | 0.4413–0.4543 | 0.861 | 1.010 |
| full_defusing | 0.4509 | 0.4444–0.4573 | 0.860 | 0.995 |
| full_util_types | 0.4509 | 0.4445–0.4582 | 0.860 | 1.007 |

- **Gate:** log loss 0.4509 vs 0.535, max bin gap 0.074, slope 1.013 (FAIL on max bin gap).
- **Secondary gate (excluding de_cache):** log loss 0.4524, max bin gap 0.075, slope 1.006.
- **Slope stays calibrated (1.013).** Platt recalibration was not needed because steps 1–3 achieved a slope inside [0.95, 1.05].
- **Bucket shifts:** 1v1 unplanted prediction drops from 0.678 to 0.645 (closer to 0.577 observed, gap drops from 0.101 to 0.069).
- **Validation** (444 test maps, 171 players with 300+ rounds):
  - WPA month-to-month stability $r = 0.425$ (up from 0.388 in dryrun-2026h1 and 0.385 in dryrun-weighted, exceeding the paper's 0.40).
  - WPA correlation with K/D $r = 0.770$ (consistent with the paper's 0.73).

## 2026-11-04: Step 2 — Regularized grid with early stopping (dryrun-regularized)

**Question:** does restricting tree depth (3–6), increasing child weight (1–50 on weighted scale) and adding early stopping on validation fix the calibration slope?

**Data:** `train --test-from 2026-07-01 --model dryrun-regularized --ablations`.

| Model | Test log loss | 95% CI | AUC | Slope |
| --- | --- | --- | --- | --- |
| Map average | 0.6936 | 0.6922–0.6951 | 0.523 | 0.504 |
| Logistic | 0.4665 | 0.4598–0.4725 | 0.851 | 1.022 |
| XGBoost replication | 0.4782 | 0.4705–0.4873 | 0.843 | 0.785 |
| XGBoost full | **0.4512** | 0.4438–0.4577 | 0.860 | 1.003 |
| full_euclid | 0.4514 | 0.4437–0.4580 | 0.860 | 0.997 |
| full_no_elo | 0.4525 | 0.4450–0.4591 | 0.859 | 0.988 |
| full_no_kits | 0.4510 | 0.4447–0.4583 | 0.860 | 1.006 |
| full_no_util | 0.4515 | 0.4453–0.4578 | 0.860 | 0.991 |
| full_plant_clock | 0.4483 | 0.4421–0.4560 | 0.862 | 0.996 |
| full_defusing | 0.4507 | 0.4436–0.4569 | 0.860 | 1.005 |
| full_util_types | 0.4513 | 0.4442–0.4590 | 0.860 | 0.990 |

- **Gate:** log loss 0.4512 vs 0.535, max bin gap 0.067, slope 1.003 (FAIL on max bin gap).
- **Slope hits 1.003**, recovering from 0.783 in dryrun-2026h1. Log loss drops from 0.4797 to 0.4512.
- The grid selected depth 4 and min_child_weight 5 with ~320 trees, cutting variance dramatically.

## 2026-11-04: Step 1 — Round weighting (dryrun-weighted)

**Question:** does weighting each state by $1 / \text{states\_in\_round}$ stop XGBoost from fingerprinting rounds through round-constant equipment and Elo?

**Data:** `train --test-from 2026-07-01 --model dryrun-weighted --ablations`.

| Model | Test log loss | 95% CI | AUC | Slope |
| --- | --- | --- | --- | --- |
| Map average | 0.6936 | 0.6920–0.6951 | 0.523 | 0.504 |
| Logistic | 0.4664 | 0.4591–0.4740 | 0.851 | 1.022 |
| XGBoost replication | 0.4782 | 0.4700–0.4869 | 0.843 | 0.785 |
| XGBoost full | **0.4621** | 0.4551–0.4699 | 0.853 | 0.877 |
| full_euclid | 0.4626 | 0.4554–0.4704 | 0.853 | 0.872 |
| full_no_elo | 0.4600 | 0.4537–0.4673 | 0.855 | 0.878 |
| full_no_kits | 0.4604 | 0.4525–0.4696 | 0.854 | 0.887 |
| full_no_util | 0.4632 | 0.4542–0.4713 | 0.853 | 0.869 |
| full_plant_clock | 0.4592 | 0.4509–0.4659 | 0.855 | 0.870 |
| full_defusing | 0.4629 | 0.4558–0.4709 | 0.853 | 0.863 |
| full_util_types | 0.4605 | 0.4523–0.4694 | 0.855 | 0.881 |

- **Superseded (2026-11-05):** these weights biased the model toward CT, because T-won rounds run longer. They were replaced by constant weights; see dryrun-constant.
- **Gate:** log loss 0.4621 vs 0.535, max bin gap 0.107, slope 0.877 (FAIL).
- **Secondary gate (excluding de_cache):** log loss 0.4631, max bin gap 0.099, slope 0.871.
- **XGBoost full overtakes logistic regression** (0.4621 vs 0.4664). Slope rises from 0.783 to 0.877 and max gap falls from 0.118 to 0.107, but depth 6–12 without early stopping is still under-regularized.

## 2026-11-04: Dry run on 2026 only (not a gate result)

**Question:** before the 2025 backfill lands, does the model hold up at real scale, and which experiments matter?

**Data:** `train --test-from 2026-07-01 --model dryrun-2026h1 --ablations`.

- Train on 868 maps from 2025-11-24 to 2026-06-21 (6.76M states). This is mostly H1 2026, plus the 5 StarLadder Major maps parsed so far.
- Test on 444 maps from 2026-07-30 to 2026-10-18 (3.50M states).

| Model | Test log loss | 95% CI | AUC | Slope |
| --- | --- | --- | --- | --- |
| Map average | 0.6936 | | 0.523 | |
| Logistic | **0.4664** | 0.4583–0.4738 | 0.851 | 1.022 |
| XGBoost replication | 0.4782 | 0.4688–0.4864 | 0.843 | 0.785 |
| XGBoost full | 0.4797 | 0.4721–0.4899 | 0.843 | 0.783 |
| full_euclid | 0.4807 | | | 0.770 |
| full_no_elo | 0.4770 | | | 0.784 |
| full_no_kits | 0.4812 | | | 0.772 |
| full_no_util | 0.4798 | | | 0.789 |
| full_plant_clock | 0.4776 | | | 0.776 |
| full_defusing | 0.4826 | | | 0.765 |
| full_util_types | 0.4782 | | | 0.789 |

Under the gate, `full` would fail. It beats the paper's log loss (0.480 vs 0.535), but its max bin gap is 0.118 against a limit of 0.03, and its slope is 0.783 against [0.95, 1.05].

- **XGBoost memorizes rounds at full scale too.** Validation log loss rises steadily with depth: 0.483 at depth 6, 0.53 at 8, 0.59 at 10 and 0.66 at 12. The grid picks its most regularized corner (depth 6, child weight 7). Unpenalized logistic regression beats every tree model and is calibrated (slope 1.02). That means the problem is variance, not missing signal. The paper's grid can't regularize enough for about 7.8k states per map. Per-round weighting, a much larger `min_child_weight`, shallower trees and early stopping move from queued to first in line.
- **Ablations are all inside the noise of an overfit model.** Dropping Elo (−0.003) and adding the plant clock (−0.002) help slightly, and adding defusing hurts (+0.003), but every CI overlaps. Re-judge them once the base model is calibrated.
- **Flagged buckets (full):**
  - 1v1 without a plant: 0.678 predicted vs 0.577 observed (423 rounds)
  - 1v2 without a plant: 0.196 vs 0.119 (598 rounds)
  - 5v3 post-plant: 0.681 vs 0.791 (113 rounds)
  - 5v4 post-plant: 0.317 vs 0.399 (146 rounds)

  The model favors CT in clutches without a plant and undervalues CT in man-up retakes.
- **Importance:** bomb planted 29, T alive 24, CT alive 21, T utility 3.8. Equipment is only 2.5–2.7. The paper's ranking still doesn't reproduce.
- **Validation** (444 test maps, 171 players with 300+ rounds; WPA credited by this ungated model):

  | Metric | Month-to-month r | r with K/D |
  | --- | --- | --- |
  | WPA | 0.388 | 0.745 |
  | nWPA event | 0.372 | 0.927 |
  | nWPA mancount | 0.335 | 0.880 |
  | Rating 2.0 (approx.) | 0.447 | 0.953 |
  | Rating 3.0 | 0.445 | 0.893 |
  | Swing | 0.396 | 0.864 |

  WPA matches the paper's pattern: stability near the paper's 0.40, and correlation with K/D near the paper's 0.73. Unlike the paper, though, WPA is less stable than Rating 2.0 here, not more.

## 2026-10-23: Smoke run on Thunderpick 2026 (not a gate result)

**Question:** does the pipeline run end to end, from mirror to states to train, credit and validate?

**Data:** Thunderpick World Championship 2026 only.

- Train on 24 maps from 2026-10-14 to 16 (197k states).
- Test on 13 maps from 2026-10-17 to 18 (110k states).

| Model | Test log loss | Notes |
| --- | --- | --- |
| Map average | 0.711 | |
| Logistic | 0.504 | |
| XGBoost replication | 1.053 | depth 6, child weight 3 |
| XGBoost full | 0.934 | depth 6, child weight 7 |

- **XGBoost overfits badly on about 600 training rounds.** The paper's grid has no setting shallow or regularized enough for this little data. This says nothing about the gate. It's a reason to watch for round memorization at full scale.
- **Importance in `full`:** alive counts (20% each) and bomb planted (14%) lead. The paper's ranking leads with equipment.
- **Credit and validation run.** HLTV Rating 3.0 and Swing joined for all 35 players with 300+ rounds.
