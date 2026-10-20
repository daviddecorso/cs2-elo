# Overview

cs2-elo reproduces Valve's CS2 Regional Standings (VRS) from public match data, and runs a map-level team Elo alongside it. VRS reproduction came first because Valve's published standings and per-roster details files give us ground truth to verify the data pipeline against. Elo reads the same Liquipedia data through its own normalized feed.

## Data flow

1. `npm run fetch-liquipedia` pulls matches, tournaments, placements and players from the Liquipedia API into `data/raw/` (gitignored).
2. `npm run build-matchdata` turns the raw rows plus the committed `data/overrides.json` into `data/matchdata.json` (gitignored), shaped like Valve's model input.
3. `computeStandings` in `scripts/lib/vrs/valveModel.ts` runs Valve's unmodified model (`vendor/counter-strike_regional_standings`) on that input for a given snapshot date.
4. `npm run verify-vrs` and `npm run diff-details` compare the result against Valve's published standings and details files in `vendor/.../live/`.
5. `npm run update-data` publishes Valve's latest snapshot to `public/data/vrs/` for the site.

Elo ([elo-model.md](elo-model.md)):

6. `npm run backfill-liquipedia` fills `data/raw/archive/` with months older than the hot store, a few months per hourly run.
7. `npm run freeze-history` writes settled months to the committed `data/history/`.
8. `npm run backtest-elo` scores the model against the VRS baseline and writes `public/data/elo/calibration.json`. `npm run build-elo` writes `public/data/elo/latest.json`.

The nightly `Update data` workflow runs steps 1, 2, 5, 7 and 8 (without tuning).

## Docs

| File | Topic |
| --- | --- |
| [valve-model.md](valve-model.md) | How Valve's model works, its quirks, and the exact `matchdata.json` input schema |
| [liquipedia-api.md](liquipedia-api.md) | Liquipedia API endpoints, fields and observed data shapes |
| [matchdata-pipeline.md](matchdata-pipeline.md) | How Liquipedia data becomes Valve model input, and the decisions behind each rule |
| [vrs-verification.md](vrs-verification.md) | Snapshot windows, the details-file oracle, current accuracy and the acceptance gate |
| [elo-model.md](elo-model.md) | Elo feed, model, VRS baseline, gate and results |
| [roadmap.md](roadmap.md) | Next steps for VRS and Elo |

Liquipedia's usage terms (API key handling, attribution, no scraping) are in `AGENTS.md`.

## Commands

All of these exit on their own:

```bash
npm run fetch-liquipedia -- --from 2026-04-01 --to 2026-10-19
npm run build-matchdata -- --date 2026-10-19
npm run validate-matchdata -- data/matchdata.json
npm run verify-vrs -- --date 2026-10-05 --matchdata data/matchdata.json
npm run diff-details -- --date 2026-10-05 --matchdata data/matchdata.json [--team <name>]
npm run backfill-liquipedia -- --max-requests 30
npm run freeze-history
npm run backtest-elo -- [--tune --write] [--gate]
npm run build-elo -- [--update-team-map]
npm run test:run
npm run lint
```

Use `npm run test:run`, not `npm test`, which starts vitest in watch mode.
