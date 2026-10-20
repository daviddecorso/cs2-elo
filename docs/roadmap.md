# Roadmap

## Overview

VRS is close but not at the gate defined in [vrs-verification.md](vrs-verification.md). Infrastructure work comes first, so VRS fixes land on a committed branch and a feed that Elo can share. Then the VRS work goes after the gate.

## Before Elo

- [ ] **Commit on a branch.** Everything up to the Liquipedia pipeline, agy's work included, plus these docs.
- [ ] **Run the nightly job end to end once.** It needs `LIQUIPEDIA_API_KEY` as a repo secret. The `/player` fetch hit Liquipedia's hourly limit locally. Skip players already in `data/raw/players.json`, and persist `data/raw/players.json` and `.cache/liquipedia/` across runs with `actions/cache`.
- [ ] **Split the match feed from the VRS projection.** Extract `normalizeMatches` (clean Liquipedia matches keyed by page name) from `buildMatchdata`. A `projectVrs` step owns `valveRanked`, the qualifier rule, lineup resolution, aliases and prize overrides. Elo uses the normalized feed, not Valve's coverage quirks.
- [ ] **Settle identity.** Page names are the stable IDs. Aliases apply only in the VRS projection.

## VRS to the gate

- [ ] **Make the gate the pass/fail.** Add a top-50 / cutoff mode to `compareStandings`. `verify-vrs` passes or fails on it, with `--all-calibrated` running every date in `snapshotWindowEnds.json`.
- [ ] **More snapshots.** Turn the scratch calibration solver into `scripts/calibrate-window.ts`. Calibrate 2026-08-03 and 2026-07-06 (the fetch needs to reach back to early January), then verify across all of them. 2026-11-02 uses the same script once it's published.
- [ ] **Fix only what moves the top 50.** Point `diff-details` at the top-50 rosters and their opponents. Allow a per-event override only when it improves every calibrated snapshot.
- [ ] **Close the factor gaps.** Bounty collected is exact for only 31% of top rosters, and bounty offered misses for 12%. Most of this is likely prize money and club share (`clubShare` is always 0 today). Confirm event by event from the Bounty Offered tables in the details files. Fix bounty offered first, since bounty collected depends on opponents' bounty offered.

## Open items

- Confirm invite cutoffs against Valve's rulebook.
- Once a page showing Liquipedia data is live, send the project link to Liquipedia for verification.
