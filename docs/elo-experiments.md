# Elo experiments

## Overview

A log of every change tried on the Elo model ([elo-model.md](elo-model.md)), including the ones that didn't help, so nothing is re-run blind. From 2026-11-21, each entry names the assumption it tests in [elo-assumptions.md](elo-assumptions.md), and a lever that contradicts a Held assumption meets the higher bar set there. Newest first. Unless an entry says otherwise, the protocol is: tune on 2024–2025 series log loss with `npm run backtest-elo -- --tune`, and judge on the 2026 gate set (8,490 series where both rosters have VRS points).

Calibration columns come from the backtest's calibration block. **Slope** is a logistic fit of outcome on logit(p), where 1 is calibrated and below 1 is overconfident. **ECE** is the size-weighted gap between predicted and actual favourite win rates across ten bins.

An entry is kept only if it lowers gate log loss. Tuning moves of under 0.0005 count as noise. **Region-only changes** (declared 2026-11-19, since cross-region is 8% of the gate and caps any gain there near 0.0002) are judged by `npm run backtest-elo -- --region-walk` instead. That command fits on 2024 and scores 2025, then fits on 2024–25 and scores 2026, and pools the two test years. To pass, the cross-region series gain must have a 90% event CI above 0, and the 2026 gate must be no more than 0.0002 worse. To try one value without retuning, use `npm run backtest-elo -- --set key=value` (repeatable).

**Tier-1 LAN rule** (declared 2026-11-21, before any run under it). Majors are tier-1 LAN, which is about 4% of 2026 test series, so a lever that only acts there can't clear the 0.0005 gate bar. A lever has to be declared Major-relevant before its run to be judged this way. Judge it with `npm run backtest-elo -- --walk key=v1,v2,…`, which fits on 2024 and scores 2025, then fits on 2024–25 and scores 2026. To pass, the pooled gain on tier-1 LAN series (Liquipedia tier 1, LAN) must have a 90% event CI above 0, and the 2026 gate must be no more than 0.0002 worse.

## Untried ideas

- A temperature scoped to online tier-1 qualifiers (tournament `publishertier` "Tier 1 Qualifier" / `liquipediatiertype` Qualifier or Online Stage) rather than all of tier 2. It's where the 2026 tier-2 overconfidence sits (see the tier-2 entry below), but it can't clear the gate on its own either. It only matters for the simulator's qualifier odds.

## 2026-11-22: Better veto choice model in series odds — rejected for odds, kept for display

**Question:** The veto choice model's play preference now decays and starts new pool maps neutral, with separate ban and pick weights, which lifts 2026 top-choice accuracy from 52% to 64% on Liquipedia inputs. Do series odds that play out the veto now beat pool-averaged Elo? Assumption tested: "Strength is one number per team, plus small map preferences" ([elo-assumptions.md](elo-assumptions.md)), the map half.

**Protocol:** `cs2wp sim-veto`: fit before 2026, scored on every 2026 series, gate "no worse on all series", events resampled.

| Series | n | Current | `hltv` gain (90% CI) | `liquipedia` gain (90% CI) |
| --- | --- | --- | --- | --- |
| All | 17,132 | 0.5957 | −0.0001 (−0.0003, +0.0001) | −0.0002 (−0.0004, +0.0001) |
| Vetoed | 616 | 0.6116 | −0.0001 (−0.0023, +0.0021) | +0.0003 (−0.0014, +0.0020) |

**Rejected for odds:** both fail the gate within noise, and knowing the real maps is no better (−0.0003), as on 2026-11-19. The forecast ships on `/matches` as labels only ([simulator.md](simulator.md#veto-predictions-on-matches)), and win odds don't read it.

## 2026-11-21: Head-to-head persistence (style matchups)

**Question:** Elo is transitive: one number per team, plus map offsets. If teams have styles or pools that suit or don't suit a given opponent, a pair's results against each other should keep missing Elo in the same direction. Do they? Assumption tested: "Strength is one number per team, plus small map preferences" ([elo-assumptions.md](elo-assumptions.md)), the styles half (Open).

**Declared test (written before any run):** `npm run backtest-elo -- --h2h`.
- **Pair residual, per map.** Sum side A's map residuals (y − p) against this same opponent lineage, from earlier series only, with a 365-day decay. Divide by the decayed map count plus 10.
- **Control.** Each side's residual against everyone, built as `--residual-lead` does (shrink 40 maps, decay 365 days), taken as A minus B.
- **Fit.** A logistic regression with offset logit(p) on [pair, control], run separately on 2025 maps (the mechanism year) and 2026 maps (the test year).
- **Pass:** the pair coefficient is positive in 2025, and positive with z ≥ 2 in 2026. A matchup term then gets built and judged by the gate. Otherwise styles stay Open with this test logged against them. If both years sit near 0 with tight SEs, styles move to Rejected.
- **For information:**
  - tier 1;
  - pairs with 3+ earlier maps;
  - the same-map pair residual;
  - the 2026 map log loss gain from applying the 2025 coefficients, with an event-clustered CI.

**Result: fails, not built.** Pair coefficients are on map logit per unit of pair residual. SEs are unclustered, so they flatter the z-scores.

| Slice | 2025 | 2026 |
| --- | --- | --- |
| All maps (41,256 / 39,018) | +1.09 ± 0.27 (z 3.98) | +0.50 ± 0.29 (z 1.72) |
| Same-map pair residual | +0.41 ± 0.47 | +0.59 ± 0.50 |
| Tier 1 | +0.31 ± 1.08 | −1.16 ± 1.06 |
| Pairs with 3+ earlier maps | +0.82 ± 0.32 | +0.40 ± 0.34 |
| Control: each side's form | −2.49 ± 0.36 | −3.14 ± 0.41 |

- **There's a matchup effect, but it's tiny.** It's positive in both years, and 2025 is clearly above 0. 2026 misses z 2. Where a pair has met, their residual has an SD of 0.056, so one SD is worth 0.03–0.06 on the map logit, about 1 point of win probability.
- **It's worth nothing to predictions.** Applying the 2025 coefficients to 2026 maps gains −0.00001 (90% CI −0.00017 to 0.00015) over form alone.
- **No effect at tier 1.** The sign flips between years, and the 2026 estimate is negative. This is where teams prepare for specific opponents, and it doesn't show.
- **Per-map matchups add nothing over the whole pair.** Same-map pair residuals are noisier and no stronger.
- **Side finding:** the control is strongly negative in both years. A side's recent residual against everyone predicts it will miss the other way next, so Elo still over-reacts a little. `--residual-lead` and burst damping already cover this.

## 2026-11-21: Tier-1 LAN overconfidence by year — not built, diagnostic only

**Question:** At tier-1 LANs the field is closer in level and teams prepare for specific opponents, unlike tier 2–3 teams grinding the same rivals online. Is Elo overconfident there in a way a tier-1 LAN temperature could fix? The Major backtest's series slope is 0.80. Assumption tested: "Preparation decides tier-1 games in ways Elo can see" ([elo-assumptions.md](elo-assumptions.md)).

**Diagnostic** (`npm run backtest-elo` now prints tier-1 LAN series and maps by year):

| Year | Series | Current params: log loss (slope) | A2: log loss (slope) |
| --- | --- | --- | --- |
| 2024 | 684 | 0.6387 (0.611) | 0.6487 (0.564) |
| 2025 | 783 | 0.6141 (0.870) | 0.6122 (0.895) |
| 2026 | 661 | 0.6021 (0.994) | 0.6042 (1.016) |

- **Not built.** The overconfidence was real in 2024 and 2025 but is gone in 2026. A temperature fit on earlier years would flatten 2026 odds that are already calibrated. The 2026-11-18 tier-1 `TIER_TEMP` fit hit the same thing. The Majors follow the same trend: the 0.80 comes from Copenhagen (0.57) and Austin (0.50), while Cologne is 1.42.
- **A2 at tier-1 LAN:** calibrated in 2026 but still worse, so its tier-1 loss is in where it puts ratings, not how sharp its odds are. A tier-1 temperature on top wouldn't rescue it. It's also worse on 2024, partly because it sharpens odds that were already overconfident there. 2025 is its tune year.

## 2026-11-21: Round-share target (`roundWeight`) and insularity offset (`insularityPrior`) — neither kept

**Question:** Two levers that might close the Major gap with the Supercomputer haven't been tried.
- **Round share, all tiers.** Elo learns from the binary map result, and margin only scales K. A 13-11 win and an 11-13 loss move ratings in opposite directions by about the same amount. Does learning from round share (efficiency, as SP+ or KenPom do) help?
- **Insularity, Asia.** Asian rosters with 50%+ own-region share of maps are overrated against other regions, by 35–59 points (2026-11-19 diagnostic). The gap is larger at LANs. Does an offset scaled by own-region share help where Majors are played?

**Declared tests (written before any run):**
- **A, `roundWeight` w and `roundSlope` c.** The update target becomes `(1 − w)·y + w·σ(c·signed margin)`. Predictions are unchanged. Run `npm run backtest-elo -- --tune` on 2025 with both free, from w 0 and c 0.25. Keep it if the 2026 gate improves by more than 0.0005 against 0.6090. Tier-1 LAN is reported for information only.
- **B, `insularityPrior` (points, ≤ 0).** On a cross-region map, a rest-of-Asia roster (not Oceania, which has its own prior) with at least 10 maps in the last 180 days gets `insularityPrior · max(0, share − 0.5) / 0.5` added to its side of the gap. Share counts Valve regions, as the diagnostic did. It's predictions-only (`insularityInUpdate` 0), and in-update is a variant. Judged by the tier-1 LAN rule, with `--walk insularityPrior=0,-10,-20,-30,-40,-50,-60,-80 --walk-fit cross`.
- **Joint A + B.** One `--walk` with `roundWeight` in {0, A's tuned w} at A's tuned c, crossed with B's grid. The walk fits on all series, and the result is judged by the tier-1 LAN rule. It's run once and logged whatever the result.
- **Conditional.** A CT/T side split from Liquipedia half scores is built only if A's tuned w is above 0 and A gains on the gate or on tier-1 LAN.
- **A2, declared after A's run.** A's run showed map-level predictions underconfident on 2025 train (slope 1.26). A2 adds `predictionTemp`, a map-logit multiplier on every prediction (maps, Bo1, series and the simulator's map odds, but not the update's expected score), tuned with A's params. Same protocol as A. Tier-1 LAN and the Major backtest are reported for information.

**A, round share.** The tune drove `roundWeight` to 1, its upper bound, with `roundSlope` 0.4. It also moved `onlineK` 1 → 1.1, `crossRegionK` 0.75 → 1, `otMargin` 1 → 2, `seriesMapTemp` 0.9 → 1.05, `burstDays` 16 → 18 and `mapShrink` 0.01 → 0.02. 2025 train went 0.59936 → 0.59719.

| Run | Gate | 2026 maps (slope) | 2026 tier 1 | 2026 LAN Bo1 slope |
| --- | --- | --- | --- | --- |
| Current params | 0.6090 | 0.6247 (1.04) | 0.6057 | – |
| A, tuned | **0.6077** | 0.6258 (1.26) | 0.6067 | 1.44 |
| Round share alone, other params current | 0.6093 | – | 0.6068 | – |
| A's other moves, round share off | 0.6118 | – | 0.6102 | – |

A passes the gate, but only because `seriesMapTemp` sharpens Bo3. Learning from round share compresses rating gaps, so map and Bo1 odds come out underconfident (slope 1.26 and 1.44). Neither half works alone. Not kept in this form, because the simulator prices maps and Bo1 directly.

**A2, round share with `predictionTemp`.** The tune reached `roundWeight` 1, `roundSlope` 0.35 and `predictionTemp` 1.25. It also moved `otMargin` 1 → 2, `onlineK` 1 → 1.1, `crossRegionK` 0.75 → 1, `burstDays` 16 → 18 and `regionPriorOceania` −175 → −150. `seriesMapTemp` stayed at 0.9, and 2025 train went 0.59936 → 0.59613.

| 2026 slice | Series | Before | A2 | Paired gain (90% event CI) |
| --- | --- | --- | --- | --- |
| Gate | 9,375 | 0.6090 | **0.6077** | +0.0014 (+0.0005, +0.0023) |
| All | 18,424 | 0.5926 | 0.5904 | +0.0022 (+0.0015, +0.0029) |
| Cross-region | 1,002 | – | – | +0.0048 (+0.0015, +0.0083) |
| Tier-1 LAN | 661 | – | – | −0.0021 (−0.0063, +0.0020) |
| Maps (slope) | 39,018 | 0.6247 (1.04) | 0.6227 (1.06) | – |
| Bo1 (slope) | 3,428 | 0.5836 (1.06) | 0.5807 (1.08) | – |

The paired CIs come from `npm run backtest-elo -- --walk` with A2's eight values as a single-point grid; only its 2026 fold is out of sample. The Major backtest (`npm run backtest-majors -- --set …`) gets worse:

| Majors | Before | A2 |
| --- | --- | --- |
| Stage log loss (18 blocks) | 1.1307 | 1.1409 |
| Advance log loss | 0.5309 | 0.5356 |
| Elo − Supercomputer, 8 blocks | −0.003 | +0.007 (CI −0.031, +0.043) |
| Major series log loss (slope) | 0.6396 (0.80) | 0.6421 (0.77) |

- **A2 passes the declared gate**, with a CI above zero on the gate and on all series. The gain is broad: online, LAN and cross-region all improve.
- **Tier-1 LAN and Majors lean worse**, though neither is significant. Round share helps most where results are noisiest, in tier 3–4 and online play. Majors are the opposite.

**B, insularity.** Fails the tier-1 LAN rule in both forms. Both folds pick −80, the edge of the grid, so cross-region training loss wants more, but tier-1 LAN doesn't move.

| Variant | 2025 tier-1 LAN | 2026 tier-1 LAN | Pooled tier-1 LAN (90% CI) | 2026 cross-region | 2026 gate |
| --- | --- | --- | --- | --- | --- |
| Predictions only | +0.0001 | −0.0002 | −0.0000 (−0.0012, +0.0012) | +0.0011 (−0.0017, +0.0039) | +0.0001 |
| In update | −0.0003 | −0.0004 | −0.0004 (−0.0012, +0.0006) | +0.0003 (−0.0020, +0.0027) | −0.0000 |

**Joint A + B** (run once, with A2's values in place of A's): `--set roundSlope=0.35 --walk roundWeight=0,1 --walk predictionTemp=1,1.25 --walk insularityPrior=0,…,−80 --walk-fit all`.
- **2024 → 2025:** picks w 1, temperature 1, insularity −60. Tier-1 LAN gains +0.0049 (+0.0004, +0.0093), all series −0.0007.
- **2024–25 → 2026:** picks w 1, temperature 1.25, insularity −40. Tier-1 LAN −0.0018 (−0.0073, +0.0028), gate +0.0014.
- **Pooled tier-1 LAN:** +0.0018 (−0.0017, +0.0051). **Fails.** The years disagree in sign.

**A3, tier-scaled round share (declared before its run).** A2 isn't kept as it stands, because Majors are the reason for this work. In A3, tier-1 series update with `roundWeight · roundTier1Scale` (0–1, step 0.1) instead of `roundWeight`. A3 is tuned with `npm run backtest-elo -- --tune` on 2025, starting from A2's values with every step free. All three conditions must hold to keep it:
1. The 2026 gate improves by more than 0.0005 against 0.6090.
2. The 2026 tier-1 LAN paired gain against current params is ≥ 0.
3. The Major backtest's stage log loss is no worse than 1.1307.

The tier-1 LAN rule's walk can't be used, because the round values are tuned on 2025 and its first fold would score them in-sample, so condition 2 stands in for it on 2026 alone. If A3 fails, nothing is kept, and the round params leave `--tune`'s steps.

**A3 result: fails, so nothing is kept.** The tune left `roundTier1Scale` at 1, meaning 2025 tier-1 series also want full round share. It moved only `mapShrink` to 0.02 and `kMap` to 12, each worth under 0.00001 on train. So A3 is A2.
- Condition 1 holds: gate 0.6077, +0.0014 (+0.0005, +0.0023).
- Condition 2 fails: 2026 tier-1 LAN is −0.0021 (−0.0063, +0.0020) against current params.
- Condition 3 fails, as for A2.

Tier-1 LAN flips sign between years: +0.0049 on 2025 in the joint walk, −0.0021 on 2026. That looks like noise, but the declared rule doesn't keep a lever that leans worse where Majors are played.

**Left in place:**
- The engine params (`roundWeight`, `roundSlope`, `roundTier1Scale`, `predictionTemp`, `insularityPrior`, `insularityInUpdate`) stay, off by default, and aren't in `--tune`'s steps.
- To rerun A2: `npm run backtest-elo -- --set otMargin=2 --set onlineK=1.1 --set crossRegionK=1 --set burstDays=18 --set regionPriorOceania=-150 --set roundWeight=1 --set roundSlope=0.35 --set predictionTemp=1.25`.
- 2027 is the honest recheck. If A2 holds the gate and stops leaning worse on tier-1 LAN, it's the strongest candidate on file (+0.0022 on all 2026 series).
- **Half scores (CT/T split): not built.** It needs round share kept first, since a side split refines the same target.

## 2026-11-21: Rating uncertainty (Glicko-style widening) — not built, diagnostic only

**Question:** Luz's Supercomputer is a Bayesian Bradley–Terry model, so it widens odds when a rating rests on thin evidence. Is that where its edge on Vitality, Lynn Vision and changed rosters comes from? Declared beforehand: add a temperature that fades after a core change (`coreChangeTemp`) only if a temperature fit on the slice itself could gain more than 0.0005 on the 2026 gate.

**Already covered** (rerun on today's params, 2026 test series): provisional slope 0.958 against 0.984 for established teams, and idle > 30 days 0.938 against 0.966 for active ones. Both gaps are within noise, as on 2026-10-20. Cross-region staleness had no signal on 2026-11-19.

**Diagnostic** (`npm run backtest-elo -- --core-change`, kept): gate series by the fewer maps either side has played since its last core change. Each slice gets a temperature of its own, fit on 2025 train or on the slice itself (the ceiling). Gain is in gate log loss.

| Slice | n | Slope | Gain, 2025 fit | Ceiling |
| --- | --- | --- | --- | --- |
| < 30 maps | 6,571 | 0.965 | 0.00000 | −0.00001 |
| < 30 maps, cross-region | 447 | 0.908 | −0.00028 | 0.00003 |
| 30–100 maps | 2,391 | 0.921 | −0.00038 | 0.00010 |
| 30–100 maps, cross-region | 216 | 0.769 | 0.00003 | 0.00009 |
| ≥ 100 maps or never changed | 413 | 0.823 | 0.00008 | 0.00008 |
| ≥ 100 maps or never changed, cross-region | 56 | 0.453 | 0.00010 | 0.00009 |

**Not built.** The best ceiling is 0.0001, a fifth of the bar. Fresh core changes aren't overconfident (0.965, against 0.948 for the whole gate). The slices with low slopes are too small to matter, and their 2025 temperatures don't carry over. Widening for uncertainty has no room left in Elo, so the Supercomputer's edge on those teams is in where it puts their ratings, not in how wide their odds are. See `changeK` below for the bias side of the same question.

## 2026-11-21: Volatility after partial roster changes (`changeK`) — not built, diagnostic only

**Question:** `provisionalK` speeds up learning for new lineages only. A partial core change (3-of-5 overlap) learns at an established team's speed. Is Elo slow to catch up after one? Declared beforehand: build `changeK` (a provisional-style K boost scaled by replaced/5, fading over `provisionalMaps`) only if teams beat or miss Elo early after a change and that fades. If they only look overconfident early, the fix is widening instead. If neither, stop.

**Diagnostic** (scratch script, current params): each side of each series, oriented to that side, binned by maps since its lineage's last partial core change. Residual is wins minus Elo expectation per series. Slope and intercept are a logistic fit of the outcome on logit(p).

| Bin (maps since change) | 2025 all: resid (z) | 2026 all: resid (z) | 2025+ tier 1–2: n, resid (z), slope | 2025+ tier 1, 2+ replaced: n, resid (z) |
| --- | --- | --- | --- | --- |
| 0–10 | +0.007 (1.6) | +0.012 (2.5) | 657, −0.011 (−0.6), 0.90 | 78, −0.016 (−0.3) |
| 10–30 | +0.008 (1.6) | +0.011 (2.2) | 852, +0.006 (0.4), 0.88 | 108, +0.056 (1.3) |
| 30–60 | +0.020 (3.4) | +0.011 (1.7) | 871, +0.006 (0.4), 0.74 | 132, +0.036 (0.9) |
| 60–100 | +0.015 (2.0) | +0.007 (0.8) | 800, −0.005 (−0.3), 0.79 | 151, +0.008 (0.2) |
| No change in 100 maps | −0.023 (−5.8) | −0.023 (−5.5) | 1,394, +0.001 (0.1), 0.86 | – |

**Not built.** Neither pattern shows up where Majors are played:
- **Tier 1–2:** every bin is within z 0.6 of zero, including 2+ player swaps. The slope sits below 1 in every bin, including no change, so that's the known tier-1–2 overconfidence, not a roster-change effect.
- **All tiers:** recently changed lineages beat Elo by about 1% per series, and lineages with no change in 100 maps miss it by 2.3% (z −5.8 in both years). The gap doesn't fade over 100 maps, so faster learning (`changeK`) isn't the fix for it.

The all-tier split is a lead, not acted on. The no-change bin also holds new lineages that are under 100 maps old, so it may be a seeding or age effect rather than a roster one. It comes from tier 3 and below, so it doesn't bear on the Supercomputer gap.

## 2026-11-21: WAR-based transfer prior on core changes (prototype) — rejected

**Question:** `transferWeight` (entry below) judges incoming players by their old team's rating, which mixes player and team. Does a player-only measure help? This is the roster-change test in [spec.md](spec.md) in Elo form, using within-team WAA as proposed in [war.md](war.md#war-validation) (follow-up 2).

**Usable changes.** Counted 2025 onward, with every incoming core player having prior demo history in `player-skill.json` duels:

| Changes | All | Any history | All have >0 | All ≥ 600 duels | All ≥ 1,207 duels |
| --- | --- | --- | --- | --- | --- |
| 2025+, all tiers | 8,338 | 518 | 308 | 117 | 67 |
| 2025+, tier 1–2 | 155 | 121 | 113 | 47 | 32 |
| 2026, tier 1–2 | 73 | 60 | 55 | 31 | 24 |

That clears the spec's 80, though core-vote churn counts some swaps twice (FaZe picks up jcobbb twice). New lineages never qualify, since the demo archive starts in 2025.

**Change (prototype in a scratch script, not engine code):** on a core change, add `warScale · (Σ incoming − Σ outgoing deviation) / 5` to the rating. A player's deviation is their `wpa_opp` round-wins above role baseline minus their teammates' mean rate on the same maps, per 100 rounds, from maps dated before the change, shrunk by k = 1,024 rounds. The per-map rows come from `data/war/role-rounds.parquet`. Players with no history count as 0. Treated series are those within 30 maps after a change where every incoming player has 300+ prior rounds (75 lineages).

**Declared test:** pick `warScale` on 2025 all-series log loss; it fails if 2026 all-series loss doesn't improve by more than 0.0005. The official gate set wasn't scored because the prototype isn't wired into `backtest-elo`.

| `warScale` | 2025 | 2026 | 2026 tier 1 | Treated 2025 (420) | Treated 2026 (1,175) |
| --- | --- | --- | --- | --- | --- |
| 0 | 0.59936 | 0.59264 | 0.6057 | 0.5937 | 0.5854 |
| 40 | 0.59931 | 0.59262 | 0.6060 | 0.5924 | 0.5851 |
| **80** | 0.59929 | 0.59265 | 0.6067 | 0.5915 | 0.5852 |
| 160 | 0.59929 | 0.59288 | 0.6092 | 0.5910 | 0.5869 |
| 320 | 0.59951 | 0.59394 | 0.6191 | 0.5956 | 0.5956 |
| −20 | 0.59939 | 0.59266 | – | 0.5946 | 0.5857 |

With `transferWeight` 0.1 on top, every row moves by 0.0001 or less.

**Rejected.** 2025 picks 80–160, and at that scale 2026 is flat to worse overall and clearly worse in tier 1, so the 2025 signal on 420 treated series doesn't carry over. The 2026 treated slice gains at most 0.0003, and it's 6% of 2026 series (1,175 of 20,052), so that's worth about 0.00002 overall. This matches `validate-war`'s null on lineup changes. Nothing was added to the engine. Worth revisiting only once WAR covers tier-2 events and has a second season of prior rounds per player.

## 2026-11-21: Elo's Major misses against the Supercomputer, and transfer-aware roster changes (`transferWeight`) — rejected

**Question:** Why does Elo miss Vitality at the Budapest 2025 playoffs and Lynn Vision across Majors, and why does it rate GOSH, 9z and PVISION 14–17 points of Stage 1 advance below Luz's Major Supercomputer at Singapore 2026? Is there a general engine fix?

The prompt's figures predated the CS:GO warmup (entry below). With the warmup:

| Case | Before warmup | Now | Supercomputer |
| --- | --- | --- | --- |
| Vitality, Budapest title | 12.8% | 18.9% (won) | 34.4% |
| Budapest playoff stage log loss | 1.692 | 1.476 (coin 1.224) | 1.452 |
| Lynn Vision, Budapest / Cologne Stage 1 advance | ~52% / ~52% | 47% / 54% (out both) | – / 35% |

Singapore Stage 1 advance, Elo minus Supercomputer: Lynn Vision +29.8, GOSH −17.2, 9z −15.7, PVISION −14.0, FaZe −13.1, NiP −9.4, HEROIC −8.8.

**Diagnostics** (engine run in memory on the current feed and params):

- **Vitality's drop was earned.** It fell from 296 to 149 between August and the Budapest start while going 28–11 in series against 29.9 expected. Much of the fall came from maps lost by large margins inside series it won. Elo had five teams level for the title (Spirit 12%, Falcons 18%, Vitality 19%, FURIA 21%, MOUZ 22%), while the Supercomputer put FURIA and Vitality at 34% each. Most of the playoff log loss is FaZe reaching the final at 1.3% to win and 4.5% for second (Supercomputer: 1.1% to win).
- **Elo doesn't underrate teams at the top.** Tier-1 LAN series, wins minus Elo's expectation by rank at the time:

| Rank | 2024 | 2025 | 2026 |
| --- | --- | --- | --- |
| Top 3 | −13.7 (z −2.4) | −4.4 (z −0.8) | −4.7 (z −0.8) |
| 4–8 | −9.4 | −0.6 | +8.2 |
| 9–16 | −5.1 | −9.3 | −2.7 |
| 17–32 | +19.8 | +1.5 | −4.1 |

- **No over-reaction to recent form.** The residual on each side's 120-day rating change, in logit per 100 points: −0.053 ± 0.022 (2024), −0.031 ± 0.024 (2025), −0.044 ± 0.026 (2026) over all series. In tier 1 it flips sign (+0.11, −0.19, 0.00, each ±0.1). That's too small to act on.
- **Lynn Vision isn't systematic at Majors.** It's been one lineage with the same five players since 2022. Its Major Stage 1 and 2 forecasts sum to about 1.9 expected advances, and it advanced twice. Cross-region series: 19 wins against 19.0 expected in 2025, 5 against 7.5 in 2026, with in-region runs adding rating (+69 in March 2026). That's the insularity residual from the 2026-11-19 entries, not a Lynn-specific fault.
- **9z looks right.** 74% of its last 180 days was tier-1 LAN, and it went 18 wins against 19.3 expected. The Supercomputer just rates it higher.
- **GOSH, PVISION and FaZe keep their lineage's rating through roster turnover.**
  - `regress` is tuned to 0, and its target is the tier mean, so a partial core change leaves the rating untouched.
  - GOSH (BC.Game) is a lineage from 2022. Through 3-of-5 overlaps it went from s1mple with electroNic, MUTiRiS, krazy and aragornN to s1mple, Senzu, Magisk, mzinho and asap, and still carries the old roster's −165.
  - FaZe's 2022 lineage has none of its original players. PVISION added FL1T and HObbit.
  - A new lineage is seeded from its players' old ratings, but a partial change ignores the incoming players.

**Change (trial):** `transferWeight`. On a core change, the rating closes `transferWeight · replaced/5` of the gap to the mean of the incoming players' previous-lineage ratings, put on the same region scale.
- An incoming player counts only if their previous lineage has 30+ maps and played in the last 180 days. Otherwise they count as the lineage's current rating.
- A first prototype that put unrated players at the tier mean deflated the whole pool and lost on 2025 and 2026, so it was dropped.

**Declared test:** the standard protocol. `npm run backtest-elo -- --tune` on 2025 with `transferWeight` free, then keep it if the 2026 gate improves by more than 0.0005 against 0.6090.

| `transferWeight` | 2025 train | 2026 gate | 2026 tier 1 | 2026 tier-1 LAN | 2026 slope | GOSH − MOUZ |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (current) | 0.5994 | 0.6090 | 0.6057 | 0.6021 | 0.964 | −334 |
| **0.1 (tuned)** | 0.5993 | **0.6088** | 0.6055 | 0.6016 | 0.976 | −326 |
| 0.3 | 0.5994 | 0.6088 | 0.6058 | 0.6013 | 0.998 | −310 |
| 0.5 | 0.5999 | 0.6092 | 0.6068 | – | 1.015 | – |
| 1 | 0.6018 | 0.6115 | 0.6113 | – | 1.045 | – |

- **Rejected.** The tune moved only `transferWeight` (to 0.1; every other param stayed put, so the current set is the control). The gate gains 0.0002.
- Series where either side is within 30 maps of a core change (12,608 in 2026) don't move: 0.5856 at both 0 and 0.1. Higher weights push the test slope above 1, so ratings end up compressed.
- **Majors at 0.1** (`backtest-majors --n 10000`): stage log loss 1.1307 → 1.1319, advance 0.5309 → 0.5317, Elo − Supercomputer −0.003 → −0.0026. Slightly worse.
- **It doesn't fix GOSH.** Even at weight 1, GOSH only moves from −334 to −270 against MOUZ. That's still far below where the Supercomputer has them.
- The engine code stays, off by default (`transferWeight` 0), and isn't in `--tune`'s steps, so a retune can't switch it on without a gate pass. `--set transferWeight=0.1` reruns it.

**Not run:** an insularity term for Lynn Vision (a cross-region offset scaled by a roster's own-region share of recent maps). The 2026-11-19 entries put the whole region effect at about 0.0002 of the gate, under the region rule's bar, and Lynn Vision's Major record doesn't show a miss to fix.

## 2026-11-21: CS:GO warmup (2022-01 → 2023-09) — kept with a 2025 retune, 2026 gate 0.6106 → 0.6090

**Change:** Ratings warm up on 38,016 CS:GO series before the first CS2 month, instead of starting cold in 2023-10. The motivation was the Major backtest: Copenhagen 2024's Opening Stage was Elo's worst block (1.81, against 1.25 for a coin), and Americas teams beat Elo's expectation there by 9.7 wins in 32 cross-region series.
- CS:GO margins are MR15, so they're scaled by 12/15, and overtime starts when the loser has 15.
- New `gameRegress` closes part of every lineage's gap to its tier mean at the first CS2 series.

**Declared test:** with `gameRegress` fixed at 0.3 and the other params unchanged, keep the warmup if 2024-01 → 2024-06 series log loss improves by more than 0.0005, and the 2026 gate is no more than 0.0005 worse.

| Set | Cold start | CS:GO, old params | CS:GO, retuned on 2025 | Cold start, retuned on 2025 (control) |
| --- | --- | --- | --- | --- |
| 2024 H1, all series (10,598) | 0.6408 | 0.6049 | 0.6054 | – |
| 2024 H1, tier 1 (349) | 0.9480 | 0.6406 | 0.6659 | – |
| 2025 train series | 0.6040 | 0.6024 | 0.5994 | 0.6039 |
| 2026 gate (9,375) | 0.6106 | 0.6115 | **0.6090** | 0.6103 |
| 2026, all series (18,424) | 0.5959 | 0.5948 | 0.5926 | 0.5959 |
| 2026, tier 1 (727) | 0.6106 | 0.6101 | 0.6057 | 0.6101 |
| 2026, cross-region (719) | 0.6253 | – | 0.6274 | – |
| 2026 test slope | 0.995 | 1.028 | 0.964 | 0.965 |

- **The declared test failed.** Early 2024 gained 0.036, but the 2026 gate got 0.0009 worse. The params had been tuned on a feed that started cold, and the 2026 slope above 1 shows the warm ratings were now too spread out for them.
- **A retune on 2025 with CS:GO, the same protocol as every other tune, passes:** the gate gains 0.0016. The control, which retunes the cold-start feed from the same starting point, only reaches 0.6103. So 0.0013 of the gain is the warmup, and 0.0003 is retuning noise.
- **The retune moved:** `crossRegionK` 1.25 → 0.75, `kMap` 6 → 8, `tierGap` 750 → 800 (the upper bound), `seriesMapTemp` 0.8 → 0.9 (with the online temperature also at 0.9), `burstMaps` 24 → 16, `burstDays` 12 → 16, `oceaniaTemp` 1.5 → 1.4 and `gameRegress` 0.3 → 0. With longer histories, single international results matter less. Cross-region series score 0.0021 worse.
- **`gameRegress` goes to 0 because 2025 can't see the switch.** Early-2024 tier 1 is better at 0.3 (0.641) than at 0 (0.666, slope 0.51). It's left at the tuned 0, because picking it on 2024 would make that window a tuning set. A walk-forward fit on 2024 H1 could revisit it.
- **HLTV encompassing** λ falls to 0.01 (points) and 0.01 (rank), from 0.12 and 0.14 in the control: with CS:GO history, Elo leaves nothing for HLTV to add.
- **Majors** (`backtest-majors`, 18 stage blocks): stage outcome log loss went 1.2066 → 1.1307. Elo − VRS went +0.041 → −0.008, and Elo − Supercomputer went +0.042 → −0.003. See [simulator.md](simulator.md).
- `loadFeed` now includes CS:GO by default, and `--no-csgo` turns it off in `backtest-elo` and `backtest-majors`.

## 2026-11-20: Oceania prior and temperature tuned on 2025 — kept, 2026 gate 0.6122 → 0.6106

**Change:** `regionPriorOceania` (in the update) and `oceaniaTemp` are now in `--tune`'s steps, and were tuned on 2025 series log loss with every other param fixed. The search started from 0 and 1.

| Prior | Temp | 2025 log loss |
| --- | --- | --- |
| 0 | 1 | 0.60476 |
| −175 | 1 | 0.60440 |
| −200 | 1.5 | 0.60404 |
| **−175** | **1.5** | **0.60404** |
| −150 | 1.5 | 0.60404 |

The surface is flat from −150 to −200, and the search stopped at −175 / 1.5.

**2026 (same feed, 9,375 gate series):**

| Set | Before | After |
| --- | --- | --- |
| Gate | 0.6122 | **0.6106** |
| All series (18,424) | 0.5965 | 0.5959 |
| Cross-region, Valve regions (719) | 0.6271 | 0.6253 |
| Oceania v Oceania (421) | slope 1.61 | +0.0350 (CI +0.0192 to +0.0514), slope 1.04 |
| Oceania v other regions (146) | – | −0.0059 |

- **Kept** under the standard gate (+0.0016 against the 0.0005 bar). All of the gate gain is in series involving Oceania.
- The region-only rule doesn't apply, because the gain is inside Oceania, not across regions. On it, the pooled cross-region gain is +0.0010 (CI −0.0023 to +0.0041).
- **Caveat:** 2026 isn't a clean test. Both terms came out of the entry below, which looked at 2026. The tuned values sit close to the ones picked there by eye, and 2024 Oceania wasn't underconfident. Recheck on 2027.
- **Published ratings:** with the prior in the update, Oceania's raw ratings drift up by about the prior, on their own internal scale. FlyQuest's raw rating is 157.5. `build-elo` (rankings and game log) and `simulate` now publish rating plus region prior, so FlyQuest shows −17.5 (rank 40, was 38.5 at rank 26).
- **Simulator:** the `Predictor` gets the prior through the engine's `mapProbability` and the veto base logit, and gets `oceaniaTemp` on Oceania v Oceania map logits. FlyQuest's PGL Major Singapore odds: Stage 2 advance 55% → 38%, playoffs 3.2% → 0.7%.

## 2026-11-20: Oceania's internal gaps are compressed — K, temperature and prior compared, nothing kept yet

**Question:** This follows the entry below. Why does an Oceania prior in the update help Oceania v Oceania series, and is there a more direct fix?

**Travellers are underrated at home.** `--region-residual` compares same-region series where one side played a cross-region series in the last 90 days and the other hasn't in 180 days or ever. Points are for the travelled side, on maps:

| Region | 2024 | 2025 | 2024–25 | 2026 |
| --- | --- | --- | --- | --- |
| Europe | −22.3 ± 5.5 | −4.9 ± 5.3 | −13.4 ± 3.8 | +6.7 ± 4.9 |
| Americas | +34.7 ± 11.2 | +14.3 ± 10.4 | +23.8 ± 7.6 | +21.8 ± 11.9 |
| Asia (excl. Oceania) | +43.9 ± 15.2 | +65.9 ± 15.6 | +54.7 ± 10.9 | +11.0 ± 16.5 |
| Oceania | +77.8 ± 39.4 | +137.3 ± 37.3 | **+110.5 ± 27.0** | **+150.1 ± 59.6** |

The smaller the pool, the more its travellers are underrated against home rivals: they pay the pool's inflated level when they lose abroad. That squeezes the pool's internal gaps.

**Same-region calibration slope (series, > 1 is underconfident):**

| Region | 2024 | 2025 | 2026 |
| --- | --- | --- | --- |
| Europe | 0.70 | 0.97 | 0.96 |
| Americas | 0.92 | 1.01 | 1.15 |
| Asia (excl. Oceania) | 0.93 | 1.22 | 1.07 |
| Oceania | 0.87 (intercept 0.56) | **1.60** | **1.61** |

Tier doesn't explain it. Europe's tier 4 is calibrated (1.00 in 2025, 0.97 in 2026) while Oceania's tier 4 is 1.58 and 1.57. 2024 Oceania was *not* underconfident, so a fit on 2024 would point the wrong way.

**Fixes tried (fixed values, `--region-walk --region-walk-fixed`, Oceania v Oceania series 423 in 2025 and 421 in 2026):**

| Change | O v O gain 2025 | O v O gain 2026 | O v O slope 2025 / 2026 | All series 2025 / 2026 | 2026 gate |
| --- | --- | --- | --- | --- | --- |
| baseline | – | – | 1.60 / 1.61 | – | 0.6122 |
| `oceaniaK` 1.5 | +0.0060 | +0.0036 | 1.42 / 1.41 | −0.0001 / −0.0001 | 0.6126 |
| `oceaniaK` 2 | +0.0070 | +0.0026 | 1.27 / 1.25 | −0.0002 / −0.0004 | 0.6131 |
| `oceaniaK` 3 | +0.0003 | −0.0060 | 1.04 / 1.03 | −0.0008 / −0.0012 | 0.6141 |
| `oceaniaTemp` 1.3 | +0.0160 | +0.0171 | 1.22 / 1.23 | +0.0003 / +0.0004 | 0.6116 |
| `oceaniaTemp` 1.5 | +0.0201 | +0.0210 | 1.06 / 1.06 | +0.0004 / +0.0005 | 0.6114 |
| `regionPriorOceania` −150 (in update) | +0.0137 | +0.0139 | 1.54 / 1.59 | +0.0003 / +0.0002 | 0.6114 |
| prior −150 + temp 1.3 | **+0.0289** | **+0.0302** | 1.18 / 1.21 | +0.0007 / +0.0006 | **0.6109** |

- A bigger K straightens the slope but adds noise, so log loss doesn't improve. Oceania's ordering is right and only its spread is squeezed.
- The temperature and the prior stack, because they fix different things: the spread of the odds, and the travellers' ratings. Together they are the best result here: the 2026 gate is +0.0013 and the pooled cross-region gain is +0.0013 (CI −0.0014 to +0.0040).
- **Not kept here** (superseded by the 2025-tuned entry above). All of these values were chosen after seeing 2025 and 2026, so this is exploration, not a test. A clean test would tune `oceaniaTemp` and `regionPriorOceania` on 2025 only (the standard protocol) and score 2026. But 2026 has already been seen, so the honest out-of-sample check is 2027. A walk-forward fit from 2024 would fail, because 2024 Oceania wasn't underconfident.
- The engine params (`oceaniaK`, `oceaniaTemp`) stay, off by default. `oceaniaTemp` touches only the engine's series odds; the simulator's `Predictor` would need it separately.

## 2026-11-19: Region priors and Oceania split out — cross-region rule fails, Oceania-internal gain found

**Question:** Can a model-level term fix region calibration where `kRegion` and the simulator offset couldn't? It's judged by the region rule in the Overview, which was declared before any run.

**Mechanism (`--region-residual`, Asia side's points against the rest, maps).**

| Split | 2024–25 | 2026 |
| --- | --- | --- |
| Oceania (3+ AU/NZ players) | **−129.0 ± 27.3** (260) | **−126.4 ± 49.2** (67) |
| Rest of Asia | −13.1 ± 8.1 (2,229) | −15.4 ± 13.3 (776) |
| LAN in Asia / LAN abroad / online | −43.9 / −43.9 / −10.7 | −33.5 / −35.0 / −2.6 |
| Own-region share < 50% / 50–80% / ≥ 80% | −5.5 / −35.0 / −36.9 | −1.4 / −49.8 / −59.1 |
| Oceania v Europe | −142.2 ± 30.7 (213) | −146.7 ± 54.0 (56) |
| Oceania v rest of Asia (same Valve region) | −44.3 ± 20.8 (340) | −14.5 ± 26.7 (214) |

- Valve's "Asia" bias is mostly Oceania. Without it, the rest of Asia is about −13.
- It isn't travel: LANs in Asia and abroad are equally off. Online is milder.
- It grows with how insular a roster's schedule is.
- By year, Oceania's residual is −180 (2024), −79 (2025) and −126 (2026).

**Change (trial).** The engine (`regionGap` in `mapProbability`) adds fixed offsets against Europe whenever two rosters' regions differ:
- `regionPriorAmericas`, `regionPriorAsia` and `regionPriorOceania`, with Oceania split out of Asia as region 3 by core players' countries;
- `regionPriorInUpdate` (1 puts the prior in the update's expected score as well, 0 is predictions only);
- `oceaniaCross` (Oceania v Asia counts for `crossRegionK`; not run).

All default to off. `--region-walk` fits the priors walk-forward (3 refit passes on training-year cross-region maps), and `--region-walk-fixed` scores the given values instead.

| Variant | Priors fit on 2024–25 (Am / As / Oc) | Cross-region 2025 | Cross-region 2026 | Pooled (90% CI) | 2026 gate |
| --- | --- | --- | --- | --- | --- |
| All regions, in update | +46 / −26 / −161 | +0.0001 | −0.0018 | −0.0008 (−0.0047 to +0.0028) | +0.0003 |
| All regions, prediction only | +23 / −13 / −84 | −0.0057 | −0.0027 | −0.0043 (−0.0089 to −0.0002) | −0.0001 |
| Oceania only, in update | – / – / −148 | +0.0020 | −0.0003 | +0.0009 (−0.0022 to +0.0040) | **+0.0008** |
| Oceania only, prediction only | – / – / −78 | −0.0013 | +0.0010 | −0.0002 (−0.0037 to +0.0032) | +0.0003 |

**The declared rule fails for every variant.** The Americas residual flips sign between years, so fitting it hurts. Oceania's is too unstable year to year for a fixed cross-region price to transfer.

**Found after the fact: the Oceania prior in the update fixes Oceania's internal ratings.** Its 2026 gate gain comes almost entirely from series with an Oceanian roster (0.0007 of 0.0008), and mostly from Oceania v Oceania, not from cross-region series. With the prior fixed (`--region-walk-fixed`), it scales with size and doesn't plateau:

| `regionPriorOceania` (in update) | −50 | −100 | −150 | −200 |
| --- | --- | --- | --- | --- |
| Oceania v Oceania, 2025 (423) | +0.0050 | +0.0095 | +0.0137 (+0.0111 to +0.0168) | +0.0174 |
| Oceania v Oceania, 2026 (421) | +0.0050 | +0.0096 | +0.0139 (+0.0098 to +0.0183) | +0.0178 |
| All series 2025 / 2026 | +0.0002 / +0.0001 | +0.0003 / +0.0002 | +0.0003 / +0.0002 | +0.0004 / +0.0002 |
| 2026 gate | 0.6119 | 0.6117 | 0.6114 | 0.6112 |
| Pooled cross-region (90% CI) | +0.0010 (+0.0001 to +0.0019) | +0.0014 (−0.0004 to +0.0032) | +0.0012 (−0.0016 to +0.0039) | +0.0004 |

Likely mechanism: Oceania's travelling rosters lose rating abroad at a rate that doesn't reflect their strength *within* Oceania. That compresses Oceania's internal gaps. Pricing their trips with a prior stops the loss, and the internal gaps spread out again.

- This is a post-hoc finding from a slice, with several variants seen on 2026, so it isn't a pass. The 2025 fold is a clean out-of-sample check (fit on 2024, never tuned on), and it agrees.
- The lack of a plateau is unexplained. The next test, before adopting anything, is a direct one: Oceania v Oceania calibration slope and the residual by "has travelled in the last 180 days".
- **Not kept yet.** Params are unchanged and the engine code stays, off by default. If it's adopted, `latest.json` should publish rating + prior, or the rankings will disagree with predictions.

## 2026-11-19: Region-aware seeding and a fixed Asia offset — seeding rejected, simulator offset added then reverted

**Question:** These follow up the `kRegion` entry below. Is Asia's 23-point overrating caused by seeding? If not, does a fixed offset (rather than a learned one) price cross-region series better?

**Seeding diagnostic.** In a closed pool, newcomers seeded too high lose their excess to the pool's incumbents. Unrated players are seeded at the global `tierMean`, so Asia newcomers could be the source. `--region-residual` now reports each new lineage's rating after 30 maps minus its seed, by region:

| Born | Europe | Americas | Asia |
| --- | --- | --- | --- |
| 2024–25 | +60.9 ± 5.5 (424) | +48.0 ± 9.9 (123) | +88.9 ± 11.9 (94) |
| 2026 | +43.7 ± 8.3 (147) | −1.5 ± 19.5 (29) | +79.4 ± 21.0 (20) |

Every region's survivors climb from their seed, which is partly survivor bias. Asia's climb most, so Asia newcomers are seeded too *low* and take points from the pool rather than feed it. **Rejected:** a per-region tier mean (step 1b) wasn't built, because seeding isn't the source.

**Fixed offset.** Each cross-region series with an Asia side gets a fixed shift (series odds recomputed from the shifted map probability). The offset was fit on 2024–25, which gives −23. Gains are in series log loss, with 90% event-resampled CIs:

| Slice | Series | −10 | −23 | −35 |
| --- | --- | --- | --- | --- |
| 2024–25 cross-region (fit) | 2,396 | +0.0007 | +0.0010 | +0.0005 |
| 2026 cross-region | 1,002 | +0.0011 (+0.0001 to +0.0021) | +0.0019 (−0.0003 to +0.0042) | +0.0020 |
| 2026 gate cross-region | 719 | +0.0010 (+0.0001 to +0.0019) | +0.0018 (−0.0002 to +0.0039) | +0.0021 |
| 2026 tier-1 cross-region | 345 | +0.0005 | +0.0008 (−0.0021 to +0.0033) | +0.0006 |
| 2026 gate | 9,375 | +0.0001 | +0.0001 | +0.0002 |

Calibration slopes don't move. Unlike the learned `kRegion`, the fixed value transfers out of sample. It's still far below the 0.0005 gate threshold, so the Elo model is unchanged.

**Reverted.** It was briefly added to the simulator as `REGION_OFFSET`. It was removed because −23's 2026 CI includes 0, and the only clean value (−10) was picked after seeing results. The model-level follow-up is the entry above. While it was in: −23 for Asia when the regions differ. On the PGL Major Singapore 2026 sim (ratings as of 2026-11-19), FlyQuest's Stage 1 advance odds drop from 0.550 to 0.492. That puts them level with 9z (0.488) and M80 (0.482) and below Eternal Fire (0.559). The Lynn Vision and The MongolZ odds also drop.

## 2026-11-19: Region offsets (`kRegion`) and cross-region staleness — rejected

**Question:** Does Elo misprice teams from isolated regional pools? Two mechanisms were tried. The first is a regional level error, where a whole region's pool is mis-anchored. The second is stale anchoring, where a team whose last cross-region series is months old gets an overconfident price. The prompt was FlyQuest: it hadn't played Europe or Americas since IEM Cologne in June.

**Diagnostic.** `npm run backtest-elo -- --region-residual` (kept) fits, on cross-region maps, a residual in Elo points with logit(p) as offset (± 1 SE). It reports the residual by Valve region pair, calibration by the staler side's days since its last cross-region series, and a stale side (> 90 days or never) against a fresh one (≤ 30 days). Predictions now carry `regions` and `crossGapDays`.

| Region v rest | 2024 | 2025 | 2024–25 | 2026 |
| --- | --- | --- | --- | --- |
| Europe | −7.5 ± 8.9 | +4.6 ± 8.6 | −1.3 ± 6.2 | +21.9 ± 8.5 |
| Americas | +50.8 ± 12.1 | +8.4 ± 10.5 | +26.5 ± 7.9 | −15.6 ± 9.9 |
| **Asia** | **−28.8 ± 10.8** | **−17.2 ± 11.2** | **−23.2 ± 7.8** | **−23.3 ± 12.8** |

- Asia (Valve's region, which includes Oceania) is overrated against the rest by about 23 points in every year. It's the only stable bias. Europe v Americas flips sign (−56, −10, +19).
- Staleness has no signal. The stale side's residual is −1.5 ± 12.4 on 2024–25 and −9.9 ± 18.6 on 2026. Stale buckets aren't more overconfident than fresh ones (2024–25 series slope: ≤ 30 days 0.62, > 180 days or never 0.83). The anchor-staleness temperature wasn't built.

**Change (trial).** `kRegion` gave each Valve region a shared, mean-zero offset added to the rating gap. Only cross-region maps moved it: `kRegion · margin multiplier · (y − p)`.

| `kRegion` | 0 | 0.1 | 0.25 | 0.5 | 1 | 2 | 4 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Train (2025) | 0.6048 | 0.6048 | 0.6048 | 0.6048 | 0.6049 | 0.6051 | 0.6053 | 0.6059 |
| Gate (9,375) | 0.6122 | 0.6122 | 0.6121 | 0.6121 | 0.6122 | 0.6124 | 0.6128 | 0.6140 |
| Cross-region gate (719) | 0.6271 | 0.6269 | 0.6271 | 0.6277 | 0.6294 | 0.6328 | 0.6394 | 0.6530 |
| Asia v rest, 2024–25 | −23.2 | −19.7 | −15.2 | −9.8 | −3.4 | +2.0 | +5.7 | +8.1 |
| Asia v rest, 2026 | −23.3 | −13.5 | −3.4 | +5.8 | +12.3 | +14.3 | +13.3 | +11.0 |

**Rejected.** The offsets remove the bias (Asia's residual reaches 0 near `kRegion` 0.5–1), but log loss doesn't move. The best gate gain is 0.0001 and the best cross-region gain is 0.0002. Above 0.5 every score gets worse, because the offset chases noise and overshoots on 2026. That's expected: 23 points is about 0.066 logit, worth roughly 0.0003 of log loss per cross-region map even when fixed exactly, and cross-region is 8% of the gate. The engine code and param were reverted. The diagnostic flag stays.

- For reading the rankings by hand, Asia/Oceania rosters measured against other regions are worth about 20–25 points less than their rating.
- Not tried: splitting Oceania from Asia. With no log-loss value at the 3-region level, a finer split has even less data per region.

## 2026-11-19: Tune on the latest full year (2025) instead of 2024–2025 — kept

**Change.** `backtest-elo` now defaults `--train-from` to 2025-01-01, so `--tune` trains on 2025 only. That was justified by the 2025 H2 check in the walk-forward entry below, where recent-only tuning beat all-history tuning by 0.0054 on the gate set. The VRS baseline's scale is unchanged (880), and the HLTV links keep their own 776 training series.

```
npm run backtest-elo -- --tune --write
npm run backtest-elo -- --set seriesMapTempOnline=0.8   # check the online split the tune re-added
npm run backtest-elo -- --gate
```

The tune re-added `seriesMapTempOnline` 0.85. With it at 0.8 instead, the gate is unchanged (0.6116 vs 0.6116) and 2025 training loss is 0.0002 worse. That's in line with the 2026-11-18 rejection, so the key was removed from `params.json`. The written set differs from current in `onlineK` 1, `crossRegionK` 1.25, `provisionalK` 2, `provisionalMaps` 100, `kMap` 6, `mapShrink` 0.01, `coreWindow` 7, `tierGap` 750, `burstMaps` 24 and `burstDays` 12.

| Set (2026) | Before | After |
| --- | --- | --- |
| Gate (9,167) | 0.6132 | **0.6116** |
| Every series (18,069) | 0.5971 | 0.5953 |
| Every map (38,206) | 0.6276 | 0.6260 |
| Cross-region (714) | 0.6253 | 0.6274 |
| HLTV set Elo (651) | 0.6064 | 0.6078 |
| Test series slope / ECE | 1.030 / 0.012 | 1.015 / 0.009 |

- The gate gain (0.0016) clears the 0.0005 bar. The 2026 gate was looked at once before this rule was confirmed on 2025 H2, so it's a confirmation, not a clean test.
- Cross-region and the tier-1 LAN HLTV set got slightly worse (both small sets). 2026 LAN series slope is 1.133, still underconfident.
- From now on, retune each year on the latest full year before the test year.

## 2026-11-19: Walk-forward validation of the tuned parameters — diagnostic

**Question:** Are the tuned parameters stable across years, or does each year pull them somewhere different?

**Runs.** No code or param changes. `--tune` warm-starts from the current `params.json`, so coordinate descent may stay near it and understate drift.

```
npm run backtest-elo -- --train-from 2024-01-01 --train-to 2024-12-31 --test-from 2025-01-01 --test-to 2025-12-31          # current
npm run backtest-elo -- --tune --train-from 2024-01-01 --train-to 2024-12-31 --test-from 2025-01-01 --test-to 2025-12-31   # 2024-tuned
npm run backtest-elo -- --tune --train-from 2025-01-01 --train-to 2025-12-31 --test-from 2025-01-01 --test-to 2025-12-31   # 2025-tuned (in-sample)
```

Each tuned set was then scored on the usual 2026 gate with `--set` for every key.

| Param (step) | Current (2024–25) | 2024-tuned | 2025-tuned |
| --- | --- | --- | --- |
| `tierGap` (25) | 475 | 475 | **750** |
| `seriesMapTemp` (0.05) | 0.8 | **0.6** | 0.8 |
| `seriesMapTempOnline` (0.05) | 0.8 | 0.75 | 0.85 |
| `kMap` (2) | 4 | **0** | **6** |
| `k` (4) | 12 | 16 | 12 |
| `provisionalK` (0.5) | 2.5 | 2.5 | 2 |
| `provisionalMaps` (10) | 70 | 70 | **100** (bound) |
| `burstMaps` (8) | 64 | **24** | **24** |
| `burstDays` (2) | 14 | 16 | 12 |
| `onlineK` (0.1) | 0.9 | 1 | 1 |
| `crossRegionK` (0.25) | 1 | 1.25 | 1.25 |
| `standInK` (0.2) | 1.2 | 1 | 1.2 |
| `coreWindow` (1) | 6 | 6 | 7 |
| `mapShrink` (0.01) | 0.02 | 0.02 | 0.01 |
| `marginWeight`, `otMargin`, `tierK`, `regress`, `newRosterRegress` | 0.75, 1, 0.9, 0, 0 | same | same |

Bold marks moves of 3+ steps from current.

| Scored on | Current | 2024-tuned | 2025-tuned |
| --- | --- | --- | --- |
| 2025 all series (20,921) | 0.6071 | 0.6091 | 0.6046 (in-sample) |
| 2025 gate set (8,292) | 0.6082 | 0.6110 | 0.6049 (in-sample) |
| 2025 maps (41,234) | 0.6322 | 0.6327 | 0.6307 (in-sample) |
| 2025 series slope / ECE | 1.056 / 0.014 | 1.067 / 0.017 | 0.970 / 0.008 |
| 2025 LAN series slope | 1.065 | 1.255 | 0.921 |
| 2026 gate (9,167) | **0.6132** | 0.6156 | 0.6116 |
| 2026 all series (18,069) | 0.5971 | 0.5996 | 0.5954 |
| 2026 gate slope | 1.020 | 1.099 | 0.958 |

**Findings.**
- Tuning on 2024 alone gains 0.0018 on 2024 (0.61472 → 0.61288) but loses 0.0020 on 2025 against current params and 0.0024 on the 2026 gate. One year of tuning overfits by about the size of a typical kept experiment.
- The gap between 2024-tuned and the 2025 in-sample optimum is 0.0045 on 2025 series. That's the cost of drift plus tuning noise in one year.
- `seriesMapTemp` drifts with the LAN calibration regime. 2024 LAN was overconfident (slope 0.66 at current params), so 2024 tuning softens to 0.6. That leaves 2025 and 2026 LAN underconfident (slopes 1.26 and 1.38). Under 2025-tuned params, 2024 LAN slope is 0.40.
- `tierGap` is the least stable (475 vs 750, 11 steps), and `kMap` swings 0 vs 6. Both matter mostly for new or low-tier rosters and map picks, so treat their current values as soft.
- Both single-year tunes agree on `burstMaps` 24, `onlineK` 1 and `crossRegionK` 1.25, away from current (64, 0.9, 1). Those are candidates for a joint retune, not changes made here.
- The 2025-tuned set beats current on the 2026 gate by 0.0016, above the 0.0005 bar. That hints recent years predict forward better than the 2024–25 pool. It's a test-set read, so acting on it (recency-weighted tuning or a rolling window) needs its own declared test.

**Follow-up: recent-only vs all-history tuning, scored on 2025 H2.** This tests the recency idea without touching 2026. Both tunes are out of sample on 2025 H2. Current params saw 2025 H2 during their own tuning, so they're only a reference.

```
npm run backtest-elo -- --train-from 2025-01-01 --train-to 2025-06-30 --test-from 2025-07-01 --test-to 2025-12-31          # current (reference)
npm run backtest-elo -- --tune --train-from 2025-01-01 --train-to 2025-06-30 --test-from 2025-07-01 --test-to 2025-12-31   # recent-only
npm run backtest-elo -- --tune --train-from 2024-01-01 --train-to 2025-06-30 --test-from 2025-07-01 --test-to 2025-12-31   # all history
```

| Scored on 2025 H2 | Current (saw H2) | Recent-only (2025 H1) | All history (2024–2025 H1) |
| --- | --- | --- | --- |
| All series (10,438) | 0.6045 | **0.6026** | 0.6054 |
| Gate set (4,139) | 0.6061 | **0.6029** | 0.6083 |
| Maps (21,412) | 0.6312 | **0.6301** | 0.6313 |
| Series slope / ECE | 1.076 / 0.018 | 1.029 / 0.014 | 1.102 / 0.018 |
| LAN series slope | 1.028 | 0.933 | – |

Params that moved: recent-only went to `kMap` 20, `marginWeight` 1.25, `otMargin` 2, `tierGap` 800, `mapShrink` 0.05, `burstMaps` 32, `burstDays` 18, `provisionalMaps` 100 and `seriesMapTemp` 0.75. All-history went to `kMap` 0, `marginWeight` 1.75, `tierGap` 500, `seriesMapTemp` 0.65 and `burstMaps` 24. Both moved `tierK` to 0.85, `provisionalK` to 2 and `standInK` to 1.

- Recent-only beats all-history by 0.0028 on series and 0.0054 on the gate set, both well above the 0.0005 bar. It also beats current params, which had seen H2.
- That confirms the 2025-tuned set's win on the 2026 gate (0.6116 vs 0.6132) comes from recency, not a lucky test-set read: tune on the latest full year, not the whole history.
- `kMap` is weakly identified: 0, 4, 6 and 20 across tunes. The loss surface is flat there, so its value matters little.
- Not tried: recency weights between the two extremes (for example 2024 at half weight), or a trailing window shorter than a year.

**Not changed.** Diagnostic only; `params.json` and `calibration.json` are untouched.

## 2026-11-19: Tier-2 temperature in Elo's series probability (`tier2Temp`) — rejected

**Question:** Elo's 2026 tier-2 series slope is 0.597 (401 series). Is the tier classification wrong? If not, does a tier-2 temperature inside Elo's series odds (the `TIER_TEMP` fix from the simulator) pay off on the gate?

**Classification check.** Every tier-2 prediction from 2024 to 2026 was joined back to its raw match and tournament rows (local store only). It's sound:
- Every tier-2 series' tournament is tier 2 too, so match and tournament tiers never disagree.
- There are 4 showmatches in 2024, 3 in 2025 and none in 2026.
- Qualifiers are tier 2 by Liquipedia's convention, not mislabels.
- The match-level `liquipediatiertype` is empty on archive rows. Use the tournament row's.

The 2026 miscalibration is the online tier-1 qualifiers, not tier 2 as a whole:

| 2026 tier-2 slice | Series | Log loss | Slope |
| --- | --- | --- | --- |
| LAN (main events) | 241 | 0.658 | 0.89 |
| Online qualifiers and online stages (`publishertier` "Tier 1 Qualifier") | 160 | 0.699 | 0.32 |
| of which BLAST Bounty Summer 2026 Qualifier | 24 | 0.898 | −0.80 |

That split is much weaker in training. 2025 tier 2 has slope 0.89 (online 0.95, qualifiers 0.68), and 2024 tier 2 has 0.68 (qualifiers 0.61).

**Test.** τ multiplied the map-level Elo gap (logit) before the Bo3/Bo5 conversion, for tier-2 series odds only. Ratings and map predictions were unchanged. τ was gridded 0.5–1.0 on 2024–25 tier-2 series log loss (965 series) and gave **τ = 0.7375** (train 0.62888 → 0.62206, slope 0.720 → 0.983).

| 2026 | Baseline | τ = 0.7375 |
| --- | --- | --- |
| Gate log loss (9,167 series) | 0.6132 | 0.6129 |
| Tier-2 log loss (401) | 0.6742 | 0.6675 |
| Tier-2 slope | 0.597 | 0.817 |
| Tiers 1 and 3 | — | unchanged |

- Rejected, because the gate gain is about 0.0003, under the 0.0005 bar.
- The cap is structural. Tier 2 is 4% of the gate set, so the 0.0067 tier-2 gain is diluted to 0.0003 at most. Even the 2026-optimal τ (0.65, tier-2 0.6670) only reaches about 0.0003.
- Elo's published series odds stay untempered. The simulator keeps `TIER_TEMP = { 2: 0.905 }`, where tier-2 odds are the whole point.

## 2026-11-19: Home-region advantage at LANs (`homeElo`) — rejected

**Question:** At a LAN in its own Valve region (home crowd, no travel), does a team beat its rating against an opponent from elsewhere?

**Definitions.** Event region is `countryRegion(locations.country1)` from the Liquipedia tournament row (local store only, `data/raw/archive/tournaments-*.json` plus `data/raw/tournaments.json`), joined on `EloMatch.event`. Every LAN series from 2024 on has a row with a country, and no event lists venues in two regions. Team region is the lineage's `region` (Valve's `region.js` on core players' countries), not the VRS snapshot join, which starts 2024-08 and only covers ranked rosters. A series is home-vs-away when exactly one side's region matches the event's. About 75% of LAN series have both sides in the event's region, so no term applies to them.

**Raw residual** (today's params, home side's view; points from a logistic fit of `y` on the home indicator with `logit(p)` as offset, ± 1 SE):

| Slice | Series | Series points | Maps | Map points |
| --- | --- | --- | --- | --- |
| 2024 | 449 | −11.6 ± 19.2 | 897 | −11.7 ± 13.0 |
| 2025 | 532 | +18.6 ± 16.5 | 1,154 | +11.4 ± 10.9 |
| **2024–25 (train)** | 981 | **+5.8 ± 12.5** | 2,051 | +1.9 ± 8.4 |
| 2024–25 tier 1 | 570 | +16.7 ± 16.7 | 1,202 | +6.8 ± 11.0 |
| 2024–25 tier 2+ | 411 | −8.6 ± 19.1 | 849 | −4.8 ± 12.9 |
| 2024–25 same country | 225 | +4.7 ± 26.3 | 454 | +2.0 ± 17.9 |
| 2024–25 region only | 756 | +6.1 ± 14.3 | 1,597 | +1.9 ± 9.5 |
| 2026 (test) | 653 | +21.2 ± 14.9 | 1,362 | +14.5 ± 10.1 |

Train is null and the sign flips between 2024 and 2025 (tier 1: −44 in 2024, +55 in 2025). A home country (event in the home core's majority country) isn't stronger than region-only. 2026 leans positive but is the test year.

**Change (trial).** `homeElo` added `homeElo · h` to the rating gap (`h` = ±1 for the home side), in both the prediction and the update's expected score, like the skill shift. Sweep (train / gate / gate home-vs-away subset, 543 series):

| `homeElo` | 0 | 5 | 10 | 15 | 20 | 30 | 40 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Train | **0.61094** | **0.61094** | **0.61094** | 0.61095 | 0.61096 | 0.61099 | 0.61104 |
| Gate | 0.61317 | 0.61314 | 0.61312 | 0.61311 | 0.61312 | 0.61315 | 0.61322 |
| Gate home | 0.6159 | 0.6158 | 0.6159 | 0.6161 | 0.6165 | 0.6176 | 0.6193 |

**Rejected.** Train is flat from 0 to 10, and the best gate gain anywhere is 0.00006 (at 15), far under the 0.0005 bar. On the home-vs-away series it's meant to fix, any value above 5 makes the gate worse. Test LAN slope doesn't move (1.178 → 1.180), so this isn't the 2026 LAN underconfidence either. Engine, param, loader and `--home-residual` code were reverted. Params are unchanged, so the registered 2024 test is unaffected.

- Revisit only if 2027 home-vs-away series show a residual above 20 points again. With 2026 at +21 ± 15, pooling it with 2027 as a declared test would be the honest read.

## 2026-11-19: Veto-aware series odds (v2) and play-share pool weights — rejected

**Question:** v1 averages the map probability over the active pool. Does pricing a series on the maps its HLTV veto actually produced lower series log loss? And for series without a veto, does weighting the pool by both teams' play share (a pick/ban proxy) help?

**Veto-aware (v2).** `cs2wp veto` now ends with a series gate (`series_gate` in `wp/src/cs2wp/veto.py`, report section "Series gate"). `export-map-elo` writes Elo's series `p` to `elo-series.jsonl` so v1 is exactly what the backtest scores. Vetoed series with a standard Bo1/Bo3/Bo5 veto over 7 maps are scored three ways against v1, with events resampled:

- **Elo, veto maps:** Elo's map offsets on the actual picks plus the decider.
- **Model, veto maps (v2):** `cs2wp veto`'s map model (`veto-v2`, coefficients fit on 2025) on the same maps, with γ for the picker. This is the actual veto's terminal value in the value-lost solver.
- **Model, pool:** the map model averaged over the 7-map pool, i.e. no veto knowledge.

| Series | n | Events | v1 | Elo, veto maps (gain, 90% CI) | Model, veto maps | Model, pool |
| --- | --- | --- | --- | --- | --- | --- |
| 2026 vetoed | 608 | 22 | 0.6113 | −0.0001 (−0.0004, +0.0002) | −0.0017 (−0.0047, +0.0010) | −0.0005 (−0.0014, +0.0004) |
| 2026 Bo1 | 64 | 4 | 0.6160 | +0.0001 (−0.0007, +0.0007) | −0.0004 (−0.0124, +0.0172) | −0.0009 (−0.0027, +0.0015) |
| 2026 Bo3 | 526 | 22 | 0.6123 | −0.0001 (−0.0005, +0.0003) | −0.0016 (−0.0048, +0.0017) | −0.0006 (−0.0014, +0.0004) |
| 2024–2025 (in-sample coefs) | 827 | 33 | 0.6213 | +0.0004 (−0.0000, +0.0008) | +0.0038 (+0.0012, +0.0065) | +0.0004 (+0.0000, +0.0007) |

v2 is worse than v1 out of sample, and only wins on the years its coefficients were fit on. Knowing the maps adds nothing under Elo's own offsets (−0.0001), which matches sim-veto's "played maps known" ceiling ([simulator.md](simulator.md#veto-simulation-off-ties-the-current-simulator)). The map model's +0.0015 per-map edge on vetoed maps doesn't carry to the series: even averaged over the pool it loses 0.0005.

**Play share (no veto data).** A trial `playShareWeight` λ blended the pool average from uniform toward weights `(s_A(m) + s_B(m)) / 2`, where `s_X` is the lineage's play share on pool maps, decayed with a 180-day time constant and shrunk toward uniform by 5 plays.

| λ | 0 (v1) | 0.25 | 0.5 | 1 |
| --- | --- | --- | --- | --- |
| Train | 0.61094 | 0.61094 | 0.61094 | 0.61095 |
| Gate | 0.61317 | 0.61318 | 0.61318 | 0.61320 |

Flat: Elo's map offsets are too small (`kMap` 4, `mapShrink` 0.02) for reweighting the pool to move the average. The engine code was reverted.

**Decision:** keep v1. Don't build v2: the CI never clears 0, the point estimate is negative, and only about 7% of gate series have a veto anyway. Revisit only if a map model beats v1 on 2026 vetoed series at the series level.

## 2026-11-18: Does HLTV add information beyond Elo? Encompassing test — informational, not gated

**Question:** Elo beats HLTV head to head on tier-1 LANs, but does HLTV carry information Elo lacks? If so, a blend would beat Elo alone.

**Method.** On the HLTV test set, fit one λ by maximum likelihood in `logit(p) = logit(p_elo) + λ · (logit(p_hltv) − logit(p_elo))` with `lambdaCi` from `scripts/lib/elo/encompassing.ts` (2,000 event-bootstrap draws, seed 1). λ = 0 means HLTV adds nothing, λ = 1 means HLTV alone is as good as any blend. Everything is out of sample: Elo params and HLTV `β`s were fit on 2024–2025. `npm run backtest-elo` now prints both lines after the HLTV gains (console only, not in `calibration.json`).

The set is now 651 test series (was 630 on 2026-11-15) and Elo scores 0.6064 on it (was 0.6094), after the Elo and matchdata changes since that entry; 776 training series and `β`s are unchanged.

| HLTV forecast | Series | λ | 90% CI |
| --- | --- | --- | --- |
| Points, `(pts_a − pts_b) / 100`, `β = 0.26` | 651 | 0.034 | −0.273 to 0.413 |
| Rank, `β = 0.70` | 651 | 0.108 | −0.196 to 0.402 |

**Decision:** no blend. Neither CI is above 0, and both point estimates are near 0, so Elo already encompasses HLTV's ranking on these series. Elo's head-to-head gain also tightened: +0.0233 (CI +0.0046 to +0.0395) over points and +0.0180 (CI +0.0041 to +0.0327) over rank, both now clear of 0. The CI upper bounds (~0.4) leave room for a small HLTV contribution that 651 series can't detect.

## 2026-11-18: LAN vs online `seriesMapTemp` (`seriesMapTempOnline`) — rejected

**Question:** The 2026-10-20 entry left LAN series underconfident and online slightly overconfident. Does a separate series temperature for online series lower gate loss?

**Change.** New param `seriesMapTempOnline`, used in place of `seriesMapTemp` for online series' Bo3/Bo5 conversion (`engine.ts`). It's absent from `params.json`, so it follows `seriesMapTemp` and the baseline is unchanged. `--set seriesMapTemp=x` also carries to it unless it's set explicitly. Ratings don't move, only series p. The backtest now prints `train LAN` / `train online` calibration too.

Baseline (today's params): train 0.61094, gate 0.61317 on 9,167 series. Train / gate with `seriesMapTemp` (LAN) at 0.8:

| `seriesMapTempOnline` | Train | Gate |
| --- | --- | --- |
| 0.65 | 0.61265 | 0.61539 |
| 0.7 | 0.61180 | 0.61433 |
| 0.75 | 0.61123 | 0.61359 |
| 0.8 (baseline) | 0.61094 | 0.61317 |
| **0.825** | **0.61090** | 0.61308 |
| 0.85 | 0.61092 | 0.61306 |
| 0.875 | 0.61101 | 0.61311 |
| 0.9 | 0.61115 | 0.61324 |
| 0.95 | 0.61163 | 0.61370 |

Follow-up, `seriesMapTemp` (now LAN only) with online at 0.825:

| `seriesMapTemp` | 0.6 | 0.65 | 0.7 | **0.75** | 0.8 | 0.85 | 0.9 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Train | 0.61111 | 0.61096 | 0.61087 | **0.61085** | 0.61090 | 0.61100 | 0.61116 |
| Gate | 0.61467 | 0.61407 | 0.61360 | 0.61328 | 0.61308 | 0.61300 | 0.61304 |

Calibration slope by slice:

| Slice | Baseline (0.8 / 0.8) | Online 0.825 | Online 0.825, LAN 0.75 |
| --- | --- | --- | --- |
| Train LAN (5,531) | 0.860 | 0.860 | 0.903 |
| Train online (36,543) | 1.015 | 0.995 | 0.995 |
| Test LAN (4,655) | 1.178 | 1.178 | 1.236 |
| Test online (13,414) | 0.977 | 0.952 | 0.952 |
| Gate set | 1.020 | 1.000 | 1.015 |

**Rejected.** Train picks online 0.825, which gains 0.0001 on the gate, under the 0.0005 bar. The train-best LAN value (0.75) makes the gate worse (0.61328). Params are unchanged, so the registered 2024 test is unaffected (`--set burstMaps=0` still reproduces train 0.61138, gate 0.61490).

- 0.8 was already near-optimal for online, which is 87% of train series, so the shared value was fit to online in the first place.
- The LAN gap flips between years: overconfident on 2024–25 (slope 0.86), underconfident on 2026 (1.18). Train pushes LAN softer, 2026 wants it sharper. That's drift, not a series-conversion problem a fixed temperature can fix, and it matches the slower-Elo drift in the `k` entries below.
- The param stays in the engine at its neutral default and in `--tune`'s steps. The simulator wasn't wired to it.

**Follow-up: is the LAN gap map-level?** If LAN maps were steadily underconfident, a LAN multiplier on the map logit would be the right fix rather than a series temperature. The backtest now prints slope by year and venue (today's params):

| Year | LAN maps | LAN Bo1 | LAN Bo3+ | Online maps | Online Bo1 | Online Bo3+ |
| --- | --- | --- | --- | --- | --- | --- |
| 2024 | 0.657 (4,789) | 0.615 (592) | 0.709 (1,742) | 0.942 | 1.014 | 0.949 |
| 2025 | 1.037 (6,668) | 0.922 (728) | 1.107 (2,469) | 1.022 | 0.993 | 1.086 |
| 2026 | 1.130 (9,549) | 1.153 (1,096) | 1.188 (3,559) | 0.957 | 0.948 | 0.985 |

- The LAN gap is map-level: maps, Bo1 and Bo3+ move together, so the series conversion isn't the cause.
- It isn't a stable bias. LAN slope climbs every year (0.66 → 1.04 → 1.13), while online stays within 0.94–1.09. 2024 is probably warm-up, since the feed starts 2023-10-01 and LAN ratings start from sparse LAN history. 2025 is close to calibrated.
- A LAN map multiplier fit on 2024–25 would land below 1 and hurt 2026, the same failure as the series split. Only 2026 asks for one above 1. **Closed.** Reopen only as a declared test if 2027 LAN maps also show a slope above 1.1.

## 2026-11-18: Burst-damped K (`burstMaps`, `burstDays`) — kept

**Question:** The K sweep below left the over-reaction in place. Which past residuals carry it, and does a fix aimed there pass where `k` didn't?

**Where the lead lives.** `--residual-lead` now also splits `u` into two parts that share one denominator, fitted together (today's params, all 2026 maps):

| Split | Part 1 | Part 2 |
| --- | --- | --- |
| Age at prediction | ≤ 7 days: **−9.20 ± 0.89** | older: −5.78 ± 0.51 |
| Map margin | ≥ 8 rounds: −5.70 ± 0.72 | closer: −6.58 ± 0.49 |
| Position in series | map 2+: −6.43 ± 0.55 | map 1: −6.39 ± 0.58 |

The over-reaction is concentrated in recent results, so it's bursts of maps (one event, a few days). Blowouts aren't worse, so the margin multiplier isn't the cause. Later maps of a series aren't worse either, so a per-series update damping has nothing to fix and wasn't built. `marginWeight` acts like `k`: 0 / 0.25 / 0.5 / 1 give train 0.62391 / 0.61553 / 0.61218 / 0.61212 against 0.61138 at 0.75, while the gate prefers lower (0.25: 0.61337). Rejected for the same reason as `k`.

**Change.** New params in `engine.ts`: K divides by `1 + load / burstMaps`, where `load` is the lineage's earlier maps decayed with time constant `burstDays` (`burstMaps` 0 is off, the old behaviour). It's a cheap form of an uncertainty-aware K: evidence arriving in a burst counts for less.

Train / gate / all-maps coefficient, other params unchanged (baseline 0.61138 / 0.61490 / −6.41):

| `burstDays` \ `burstMaps` | 16 | 24 | 32 | 48 | 64 | 80 |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | 0.61117 / 0.61297 / −4.68 | 0.61107 / 0.61334 / −5.22 | 0.61107 / 0.61361 / −5.50 | 0.61111 / 0.61395 / −5.79 | | |
| 5 | 0.61132 / 0.61263 / −4.11 | 0.61107 / 0.61297 / −4.79 | 0.61102 / 0.61326 / −5.16 | 0.61103 / 0.61364 / −5.56 | | |
| 7 | 0.61154 / 0.61246 / −3.62 | | 0.61101 / 0.61300 / −4.87 | 0.61098 / 0.61341 / −5.35 | 0.61101 / 0.61368 / −5.60 | |
| 10 | | 0.61129 / 0.61251 / −3.94 | 0.61106 / 0.61274 / −4.47 | 0.61095 / 0.61314 / −5.07 | 0.61096 / 0.61343 / −5.38 | |
| 14 | | 0.61161 / 0.61239 / −3.39 | 0.61123 / 0.61253 / −4.02 | 0.61099 / 0.61288 / −4.73 | **0.61094 / 0.61317 / −5.12** | 0.61095 / 0.61339 / −5.36 |
| 20 | | 0.61222 / 0.61244 / −2.70 | 0.61159 / 0.61243 / −3.44 | 0.61113 / 0.61265 / −4.29 | 0.61099 / 0.61291 / −4.77 | 0.61096 / 0.61313 / −5.07 |

Also tried: `burstDays` 1–2 (train ≥ 0.61109), 30 / 96 (0.61101), and small `burstMaps` (2–8), which over-damp (train up to 0.642, coefficient turns positive). With `k` 13 or 14 at 5 / 32, train is 0.61091 / 0.61104 and the gate 0.61381 / 0.61447.

**Kept: `burstMaps` 64, `burstDays` 14**, the train-best cell. Train 0.61138 → 0.61094, gate 0.6149 → **0.6132** (−0.0017), test series slope 0.982 → 1.030, cross-region 0.6247 → 0.6253. The coefficient moves from −6.41 to −5.12 (≤ 7 days: −7.92). Train is flat along a ridge (0.61094–0.61107), and the gate gain holds across all of it (−0.0010 to −0.0025), so the choice of cell isn't driving the result.

- A full `--tune` with the burst steps (not written) reached train 0.60998 and gate 0.61274, but it also moved `kMap` to 0, `marginWeight` to 1.25, `onlineK` to 1.1, `provisionalK` to 2, `coreWindow` to 7 and `standInK` to 1. `kMap` 0 turns off the map offsets the simulator and veto model read, so it wasn't adopted. Its coefficient was −5.70, worse than burst alone.
- Lower `burstMaps` keeps shrinking the coefficient and improving 2026 but costs train, the same 2026-wants-a-slower-Elo drift as `k`. About −5 of the lead is still there.
- **Registered 2024 test:** it must run on params as they stood at registration, which is `scripts/lib/elo/params.json` as of 0176598 (no `burstMaps`, so off). Today's code reproduces that exactly with `--set burstMaps=0` (train 0.61138, gate 0.61490 checked). Add that flag to the registered command.

## 2026-11-18: Over-reaction lead: `provisionalK`, `provisionalMaps`, `k` — rejected

**Question:** A lineage's mean past residual against Elo predicts its next maps with a negative sign (−8.4 ± 1.0 in `cs2wp veto`, [roadmap.md](roadmap.md)). Does a lower `provisionalK` or `k` remove that over-reaction and lower gate loss?

`npm run backtest-elo -- --residual-lead --set …` (new flag). It walks the feed with each lineage's decayed mean map residual `y − p`, using `cs2wp veto`'s `u` settings (40 maps shrink, 365 days decay). It fits one coefficient on the A − B gap on 2026 maps by logistic regression with logit(p) as offset, and exits before `calibration.json` is written. Negative means over-reaction. On today's params it reads −6.41 ± 0.48 on all 38,206 maps and −7.53 ± 2.56 on tier 1, so the lead reproduces.

The feed has grown since the last gate read: today's params score **0.6149** on 9,167 gate series (was 0.6135 on 8,490), so that's the baseline here. Train is 2024–25 series log loss.

| `provisionalK` / maps | 35 | 50 | 70 | 100 | 140 |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.6153 / 0.6146 / −2.45 | | 0.6139 / 0.6146 / −3.33 | | 0.6133 / 0.6150 / −4.25 |
| 1.5 | 0.6138 / 0.6146 / −3.18 | | 0.6124 / 0.6146 / −4.50 | | 0.6123 / 0.6154 / −5.87 |
| 2 | 0.6129 / 0.6147 / −3.78 | | 0.6116 / 0.6147 / −5.52 | | 0.6121 / 0.6159 / −7.31 |
| 2.5 | 0.6123 / 0.6147 / −4.27 | 0.6118 / 0.6148 / −5.34 | **0.6114 / 0.6149 / −6.41** | 0.6118 / 0.6154 / −7.72 | 0.6127 / 0.6164 / −8.59 |
| 3 | | | 0.6116 / 0.6151 / −7.18 | | |

Cells are train / gate / all-maps coefficient, at `k` 12.

| `k` | Train | Gate | Gate slope | Coefficient |
| --- | --- | --- | --- | --- |
| 9 | 0.6125 | 0.6129 | 1.044 | −3.19 ± 0.42 |
| 10 | 0.61172 | 0.61342 | 1.018 | −4.28 ± 0.44 |
| 10.5 | 0.61151 | 0.61374 | | −4.82 ± 0.45 |
| 11 | 0.61138 | 0.61409 | 0.991 | −5.36 ± 0.46 |
| 11.5 | **0.61134** | 0.61448 | | −5.89 ± 0.47 |
| 12 (current) | 0.61138 | 0.61490 | 0.964 | −6.41 ± 0.48 |
| 13 | 0.6116 | 0.6158 | 0.938 | −7.44 ± 0.49 |

`k` 10 and 11 with `provisionalK` 1.5 (train 0.6138 / 0.6129, gate 0.6133 / 0.6139) and `k` 11 with `provisionalK` 2 or 3, or `provisionalMaps` 50 (train 0.61188 / 0.61131 / 0.61206), don't beat the single-parameter moves.

**Rejected.** Train picks today's `provisionalK` 2.5 over 70 maps and `k` ≈ 11.5. That `k` gains only 0.0004 on the gate, under the 0.0005 bar. Params are unchanged, so the registered 2024 test is unaffected.

- `provisionalK` moves the coefficient a lot (−6.4 → −2.5) but the gate hardly at all (best −0.0003), and it costs train loss. The provisional boost isn't what over-reacts in a way that costs log loss.
- `k` is the real lever, but only on 2026. Lower `k` helps the gate steadily (k 9: −0.0020, slope 1.04), while 2024–25 is flat from 11 to 12 and worse below. So 2026 rewards a slower Elo than 2024–25 did. Choosing `k` 10 now would be selection on the test set.
- Even the slowest settings leave the coefficient at about −3, so part of the lead isn't a K problem. A residual the ratings already absorbed still carries noise from the map it came from.
- Reopen as a declared test, not a retune: `k` 10 against 12, scored on 2027 series only, or on walk-forward years once that's built (Untried ideas).

## 2026-11-18: Tier temperature in the simulator (`TIER_TEMP`) — kept for tier 2 only

**Question:** Elo was overconfident at tier 2 (slope 0.54 on 377 series). Does a per-tier temperature fix the simulator's series odds?

Simulation only: Elo ratings and the Elo gate are unchanged. `npm run fit-sim-noise` scales the map-level Elo gap by τ per Liquipedia tier, fits τ on 2025 series log loss, and scores 2026.

| Tier | τ (2025 fit) | 2026 series | 2026 log loss | 2026 slope |
| --- | --- | --- | --- | --- |
| 1 | 0.901 | 719 | 0.6121 → 0.6125 | 0.983 → 1.095 |
| 2 | 0.905 | 401 | 0.6777 → **0.6738** | 0.597 → 0.662 |
| 3+ | 1.034 | 16,949 | 0.5958 → 0.5958 | 1.012 → 0.979 |

- Kept for tier 2 only (`TIER_TEMP = { 2: 0.905 }` in `predict.ts`). It's the only tier where 2026 improves. Tier 2 play is noisier for reasons Elo doesn't see: lots of online play, crowded match days, and integrity concerns.
- Choosing tier 2 after seeing 2026 is mild selection on the test set. 2025 tier 2 was much better calibrated than 2026, so τ fixes only part of the 2026 gap.
- Tier 3+, where mid-table teams grind small events and most qualifiers sit, is already calibrated. So the planner's "Elo is overconfident below tier 1" risk mostly doesn't apply.
- `npm run backtest-sim` replays only a tier-1 fixture, so it can't test this.

## 2026-11-15: HLTV points baseline and calibration curve — informational, not gated

**Question:** How does a points-based HLTV baseline compare against Elo, VRS points, and HLTV rank on tier-1 LANs?

Every cached weekly HLTV ranking page (`ranking-YYYY-MM-DD.html`, 70 distinct weeks covering every exported series) lists all ranked teams down past #250 with their HLTV points. `write_ranks` validates each team's ranking-page position against the match-page badge rank and leaves `points` null on missing teams or mismatches. Four of the 1,413 exported series—all in 2025 from org-roster swaps (`2025-03-31` Aurora/Eternal Fire badge `#5` vs page `#40`, and `2025-09-22` Inner Circle missing from that week's table)—have `points: null`, leaving 776 training series (2025) and all 630 test series (2026 through 2026-11-12).

Two one-parameter logistic links were fit on the 776 training series, keeping the lower training log loss:

| HLTV points link | β | Train log loss | 2026 test log loss |
| --- | --- | --- | --- |
| `(pts_a − pts_b) / 100` (selected) | 0.26 | **0.6282** | 0.6283 |
| `ln pts_a − ln pts_b` | 0.58 | 0.6286 | 0.6245 |

Scored on the 630 test series (`HLTV rank β = 0.70`, `VRS rank β = 0.67`):

| Model | Series | Log loss | Brier | Accuracy |
| --- | --- | --- | --- | --- |
| Elo | 630 | **0.6094** | 0.2107 | 67.3% |
| HLTV points | 630 | 0.6283 | 0.2185 | 65.7% |
| HLTV rank | 630 | 0.6221 | 0.2161 | 65.7% |
| VRS points | 630 | 0.6264 | 0.2182 | 65.2% |
| VRS rank | 630 | 0.6328 | 0.2202 | 65.4% |

Elo − HLTV points log-loss gain is +0.0188 with a 90% event-resampled CI of (−0.0005, +0.0342); against HLTV rank it is +0.0126, CI (−0.0003, +0.0253). `(pts_a − pts_b) / 100` wins training log loss by 0.0004 over `ln pts_a − ln pts_b` and is selected, though both points links trail HLTV's rank-only baseline on 2026 test (and linear points is overconfident in the 80–90% favorite bands—77.5% and 80.0% actual—because HLTV pins #1 at 1,000 points with a long tail).

## 2026-11-15: HLTV world ranking baseline — informational, not gated

**Question:** How does Elo compare against HLTV's weekly world ranking on tier-1 LAN series, and how does HLTV compare against VRS?

Each cached HLTV match page carries both teams' pre-match HLTV world ranks (`data/demos/hltv/ranks.jsonl`, 1,413 series exported). Joined by `match2id` and intersected with VRS-ranked series gives 780 training series (2025) and 630 test series (2026 through 2026-11-12). Since HLTV publishes ranks without points, `hltvBaseline.ts` fits `p = 1/(1 + exp(−β·(ln rank_b − ln rank_a)))` on the 780 training series (`β = 0.69`), alongside a VRS rank-only fit (`β = 0.67`) on the same training set; the VRS points scale stays 880 (fit on all 11,585 training series).

| Model | Series | Log loss | Brier | Accuracy |
| --- | --- | --- | --- | --- |
| Elo | 630 | **0.6094** | 0.2107 | 67.3% |
| HLTV rank | 630 | 0.6219 | 0.2160 | 65.7% |
| VRS points | 630 | 0.6264 | 0.2182 | 65.2% |
| VRS rank | 630 | 0.6328 | 0.2202 | 65.4% |

Elo − HLTV log-loss gain is +0.0124 with a 90% event-resampled CI of (−0.0005, +0.0248). Elo beats HLTV on point estimate across log loss, Brier and accuracy, though at 630 series the 90% interval barely spans zero and cannot settle the edge on its own. HLTV updates weekly while VRS snapshots are roughly monthly, so on this set the VRS baselines are staler than HLTV's. HLTV stays informational on `/model` (`calibration.json` preserves the `hltv` block across CI runs when `ranks.jsonl` is missing) and is never gated.

## 2026-11-15: Encompassing gate and a registered 2024 test — registered, not yet run

**Question:** The gain gate asks whether the adjustment is at least about half as strong as its frozen weights assume, not whether it carries any signal at all, so it has little power for a nested model. Is there a sharper test, and data no choice was made on?

- **Encompassing statistic.** `backtest-elo --luck|--skill` now also fits one λ by maximum likelihood on treated series, in `logit(p) = logit(p_base) + λ · (logit(p_adjusted) − logit(p_base))`, with the same event bootstrap as the gain CI (`scripts/lib/elo/encompassing.ts`). λ = 0 is no signal, λ = 1 is the frozen weights right.
- **Check on 2025 only** (`--test-from 2025-01-01 --test-to 2025-12-31`, in-sample for the weights, so not evidence): λ 1.448, 90% CI 0.756 to 2.014; gain +0.0089, CI +0.0024 to +0.0141.
- **Power simulation** (`--simulate 1000`): 1,000 event resamples of the 844 2025 treated series (67 events), outcomes drawn at a true λ, 400 inner bootstrap draws. λ̂ has SD 0.35 at this size.

| True λ | Gain gate (CI above 0) | Encompassing gate (λ CI above 0, gain above 0) |
| --- | --- | --- |
| 0 | 0.0% | 5.3% |
| 0.5 | 4.8% | 41.4% |
| 1 | 42.9% | 87.0% |

The encompassing gate holds its 5% size and roughly doubles power, as the back-of-envelope said. Applying it to 2026 now would be a gate change after seeing the result, so it's only used on data not yet scored.

**2024 is that data.** Demo coverage starts 2025-01-23 but the Elo feed starts 2023-10-01, and no weight, variant or rule was chosen on 2024 (the base Elo params were tuned with 2024 in sample, which only makes the baseline harder to beat). The local store has 23 tier-1 LAN events from 2023-10-01 to 2024-12-31: 756 series, 1,603 maps, none with an HLTV link yet (`npm run backfill-hltv-links -- --from 2023-10-01 --to 2025-01-01` fills that). The coverage simulation put 2024 treated series at about 815. The registered test is in [roadmap.md](roadmap.md) and replaces the pooled 2026 + 2027 test.

**Incidental read.** Checking that the gain line was unchanged by this work printed the 2026 gain under the teammate-mean rule, which the entry below hadn't read: +0.0065, CI −0.0027 to +0.0158 (θ = 0 rule: +0.0060). It changes no decision. The 2026 `Encompassing` line was not read.

## 2026-11-14: Skill term without θ = 0 for unknown players — kept in the engine, weights still 0

**Question:** The combined form below makes untreated series slightly worse, likely because players with no demo history count as θ = 0, the tier-1 LAN average. Now a player with no history takes the mean θ of teammates who have it, and the skill gap is 0 unless both sides have at least 3 players with history (`EloEngine.skillGap`). Declared beforehand: judged on 2025 all-series loss only at the frozen weights (`skillWeight` 8,458, `value` w = 0.6), kept if no worse than no adjustment. The 2026 lines weren't read for this decision. `npm run backtest-elo -- --skill --skill-weight 8458 --luck-weight 0.6 --luck-variant value` (the new `--skill-weight` scores one weight with no grid).

| 2025 | none | `value` w = 0.6 | Combined, θ = 0 | Combined, teammate mean |
| --- | --- | --- | --- | --- |
| All series | 0.60785 | 0.60750 | 0.60767 | **0.60735** |
| Treated series (844) | 0.62512 | 0.61994 | 0.61618 | 0.61622 |

**Kept.** All-series loss drops below both no adjustment and `value` alone, so the combined form no longer gives back `value`'s gain off the treated set, and the treated-series fit is unchanged. Every 2025 treated series still has a nonzero gap. The weights stay frozen and `skillWeight` / `luckWeight` stay 0 in the live params.

**Coverage count.** Simulating demo coverage on the feed (the same treated rule: both sides 5+ covered maps in 120 days; the simulation gives 845 / 822 for today's coverage against the real 844 / 822):

| Demo coverage | 2025 treated | 2026 treated (to 11-12) |
| --- | --- | --- |
| Tier-1 LAN (today) | 845 | 822 |
| + tier-2 LAN | 1,110 | 1,110 |
| + tier-1 online | 916 | 850 |
| + both | 1,131 | 1,139 |
| All tier 1–2 | 1,363 | 1,447 |

Tier-2 LAN plus tier-1 online adds about 600 treated series across 2025–26, and even full tier 1–2 coverage adds about 1,150, short of the ~1,500 the declared rule needed. Most tier-2 teams don't play enough covered maps to reach 5 in 120 days. So wider coverage doesn't make the gate reachable, and the term is **parked**: no shadow mode, no backfill for this purpose. The pooled 2026 + 2027 test in [roadmap.md](roadmap.md) still runs, as a test with about a 1-in-2 chance of passing.

## 2026-11-14: Player-skill term (`skillWeight`, `--skill`) — not kept

**Question:** The skill-only control below gained +0.0020 and was still improving at the grid edge, so Elo looks short of information about how good the players are at duels. Does feeding it in directly help? Each side's mean prior duel skill θ (execution per duel over the player's demo series strictly before this one, shrunk by k = 1,207 duels) shifts the predicted rating gap by `skillWeight · (θ̄_A − θ̄_B)`. The shifted expectation is used in the update too, so the rating learns only what the term leaves over. Players with no demo history count as θ = 0 ([war.md](war.md#player-skill-term)). Same treated set and gate as the luck runs. Grid: 0 to 100 Elo points per SD of the 2025 treated skill gap (SD 0.0071 θ, so 10 pts/SD = `skillWeight` 1,409.6). Declared beforehand: it beats the luck variants only if its 2025 tuned loss is below `value`'s 0.61994 inside the grid; a combined run with `luckWeight` held at 0.6 (`value`) shows separate effects only if its 2025 loss is below both single runs. Exploratory: the sixth and seventh things scored on these 2026 series.

| Pts/SD | Skill alone, 2025 log loss | Skill + `value` w = 0.6, 2025 log loss |
| --- | --- | --- |
| 0 | 0.62512 | 0.61994 |
| 10 | 0.62485 | 0.61885 |
| 20 | **0.62476** | 0.61795 |
| 30 | 0.62486 | 0.61723 |
| 40 | 0.62515 | 0.61669 |
| 60 | 0.62628 | **0.61618** |
| 80 | 0.62816 | 0.61642 |
| 100 | 0.63079 | 0.61740 |

| 2026 | n | none | Skill, 20 pts/SD | `value` w = 0.6 | Skill 60 pts/SD + `value` w = 0.6 |
| --- | --- | --- | --- | --- | --- |
| Treated series | 822 | 0.6277 | 0.6269 | 0.6241 | 0.6217 |
| Treated maps | 1,931 | 0.6566 | 0.6566 | 0.6527 | 0.6525 |
| Gate set series | 9,150 | 0.6151 | 0.6151 | 0.6144 | 0.6147 |
| All series | 18,069 | 0.5982 | 0.5984 | 0.5978 | 0.5982 |
| Treated-map margin MSE | 1,931 | 32.045 | 32.008 | 31.857 | 31.788 |

- **Skill alone:** tuned at 20 pts/SD (`skillWeight` 2,819), 2025 loss 0.62476, nowhere near `value`'s 0.61994, so by the declared rule it doesn't beat the luck variants. 2026 treated-series gain +0.0008, 90% CI −0.0006 to +0.0022: **fails the gate.** It is also smaller than the skill-only control's +0.0020, so a prior-skill shift on the prediction does less than skill entering through the update target. All series gets slightly worse (0.5984 against 0.5982): series with no demo history get θ = 0 on one or both sides.
- **Combined:** 2025 loss 0.61618 at 60 pts/SD (`skillWeight` 8,458), below both single runs, so by the declared rule skill and luck are separate effects. With luck noise removed from the updates, the skill term takes three times the weight. 2026 treated-series gain +0.0060, CI −0.0022 to +0.0144: **fails the gate**, though it is the largest gain of any variant and the best on treated series, treated maps and margin (+0.81%, CI −0.03 to +0.53 MSE). Off the treated set it gives back part of `value`'s gain (gate set 0.6147 against 0.6144), the same θ = 0 effect as above.
- `skillWeight` and `luckWeight` stay 0. The 2027 no-retuning test now scores the combined form ([roadmap.md](roadmap.md)).

## 2026-11-14: Non-duel luck and a skill-only control (`--luck-variant full`, `skillonly`) — not kept

**Question:** Two follow-ups to the value variant below. (1) `full`: does also removing round-conversion luck help? `x_margin_full = margin − β_v · exec_luck_value − β_c · conv`, with both βs fit jointly ([war.md](war.md#non-duel-luck-and-the-skill-control)). (2) `skillonly`: how much of the value variant's gain is player skill entering Elo instead of luck leaving it? `x_margin_skillonly = margin + β · exec_skill_value` is the value variant with the luck removal left out. Same protocol and gate. Exploratory: the fourth and fifth variants scored on the same 2026 series.

| w | `value` 2025 log loss | `full` 2025 log loss | `skillonly` 2025 log loss |
| --- | --- | --- | --- |
| 0 | 0.62512 | 0.62512 | 0.62512 |
| 0.2 | 0.62179 | 0.62055 | 0.62456 |
| 0.4 | 0.62026 | 0.61813 | 0.62417 |
| 0.6 | **0.61994** | **0.61714** | 0.62387 |
| 0.8 | 0.62128 | 0.61796 | 0.62364 |
| 1.0 | 0.62486 | 0.62112 | **0.62349** |

| 2026 | n | w = 0 | `value`, w = 0.6 | `full`, w = 0.6 | `skillonly`, w = 1 |
| --- | --- | --- | --- | --- | --- |
| Treated series | 822 | 0.6277 | 0.6241 | 0.6243 | 0.6256 |
| Treated maps | 1,931 | 0.6566 | 0.6527 | 0.6529 | 0.6566 |
| Gate set series | 9,150 | 0.6151 | 0.6144 | 0.6144 | 0.6150 |
| All series | 18,069 | 0.5982 | 0.5978 | 0.5978 | 0.5983 |
| Treated-map margin MSE | 1,931 | 32.045 | 31.857 | 31.873 | 31.955 |

- **`full`:** treated-series gain +0.0034, 90% CI −0.0039 to +0.0106: **fails the gate.** It fits 2025 better than `value` (0.61714 against 0.61994) but is no better on 2026 on any row, so the 2025 edge didn't carry. Of the checks declared beforehand, same-map variance (72.9% against 68.6%) and the 2025 tune pass; the 2025 carryover coefficient is −0.16 with its interval reaching 0 (−0.34, +0.00), which misses. `value` stays the best form.
- **`skillonly`:** treated-series gain +0.0020, CI −0.0040 to +0.0080. It reproduces 31% of the value variant's 2025 gain (0.0016 of 0.0052), so by the reading fixed beforehand most of the gain is luck removal. On 2026 the share is 56% (0.0020 of 0.0036), with both numbers inside each other's noise. Its 2025 curve is still falling at w = 1, so the skill term would take a larger weight than β gives it.
- `luckWeight` stays 0. The 2027 no-retuning test of `value` at w = 0.6 is unchanged.

## 2026-11-14: Value-weighted luck (`luckWeight`, `--luck-variant value`) — not kept, best variant so far

**Question:** The skill variant below counts every duel the same. Does weighting each duel's luck by its stake (the man-count value of the attacker's kill plus the victim's counterfactual one) correct better? `cs2wp luck` writes `x_margin_value = margin − β · Σ (win − p − (θ_self − θ_opponent)) · stake` ([war.md](war.md#value-weighted-luck)). Same protocol and gate. Exploratory: this is the third variant scored on the same 2026 series.

| w | 2025 treated series log loss (844) | 2025 treated-map margin MSE |
| --- | --- | --- |
| 0 | 0.62512 | 30.507 |
| 0.2 | 0.62179 | 30.368 |
| 0.4 | 0.62026 | 30.272 |
| 0.6 | **0.61994** | **30.230** |
| 0.8 | 0.62128 | 30.260 |
| 1.0 | 0.62486 | 30.399 |

| 2026 | n | w = 0 | w = 0.6 |
| --- | --- | --- | --- |
| Treated series | 822 | 0.6277 | 0.6241 |
| Treated maps | 1,931 | 0.6566 | 0.6527 |
| Gate set series | 9,150 | 0.6151 | 0.6144 |
| All series | 18,069 | 0.5982 | 0.5978 |
| Treated-map margin MSE | 1,931 | 32.045 | 31.857 |

Treated-series gain +0.0036, 90% CI −0.0034 to +0.0106: **fails the gate**, so `luckWeight` stays 0. Margin gain +0.188 MSE (0.59%), CI −0.079 to +0.443; at w = 0.5 the same gain has CI −0.042 to +0.409. Against the skill variant it is better everywhere: about three times the gain on both scores, and full adjustment (w = 1) no longer scores worse than none in 2025. The two checks declared beforehand also pass (same-map margin variance explained 68.6% vs 64.9%; carryover −0.19, CI −0.32 to −0.06). The gate-set move of 0.0007 is now above the 0.0005 noise threshold, but the treated-series interval still spans 0, and three variants have been tried on this test set. The clean test is 2027 tier-1 LAN series, scored at w = 0.6 with no retuning.

## 2026-11-14: Skill-adjusted luck (`luckWeight`, `--luck-variant skill`) — parked

**Question:** The entry below removed all duel execution, which includes duel skill, because the duel model has no player identity. Does discounting only the part that each player's prior execution doesn't predict help? `cs2wp luck` now splits `exec` into `exec_skill` (Σ `θ_self − θ_opponent`, with θ from duels before the event, shrunk by k = 1,207 duels) and `exec_luck`, and `x_margin_skill = margin − β · exec_luck` ([war.md](war.md#luck-adjusted-elo)). Same protocol and gate as below: `npm run backtest-elo -- --luck` (`--luck-variant raw` reproduces the entry below).

| w | 2025 treated series log loss (844) |
| --- | --- |
| 0 | 0.62512 |
| 0.2 | 0.62183 |
| 0.4 | 0.62068 |
| 0.5 | **0.62067** |
| 0.6 | 0.62112 |
| 1.0 | 0.62740 |

| 2026 | n | w = 0 | w = 0.5 |
| --- | --- | --- | --- |
| Treated series | 822 | 0.6277 | 0.6263 |
| Treated maps | 1,931 | 0.6566 | 0.6545 |
| Gate set series | 9,150 | 0.6151 | 0.6147 |
| All series | 18,069 | 0.5982 | 0.5980 |

Treated-series gain +0.0013, 90% CI −0.0047 to +0.0076 (events resampled): **fails the gate**, so `luckWeight` stays 0. Every 2026 row moves the right way, and the direct carryover test says the effect is real: with Elo in the model, a team's trailing duel luck predicts its next round margin negatively (−0.17, CI −0.31 to −0.04), while trailing raw execution predicts nothing (+0.00). The interval here is too wide for 822 series to settle it. Two things to keep in mind before a re-run: `x_margin_skill` also adds θ, which Elo doesn't have (trailing skill coefficient +0.38), so part of the gain may be new information and not luck removal; and w = 0.5 was the tuned value for 2025, where the curve is flat from 0.4 to 0.5.

**Round-margin score (exploratory, run after the 2026 results above were seen).** The same ratings, scored on each treated map's round margin, predicted as slope · logit(p) with the slope fit on 2025 for each w. This is how luck-adjusted ratings are judged in basketball.

| 2025 treated maps, margin MSE | w = 0 | Best w | At best w |
| --- | --- | --- | --- |
| Skill variant | 30.507 | 0.6 | 30.272 |
| Raw variant | 30.507 | 0.3 | 30.405 |

| 2026 treated maps (1,931), w = 0 MSE 32.045 | MSE | Gain (90% CI, events resampled) |
| --- | --- | --- |
| Skill, w = 0.6 (margin-tuned) | 31.994 | +0.051, 0.16% (−0.200, +0.306) |
| Skill, w = 0.5 | 31.977 | +0.068, 0.21% (−0.145, +0.283) |
| Raw, w = 0.3 (margin-tuned) | 32.110 | −0.066, −0.20% (−0.149, +0.021) |
| Raw, w = 0.5 | 32.237 | −0.192, −0.60% (−0.343, −0.035) |

The margin score agrees in sign with the log-loss one and is no more decisive: the skill variant's interval spans 0. It does separate the variants, since the raw one gets worse as w rises.

**Why it's parked.** The run already uses the full 2025–2026 tier-1 LAN archive (3,111 of 3,140 maps), so there is no backfill to wait for. The series interval is ±0.006 around +0.0013, which needs about 20 times the series, and tier-1 LANs add about 820 treated series a year. Luck data covers only demo maps, so the gate set moves 0.6151 → 0.6147, under the 0.0005 noise threshold. Reopen only if demo coverage widens to tier 2 or online events. A skill-only control (`margin + β · exec_skill`) to separate luck removal from new information is untried.

## 2026-11-14: Luck-adjusted updates (`luckWeight`) — rejected

**Question:** Should a map's update blend the real result with the duel-expected one (`(1 − w)·y + w·y_hat`, with the margin blended the same way)? Inputs come from `cs2wp luck` ([war.md](war.md#luck-adjusted-elo)), on the 3,111 tier-1 LAN demo maps. `npm run backtest-elo -- --luck` tunes w on 2025 series where both rosters have 5+ luck maps in 120 days, with every other parameter frozen, and scores the 2026 ones.

| w | 2025 treated series log loss (844) |
| --- | --- |
| 0 | 0.62512 |
| 0.1 | 0.62404 |
| 0.2 | **0.62358** |
| 0.3 | 0.62382 |
| 0.5 | 0.62583 |
| 1.0 | 0.64226 |

| 2026 | n | w = 0 | w = 0.2 |
| --- | --- | --- | --- |
| Treated series | 822 | 0.6277 | 0.6287 |
| Treated maps | 1,931 | 0.6566 | 0.6562 |
| Gate set series | 9,150 | 0.6151 | 0.6150 |

Treated-series gain −0.0010, 90% CI −0.0037 to +0.0019 (events resampled): **rejected**, and `luckWeight` stays 0. The hot-hand check finds no form carrying over between series, but duel execution above expectation is mostly a stable skill, so discounting it also discounts real strength. The plain gate today reads 0.6151 vs 0.6497 on 9,150 series, because the feed has grown since the initial tuning. At w = 0 the engine reproduces the old ratings exactly.

## 2026-10-20: Simulator rating noise — per-event form rejected, horizon drift kept

**Question:** The tournament simulator ([simulator.md](simulator.md)) holds Elo fixed. Should each simulation draw a strength offset per team that's shared across its matches? The offset has to describe real correlation that the per-series odds don't already include. Elo's series odds are already calibrated as marginals, so any extra noise also flattens every single match. `npm run fit-sim-noise` measures both candidates.

**Per-event form (rejected).** The method of moments on residual covariance between a team's series in the same event: σ² = Σ rᵢrⱼ / Σ gᵢgⱼ over pairs, where g is the series probability's slope per Elo point. Jackknife SEs are over team-events.

| Period | Team-events | Series pairs | σ² (Elo²) |
| --- | --- | --- | --- |
| 2024 | 13,404 | 112,707 | 610 ± 369 |
| 2025 | 13,270 | 94,647 | −12 ± 369 |
| 2026 | 12,012 | 49,342 | −619 ± 448 |

None of these is distinguishable from 0. Within an event, a team's results don't share form beyond what Elo's in-event updates already capture.

**Horizon drift (kept).** Var(rating(t+h) − rating(t)) per team over 2025–2026 grows linearly with h:

| h (days) | 7 | 15 | 30 | 45 | 60 | 90 | 120 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Var (Elo²) | 1,768 | 2,502 | 3,565 | 4,605 | 5,519 | 6,939 | 8,448 |

- The slope is q ≈ 58 Elo²/day, about σ 42 at 30 days. The intercept of about 1,700 is Elo's update jitter, which saturates, so only the slope is real drift. It includes roster changes.
- The simulator draws each team's offset as a random walk with variance q per day, sampled at each event's start. A team that drifts up for one event stays up for later events in the same simulation.
- No sharpening is applied, because drift is uncertainty the today-ratings genuinely don't have. At horizon 0 (an event in progress), predictions are plain Elo.

**Cologne 2026 check** (`npm run backtest-sim`, Elo frozen at the event start, horizon 0, 10,000 runs), against coin flips:

| Model | Placement log loss | Champion Brier | Playoffs Brier |
| --- | --- | --- | --- |
| Elo | 1.960 | 0.0354 | 0.1438 |
| Coin flip | 2.146 | 0.0285 | 0.1557 |

The champion Brier is one outcome (Falcons) and is noise at this sample size.

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

- **Veto model.** The Liquipedia API has no veto data. HLTV vetoes and a play-share proxy were both tried on 2026-11-19 and rejected (above).
