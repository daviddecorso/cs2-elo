# CS2 VRS site: Phases 0 and 1

Target: claude — greenfield and cross-cutting. It depends on sibling local repos and on judgment calls made in planning, such as the vm-based fs shim and the snapshot-cutoff semantics.

## End state

`/Users/daviddecorso/Coding/personal/cs2-elo` is a public MIT repo, `daviddecorso/cs2-elo`, built on the same stack as `../cfb-elo`: React 19, Vite 7, TS 5.9, Tailwind 4, Vitest 4, `vite-node` scripts, and an assets-only Cloudflare Worker. It deploys to `esports.daviddecorso.com/cs2/`.

Valve's repo is a git submodule pinned to `eec4853`. A pure `computeStandings(matchData, eventData, snapshotDate)` wraps Valve's unmodified code. A schema validator documents the matchdata.json contract for Phase 2. `verify-vrs` compares model output to published standings for any matchdata path, giving strict pass/fail plus agreement metrics. A nightly GitHub Action parses Valve's latest published snapshot into `public/data/vrs/*.json`.

`/cs2/` shows sortable regional standings with expandable factor breakdowns. Acceptance #1 (exact reproduction of 2026-10-05) is reported as BLOCKED, because Valve never publishes model input data. Everything else passes.

## Facts established (Valve repo @ eec4853, local copy at `../counter-strike_regional_standings`)

- **No input data.** `data/` is gitignored. The only tracked file is `data/matchdata_sample_20230829.json`, which uses an old schema without `finished`, `clubShare`, `qualifiedEvents` or `valveRanked`, so the current model crashes on it. Commit `eec4853` only added output `.md` files.
- **Code.** Plain Node CommonJS with no dependencies. Entry is `model/main.js [regionsJSON] [dataFile] [dateLabel]`, run with `model/` as cwd. It always writes to `../live/<yr>/`, and also to `../invitation/<yr>/` when the day is before the 8th. Valve passed the label as `2026_10_05`.
- **API.** `generateRanking(versionTimestamp=-1, filename)` in `model/ranking.js` returns `[matches, teams]`.
- **I/O.** The only disk read is `fs.readFileSync` inside `DataLoader.loadData` in `model/data_loader.js`. There's no `Date.now()`. "Now" is the latest `matchStartTime` that survives the incomplete-match and unranked filters.
- **Time window.** 180 days ending at the latest match. Age weight rises linearly from 0 to 1.0 at end minus 30 days.
- **Points.** `glickoTeam.rank()` rounded to an integer for display.
- **Detail files** (`details/YYYY_MM_DD/NNNN--team--roster.md`) hold:
  - Bounty Offered, Bounty Collected, Opponent Network, LAN Wins
  - Starting Rank Value and H2H adjustment
  - Region, regional rank and global rank (NNNN in the filename is the global rank)
- **10/05 snapshot.** 380 global rows, 245 Europe, 89 Americas, 46 Asia. The `invitation/` and `live/` copies are identical. The last match is 2026-10-04 PT. The highest umid is 5649, and about 56 matches between unranked rosters appear in no detail file.
- **cfb-elo conventions to mirror** (in `../cfb-elo`, never modify it):
  - `wrangler.jsonc` custom_domain route
  - `vite.config.ts` base and `siteFiles` plugin pattern
  - `site/_headers` and `site/_redirects`
  - `.github/workflows/{ci.yml,update-data.yml}`
  - `scripts/lib/writeJson.ts` write-if-changed
  - `src/components/DataTable.tsx` (`SortHeader`, `Th`, `Td`, `Row`)
  - `src/utils/tableSort.ts`, `src/hooks/useTableSort.ts`, `src/utils/theme.ts`
  - `src/index.css` tokens and Geist fonts
  - `src/hooks/useLoadRealData.ts` runtime fetch through TanStack Query
  - Style: 4-space indents, double quotes, semicolons, named arrow exports, why-only comments
  - Node 22 in CI

## Steps

1. **Scaffold.** `git init`, then create these by copying cfb-elo's shape and trimming the NFL, worker and D1 parts:
   - `package.json`
   - `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, plus a new `tsconfig.scripts.json` that type-checks `scripts/`
   - `eslint.config.js`, `vite.config.ts`, `index.html`
   - `.gitignore`, which is cfb-elo's plus `.wrangler/`
   - `LICENSE` (MIT, David DeCorso 2026)

   Scripts:
   - `dev`, `build`, `lint`, `test` and `test:run`, as in cfb-elo
   - `update-data`, `verify-vrs`, `validate-matchdata` and `make-fixture`, all through `vite-node scripts/<name>.ts`

   Run `npm install`.
2. **Submodule.** `git submodule add https://github.com/ValveSoftware/counter-strike_regional_standings vendor/counter-strike_regional_standings`, then check out `eec4853` inside it and commit the pin. Never edit anything under `vendor/`.
3. **Deploy config.**
   - `wrangler.jsonc`: `name: "cs2-elo"`, no `main`, `routes: [{ pattern: "esports.daviddecorso.com", custom_domain: true }]`, and `assets: { directory: "./dist", not_found_handling: "404-page" }`.
   - `vite.config.ts`: `base: "/cs2/"`, build into `dist/cs2/`, and copy `site/` into `dist/`.
   - `site/_redirects`: `/` goes to `/cs2/` with a 302, and `/cs2/*` is an SPA rewrite with a 200.
   - `site/_headers` is adapted from cfb-elo, with `data/*` no-cache and `assets/*` immutable.
   - Add `site/404.html`.
4. **README.md** covers:
   - Purpose: team Elo, VRS projections and Major invitation probabilities now; player WAR later.
   - Data sources: Valve VRS repo now; Liquipedia (CC BY-SA, attribution required) and HLTV demos later. HLTV attribution as in Valve's files.
   - Non-commercial status.
   - Explicit policy: no betting language and no sportsbook links.
   - Valve's code is a submodule and not covered by this repo's MIT license.
   - Getting started, a scripts table, and the layout.
5. **`docs/valve-model.md`** covers:
   - How to run the model, its entry points, and the published file layout.
   - The two stages and their constants:
     - roster identity is 3 of 5 players, matched by playerId
     - $1M prize cap
     - linked qualifier pools add × 0.5^depth
     - `valveRanked` is required after `1735689600`
     - showmatches and unfinished events are filtered out
     - reference value is the 5th-highest
     - top-10 buckets
     - seed is remapped to 400–2000
     - Glicko with a fixed RD of 75
     - no-win rosters are dropped after seeding, so they still set the seed min/max
     - a roster needs at least 5 matches to rank
   - Region plurality rules.
   - Quirks:
     - `qualifiedEvents` arrays are used as object keys.
     - `setActiveRoster` never adds a player whose latest appearance is the 10th match.
     - The active roster is keyed by nick.
   - The data-availability finding.
   - **The full matchdata.json schema**: every match, player, event and prizeDistribution field, with its type and exactly how the code uses it. This includes match order and umid assignment, `prizePool` string parsing, `prize + clubShare`, the event weight curve `1/(1+|log10(pool/1e6)|)`, `lan`, `finished`, `forfeited`, `playerId`/`nick`/`countryIso`, and the `teamId` ↔ `prizeDistribution.teamId` link. This schema is the Phase 2 contract.
6. **`scripts/lib/vrs/matchdataSchema.ts`** exports `validateMatchdata(json)`, which returns `{ errors, warnings }`.
   - Errors are inputs that crash Valve's code or produce NaN: an `eventId` with no event, missing `clubShare` or `qualifiedEvents`, a `countryIso` absent from `vendor/.../model/util/region.js` (loaded read-only with `createRequire`), a malformed `prizePool`, or a bad `winningTeam`.
   - Warnings are records the model silently drops: not exactly 5 players a side, `valveRanked` missing after 2025, unfinished events, showmatches.
   - The CLI is `scripts/validate-matchdata.ts <path>`. It exits 1 on any error.
7. **`scripts/make-fixture.ts`** uses a seeded PRNG to write `fixtures/matchdata.synthetic.json`, which is committed. It contains:
   - About 30 rosters across EU, AM and Asia countries
   - About 8 events: LAN and online, one $1.5M pool to exercise the cap, one qualifier link, one unfinished event, one showmatch
   - About 250 matches over 7 months
   - One roster swap that keeps 3 of 5 players
8. **`src/vrs/types.ts`** is shared by scripts and the page.
   - `Standings` holds `snapshotDate`, `valveCommit` (submodule HEAD), `modelCommit` (the last submodule commit touching `model/`), `source: "valve-published" | "model"`, `generatedAt` and `rosters`.
   - Each `Roster` holds:
     - `rosterKey` (sorted lowercase nicks) and `teamName`
     - `region`, `regionalRank`, `globalRank`, `points`
     - `factors { bountyOffered, bountyCollected, opponentNetwork, lanFactor }`
     - `startingValue`, `h2hAdjustment`, and `players` (5 nicks)
9. **`scripts/lib/vrs/valveModel.ts`** exports `computeStandings(matchData, eventData, snapshotDate)`.
   - Valve's `model/*.js` load once through `node:vm` with `Module.wrap` and a custom `require`. When `data_loader.js` asks for `fs`, it gets an in-memory shim. Every other require resolves normally.
   - Per call:
     - Throw unless `snapshotDate` is `YYYY-MM-DD`.
     - Keep only matches with `matchStartTime` before snapshotDate 00:00 America/Los_Angeles.
     - Put `JSON.stringify({ matches, events })` into the shim. This doubles as a deep clone, because Valve mutates its inputs.
     - Call `generateRanking(-1, sentinel)`.
     - Map the Team objects to `Standings`: points from `glickoTeam.rank()` unrounded, factors from `team.modifiers`, players from `activeRoster` nicks.
   - Give it a one-paragraph JSDoc covering purity and the snapshot semantics.
10. **`scripts/lib/vrs/publishedStandings.ts`**:
    - `readPublishedSnapshot(valveRoot, date)` parses the four standings `.md` files and every detail file. It prefers `invitation/` and falls back to `live/`, and returns `Standings` with `source: "valve-published"`.
    - `findLatestSnapshot(valveRoot)` returns the newest snapshot.
11. **`src/vrs/inviteCutoffs.ts`** holds the per-region Major invite cutoff ranks, marked unconfirmed for David to check.
12. **`scripts/lib/vrs/compareStandings.ts`** exports `compareStandings(model, published, cutoffs)`. It matches rosters by `rosterKey` and returns:
    - Strict mismatches: global or regional rank, rounded points, or a roster missing from one side
    - Exact rank matches per region, out of the region's total
    - The largest rank deviation
    - Points error, mean and max
    - Mismatches within ±3 of each region's cutoff
13. **`scripts/verify-vrs.ts`** takes `--date <YYYY-MM-DD> --matchdata <path> [--valve-root <dir>] [--json]`.
    - It validates the matchdata, runs `computeStandings`, reads the published snapshot and compares the two.
    - It prints PASS/FAIL plus the agreement table, and exits 1 on any strict mismatch.
14. **`scripts/update-data.ts`** follows the cfb-elo script shape: a `main()` with `.catch` → `process.exit(1)`, and `::warning::` annotations.
    - Find the latest snapshot, parse it, and write `public/data/vrs/<date>.json` and `latest.json` through a write-if-changed helper copied from cfb-elo's `writeJson.ts`.
    - If `VRS_MATCHDATA` is set, also run the model and verify-vrs. Otherwise emit `::warning::` that model verification was skipped for lack of input data.
15. **Workflows.**
    - `ci.yml`: same as cfb-elo's, with `submodules: true` on checkout.
    - `update-data.yml`, modelled on cfb-elo's:
      - Triggers on `workflow_dispatch` plus a daily cron at an off-hour minute, with `contents: write` and concurrency.
      - Checks out with submodules and runs `git submodule update --remote vendor/counter-strike_regional_standings`.
      - If `git diff <old>..<new> -- model` is non-empty inside the submodule, the job fails before committing.
      - Then `npm ci`, `npm run update-data`, `npm run test:run`, and a commit of `public/data` plus the submodule bump as "Update data".
16. **Page.**
    - Copy `DataTable.tsx`, `tableSort.ts`, `useTableSort.ts`, `theme.ts`, the `index.css` tokens and the Geist font imports from cfb-elo.
    - `src/main.tsx` and `src/App.tsx` set up React Router with basename `/cs2` and a TanStack Query provider.
    - `src/pages/Standings.tsx`:
      - Region tabs (Global, Europe, Americas, Asia) in a query param.
      - Sortable columns: rank, team, players, points, and the four factors.
      - Each row has an `aria-expanded` toggle that opens a detail row: factor bars, starting value + H2H = points, and the players.
      - Data is fetched from `${BASE_URL}data/vrs/latest.json`.
      - Footer: snapshot date, model commit linked to the GitHub commit, a source label, and Valve and HLTV attribution.
17. **Tests** (colocated `*.test.ts`, Vitest):
    - `valveModel.test.ts`:
      - Appending a fake match changes the output.
      - The same inputs give deep-equal output twice, and the inputs aren't mutated.
      - A missing or malformed date throws.
      - Changing the snapshot date changes the output.
    - `valveFidelity.test.ts`: copy `vendor/.../model` into a temp dir with the fixture at `data/matchdata.json`, run `node main.js '[0,1,2]' ../data/matchdata.json 2026_10_05` there through `execFileSync`, parse the result with `readPublishedSnapshot`, and require zero strict mismatches against `computeStandings`.
    - `publishedStandings.test.ts`, against the 10/05 files:
      - Counts are 380/245/89/46.
      - Global #1 is Spirit, 2046, players donk, magixx, sh1ro, tN1R, zont1x.
      - Factors are 1.000, 0.872, 0.398 and 0.932.
    - `matchdataSchema.test.ts`: the fixture has zero errors, and each targeted corruption raises its expected error.
    - `compareStandings.test.ts`: the metrics and the ±3 cutoff band.
    - `Standings.test.tsx`: renders the page with `react-dom/server` against the generated `latest.json`, and asserts the region tabs, rows and footer.
18. **Publish.** Commit, then `gh repo create daviddecorso/cs2-elo --public --source . --push`. Then `gh workflow run update-data.yml`, followed by `gh run watch --exit-status <id>`.

## Verification (every command exits on its own)

- `npm run lint`, `npm run test:run` and `npm run build`
- `npm run validate-matchdata -- fixtures/matchdata.synthetic.json` exits 0.
- `npm run verify-vrs -- --date 2026-10-05 --matchdata fixtures/matchdata.synthetic.json` is expected to exit 1 with a full agreement report. This proves the exit code works; the real 10/05 run is BLOCKED.
- `npm run update-data` writes `public/data/vrs/2026-10-05.json` and `latest.json`.
- The nightly workflow goes green on the manual trigger, confirmed with `gh run watch --exit-status`.
- The visual browser check of `/cs2/` is left to David or a follow-up session. Don't start a dev server headless.

## Decisions (don't relitigate)

- Site JSON comes from Valve's published standings and detail files, with `source: "valve-published"`. The model path runs only when real matchdata exists.
- Acceptance #1 is reported as BLOCKED with the reason. No tolerances or overrides to manufacture a pass.
- The URL is `esports.daviddecorso.com/cs2/`, with root `/` redirecting to it.
- The fs shim goes through `node:vm`. Don't monkeypatch global `fs` and don't copy Valve's logic.
- Snapshot cutoff is matches before snapshotDate 00:00 America/Los_Angeles, then `generateRanking(-1)`. Passing the snapshot as `versionTimestamp` would move the window end off the last match, which Valve doesn't do. This is a hypothesis to document.
- Rosters are keyed by sorted lowercase nicks, because published files carry no player IDs. Never key on team name.
- The nightly job fails rather than auto-adopting a Valve `model/` change.
- The README says "probabilities", not "odds", to keep it clear of betting language.
- Scripts live in `scripts/` and run through `vite-node`, matching cfb-elo. Shared types live in `src/vrs/`.

## Ruled out

- Rebuilding matchdata.json from detail files. It's circular, and about 56 matches, player IDs, countries and prize splits are missing.
- Porting Valve's model to TS, or editing anything under `vendor/`.
- Running `model/main.js` inside the submodule. It overwrites Valve's published files, so always use a temp copy.
- Modifying `../cfb-elo`.
- New stacks or dependencies beyond cfb-elo's set. No zod: the validator is hand-written.

## Final report must include

- Pass/fail per acceptance criterion, with #1 BLOCKED.
- Manual steps for David:
  - Connect Cloudflare Workers Builds to the repo, or run `npx wrangler login && npm run deploy` once. The `custom_domain` route creates the DNS record for `esports.daviddecorso.com`.
  - Create the GitHub repo if `gh` wasn't authed.
  - Confirm the cutoffs in `src/vrs/inviteCutoffs.ts`.

## Delegable sub-tasks

These only become possible after step 18 pushes the scaffold with the submodule.

- **compareStandings (jules).** "In daviddecorso/cs2-elo, implement `scripts/lib/vrs/compareStandings.ts` per `plans/vrs-phase-0-1.md` step 12, using the types in `src/vrs/types.ts`. Add `scripts/lib/vrs/compareStandings.test.ts` covering strict mismatches, per-region exact counts, max rank deviation, mean and max points error, and the ±3 cutoff band. Verify with `npm run test:run` and `npm run lint`."
- **publishedStandings parser (jules).** "In daviddecorso/cs2-elo, implement `scripts/lib/vrs/publishedStandings.ts` per `plans/vrs-phase-0-1.md` step 10, parsing the markdown files under `vendor/counter-strike_regional_standings/{invitation,live}/`. Add `publishedStandings.test.ts` asserting the 2026-10-05 counts (380/245/89/46) and the Spirit row (rank 1, 2046 points, donk/magixx/sh1ro/tN1R/zont1x, factors 1.000/0.872/0.398/0.932). Verify with `npm run test:run`."
