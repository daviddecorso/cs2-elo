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

- [ ] **Make the gate the pass/fail.** Add a top-50 / cutoff mode to `compareStandings`. `verify-vrs` passes or fails on it, with `--all-calibrated` running every date in `snapshotWindowEnds.json`.
- [ ] **More snapshots.** Turn the scratch calibration solver into `scripts/calibrate-window.ts`. Calibrate 2026-08-03 and 2026-07-06 (the fetch needs to reach back to early January), then verify across all of them. 2026-11-02 uses the same script once it's published.
- [ ] **Fix only what moves the top 50.** Point `diff-details` at the top-50 rosters and their opponents. Allow a per-event override only when it improves every calibrated snapshot.
- [ ] **Close the factor gaps.** Bounty collected is exact for only 31% of top rosters, and bounty offered misses for 12%. Most of this is likely prize money and club share (`clubShare` is always 0 today). Confirm event by event from the Bounty Offered tables in the details files. Fix bounty offered first, since bounty collected depends on opponents' bounty offered.

## Open items

- Confirm invite cutoffs against Valve's rulebook.
- Once a page showing Liquipedia data is live, send the project link to Liquipedia for verification.
