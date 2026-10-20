# VRS verification

## Overview

We verify the pipeline by running Valve's model on our matchdata for a published snapshot date and comparing against Valve's published standings and per-roster details files in `vendor/counter-strike_regional_standings/live/<YYYY>/`. Valve has published monthly snapshots since 2026-01-05. The details files are the ground truth for every roster's counted matches, lineups, age weights and prize winnings.

## Snapshot window

Valve's data pull runs into the snapshot day, and its 180-day window ends at the latest match in that pull, not at midnight. For published snapshots, the window end is calibrated from the age weights in the details files and stored in `scripts/lib/vrs/snapshotWindowEnds.json` (Unix seconds). `getSnapshotWindow` in `scripts/lib/vrs/valveModel.ts` uses the calibrated end as both pull cutoff and `versionTimestamp`. Uncalibrated dates fall back to 07:00 America/Los_Angeles with `versionTimestamp -1`.

An age weight `w < 1` on a match at time `t` implies `windowEnd = t + 180d − 150d·w`. The calibrated values are 2026-10-05 → `1791208800` and 2026-09-07 → `1788817680`.

## Details-file oracle

- `scripts/lib/vrs/valveDetails.ts` parses details files: match rows (match ID, date, opponent, W/L, age and event weights, factor contributions, lineup) and the Bounty Offered table.
- The match ID is Valve's `umid`, the match's index in the full match array sorted newest first. Gaps between IDs give exact counts of how many matches Valve had in a date range, which makes them a completeness check.
- `npm run diff-details` diffs our per-roster match lists against the details files: missing and extra matches, lineups, prize winnings, LAN and event weights. Output is ordered by earliest divergence, because one wrong match cascades through Glicko.
- `computeStandingsWithDetails` runs Valve's `report.js` in memory (the fs shim captures `writeFileSync`) to produce our own details files, which `diff-details` compares against Valve's.

## Current accuracy (published global top 50)

| Snapshot | Exact rank | Within ±2 | Worst rank miss | Mean / p90 points error |
| --- | --- | --- | --- | --- |
| 2026-10-05 | 23 | 45 | 4 | 11.3 / 22.6 |
| 2026-09-07 | 27 | 40 | 7 | 19.6 / 37.8 |

Factor gaps across top rosters: bounty collected matches exactly for only 31%, and bounty offered misses for 12%.

## The gate

Exact points for every ranked roster isn't reachable from Liquipedia data, and isn't needed. VRS reproduction is acceptable when, on **at least three calibrated snapshots**:

- every published global top-50 roster is within ±2 ranks,
- mean points error over the top 50 is under 5, and
- invite-cutoff membership (rosters at or above the cutoff in each region) is exact in every region.

`compareStandings` currently reports only the strict mode (exact rank and rounded points for every roster), so `verify-vrs` always fails today. Adding a gate mode is the first item in [roadmap.md](roadmap.md).

Invite cutoffs in `src/vrs/inviteCutoffs.ts` (Europe 16, Americas 8, Asia 8) are still unconfirmed against Valve's rulebook.
