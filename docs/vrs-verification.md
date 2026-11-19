# VRS verification

## Overview

We verify the pipeline by running Valve's model on our matchdata for a published snapshot date and comparing against Valve's published standings and per-roster details files in `vendor/counter-strike_regional_standings/live/<YYYY>/`. Valve has published monthly snapshots since 2026-01-05. The details files are the ground truth for every roster's counted matches, lineups, age weights and prize winnings.

## Snapshot window

Valve's data pull runs into the snapshot day, and its 180-day window ends at the latest match in that pull, not at midnight. For published snapshots, the window end is calibrated from the age weights in the details files and stored in `scripts/lib/vrs/snapshotWindowEnds.json` (Unix seconds). `getSnapshotWindow` in `scripts/lib/vrs/valveModel.ts` uses the calibrated end as both pull cutoff and `versionTimestamp`. Uncalibrated dates fall back to 07:00 America/Los_Angeles with `versionTimestamp -1`.

An age weight `w < 1` on a match at time `t` implies `windowEnd = t + 180d − 150d·w`. `npm run calibrate-window -- --date <date> [--write]` matches every decaying details row to our matchdata (by Los Angeles date, 3+ shared players, then opponent name), turns each into a ±0.0005-weight interval, and takes the range most rows agree on, snapped to a match time when one falls inside it. It only needs matches from the last 150 days of the window, so the hot store is enough. The calibrated values are 2026-07-06 → `1783346400`, 2026-08-03 → `1785769920`, 2026-09-07 → `1788817680`, 2026-10-05 → `1791208800` and 2026-11-02 → `1793632320`.

`verify-vrs` refuses a snapshot whose 180-day window starts before the matchdata does.

Live standings (`public/data/vrs/live.json`, from `update-data`) and simulator projections aren't calibrated snapshots. They run with `windowEndsAtPull`, which ends the window at the 07:00 LA pull time instead of the latest match.

## Details-file oracle

- `scripts/lib/vrs/valveDetails.ts` parses details files: match rows (match ID, date, opponent, W/L, age and event weights, factor contributions, lineup) and the Bounty Offered table.
- The match ID is Valve's `umid`, the match's index in the full match array sorted newest first. Gaps between IDs give exact counts of how many matches Valve had in a date range, which makes them a completeness check.
- `npm run diff-details` diffs our per-roster match lists against the details files: missing and extra matches, lineups, prize winnings, LAN and event weights. Output is ordered by earliest divergence, because one wrong match cascades through Glicko.
- `computeStandingsWithDetails` runs Valve's `report.js` in memory (the fs shim captures `writeFileSync`) to produce our own details files, which `diff-details` compares against Valve's.

## Current accuracy (published global top 50)

From `verify-vrs --all-calibrated` (with `--include-archive`):

| Snapshot | Exact rank | Within ±2 | Worst rank miss | Mean / p90 points error | Cutoff membership |
| --- | --- | --- | --- | --- | --- |
| 2026-11-02 | 37 | 50 | 2 | 1.62 / 3.59 | exact |
| 2026-10-05 | 40 | 50 | 2 | 1.67 / 2.95 | Europe: Alliance out, BIG in (1483.4 tie) |
| 2026-09-07 | 33 | 50 | 2 | 1.45 / 3.86 | exact |
| 2026-08-03 | 46 | 50 | 2 | 2.26 / 5.18 | exact |
| 2026-07-06 | 31 | 49 | 6 | 3.73 / 7.55 | Europe: BIG out, Alliance in |

With `placements-2026-01..05.json` and `2026-05` matches/tournaments archived, `isUntrackedEseaDivision` (`Main`/`Entry`/`Open10`), `unrankedBo1Matchlists` for Tier-2 LAN group stages (`Parken_Challenger_Championship/6..8`, `Roman_Imperium_Cup/8`, `Journey/2026/Summer`), `EXTREMESLAND/2026` `Oceania`/`Mongolia` unranking, `Alter Ego` `DFRAG/Invitational/2026` lineup fixes, and `propose-prize-overrides` payouts (`Journey/2026/Summer`, `Moscow_Cyber_Games/2026`, `DraculaN/Season_7`, `CyberClash/Season_2`, `CCT/Season_3/Europe/Series_13 & 15`), 3 of 5 calibrated snapshots (`2026-08-03`, `2026-09-07`, `2026-11-02`) pass the gate and mean points error is under 5 on all 5 (`1.45`–`3.73`). (`2026-10-05` misses only on a 0.0-point tie at the Europe #18 cutoff; `2026-07-06` misses `BIG`'s `$22,000` `NODWIN_Gaming/Clutch_Series/5` placement whose matches are absent from Liquipedia's March 2026 match export.)

## The gate

Exact points for every ranked roster isn't reachable from Liquipedia data, and isn't needed. VRS reproduction is acceptable when, on **at least three calibrated snapshots**:

- every published global top-50 roster is within ±2 ranks,
- mean points error over the top 50 is under 5, and
- invite-cutoff membership (rosters at or above the cutoff in each region) is exact in every region.

`compareStandings` reports both the gate (`report.gate`, thresholds in `GATE`) and the strict check (`report.passed`: exact rank and rounded points for every roster). A roster in the published top 50 that the model doesn't rank counts as a rank miss with its full points as error. `verify-vrs` exits on the gate, or on the strict check with `--strict`. `--all-calibrated` runs every date in `snapshotWindowEnds.json` and also fails if there are fewer than three. The nightly `update-data` warning uses the gate.

Invite cutoffs in `src/vrs/inviteCutoffs.ts` (`cutoffsForSnapshot`) match `vendor/counter-strike_rules_and_regs/major-supplemental-rulebook.md` (`16/10/6` pre-Cologne 2026, `18/9/5` post-Cologne 2026).
