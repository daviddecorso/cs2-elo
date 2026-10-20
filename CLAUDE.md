@AGENTS.md

## Liquipedia rate limits

Staying under Liquipedia's API limits is very important. They're hourly, per table, and every request counts, including retries and probes. Repeated overruns risk losing API access, and a 429 response body echoes the API key.

- Never call the API directly (curl, ad-hoc scripts). Go through `scripts/lib/liquipedia/client.ts`, which fails fast on 429 and redacts the key.
- Read from the local store in `data/raw/` instead of refetching. `npm run fetch-liquipedia` is incremental: it refetches the last 14 days plus any uncovered range, and does a full refresh weekly. Don't pass `--full` or delete `data/raw/` without asking.
- The nightly CI job also fetches. Don't run fetches back to back, and don't trigger the workflow repeatedly.
- On a 429, stop and wait for the hour to reset. Don't retry.

## Docs

Project knowledge lives in `docs/<topic>.md`, each opening with an Overview. Start at `docs/overview.md`. Split a topic into a folder only once it outgrows one file.

- `docs/overview.md`: data flow, doc index, commands
- `docs/valve-model.md`: Valve's model mechanics, quirks and input schema
- `docs/liquipedia-api.md`: Liquipedia API endpoints and data shapes
- `docs/matchdata-pipeline.md`: Liquipedia → matchdata rules, overrides, identity
- `docs/vrs-verification.md`: snapshot windows, details oracle, accuracy, the gate
- `docs/elo-model.md`: Elo feed, model, backtest gate, current results
- `docs/elo-experiments.md`: every Elo change tried, kept or rejected, with scores
- `docs/simulator.md`: bracket simulator, VRS projections, Major invite odds, event config
- `docs/roadmap.md`: next steps

Record decisions in the relevant doc, not in `plans/` (gitignored). Log every Elo experiment in `docs/elo-experiments.md`, including the ones that fail.
