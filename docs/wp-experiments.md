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
- **Rare-state calibration**, if the bucket check flags 1vX retakes or late post-plant:
  - monotone constraints on alive count, HP and kits
  - more trees with early stopping
- **Per-round weighting** (each round's states weighted 1/n), if XGBoost memorizes rounds. Equipment and Elo are constant within a round and nearly unique per round. That makes memorizing easy, and the smoke run below shows it.

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
