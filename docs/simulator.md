# Tournament simulator, VRS projections and Major invites

## Overview

Elo predicts each match, the simulator plays out each announced bracket, and Valve's model turns each simulated season into projected regional standings and Major invites. Code is in `scripts/lib/sim/`. `npm run simulate` writes `public/data/sim/`, and the site renders it at `/events`, `/events/:slug` and `/major` (see [Major page](#major-page)). The nightly job runs it after `build-elo`.

Invite projections run for PGL Major Singapore (25 Nov – 13 Dec 2026, snapshot 2026-11-02) and, once Singapore can be simulated, the FiRe Major Buenos Aires (31 May – 20 June 2027, snapshot expected in early April 2027).

**Projections count announced events only.** Teams add small LAN events late, and those aren't in the simulation until they're configured. The invite page shows the as-of date and every event that was left out, with the reason.

## Pipeline

1. **Fetch** (`scripts/lib/liquipedia/upcoming.ts`). `fetch-liquipedia` ends with `fetchUpcoming`, which replaces `data/raw/upcoming.json` whole each run:
   - `/tournament` rows starting in the next 200 days, for finding pages to configure.
   - Unfinished `/match` rows and all `/placement` rows for configured events and every other LAN in the [event catalog](vrs-simulator.md#event-catalog), queried by `parent`, so every stage subpage comes along.

   That's one request per table per 50 events, 5 per run today (capped at 100 pages). `npm run fetch-upcoming` runs it alone, for when you've just written a config; `--discover page,page` adds unconfigured parent pages so you can read their brackets before writing one. Don't run it back to back with the nightly job. Finished matches come from `matches.json` as usual.
2. **Event config** (`data/events/<slug>.json`, committed, written by hand). See [Config](#config).
3. **Simulation** (`simulate.ts`). For each run:
   - Draw every team's rating path.
   - Play each event's stages in order.
   - Record placements and the stages each team reached.

   Played matches are fixed, and when Liquipedia shows a round's pairings, those are used instead of ours.
4. **VRS layer** (`vrsProjection.ts`, `vrsPool.ts`). For the first `--vrs-n` runs (default 5,000):
   - Append each included event's unplayed simulated matches to `data/matchdata.json`.
   - Replace the event's entry with the simulated prize table.
   - Rerun Valve's model at the invite snapshot date (`rerun` on a world loaded once per worker, see [vrs-simulator.md](vrs-simulator.md#exact-rerun-valveworldts)).
5. **Invites** (`invites.ts`). Apply the regional invite rule to each projected standings and aggregate.

## Formats

All formats are pure functions over `(teams in seed order, context) → { advancing, exits, matches }`. The context's `play` checks for a played result before drawing one. Exit keys map to the parent event's placement labels through the config.

| Format | Exit keys | Notes |
| --- | --- | --- |
| `swiss` | final record, `2-3`, `1-3`, `0-3` | See below. |
| `single_elim` | `r<round>`, `champion` | Standard seeding (1v8, 4v5, 2v7, 3v6) or Liquipedia's round-1 draw once all of it is known. A field that isn't a power of two gives the top seeds round-1 byes. Final at `bestOf.final`; rounds of more than 8 matches (`LARGE_ROUND`) at `bestOf.largeRound` when set. Stops early with `advance > 0`. |
| `double_elim` | `lb-r<n>`, `gf`, `champion` | No bracket reset. Drop order alternates to avoid immediate rematches. `advance: 2` skips the grand final and advances both bracket winners. |
| `gsl` | `gsl-3`, `gsl-4` | Four-team groups (1v4, 2v3, winners, elimination, decider). Seeds snake across `groups` unless `groupTeams` gives the draw. |
| `round_robin` | `pos<n>` | Single round robin per group. Ranked by wins, then head-to-head among the tied, then at random (tiebreaker matches aren't simulated). |
| `bracket` | match id (loser), `w:<id>` (winner) | Any elimination shape, listed match by match in play order in `matches`. Each side is a seed (`s1`) or an earlier result (`w:ub1`, `l:ub1`); `qualify` lists the results that advance. Used for IEM/BLAST groups, playoffs with byes or a third-place match, and double elimination with a known drop order. Seed-vs-seed matches must come first, in Liquipedia's match order, so its opening draw replaces ours once posted. |

A stage's `exits.advance`, when set, labels the teams it advances; a qualifier's last stage uses it to place the teams that qualify. The generic formats the season catalog builds for unconfigured events are in [vrs-simulator.md](vrs-simulator.md#event-catalog).

### Major Swiss

Per Valve's rulebook:
- Three wins advance and three losses eliminate. Advancement and elimination matches are Bo3 (`bestOf.decider`), everything else Bo1.
- Round 1 pairs seed 1 v 9, 2 v 10, and so on.
- Later rounds pair within a W-L pool, sorted by difficulty (Buchholz: the sum of current opponents' wins minus losses), then initial seed.
- Rounds 2–3 pair highest against lowest without a rematch, backtracking if that strands a team. Six-team pools in rounds 4–5 use Valve's 15-row priority table.
- Advancing teams leave in order of record, difficulty, then seed, and are seeded after the next stage's invited teams.

This reproduces every pairing of IEM Cologne 2026 Stages 1–3 from seeds and results alone (`fixtures/cologne-2026-swiss.json`, tested in `formats/swiss.test.ts`). Seeds were the invited teams in VRS global order at the 2026-05-04 snapshot. Stage 3's advancing order also gives Cologne's real quarterfinal bracket.

The Swiss pairing rules live in `src/sim/swissPairing.ts`, shared by `formats/swiss.ts` and the site's Major simulator, so the Cologne fixture covers both.

## Major page

`/major` (and `/major/:slug`) shows the current or upcoming Major. That's the earliest event in `events/index.json` with `major: true` (any stage with `vrsStage`) that hasn't ended; with none, it's the soonest invite projection. When there are several (Singapore plus Buenos Aires' invites), a switch picks one.

- **Field not set:** the invite odds (`MajorInvites`).
- **Field set:** the event file carries a `pickem` block, and the page becomes a click-through simulator:
  - The `pickem` block holds each stage's seeds (`invited` in seed order), its played Liquipedia results, the playoff `matches`, and pairwise Bo1/Bo3/Bo5 series odds from today's Elo without drift.
  - `src/sim/pickem.ts` replays the stages with Valve's pairing. Played results lock, and a changed pick re-pairs every later round.
  - It starts with every open match filled by the favourite. "Clear" turns that off, and picks are kept in `localStorage` per Major.
- **Pick'em row:** under each Swiss stage, your bracket's 2× 3-0, 6× 3-X and 2× 0-3 picks are shown next to the model's set, each with its coin chance (5+ correct, Valve's per-stage coin upgrade) and expected correct picks.
  - "3-X" means advancing 3-1 or 3-2. A 3-0 team picked at 3-X scores nothing.
  - `scripts/lib/sim/pickemModel.ts` simulates the stage alone from round 1 with Valve's pairing and the `pickem` odds, ignoring its played results. Picks are correlated (round-1 opponents can't both go 3-0), so it scores whole pick sets per simulation rather than per-team odds.
  - The model set maximizes P(5+ correct), ties broken by expected correct: hill climbing over replace and swap moves, from the expected-correct optimum and 20 random starts, on 20,000 simulations.
  - A separate 5,000-simulation sample ships as `pickem.model[stage].sample` (2 bits per seed per simulation), and the site scores both rows on it, so the model's numbers aren't in-sample.
  - Valve locks picks at stage start, so once a stage has a played result its model is copied from the previous event file unchanged (as long as the seeds match). Before that it's recomputed every run. A stage needs known seeds, so later stages get a model only once the stage feeding them is fully played.
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

Each slot keeps at most its 16 likeliest teams, plus `size`, the average number of teams there across all of them. The Swiss view (`src/components/bracketModel.ts`) doesn't place each team in its likeliest pool, because that overfills some pools and empties others (three 0-3 teams, no 3-0). It traces one likeliest path instead:
- The first round takes the `size` likeliest teams.
- In each pool, the half with the best conditional win rate moves up and the rest move down. Played results and set pairings decide first.

Every pool then holds exactly its size, and each team's record only moves forward. Hovering a team still shows its full odds for every pool.

Each slot carries:
- `here` and `win`: the share of all simulations in which a team played in, or won, that slot. A final's `win` is the title odds.
- `matchups`: the top pairings.
- `results`: the played results, once every match there is played.

A pairing at 99% or more is drawn as a fixed match.

## Match odds and noise

`predict.ts` uses the same series odds as Elo: the map probability averaged over the active pool, then `seriesWinProbability` with `seriesMapTemp`. Teams with no lineage get the tier 2 mean.

Ratings carry no per-event noise. A team's rating drifts as a random walk of `DRIFT_PER_DAY` (58 Elo²/day) from the ratings' as-of date to each event's start, shared across events within a simulation. That's about σ 50 per team for an event six weeks out.

Tier 2 events (Liquipedia tier, `EventConfig.tier`, set by the catalog and by `npm run simulate`) play with the map-level Elo gap scaled by `TIER_TEMP` (0.905), on both the pooled odds and the veto model's map logits. Elo is overconfident there (2026 slope 0.60). Tiers 1 and 3+ keep 1, since a temperature didn't help them. Events with no tier keep 1. These choices are measured in [elo-experiments.md](elo-experiments.md), and `npm run fit-sim-noise` re-measures them.

### Veto simulation (off: ties the current simulator)

`--vetoes liquipedia|hltv` simulates each series' veto and then plays its maps one at a time, instead of giving every map the pool-averaged probability. It reads `data/sim/veto-model.json` from `cs2wp sim-veto --write` (`wp/src/cs2wp/simveto.py`). `scripts/lib/sim/veto.ts` mirrors that model, and a shared fixture in both test suites keeps the two in step.

- **Map logit:** the Elo base logit (overall ratings plus drift) plus `veto.py`'s map terms: `c_u·Δu`, and for `hltv` also the ban- and pick-rate terms and `γ` for the picker.
- **Choices:** at each step the acting team bans or picks from the remaining maps by a conditional logit, whose features are:
  - its own HLTV ban or pick rate (`hltv` only);
  - its Liquipedia played-map preference (plays per series over the uniform share, shrunk by 5 series);
  - the map model's edge for it.
- **Who acts first:** the lower seed in the stage's seed order bans first. Across HLTV vetoes, the better-ranked team acts second about 70% of the time in Bo1 and Bo3.
- **Order:** the defaults per format are each format's most common HLTV order: Bo1 `FFSSSF`, Bo3 `FSFSFS`, Bo5 `FSFSFS`, where `F` is the team that bans first. Majors mostly run Bo3 as `FSFSSF`, so an event config can override the order with `vetoOrder` (`{ "3": "FSFSSF" }`), as Singapore's does.
- **`liquipedia` mode** keeps HLTV ban and pick rates out of the output, but its choice weights are still fit on HLTV vetoes.

**Why the first version lost (fixed in `veto-v2`).** `u` wasn't centred on the team's pool, so besides map strength it carried "this team beats its Elo overall". That part predicts the next maps with the wrong sign (−8.4 ± 1.0 per map when split out, against +2.78 ± 0.24 for the map-specific part). It shifts every map of a Bo3 the same way, so it never cancels: a veto with random choices, or no veto and every map shifted by the pool-mean gap, reproduced the whole loss (−0.0006). The veto logic was never the problem. `u` is now centred (see [war.md](war.md#veto-value-lost)), and `K, TAU` follow `cs2wp veto`'s retune (40 maps, 365 days).

**Result (2026-11-15, `veto-v2`):**

- **Choice model:** it predicts real vetoes well. Per step, log-likelihood is −0.929 for `hltv` and −1.142 for `liquipedia`, against −1.421 for a uniform choice. The `hltv` blend beats habits only (−1.023) and edge only (−1.074).
- **Series gate:** a tie. Series log loss from 2026-01-01 is 0.5999 for the current simulator, against:

  | Series | n | `hltv` gain (90% CI) | `liquipedia` gain (90% CI) |
  | --- | --- | --- | --- |
  | All | 16,777 | +0.0001 (−0.0000, +0.0003) | −0.0001 (−0.0002, +0.0001) |
  | Vetoed | 587 | −0.0001 (−0.0021, +0.0019) | +0.0001 (−0.0007, +0.0010) |
  | Tier 1–2 | 1,091 | −0.0001 (−0.0013, +0.0011) | −0.0000 (−0.0006, +0.0005) |
  | Bo1 | 3,147 | +0.0001 (−0.0003, +0.0004) | −0.0002 (−0.0006, +0.0002) |
  | Bo3 | 13,477 | +0.0001 (−0.0000, +0.0003) | −0.0000 (−0.0002, +0.0001) |

  The report's strict "no worse" check reads `hltv` PASS, `liquipedia` FAIL, but both are within noise.
- **What the gain is made of** (all series):
  - **Uniform choices:** +0.0001 for `hltv`, +0.0000 for `liquipedia`. Veto prediction adds nothing beyond the map model.
  - **Pool-mean only:** +0.0000 for both, equal to the current simulator as it should be once `u` is centred.
  - **Played maps known:** the ceiling for a perfect veto predictor, using a Bo1's real map, or a Bo3's real first two maps with the decider averaged over the rest. On 16,214 series it's −0.0001 (−0.0004, +0.0003) for `hltv` and −0.0002 (−0.0005, +0.0002) for `liquipedia`. So better veto prediction has no series-level headroom, which rules out opponent-aware bans for now. Map edges are real but small: the edge on a played map has an sd of 0.10–0.14 logits, about 3 points of win probability, worth the +0.002 per map the map gate measures. In a Bo3 the two picks' edges correlate at −0.47 because each team picks its own strong map, and the decider is unknown, so knowing the maps moves the series probability by 0.7 points on average (90th percentile 1.7). That is worth about 0.0001 per series, half the standard error on 13,022 Bo3s. Bo1s move twice as much, but 3,117 series are too few to resolve it: +0.0001 ± 0.0008. Elo's own map offsets on the known maps tie too (Bo3 −0.00002).
- **Why a tie is the realistic outcome:** a team's rating is earned on maps that already went through vetoes, the two picks in a Bo3 largely offset each other, and 97% of the scored series have no veto history.
- **Default:** `npm run simulate` defaults to `--vetoes off`, and the model file isn't committed.
- **Rerun:** `cd wp && uv run cs2wp sim-veto`, which takes about 3 minutes and writes `data/war/reports/sim-veto.md`.

## VRS layer

- **Lineups.** A team's simulated matches use its last lineup in `data/matchdata.json`. When a complete 5-player current Liquipedia squad (`squads.json`, excluding coaching roles) keeps 3+ of those players, the squad replaces it, since teams often change a player just before an event.
- **Ids.** Teams and events use `buildMatchdata`'s ids: the team template page through `teamAliases` (falling back through `previousNames` for renamed teams), and the parent page through `eventRollups`. A Major's Stage 1 and Stage 2 are separate events keyed by their stage page, as in [matchdata-pipeline.md](matchdata-pipeline.md).
- **Times.** Unplayed matches are spread across the event's dates in stage order. Played matches keep their real times; events already finished in `data/matchdata.json` are not re-projected into deltas.
- **Window.** Projections end Valve's 180-day window at the pull time (`computeStandings(..., { windowEndsAtPull: true })`). The default ends it at the latest match, which for a future snapshot would be the last simulated match.
- **Blocking.** An event is left out of the projection if it ends after the snapshot, has no Liquipedia prize money, has a placement label the prize table lacks, or has a team with no match history. It's never guessed.
- **Cost.** Each worker (default: cores − 1, at most 8) loads the snapshot's window once with `loadWorld`, about 0.4 s, then reruns each simulation in about 25 ms. A rerun that would relink rosters falls back to a full `computeStandings` run (about 0.75 s) and is counted in the log. Reruns give byte-identical invite files to full runs (checked with `--seed 1 --n 2000 --vrs-n 200`: 70 s with full runs, 3 s with reruns, on 8 workers, with no fallbacks).
- **Round trip.** `npm run backtest-sim` strips Cologne 2026 from the model input and rebuilds it from the replayed simulation. With Cologne's own lineups, the 2026-07-06 standings match exactly (150/150 regional top-50 ranks, 0.00 points). With last-played lineups, 9 ranks differ, because NRG, BetBoom and BIG each changed a player just before the event. That's why squads are preferred.

## Invites

Each `data/events/invites-*.json` is one invite snapshot:
- `simulate` projects every snapshot that hasn't passed yet, soonest first.
- It writes `public/data/sim/invites/<slug>.json` and an `index.json`.
- `/major` shows them as described in [Major page](#major-page).
- `--invites <file>` projects a single config instead.

For each config:
- **Stage 3.** One slot per region for each of that region's teams that reached the previous Major's playoffs (`stage3From`).
- **Stage 2.** One slot per region for each team that reached its Stage 3 but not the playoffs (`stage2From`, i.e. 9th–16th).
- **Simulated per run, or fixed.** While the previous Major is configured and unplayed, both are simulated per run, with the region taken from the team's projected roster. Once it's played, the config gives the counts as `previousMajor.slots` instead. Singapore's config (snapshot 2026-11-02) does this with Cologne 2026's split.
- **Stage 1.** A fixed per-region count. Each regional list fills Stage 3, then 2, then 1 in rank order.
- **Intact and regional lock rules.** A roster is skipped when no current squad holds `minRetained` (3) of its players, or when a 3+ player core appeared on another region's published `invitation` VRS list in the preceding 3 calendar months (unless exempted in `regionExceptions`, e.g. `BC.Game` at Singapore 2026 per `vendor/counter-strike_rules_and_regs/tournament-operation-requirements-exceptions.md`). Without squad data, it's assumed intact. A `squads.json` without `objectname` on every row predates a fetch fix: it holds one player per team, so `simulate` ignores it.
- **Snapshot date.** Estimated (2027-04-05, the first Monday of April) until Valve announces it.

**The split is verified against Valve's rulebook (`vendor/counter-strike_rules_and_regs/major-supplemental-rulebook.md`).** Stage 1 is fixed at EU 6 / Am 6 / Asia 4; Stage 2 and Stage 3 match the regions of the previous Major's Stage 3 and Playoff teams (giving EU 6 / Am 2 / Asia 0 and EU 6 / Am 1 / Asia 1 for Singapore 2026). `src/vrs/inviteCutoffs.ts` (`cutoffsForSnapshot`) uses `16/10/6` pre-Cologne and `18/9/5` post-Cologne.

**Participants resolve automatically.** `simulate` fills each stage whose `invited` is `[]` from data already on disk (`scripts/lib/sim/participants.ts`), so it needs no extra Liquipedia requests:

1. A non-empty `invited` in the config always wins, so a hand-keyed list overrides everything else.
2. **Posted draw** (`bracket` stages). The config's all-seed matches, in order, are paired with Liquipedia's round-1 matches on the stage page/sections, sorted by `match2id`. This reproduces IEM Beijing 2026's hand-keyed groups.
3. **Major invites** (stages with `vrsStage`). Applies when an `invites-*.json` has the same `liquipedia` page and fixed `previousMajor.slots`:
   - Participants are Liquipedia's placement rows on the parent page. Each row's region comes from its `VRS <region>` qualifier.
   - Each row is matched to a roster in Valve's published snapshot (`vendor/counter-strike_regional_standings`) by at least `minRetained` shared players.
   - Per region, teams in global-rank order fill Stage 3, then 2, then 1. Each stage is then seeded in global order.
   - The snapshot only exists after the nightly job's submodule update.
4. Otherwise the event is skipped and listed as "participants not announced". The log names the reason (draw not posted, unmatched team, region count off, snapshot missing).

Swiss and round-robin draws outside Majors aren't resolved; key those by hand. The Buenos Aires projection waits until Singapore can be simulated.

**Renamed teams.** A sim team id is the current Liquipedia page, so played results lock correctly. Liquipedia's `opponentaliases` on participant rows give each team's earlier pages, and the predictor falls back to those for Elo (PVISION → PARIVISION, GOSH → BC.Game Esports).

## Major backtest

`npm run backtest-majors` scores the simulator on every past CS2 Major in `fixtures/events/` (Copenhagen 2024, Shanghai 2024, Austin 2025, Budapest 2025, Cologne 2026), from local data only. Scoring lives in `scripts/lib/sim/backtest.ts`; `backtest-sim` uses the same tally for Cologne.

- **Fixtures.** Each Swiss stage's `invited` is in real seed order. A fixture is checked twice:
  - Replaying Liquipedia's results must reach every played match.
  - Rebuilding every round's pairings from seeds and results alone, with Liquipedia's pairings removed, must reach every played match too. That checks the seeds and our pairing rules together, and all five Majors pass, playoffs included.
  - Austin, Budapest and Cologne seeds are Valve's global order at the seeding snapshot. Budapest's Liquipedia match order isn't seed order, so it was keyed from the 2025-11-03 snapshot.
  - Copenhagen's Elimination Stage Legends (pre-VRS) were found by searching orders until the rebuild matched.
  - Austin and Budapest played Stage 3 as Bo1 with Bo3 deciders; Cologne's Stage 3 was all Bo3.
- **Forecasts.** At each stage's start, earlier stages are locked to their real results and the rest is simulated (10,000 runs). Elo is rebuilt from matches before that day, with no drift. The stage at index 0 is the pre-event forecast. `--lead <days>` adds a pre-event Elo forecast made that many days earlier, with drift.
- **Baselines.** A coin flip, and VRS points: a series-level logistic on Valve's points from the last snapshot before the stage. Its scale is fit on the year of series before the event, and it ignores best-of. Snapshots start 2024-08-06, so Copenhagen has no VRS row.
- **Scores.**
  - Stage outcome log loss: each entrant's Pick'em bucket (3-0, 3-1/3-2, 0-3, other) in a Swiss stage, or its placement in the playoffs.
  - P(advance) log loss and Brier, with a calibration table.
  - Before the event: placement log loss, champion Brier, and the actual champion's odds and rank.
  - Pick'em: both model sets (`coinPickem` and the expected-correct set) from the stage's real seeds, scored against what happened.
- **Elo in-sample.** Elo parameters were tuned on 2025, so Austin and Budapest are in-sample.

**Result (2026-11-21, `--n 10000`, after the CS:GO warmup and its 2025 retune):**

| Model | Stage blocks | Stage outcome log loss | P(advance) log loss | P(advance) Brier |
| --- | --- | --- | --- | --- |
| Elo | 18 | **1.1307** | 0.5309 | 0.1787 |
| VRS points | 15 | 1.1447 | 0.5568 | 0.1883 |
| Supercomputer | 7 (8 for advance) | 1.1577 | **0.5272** | **0.1764** |
| Coin | 18 | 1.2448 | 0.6433 | 0.2279 |

- Differences, over (Major, stage) blocks, resampled:
  - Elo − coin: −0.114 (90% CI −0.176, −0.051).
  - Elo − VRS: −0.008 (−0.038, +0.022).
  - Elo − Supercomputer on the 7 shared blocks: −0.003 (−0.035, +0.026). On advance log loss: −0.003 (−0.028, +0.026).
- **Before the CS:GO warmup (2026-11-20)**, Elo scored 1.2066 / 0.5843 / 0.1895, and VRS beat it by 0.041 (−0.007, +0.088). Almost all of the change is at Copenhagen and Shanghai: Copenhagen's Opening Stage went from 1.81 to 1.17, and its played-series log loss from 0.965 to 0.663.
- **Before the event:** placement log loss is 1.907 for Elo, 1.959 for VRS (4 Majors) and 2.114 for a coin.
- **Pick'em:** Elo's coin set averaged 4.2 of 10 correct and would have earned the coin in 7 of 13 Swiss stages. VRS's coin set got 4.4 correct and 6 of 11.
- **How far to trust this:** 5 events and 18 blocks, with outcomes correlated within each event, so none of the differences between Elo, VRS and the Supercomputer is significant. Austin and Budapest are in-sample for Elo.
- **Played Major series** (464, priced at their stage's start):
  - Log loss is 0.640, with slope 0.80 (CI 0.62–1.01). By Major: Copenhagen 0.663 (slope 0.57), Shanghai 0.600 (0.98), Austin 0.689 (0.50), Budapest 0.638 (0.98), Cologne 0.603 (1.42).
  - VRS gets 0.605, 0.682, 0.663 and 0.633 on the last four.
  - Elo still leans overconfident at Majors, but the slope swings from 0.5 to 1.4 by Major, and the 2026 tier-1 series slope is 0.98. That's too noisy to justify a Major-only temperature.
- **External comparison.** With `data/external/supercomputer.json` present (another model's published stage marginals and picks, kept local), the backtest adds it as a model.
  - Budapest Stage 3's source column isn't 0-3 (it sums to 300%), so that block is scored on P(advance) only.
  - Its published picks averaged 5.0 correct and earned the coin in 5 of 6 stages.
  - The two models rank teams similarly (P(advance) rank correlation 0.86–0.95 per stage, mean gap 3–11 points), and Elo is no more spread out than it.
  - Elo's biggest loss is still the Budapest playoffs, where it gave the champion Vitality 18.9% against the Supercomputer's 34.4%.
- **Region at Majors.** On cross-region Major series, Americas teams beat Elo's expectation by 4.2 wins in 32 series at Copenhagen (9.7 before the warmup) and by 6.9 in 185 overall. Asia is level (−1.8 in 82).

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

- `invited` holds Liquipedia team pages (the template page, as the Elo feed keys teams), in seed order. Leave it `[]` to resolve it automatically (see above). For Majors the order is VRS global order at the seeding snapshot. For a `bracket` group it's draw order (round-1 match 1's teams are `s1`, `s2`).
- `vrsStage` (1–3) marks a Major Swiss stage for invite resolution.
- `vetoOrder` (event level) overrides the veto model's actor order per best-of; see Veto simulation.
- Optional event-level fields used only by the season simulation (see [Event catalog](vrs-simulator.md#event-catalog)). The catalog fills `location` and `invites` when they're absent:
  - `location`
  - `invites` (`slots`, `qualifiers`, `verified`)
  - `prizeEstimate` (label → USD per team)
  - `assumed`
- `from` appends earlier stages' advancers after the invited teams; with several (`["groupA", "groupB"]`), each stage's `qualify` order follows the last.
- `sections` picks a stage's matches by Liquipedia's match `section` when several stages share one page, which is how PGL, IEM, BLAST and ESL lay out their events (`["Round 1", …]` for Swiss, `["Group A"]`, `["Playoffs"]`).
- Each exit key the format can produce needs a label. A missing label fails the run.
- `fixtures/events/cologne-2026.json` is a complete Major example.

When a run reports `N of M runs missed a played match`, the simulated pairings diverged from Liquipedia's, which usually means wrong seeds.

## Commands

```bash
npm run fetch-upcoming -- [--discover PGL/2027/Bucharest,...]   # after writing a config; about 5 requests
npm run catalog                                                  # every upcoming LAN, local files only
npm run simulate-season -- [--season-n 300] [--seed 1] [--out <dir>]   # season to the next invite snapshot (vrs-simulator.md)
npm run simulate -- [--events slug,...] [--n 10000] [--vrs-n 5000] [--seed 1] [--workers 4] [--no-vrs] [--invites <file>] [--out <dir>] [--vetoes off|liquipedia|hltv]
npm run backtest-sim -- [--config fixtures/events/cologne-2026.json] [--snapshot 2026-07-06]
npm run backtest-majors -- [--majors slug,...] [--n 10000] [--pickem-n 20000] [--seed 1] [--lead <days>]   # about 4 minutes
npm run fit-sim-noise
```
