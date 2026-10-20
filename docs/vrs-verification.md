# VRS verification

## Overview

We verify the pipeline by running Valve's model on our matchdata for a published snapshot date and comparing against Valve's published standings and per-roster details files in `vendor/counter-strike_regional_standings/live/<YYYY>/`. Valve has published monthly snapshots since 2026-01-05. The details files are the ground truth for every roster's counted matches, lineups, age weights and prize winnings.

## Snapshot window

Valve's data pull runs into the snapshot day, and its 180-day window ends at the latest match in that pull, not at midnight. For published snapshots, the window end is calibrated from the age weights in the details files and stored in `scripts/lib/vrs/snapshotWindowEnds.json` (Unix seconds). `getSnapshotWindow` in `scripts/lib/vrs/valveModel.ts` uses the calibrated end as both pull cutoff and `versionTimestamp`. Uncalibrated dates fall back to 07:00 America/Los_Angeles with `versionTimestamp -1`.

An age weight `w < 1` on a match at time `t` implies `windowEnd = t + 180d − 150d·w`. `npm run calibrate-window -- --date <date> [--write]` matches every decaying details row to our matchdata (by Los Angeles date, 3+ shared players, then opponent name), turns each into a ±0.0005-weight interval, and takes the range most rows agree on, snapped to a match time when one falls inside it. It only needs matches from the last 150 days of the window, so the hot store is enough. The calibrated values are 2026-07-06 → `1783346400`, 2026-08-03 → `1785769920`, 2026-09-07 → `1788817680` and 2026-10-05 → `1791208800`. The script reproduces the two earlier values exactly.

`verify-vrs` refuses a snapshot whose 180-day window starts before the matchdata does.

Live standings (`public/data/vrs/live.json`, from `update-data`) and simulator projections aren't calibrated snapshots. They run with `windowEndsAtPull`, which ends the window at the 07:00 LA pull time instead of the latest match.

## Details-file oracle

- `scripts/lib/vrs/valveDetails.ts` parses details files: match rows (match ID, date, opponent, W/L, age and event weights, factor contributions, lineup) and the Bounty Offered table.
- The match ID is Valve's `umid`, the match's index in the full match array sorted newest first. Gaps between IDs give exact counts of how many matches Valve had in a date range, which makes them a completeness check.
- `npm run diff-details` diffs our per-roster match lists against the details files: missing and extra matches, lineups, prize winnings, LAN and event weights. Output is ordered by earliest divergence, because one wrong match cascades through Glicko.
- `computeStandingsWithDetails` runs Valve's `report.js` in memory (the fs shim captures `writeFileSync`) to produce our own details files, which `diff-details` compares against Valve's.

## Current accuracy (published global top 50)

From `verify-vrs --all-calibrated`:

| Snapshot | Exact rank | Within ±2 | Worst rank miss | Mean / p90 points error | Cutoff membership |
| --- | --- | --- | --- | --- | --- |
| 2026-10-05 | 21 | 45 | 4 | 11.9 / 24.2 | exact |
| 2026-09-07 | 18 | 42 | 5 | 22.8 / 36.8 | Asia: 5star out, EGOISTO in |
| 2026-08-03 | 30 | 47 | unranked ×2 | 57.6 / 12.6 | exact |
| 2026-07-06 | 27 | 44 | 8 | 6.8 / 18.8 | Asia: Chinggis Warriors out, DEPO in |

Splitting Majors into stages (see [matchdata-pipeline.md](matchdata-pipeline.md)) changed the mean points error from 12.4 to 6.8 on 2026-07-06, from 62.5 to 57.6 on 2026-08-03, from 19.3 to 22.8 on 2026-09-07 and from 11.1 to 11.9 on 2026-10-05. Cologne's event weights and prize dates now match Valve's exactly, so the later regressions come from errors the old weights were offsetting.

On 2026-09-07, bounty offered for the top 50 is within 0.005 of Valve's. What's left is systematic: LAN factor is about 0.03 low for every roster below the top two, and opponent network is low too. Both are scaled by the 5th-highest roster. DEPO and Omega carry dozens of Central Asian tier-3 LAN matches that Valve doesn't have (`diff-details --team DEPO`), which lifts our LAN reference from Valve's 0.890 to 0.921.

Points error is the furthest from the gate on every snapshot. On 2026-08-03 it's dominated by Echo (#42) and Bulgaria (#44), which the model doesn't rank. Their active rosters pick up a player from Esports Nations Cup 2026 qualifier lineups (Lucky for Echo, shaiK/SHiPZ for Bulgaria). Valve's details files list only some of those qualifier matches, which suggests HLTV covered them only partly.

## The gate

Exact points for every ranked roster isn't reachable from Liquipedia data, and isn't needed. VRS reproduction is acceptable when, on **at least three calibrated snapshots**:

- every published global top-50 roster is within ±2 ranks,
- mean points error over the top 50 is under 5, and
- invite-cutoff membership (rosters at or above the cutoff in each region) is exact in every region.

`compareStandings` reports both the gate (`report.gate`, thresholds in `GATE`) and the strict check (`report.passed`: exact rank and rounded points for every roster). A roster in the published top 50 that the model doesn't rank counts as a rank miss with its full points as error. `verify-vrs` exits on the gate, or on the strict check with `--strict`. `--all-calibrated` runs every date in `snapshotWindowEnds.json` and also fails if there are fewer than three. The nightly `update-data` warning uses the gate.

Invite cutoffs in `src/vrs/inviteCutoffs.ts` (Europe 16, Americas 8, Asia 8) are still unconfirmed against Valve's rulebook.
