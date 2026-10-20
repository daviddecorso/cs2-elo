# Tournament simulator, VRS projections and Major invites

## Overview

Elo predicts each match, the simulator plays out each announced bracket, and Valve's model turns each simulated season into projected regional standings and Major invites. Code is in `scripts/lib/sim/`. `npm run simulate` writes `public/data/sim/`, and the site renders it at `/events`, `/events/:slug` and `/major-invites`. The nightly job runs it after `build-elo`.

Invite projections run for PGL Major Singapore (25 Nov – 13 Dec 2026, snapshot 2026-11-02) and, once Singapore can be simulated, the FiRe Major Buenos Aires (31 May – 20 June 2027, snapshot expected in early April 2027).

**Projections count announced events only.** Teams add small LAN events late, and those aren't in the simulation until they're configured. The invite page shows the as-of date and every event that was left out, with the reason.

## Pipeline

1. **Fetch** (`scripts/lib/liquipedia/upcoming.ts`). `fetch-liquipedia` ends with `fetchUpcoming`, which replaces `data/raw/upcoming.json` whole each run:
   - `/tournament` rows starting in the next 200 days, for finding pages to configure.
   - Unfinished `/match` rows and all `/placement` rows for configured events, queried by `parent`, so every stage subpage comes along.

   That's one request per table per 50 events, 3 per run today. `npm run fetch-upcoming` runs it alone, for when you've just written a config; `--discover page,page` adds unconfigured parent pages so you can read their brackets before writing one. Don't run it back to back with the nightly job. Finished matches come from `matches.json` as usual.
2. **Event config** (`data/events/<slug>.json`, committed, written by hand). See [Config](#config).
3. **Simulation** (`simulate.ts`). For each run:
   - Draw every team's rating path.
   - Play each event's stages in order.
   - Record placements and the stages each team reached.

   Played matches are fixed, and when Liquipedia shows a round's pairings, those are used instead of ours.
4. **VRS layer** (`vrsProjection.ts`, `vrsPool.ts`). For the first `--vrs-n` runs (default 1,000):
   - Append each included event's unplayed simulated matches to `data/matchdata.json`.
   - Replace the event's entry with the simulated prize table.
   - Run Valve's model at the invite snapshot date.
5. **Invites** (`invites.ts`). Apply the regional invite rule to each projected standings and aggregate.

## Formats

All formats are pure functions over `(teams in seed order, context) → { advancing, exits, matches }`. The context's `play` checks for a played result before drawing one. Exit keys map to the parent event's placement labels through the config.

| Format | Exit keys | Notes |
| --- | --- | --- |
| `swiss` | final record, `2-3`, `1-3`, `0-3` | See below. |
| `single_elim` | `r<round>`, `champion` | Standard seeding (1v8, 4v5, 2v7, 3v6) or Liquipedia's round-1 draw once all of it is known. Final at `bestOf.final`. Stops early with `advance > 0`. |
| `double_elim` | `lb-r<n>`, `gf`, `champion` | No bracket reset. Drop order alternates to avoid immediate rematches. `advance: 2` skips the grand final and advances both bracket winners. |
| `gsl` | `gsl-3`, `gsl-4` | Four-team groups (1v4, 2v3, winners, elimination, decider). Seeds snake across `groups` unless `groupTeams` gives the draw. |
| `round_robin` | `pos<n>` | Single round robin per group. Ranked by wins, then head-to-head among the tied, then at random (tiebreaker matches aren't simulated). |
| `bracket` | match id (loser), `w:<id>` (winner) | Any elimination shape, listed match by match in play order in `matches`. Each side is a seed (`s1`) or an earlier result (`w:ub1`, `l:ub1`); `qualify` lists the results that advance. Used for IEM/BLAST groups, playoffs with byes or a third-place match, and double elimination with a known drop order. Seed-vs-seed matches must come first, in Liquipedia's match order, so its opening draw replaces ours once posted. |

### Major Swiss

Per Valve's rulebook:
- Three wins advance and three losses eliminate. Advancement and elimination matches are Bo3 (`bestOf.decider`), everything else Bo1.
- Round 1 pairs seed 1 v 9, 2 v 10, and so on.
- Later rounds pair within a W-L pool, sorted by difficulty (Buchholz: the sum of current opponents' wins minus losses), then initial seed.
- Rounds 2–3 pair highest against lowest without a rematch, backtracking if that strands a team. Six-team pools in rounds 4–5 use Valve's 15-row priority table.
- Advancing teams leave in order of record, difficulty, then seed, and are seeded after the next stage's invited teams.

This reproduces every pairing of IEM Cologne 2026 Stages 1–3 from seeds and results alone (`fixtures/cologne-2026-swiss.json`, tested in `formats/swiss.test.ts`). Seeds were the invited teams in VRS global order at the 2026-05-04 snapshot. Stage 3's advancing order also gives Cologne's real quarterfinal bracket.

## Bracket view

Every simulated match carries a slot, its position in the stage's bracket, which stays the same across simulations. `simulateEvents` tallies each slot: who played there, who won there, which pairings occurred, and whether every run had the same played result. `bracketView.ts` writes these as each event file's `bracket`, and the event page draws them.

| Format | Slot ids | Lower lane |
| --- | --- | --- |
| `bracket` | the config match id | a match whose sources are all losers (`l:`) or lower-lane winners. That covers lower brackets and third-place matches, but not a grand final. |
| `single_elim` | `r<round>-m<i>` | none |
| `double_elim` | `ub-r<n>-m<i>`, `lb-r<n>-m<i>`, `gf` | `lb-*` |
| `gsl` | `g<k>-o1`, `-o2`, `-win`, `-elim`, `-dec` | `-elim`, `-dec` |
| `swiss` | `r<round>:<w>-<l>`, the pool's record before the match | none. All of a pool's matches share its slot. |
| `round_robin` | `g<k>-<i>v<j>` | not drawn |

Each slot carries:
- `here` and `win`: the share of all simulations in which a team played in, or won, that slot. A final's `win` is the title odds.
- `matchups`: the top pairings.
- `results`: the played results, once every match there is played.

A pairing at 99% or more is drawn as a fixed match.

## Match odds and noise

`predict.ts` uses the same series odds as Elo: the map probability averaged over the active pool, then `seriesWinProbability` with `seriesMapTemp`. Teams with no lineage get the tier 2 mean.

Ratings carry no per-event noise. A team's rating drifts as a random walk of `DRIFT_PER_DAY` (58 Elo²/day) from the ratings' as-of date to each event's start, shared across events within a simulation. That's about σ 50 per team for an event six weeks out. Both choices are measured in [elo-experiments.md](elo-experiments.md), and `npm run fit-sim-noise` re-measures them.

## VRS layer

- **Lineups.** A team's simulated matches use its last lineup in `data/matchdata.json`. When a complete current Liquipedia squad (`squads.json`) keeps 3+ of those players, the squad replaces it, since teams often change a player just before an event.
- **Ids.** Teams and events use `buildMatchdata`'s ids: the team template page through `teamAliases`, and the parent page through `eventRollups`. A Major's Stage 1 and Stage 2 are separate events keyed by their stage page, as in [matchdata-pipeline.md](matchdata-pipeline.md).
- **Times.** Unplayed matches are spread across the event's dates in stage order. Played matches keep their real times.
- **Window.** Projections end Valve's 180-day window at the pull time (`computeStandings(..., { windowEndsAtPull: true })`). The default ends it at the latest match, which for a future snapshot would be the last simulated match.
- **Blocking.** An event is left out of the projection if it ends after the snapshot, has no Liquipedia prize money, has a placement label the prize table lacks, or has a team with no match history. It's never guessed.
- **Cost.** One model run takes about 0.75 s. The model keeps its input in a module-level variable, so runs are parallel through worker threads (default: cores − 1, at most 8). That's about 4 runs per second on 4 workers locally, so 1,000 runs take about 4 minutes.
- **Round trip.** `npm run backtest-sim` strips Cologne 2026 from the model input and rebuilds it from the replayed simulation. With Cologne's own lineups, the 2026-07-06 standings match exactly (150/150 regional top-50 ranks, 0.00 points). With last-played lineups, 9 ranks differ, because NRG, BetBoom and BIG each changed a player just before the event. That's why squads are preferred.

## Invites

Each `data/events/invites-*.json` is one invite snapshot:
- `simulate` projects every snapshot that hasn't passed yet, soonest first.
- It writes `public/data/sim/invites/<slug>.json` and an `index.json`.
- `/major-invites` shows the soonest, with a switch when there are several.
- `--invites <file>` projects a single config instead.

For each config:
- **Stage 3.** One slot per region for each of that region's teams that reached the previous Major's playoffs (`stage3From`).
- **Stage 2.** One slot per region for each team that reached its Stage 3 but not the playoffs (`stage2From`, i.e. 9th–16th).
- **Simulated per run, or fixed.** While the previous Major is configured and unplayed, both are simulated per run, with the region taken from the team's projected roster. Once it's played, the config gives the counts as `previousMajor.slots` instead. Singapore's config (snapshot 2026-11-02) does this with Cologne 2026's split.
- **Stage 1.** A fixed per-region count. Each regional list fills Stage 3, then 2, then 1 in rank order.
- **Intact rule.** A roster is skipped when no current squad holds `minRetained` of its players, and its slot passes down the list. Without squad data, it's assumed intact. A `squads.json` without `objectname` on every row predates a fetch fix: it holds one player per team, so `simulate` ignores it.
- **Snapshot date.** Estimated (2027-04-05, the first Monday of April) until Valve announces it.

**The split is inferred, not read from the rulebook.** Singapore's 32 Liquipedia participant slots (`VRS <region> (Nov. 2026)`) split EU 6 / Am 2 / Asia 0, then EU 6 / Am 1 / Asia 1, then EU 6 / Am 6 / Asia 4. Those are exactly the regions of Cologne 2026's playoff teams, of its 9th–16th places, and Cologne's own Stage 1 split. The dry run (Cologne as the previous Major, snapshot 2026-11-02) reproduces all three. The page flags it until `verified` is set. Re-check against each cycle's rulebook. `src/vrs/inviteCutoffs.ts`'s 16/8/8 doesn't match either cycle.

**Pending events.** A config whose stage has `"invited": []` is skipped and listed as "participants not announced". The Buenos Aires projection waits until Singapore can be simulated. Singapore's participants come from the 2026-11-02 VRS snapshot. Once Liquipedia lists them, fill each stage's `invited` in VRS global order at that snapshot: participant slots 1–8 are Stage 3, 9–16 Stage 2 and 17–32 Stage 1.

## Config

```jsonc
{
  "slug": "pgl-major-singapore-2026",
  "name": "PGL Major Singapore 2026",
  "liquipedia": "PGL/2026/Singapore",          // parent page: prize table, VRS event id
  "startDate": "2026-11-25", "endDate": "2026-12-13", "lan": true,
  "stages": [{
    "id": "stage1", "name": "Stage 1", "page": "PGL/2026/Singapore/Stage_1",
    "format": "swiss", "bestOf": { "default": 1, "decider": 3 },
    "invited": ["…16 team pages in seed order…"],
    "advance": 8,
    "exits": { "2-3": "25-27", "1-3": "28-30", "0-3": "31-32" }
  }, {
    "id": "stage2", "from": "stage1", "invited": ["…8…"], …
  }]
}
```

- `invited` holds Liquipedia team pages (the template page, as the Elo feed keys teams), in seed order. For Majors that's VRS global order at the seeding snapshot. For a `bracket` group whose draw is posted, list teams in draw order (round-1 match 1's teams are `s1`, `s2`).
- `from` appends earlier stages' advancers after the invited teams; with several (`["groupA", "groupB"]`), each stage's `qualify` order follows the last.
- `sections` picks a stage's matches by Liquipedia's match `section` when several stages share one page, which is how PGL, IEM, BLAST and ESL lay out their events (`["Round 1", …]` for Swiss, `["Group A"]`, `["Playoffs"]`).
- Each exit key the format can produce needs a label. A missing label fails the run.
- `fixtures/events/cologne-2026.json` is a complete Major example.

When a run reports `N of M runs missed a played match`, the simulated pairings diverged from Liquipedia's, which usually means wrong seeds.

## Commands

```bash
npm run fetch-upcoming -- [--discover PGL/2027/Bucharest,...]   # after writing a config; about 3 requests
npm run simulate -- [--events slug,...] [--n 10000] [--vrs-n 1000] [--seed 1] [--workers 4] [--no-vrs] [--invites <file>] [--out <dir>]
npm run backtest-sim -- [--config fixtures/events/cologne-2026.json] [--snapshot 2026-07-06]
npm run fit-sim-noise
```
