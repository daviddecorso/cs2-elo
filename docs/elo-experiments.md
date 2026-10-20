# Elo experiments

## Overview

A log of every change tried on the Elo model ([elo-model.md](elo-model.md)), including the ones that didn't help, so nothing is re-run blind. Newest first. Unless an entry says otherwise, the protocol is: tune on 2024–2025 series log loss with `npm run backtest-elo -- --tune`, and judge on the 2026 gate set (8,490 series where both rosters have VRS points).

Calibration columns come from the backtest's calibration block. **Slope** is a logistic fit of outcome on logit(p), where 1 is calibrated and below 1 is overconfident. **ECE** is the size-weighted gap between predicted and actual favourite win rates across ten bins.

An entry is kept only if it lowers gate log loss. Tuning moves of under 0.0005 count as noise. To try one value without retuning, use `npm run backtest-elo -- --set key=value` (repeatable).

## Untried ideas

- Tier 2 calibration (slope 0.54 on 377 series). Check how tier 2 events are classified before adding a parameter.
- A LAN vs online split for `seriesMapTemp`.
- Walk-forward validation (tune on 2024, score 2025) to check that the parameters are stable across years.

## 2026-10-20: Series map temperature (`seriesMapTemp`) — kept

**Change:** Before the Bo3/Bo5 binomial, scale the pool-average map logit by `seriesMapTemp`. Bo1 and per-map predictions are unchanged, and so are rating updates. In the same run, `tierGap`'s search ceiling went from 400 to 800 and everything was retuned.

| | Before | After |
| --- | --- | --- |
| Train series log loss | 0.6132 | 0.6114 |
| Gate (VRS 0.6489) | 0.6148 | **0.6135** |
| Cross-region (VRS 0.6505) | 0.6342 | 0.6271 |
| Every 2026 series | 0.5984 | 0.5968 |
| Test series slope / ECE | 0.888 / 0.0126 | 0.993 / 0.0078 |
| Test Bo3 slope | 0.855 | 0.993 |

- `seriesMapTemp` settled at 0.8. A 60% map favourite is treated as about 58% per map when building Bo3 odds.
- With the series fix in place, the post-hoc temperature has nothing left to fix: it fits 0.955 on train and scores 0.6137 on the gate.
- The retune also moved:
  - `crossRegionK` 1.25 → 1 (the cross-region gain came from calibration, not extra K)
  - `marginWeight` 0.5 → 0.75
  - `onlineK` 1 → 0.9
  - `standInK` 1 → 1.2
  - `coreWindow` 7 → 6
  - `tierGap` 375 → 475, no longer at a bound
- `kMap` was pinned at 4 by hand. The tuner drove it to 0 for a train gain of 0.00001, but at 4 test maps score 0.6276 (vs 0.6282 at 0) and the gate is 0.6135 (vs 0.6136). Map offsets contribute almost nothing to log loss. They stay because the rankings page shows them.
- Leftover miscalibration: tier 2 series (n=377) have slope 0.54. LAN series are now slightly underconfident (1.14), while online series are slightly overconfident (0.94).

## 2026-10-20: Calibration diagnostics

**Question:** Test bins above 70% ran 1.5–4 points overconfident. Where does that come from?

**Finding:** The map-to-series conversion. The ratings are fine.

| Slice (2026) | n | Slope | ECE |
| --- | --- | --- | --- |
| Maps | 35,446 | 1.039 | 0.006 |
| Bo1 series | 3,264 | 1.075 | 0.021 |
| Bo3 series | 13,431 | 0.855 | 0.017 |
| Bo5 series | 143 | 0.768 | 0.073 |
| Provisional (< 70 maps) | 9,037 | 0.908 | 0.018 |
| Established | 7,801 | 0.870 | 0.018 |
| Idle > 30 days | 1,138 | 0.925 | 0.038 |
| LAN | 4,268 | 1.022 | 0.020 |
| Online | 12,570 | 0.842 | 0.018 |

- Maps and Bo1 are calibrated, while Bo3 and Bo5 are overconfident. The binomial treats maps in a series as independent draws at the pool-average probability, but they're positively correlated: both share the same rating error, and each side picks its own map.
- Train series show the same slope (0.896), so this isn't 2026 drift.
- New and idle rosters aren't more overconfident than established ones. That rules out Glicko-style rating uncertainty and inactivity decay as the fix, so neither was built.
- A post-hoc temperature fit on train (slope 0.896) brings the gate to 0.6134, from 0.6148. That's the ceiling for a pure calibration fix.
- **Seeding signal:** opponent1 on Liquipedia wins 56.0% of 2024–2026 series against an Elo mean of 54.4%, and 54.8% of maps against 53.3%. This is the positive intercept in every slice, probably because opponent1 is usually the higher seed. It isn't used, since team order means nothing for a hypothetical matchup.

## 2026-10-20: Initial tuning

**Change:** The first coordinate-descent run from `STARTING_PARAMS`.

| Set | Untuned | Tuned |
| --- | --- | --- |
| Gate (Elo vs VRS 0.6489) | 0.6341 | 0.6148 |
| Cross-region (VRS 0.6505) | 0.6594 | 0.6342 |

What moved, and what it means:

- `regress` 0.5 → 0 and `newRosterRegress` 0.3 → 0. Pulling a changed roster toward the tier mean hurts, because the 3-of-5 continuity rule plus seeding from players' old ratings already carries enough. **Rejected:** roster-change regression.
- `onlineK` 0.8 → 1. **Rejected:** down-weighting online maps.
- `standInK` stayed at 1, and stand-in series score about the same as the rest. **Rejected:** down-weighting stand-ins.
- `crossRegionK` 1.5 → 1.25. **Kept:** international results count for more.
- `tierK` stayed at 0.9 per tier below tier 1. **Kept.**
- `tierGap` 100 → 375, close to the 400 bound. Lower-tier newcomers start well below tier 1, and `provisionalK` 2.5 over 70 maps lets them move quickly.
- `k` 24 → 12, `otMargin` 2 → 1, `kMap` 6 → 4, `mapShrink` 0.01 → 0.02, `coreWindow` 5 → 7. `marginWeight` stayed at 0.5.

## Blocked

- **Veto model.** The API has no veto data: none of the 11,462 stored 2026 matches has a veto field. A play-share proxy for picks and bans is still untried.
