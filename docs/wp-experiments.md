# Win-probability experiments

## Overview

A log of every change tried on the win-probability model ([win-probability.md](win-probability.md)), kept or rejected, newest first.

**Protocol:**

1. Train on 2025 maps with `uv run cs2wp train --ablations`.
2. Judge on test log loss (2026+).
3. Check calibration by bucket as well as overall.

A variant replaces `full` only if it lowers test log loss without worsening a flagged bucket. Moves under 0.001 count as noise.

## Queued for the first full run

- Graph vs Euclidean distance (`full_euclid`).
- Each CS2 addition dropped: `full_no_elo`, `full_no_kits`, `full_no_util`.
- Additions: `full_plant_clock` (seconds since plant, for late post-plant), `full_defusing` and `full_util_types`.

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
