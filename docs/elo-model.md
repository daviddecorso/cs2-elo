# Elo model

## Overview

A map-level team Elo built on the normalized Liquipedia feed. It has to pass one gate: on held-out 2026 series, its log loss beats a baseline that predicts from VRS point differences. Code lives in `scripts/lib/elo/`. `npm run backtest-elo` scores it, `npm run build-elo` publishes `public/data/elo/latest.json`, and the site shows it at `/elo` and `/methodology`.

## Data

- **Feed** (`history.ts`, `normalize.ts`): series keyed by `<tournament page>:<match2id>`, with teams and players keyed on Liquipedia page names. A series carries its date, best-of, LAN flag (match `type`, falling back to the tournament), Liquipedia tier, prize pool, listed lineups, winner, forfeit flag, and every scored map with rounds per side. No VRS rules, aliases or overrides apply here.
- **Sources**: each month comes from exactly one place. Committed `data/history/YYYY-MM.json` comes first. Next is the raw archive in `data/raw/archive/`, filled by `npm run backfill-liquipedia`. Last is the hot store in `data/raw/` (`fetch-liquipedia`'s 190-day window).
- **Freezing**: `npm run freeze-history` writes every month that a source covers completely and that ended more than 60 days ago. History is committed, so losing the CI cache never forces a re-backfill. The nightly job freezes from the hot store.
- **Backfill**: one month per chunk (about 4 `/match` pages and 1 `/tournament` page), resumable, stopping at the first 429. Each run is capped by `--max-requests` (default 30), so a full backfill from 2023-10 spans several hourly runs. It uses a `query` field list to drop streams, icons and links. Don't run it back to back with `fetch-liquipedia`.
- **Maps**: a map counts only if its winner reached 13 rounds. `np` (not played), defaulted and abandoned maps are skipped. Forfeit series aren't rated or scored.
- **Lineups**: rosters of 6+ or fewer than 5 players resolve to 5 with the same ±21-day pool rule VRS uses (`scripts/lib/lineups.ts`). The resolver looks at nearby series on both sides of the date. That is identity resolution only and never uses outcomes.
- **Squads**: `fetch-liquipedia` refreshes active `/squadplayer` rows weekly for teams with a tier 1–3 series in the last 90 days (`data/raw/squads.json`). They're used only to flag core players who have left the squad.

## Model (`engine.ts`)

- **Map updates.** Each map is rated: `Δ = K · margin · provisional · (result − expected)`. Expected score is `1/(1+10^(−(Rₐ+offₐ[map]−R_b−off_b[map])/scale))`.
- **Margin.** `1 + marginWeight · ln(1 + rounds)` times 538's autocorrelation damping. An overtime win (loser on 12+) counts as `otMargin` rounds.
- **K multipliers.** `onlineK` for online maps, `tierK^(tier−1)` by Liquipedia tier (missing tier counts as 4), `crossRegionK` when the rosters' Valve regions differ, and `standInK` when a lineup has a player outside the core. The region is the majority of core players' countries, through Valve's own `region.js`.
- **Map offsets.** `kMap` per map. After each update, a roster's offsets are re-centred on the active pool and shrunk by `mapShrink`, so they show map preference, never overall strength.
- **Lineages.** A rating belongs to a lineage. The lineage's core is the 5 players seen most often in its last `coreWindow` series, with ties going to current core members, so a one-off stand-in doesn't change it. A lineup joins whichever candidate lineage (the team's current one, or any player's) it shares 3+ core players with. This follows a roster across org changes.
- **Partial changes.** When the core changes by k players, the rating moves `regress · k/5` of the way to the tier mean. The tier mean is the mean rating of rosters active in the last 120 days whose median tier of their last 10 series matches. With fewer than 5 such rosters, it falls back to `1500 − tierGap·(tier−1)`.
- **New lineages.** The seed is the mean of each player's last core lineage rating (unrated players get the tier mean), then regressed by `newRosterRegress`. `provisionalK` boosts K for a new lineage's first `provisionalMaps` maps.
- **Series probability (v1).** The map probability is averaged over the active pool (maps with at least 3% of plays in the trailing 60 days), then converted to Bo1/Bo3/Bo5. Bo2 counts as Bo3.

## Vetoes

The API has no veto data. None of the 11,462 stored 2026 matches has a veto field in match or map `extradata`. A real veto model (v2) is blocked. The fallback idea, not built, is to weight each map by both teams' share of plays on it as a proxy for picks and bans. It would have to beat v1 on 2024–2025 before it's used.

## Backtest and gate (`scripts/backtest-elo.ts`)

- Ratings warm up from 2023-10. `--tune` runs coordinate descent on 2024–2025 series log loss over every parameter except `scale`, which is redundant with K. `--write` saves the result to `scripts/lib/elo/params.json`, which overrides `STARTING_PARAMS`.
- **VRS baseline** (`vrsBaseline.ts`): uses the latest Valve global snapshot published strictly before the series' UTC day, from the `invitation/` and `live/` tables. Each side's roster is found by 3+ of 5 player overlap, matching Liquipedia page name, display nick or VRS alias nick against Valve's nicks. `p = 1/(1+10^(−Δpoints/s))`, with `s` fit on training series. Snapshots start 2024-08-06.
- **Gate**: 2026 series where both rosters have VRS points; Elo series log loss must be below VRS. `--gate` exits non-zero on failure. The report also covers Brier, accuracy, all 2026 series, map log loss, stand-in series and cross-region series. `public/data/elo/calibration.json` holds the scores and calibration bins for the methodology page.

## Rankings output (`scripts/build-elo.ts`)

Lists rosters with 15+ rated maps and a series in the last 90 days. VRS columns come from the latest snapshot, joined by player overlap first and then by `data/elo/vrsTeamMap.json` (Liquipedia team page → Valve team name). `--update-team-map` adds overlap matches to that file. Every entry carries a `reason`, and hand fixes go there. `teamAliases` in `data/overrides.json` stays VRS-only.

## Results

**The gate passes.** The feed held 67,857 series from 2023-10-01 to 2026-10-19 on 2026-10-20. Parameters were tuned on 2024–2025 (42,074 series) and scored on 2026 series.

| Set | Series | Elo log loss | VRS log loss |
| --- | --- | --- | --- |
| Both rosters VRS-ranked (gate) | 8,490 | **0.6148** | 0.6489 |
| Cross-region | 651 | 0.6342 | 0.6505 |
| Every 2026 series | 16,838 | 0.5984 | – |
| Every 2026 map | 35,446 | 0.6284 | – |

The untuned starting parameters already passed (0.6341), but they lost to VRS on cross-region series (0.6594). Tuning fixed both. The VRS baseline's fitted scale is 880 points for 10:1 odds.

What tuning found (`scripts/lib/elo/params.json`):

- `regress` and `newRosterRegress` went to 0. Pulling a changed roster toward the tier mean doesn't help. The continuity rule plus seeding from players' old ratings is enough.
- `onlineK` went to 1, so online and LAN maps count the same. `tierK` stayed at 0.9.
- `crossRegionK` fell to 1.25 from its 1.5 start, so international results still count for more.
- `standInK` stayed at 1, so down-weighting stand-in series doesn't help. Stand-in series score about the same as the rest.
- `tierGap` rose to 375, near the top of its search range. Lower-tier newcomers start well below tier 1. `provisionalK` 2.5 over 70 maps lets them move quickly from there.
- K is 12 per map. OT wins count as a 1-round margin, `marginWeight` is 0.5, `kMap` is 4, `mapShrink` is 0.02, and `coreWindow` is 7 series.
