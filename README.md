# cs2-elo

Counter-Strike 2 team Elo ratings, Valve Regional Standings (VRS) projections, and Major invitation probabilities. Player modeling is planned for a future phase.

## Purpose & Policies

- **Scope**: Accurate reproduction and forward projections of Valve's CS2 Regional Standings model, team ratings, and Major qualification probabilities.
- **Non-Commercial**: This is an independent, non-commercial research and statistical modeling project.
- **Strict Anti-Betting Policy**: This project strictly avoids betting terminology, betting odds, and links to sportsbooks or gambling services. All probabilistic projections represent statistical model probabilities.

## Licensing

- Repository code is licensed under the [MIT License](LICENSE) (c) 2026 David DeCorso.
- Valve's code in `vendor/counter-strike_regional_standings` is a git submodule tracked under Valve's repository terms and is not covered by this repository's MIT license.

## Getting Started

Clone the repository with submodules:

```bash
git clone --recurse-submodules https://github.com/daviddecorso/cs2-elo.git
cd cs2-elo
npm install
```

If already cloned without submodules:

```bash
git submodule update --init --recursive
```

## Scripts

| Script | Command | Description |
| --- | --- | --- |
| `dev` | `npm run dev` | Start Vite dev server |
| `build` | `npm run build` | Type-check and build static site into `dist/cs2/` |
| `lint` | `npm run lint` | Run ESLint across TypeScript and React code |
| `test` | `npm run test` | Run Vitest in interactive mode |
| `test:run` | `npm run test:run` | Run test suite once |
| `update-data` | `npm run update-data` | Parse Valve's latest published snapshot into `public/data/vrs/*.json` |
| `verify-vrs` | `npm run verify-vrs` | Run model against matchdata and compare output to published standings |
| `validate-matchdata` | `npm run validate-matchdata` | Validate `matchdata.json` against the model input contract |
| `make-fixture` | `npm run make-fixture` | Generate deterministic synthetic `matchdata.json` fixture |
| `fetch-liquipedia` | `npm run fetch-liquipedia` | Pull the match window from the Liquipedia API into `data/raw/` (needs `LIQUIPEDIA_API_KEY`) |
| `build-matchdata` | `npm run build-matchdata` | Build `data/matchdata.json` from `data/raw/` and `data/overrides.json` |
| `diff-details` | `npm run diff-details` | Diff per-roster match lists against Valve's published details files |

## Layout

- `data/` — Committed `overrides.json`; gitignored raw Liquipedia rows and built `matchdata.json`.
- `docs/` — Project docs; start at `docs/overview.md`.
- `fixtures/` — Committed synthetic test fixtures.
- `scripts/` — CLI commands and data pipelines (`fetch-liquipedia`, `build-matchdata`, `update-data`, `verify-vrs`, `diff-details`, `validate-matchdata`, `make-fixture`).
- `scripts/lib/liquipedia/` — Liquipedia API client with on-disk cache.
- `scripts/lib/vrs/` — Matchdata builder, VRS model runner, schema validator, snapshot and details parsers, and comparator.
- `site/` — Static deploy configuration (`_headers`, `_redirects`, `404.html`).
- `src/` — React 19 application, components, and hooks.
- `src/vrs/` — Shared VRS TypeScript types and invite cutoffs.
- `vendor/` — Valve's official regional standings repository pinned as a git submodule.
