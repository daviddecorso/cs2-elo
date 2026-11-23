# Overview

cs2-elo reproduces Valve's CS2 Regional Standings (VRS) from public match data, and runs a map-level team Elo alongside it. VRS reproduction came first because Valve's published standings and per-roster details files give us ground truth to verify the data pipeline against. Elo reads the same Liquipedia data through its own normalized feed.

## Data flow

1. `npm run fetch-liquipedia` pulls matches, tournaments, placements and players from the Liquipedia API into `data/raw/` (gitignored).
2. `npm run build-matchdata` turns the raw rows plus the committed `data/overrides.json` into `data/matchdata.json` (gitignored), shaped like Valve's model input.
3. `computeStandings` in `scripts/lib/vrs/valveModel.ts` runs Valve's unmodified model (`vendor/counter-strike_regional_standings`) on that input for a given snapshot date.
4. `npm run verify-vrs` and `npm run diff-details` compare the result against Valve's published standings and details files in `vendor/.../live/`.
5. `npm run update-data` publishes Valve's latest snapshot to `public/data/vrs/` for the site. With `VRS_MATCHDATA` set, it also runs the gate against that snapshot and writes `public/data/vrs/live.json`: the model at today's date, with each roster's model rank at the published snapshot as `previousRank`. The site shows live standings by default.

Elo ([elo-model.md](elo-model.md)):

6. `npm run backfill-liquipedia` fills `data/raw/archive/` with months older than the hot store, a few months per hourly run.
7. `npm run freeze-history` writes settled months to the committed `data/history/`. The CS:GO warmup (2022-01 → 2023-09) is already frozen in `data/history/csgo/`. `npm run freeze-sim-history` does the same for what the season simulation's history models read (`data/history/sim/`), since CI has no archive; locally, `npm run build-matchdata-full` gives them the archive's matches.
8. `npm run backtest-elo` scores the model against the VRS baseline and writes `public/data/elo/calibration.json`. `npm run build-elo` writes `public/data/elo/latest.json` and `public/data/elo/matches.json`, the latter with veto forecasts from the committed `data/sim/veto-weights.json` ([simulator.md](simulator.md#veto-predictions-on-matches)).

Simulator ([simulator.md](simulator.md)):

9. `fetch-liquipedia` also refreshes `data/raw/upcoming.json`: upcoming tournaments, plus unfinished matches and prize tables for events configured in `data/events/`.
10. `npm run simulate` plays out each configured bracket from Elo and writes `public/data/sim/events/`. For each upcoming invite snapshot (`data/events/invites-*.json`), it then runs Valve's model on the simulated results and writes `public/data/sim/invites/`.
11. `npm run simulate-season` plays every catalog LAN it can fill up to the next invite snapshot, resolving fields from projected VRS lists, then finds each top-60 team's best LAN schedule. It writes `public/data/sim/season/`, including `teams/<team>.json` and `fields/<event>.json` for upcoming-event pages ([vrs-simulator.md](vrs-simulator.md#season-simulation), [optimizer](vrs-simulator.md#schedule-optimizer), [event pages](vrs-simulator.md#upcoming-event-pages)).
12. `npm run plan-batch` picks every team whose Major invite is in doubt, plans them in groups on shared season runs with `plan-schedule`, and writes `public/data/sim/plan/`, including `events.json` ([focal planner](vrs-simulator.md#focal-planner)).

Win probability ([win-probability.md](win-probability.md)), local only:

13. `npm run export-map-elo` writes each played map's pre-map Elo to `data/wp/elo-maps.jsonl`.
14. In `wp/`, `cs2wp sync`, `states`, `train`, `credit`, `validate` and `publish` take the demo tables in R2 to round win probability, WPA and `public/data/wpa/players.json`.
15. `cs2wp positions` assigns each player's CT position per map from callouts, `cs2wp roles` their T role from opening duels and AWP buys, `cs2wp validate-roles` checks both against NER0cs's labels, `cs2wp baselines` computes each map, side and role's partially pooled WPA per round, `cs2wp duels` gives every kill an expected win probability for kills above expected, `cs2wp igls` tags per-map IGLs from `data/war/igls.json`, `cs2wp usage` splits each player's credit into team context, resource usage and conversion, `cs2wp war` computes player Wins Above Average (with round-bootstrap intervals) and writes `public/data/war/players.json` for `/war`, `cs2wp style` writes each player's style percentiles and archetype to `public/data/war/style.json`, `cs2wp radars` exports Valve radar WebPs (`public/radar/`) and coordinate metadata (`data/war/radar.json`), `cs2wp heatmaps` builds per-player positional grids, utility lineups and callout summaries (`public/data/war/heatmaps/v1/` or `R2_PUBLIC_BUCKET` with `--upload`), and `cs2wp validate-war` checks WAA's split-half reliability, whether prior lineup WAA adds to Elo, and team-context leakage ([war.md](war.md)).

The nightly `Update data` workflow runs steps 1, 2, 5, 7, 8 (without tuning), 9, 10 and 11. The weekly `Plan schedules` workflow runs step 2 on the nightly's cached store, then step 12.

## Site pages

| Route | Page |
| --- | --- |
| `/`, `/vrs` | VRS standings reproduced from Valve's model (`/standings` redirects here) |
| `/rankings` | Team tables in tabs (`?view=`): Elo, Duels (`team-duels.json`), Rounds (`team-stats.json`), Tactics (`tactics.json`). `/elo` redirects here |
| `/matches` | Upcoming and recent matches with Elo odds (`?view=`, `?show=`, `?q=`). `?match=` opens one, with map odds and, if upcoming, its predicted veto |
| `/teams/:team` | Everything on one team, keyed by Liquipedia page name with spaces as underscores: Elo rosters and map offsets, VRS rank, event and Major invite odds, stats per IGL stint, and its players by shrunk WAA. Invite odds join through the Elo roster's player key, because VRS team names differ from Liquipedia's |
| `/events`, `/events/:slug`, `/major`, `/major/:slug` | Simulator output (`/major-invites` redirects to `/major`). An upcoming event with no bracket config shows its likely field from the season simulation, and every upcoming event shows who should go by the schedule search |
| `/major/history` | Past Majors from `backtest-majors --write`: Elo against VRS, a coin and the Supercomputer, per stage, and Elo's stage forecasts (`?major=`, `?stage=`) |
| `/vrs-sim` | Season simulation in tabs (`?view=`): Calendar of upcoming LANs with projected fields, Projections of VRS standings at each publication date (`?at=`, `?region=`), Schedules with each team's recommended LAN schedules and a picker (`?team=`), Plan with a team's searched route to the Major invite from `plan-schedule` (`?team=`, `?plan=`) |
| `/players` | Player tables in views (`?view=`): WAA leaderboards (one rating, shrunk for sample size), Clutch (`clutch.json`), Validation. `/war` redirects here |
| `/players/:player` | Everything on one player, keyed by in-game name: WAA with its rank, roles, CT positions, duels, resources, clutch conversion and teammates |
| `/model`, `/methodology` | Elo calibration and method notes |

Team names in every table link to `/teams/:team`, and player names to `/players/:player`. Fetchers shared across pages live in `src/data/queries.ts`, so the team page reuses the tables' query cache.

## Docs

| File | Topic |
| --- | --- |
| [valve-model.md](valve-model.md) | How Valve's model works, its quirks, and the exact `matchdata.json` input schema |
| [liquipedia-api.md](liquipedia-api.md) | Liquipedia API endpoints, fields and observed data shapes |
| [matchdata-pipeline.md](matchdata-pipeline.md) | How Liquipedia data becomes Valve model input, and the decisions behind each rule |
| [vrs-verification.md](vrs-verification.md) | Snapshot windows, the details-file oracle, current accuracy and the acceptance gate |
| [elo-model.md](elo-model.md) | Elo feed, model, VRS baseline, gate and results |
| [elo-experiments.md](elo-experiments.md) | Log of every Elo change tried, kept or rejected, with scores |
| [elo-assumptions.md](elo-assumptions.md) | What the Elo model assumes about CS2, the evidence, and the bar for levers that contradict it |
| [simulator.md](simulator.md) | Bracket formats, Major Swiss, rating drift, VRS projections, invite rules and event config |
| [vrs-simulator.md](vrs-simulator.md) | Phase 8 VRS what-ifs: exact incremental reruns of Valve's model, the one-team model, their backtest, the event catalog, the season simulation, the schedule optimizer and the focal-team planner |
| [demo-pipeline.md](demo-pipeline.md) | HLTV demos → validated Parquet in R2 (`demos/`, Python) |
| [win-probability.md](win-probability.md) | Round win-probability model, WPA credit rules, gate and validation (`wp/`, Python) |
| [wp-experiments.md](wp-experiments.md) | Log of every win-probability change tried, kept or rejected |
| [war.md](war.md) | Player WAR: CT positions, T roles, role validation, role baselines, expected duels, IGL adjustment, WAA, usage and conversion, style and archetypes, map tendencies (`wp/`, `cs2wp positions`, `cs2wp roles`, `cs2wp validate-roles`, `cs2wp baselines`, `cs2wp duels`, `cs2wp igls`, `cs2wp usage`, `cs2wp war`, `cs2wp validate-war`, `cs2wp style`, `cs2wp radars`, `cs2wp heatmaps`) |
| [roadmap.md](roadmap.md) | Next steps for VRS and Elo |

Liquipedia's usage terms (API key handling, attribution, no scraping) are in `AGENTS.md`.

## Commands

All of these exit on their own:

```bash
npm run fetch-liquipedia -- --from 2026-04-01 --to 2026-10-19
npm run build-matchdata -- --date 2026-10-19
npm run validate-matchdata -- data/matchdata.json
npm run verify-vrs -- --date 2026-10-05 --matchdata data/matchdata.json
npm run verify-vrs -- --all-calibrated [--strict]
npm run calibrate-window -- --date 2026-11-02 [--write]
npm run diff-details -- --date 2026-10-05 --matchdata data/matchdata.json [--team <name>]
npm run backfill-liquipedia -- --max-requests 30 [--game csgo]
npm run freeze-history -- [--game csgo]
npm run backtest-elo -- [--tune --write] [--gate] [--set key=value ...] [--luck] [--no-csgo]
npm run build-elo -- [--update-team-map]
npm run fetch-upcoming
npm run catalog
npm run simulate -- [--events slug,...] [--n 10000] [--vrs-n 5000] [--no-vrs]
npm run simulate-season -- [--season-n 300] [--seed 1] [--workers N] [--rescore-n 30]
npm run plan-schedule -- --team "100 Thieves" [--n 300] [--holdout-n 300] [--workers N] [--check-exhaustive]
npm run plan-batch -- [--max 8] [--budget-minutes 240] [--dry-run] [plan-schedule options]
npm run backtest-sim
npm run backtest-majors -- [--write]
npm run backtest-vrs-whatif -- [--seed 1]
npm run backtest-fields
npm run build-matchdata-full
npm run freeze-sim-history -- [--force]
npm run hindcast-season -- [--as-of 2026-07-06] [--n 100] [--setup full|projected|listed|lan-only]
npm run hindcast-rolling -- [--origins 2026-06-01,...] [--months 4] [--n 40] [--oracle results|attendance|calendar|matches] [--value off] [--planner] [--label name]
npm run hindcast-rolling -- --compare a.json b.json | --report run.json | --calibrate run.json
npm run realized-gains -- [--from 2026-02-02]
npm run test:run
npm run lint
```

Use `npm run test:run`, not `npm test`, which starts vitest in watch mode.
