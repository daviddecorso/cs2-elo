# Elo assumptions

## Overview

What the Elo model ([elo-model.md](elo-model.md)) assumes about how CS2 works, the evidence for each assumption, and what would change it. [elo-experiments.md](elo-experiments.md) logs levers; this doc holds the beliefs those levers rest on. A lever that contradicts one is then judged as a claim about the game, not just a parameter that happened to score well. Dates in parentheses are entries in elo-experiments.md unless another doc is named.

**Statuses.**
- **Held:** tested, and the data agrees. The model is built on it.
- **Lean:** the evidence points one way but doesn't clear noise.
- **Open:** untested, or the data can't tell yet.
- **Rejected:** tested, and the data says no.

**How to use it.**
- Every experiment entry names the assumption it tests, by its heading here.
- A lever that follows a Held assumption, or tests an Open or Lean one, is judged by the usual rules: the gate, the region rule or the tier-1 LAN rule.
- A lever that contradicts a Held assumption, or revives a Rejected one, has a higher bar:
  1. State the mechanism, and show it in a diagnostic on training years before any test-year read.
  2. Gain in each walk-forward fold (`npm run backtest-elo -- --walk …`), not just pooled.
  3. If it passes, update the assumption here in the same change.
- After each experiment, update the status and evidence here. A finding that fits no assumption gets a new one, usually as Open.

## Guardrails against overtuning

These come out of the experiment log and apply to every lever.
- Tune once a year on the latest full year, and judge on the next. Recent-only tuning beat all-history tuning by 0.0054 on the gate set (2026-11-19).
- Declare the test before the run. A variant chosen after a test-year read is exploration, and its clean check moves to the next year. The Oceania values, `k` 10 and round share (A2) all wait on 2027 for that reason.
- Gate moves under 0.0005 are noise. Slices too small to clear that bar use the region rule or the tier-1 LAN rule, which are walk-forward with event-clustered CIs.
- A parameter that moves a lot between years (`tierGap`, `kMap`, `seriesMapTemp`) is soft. Don't build on its exact value or read it as a fact about the game.
- A temperature has to carry over from training years. LAN and tier-1 calibration drift from year to year, and fixes fit on one year have repeatedly hurt the next (2026-11-18, 2026-11-19, 2026-11-21).

## The game

### Outcomes are noisy, and short-term results revert (Held)

**Belief.** A single map is a noisy draw. Duel luck, economy swings and MR12's short halves decide many of them. A run of results at one event says less than the same results spread over months.

**In the model.** K is 12 per map, margin is damped by log rounds, and burst damping (`burstMaps`, `burstDays`) shrinks K for maps that arrive in a cluster.

**Evidence.**
- Elo's 2026 map log loss is 0.625, against 0.693 for a coin.
- Burst damping was kept because the over-reaction sits in results under 7 days old (2026-11-18).
- Within an event, a team's results share no form beyond Elo's own updates (2026-10-20). There's no over-reaction to 120-day form either (2026-11-21).
- Duel luck reverts. A team's trailing duel luck predicts its next round margin negatively (−0.17, CI −0.31 to −0.04), while raw execution predicts nothing (2026-11-14).

**Would change it.** A hot-hand signal across series, or K wanting to rise from one year to the next.

### Maps in a series are correlated (Held)

**In the model.** `seriesMapTemp` (0.9) flattens the map logit before the Bo3/Bo5 conversion.

**Evidence.** Treating maps as independent left Bo3 at slope 0.855 and Bo5 at 0.768, while maps and Bo1 were calibrated (2026-10-20). Both maps share the same rating error, and each side picks one.

**Would change it.** Bo3 calibrating without the temperature.

### Star players matter, but team results already carry them (Held, player-level form)

**Belief.** As in basketball, a star carries a large share of a team's strength.

**In the model.** A rating belongs to a 3-of-5 core lineage, and a new lineage is seeded from its players' old ratings. Odds also blend in a results-only player Elo (`playerElo.ts`): a side is the mean of its five players' ratings. The lineage rating never sees the player ratings, so rankings are lineage-only.

**Evidence.**
- For a stable roster, no player stat adds to Elo. WAA, HLTV 3.0 and K−D all have gains whose CIs cover 0 ([war.md](war.md#war-validation)). Elo already carries what a lineup's past output says.
- Roster changes are where stars should show, and nothing has yet. The WAR transfer prior and `transferWeight` were both rejected, and the prior-skill term gained +0.0008, not significant (2026-11-21, 2026-11-14).
- A team effect beyond its five players isn't measurable either. Round wins beyond what the players' WAR expects have split-half 0.24, CI including 0 ([war.md](war.md#team-factor)).

- A results-only player Elo, blended with lineage Elo, gains +0.0026 on the 2026 gate (CI +0.0015 to +0.0037), with λ 0.33 in both 2025 and 2026 (2026-11-24). Player identity carries information the lineage rating loses, even without demo stats.
- In the engine, tuned on 2024: gate +0.0030 (+0.0015 to +0.0045), and the tier-1 LAN walk passes at +0.0041 pooled (2026-11-24). Live.

**Would change it.** Held for player-level results, not for demo stats: those still add nothing. The demo-stat half would move if the roster-change test passes once WAR covers tier 2 and has a second season of prior rounds per player. Roster changes are also where player-based models beat team ratings in basketball. CS rosters change less often mid-season, so the ceiling here is lower.

### Team identity is the core players, not the org (Held)

**In the model.** A lineage follows 3 of its 5 core players across org changes. A partial change keeps the rating (`regress` 0), and a new lineage is seeded from its players.

**Evidence.** Regressing a changed roster toward the tier mean tuned to 0, and stand-in series score like the rest (2026-10-20).

**Known weakness.** A chain of 3-of-5 changes can carry a rating long after every original player has left (GOSH, FaZe).
- `transferWeight` didn't fix it (2026-11-21).
- Neither would more player-Elo weight where a lineage's recent maps were played by other players. λ(low share) − λ(high share) is +0.08 and +0.40 in 2024 and 2025, both CIs spanning 0 (2026-11-24).

**Would change it.** A fix for long chains that passes the gate.

### Strength is one number per team, plus small map preferences (Held)

**Belief.** Teams have styles that play well or badly against each other, and map pools that suit or don't suit a given opponent.

**In the model.** Elo is transitive: if A is favoured over B and B over C, then A is favoured over C. Map offsets (`kMap`) are re-centred on the active pool, so they show preference, never overall strength.

**Evidence on maps.**
- Map offsets are worth almost nothing to log loss. Their tuned size swings between 0 and 20 across years (2026-10-20, 2026-11-19).
- Knowing the maps a veto actually produced adds nothing to series odds (−0.0001). A dedicated map model loses out of sample (2026-11-19).
- The likely reason is that each side bans its worst map and picks its best, so map edges mostly cancel over a series. Map pools decide which maps get played more than who wins.

**Evidence on styles.**
- **Head-to-head persistence** (`npm run backtest-elo -- --h2h`, 2026-11-21) asks whether a pair's residual from earlier meetings predicts their next meeting, beyond each side's form.
  - Some persistence exists: map logit coefficient +1.09 (z 4.0) in 2025 and +0.50 (z 1.7) in 2026. It's worth about 1 point of win probability at one SD, and gains nothing out of sample.
  - At tier 1 it's absent (2026 −1.16 ± 1.06).
  - Same-map pair residuals are no stronger.
- **Team style traits.** Stable ones exist (map control, team clutching, stopping executes), but map control and numbers at contact don't add to Elo ([war.md](war.md#tactics-stats)).

**Reading.** Styles and pools may well clash, but what's left of that after Elo is too small to price. That's especially true at tier 1, where teams prepare for each other. A transitive rating loses almost nothing.

**Would change it.** A style vector built from demo traits (not pair history, which is too sparse) that predicts the pair residual, or the pair effect clearing z 2 in a later year with a gate gain.

### Preparation decides tier-1 games in ways Elo can see (Lean against)

**Belief.** At the top, strategy, preparation and reading an opponent's tendencies carry a lot of weight.

**Evidence.**
- A team's own T-side history (site, timing, execute) predicts its next round barely better than the league average does. Predictable teams don't lose more to opponents who played them in the last 60 days ([war.md](war.md#t-side-predictability), fails).
- There's no home advantage at LANs (2026-11-19).
- Tier-1 LANs show no fixed parity effect. Their calibration slope went 0.61 (2024), 0.87 (2025), 0.99 (2026) (2026-11-21).
- Rematches at the same tournament show no adaptation. The earlier loser beats Elo by +0.022 more than other sides coming off a loss there (z 0.4 on 2024–25), and 2026 flips sign. No days-since-last-meeting bin holds across years (2026-11-24).

**Reading.** Preparation matters, but every tier-1 team does it, so it may cancel. Nothing we can measure shows it moving results away from Elo.

**Would change it.** A preparation measure that predicts the residual, such as scouting volume. Days since the pair last met doesn't (2026-11-24).

### Strategic edges spread fast and don't last (Lean)

**Belief.** Astralis's utility play around 2017 took the scene a long time to counter. By 2026, scouting tools spread new smokes, flashes and setups within weeks, and much of the innovation comes from tier-2 teams.

**Consistent with it.**
- Team T-side tendencies are about as predictable as the league's (above). Map control is style, not edge, and landing executes is noise; only stopping them is a team trait ([war.md](war.md#tactics-stats)).
- Short-term results revert, and 2026 rewards a slower Elo than 2024–25 did (2026-11-18). If edges from new ideas are small and short-lived, what persists is player skill, so ratings should move slowly.
- Recent-only tuning beats all-history tuning, so the game drifts from year to year (2026-11-19).

**Not shown.** Teams rising from tier 2 don't beat Elo at tier-1 LANs. Teams ranked 17–32 there were +19.8 wins over expectation in 2024, +1.5 in 2025 and −4.1 in 2026 (2026-11-21). Elo data alone also can't separate fast-spreading ideas from CS2 settling down after launch.

**Would change it.** K wanting to rise again, or a measure of tactical novelty that predicts results.

### Round margins say more about strength below tier 1 (Lean)

**Belief.** It's like college football against the NFL. Tier 2–3 teams grind the same opponents across wide skill gaps. Tier 1 is closer, and teams prepare for each other.

**In the model.** Ratings learn from map wins, with margin only scaling K. Lower tiers count less (`tierK` 0.9 per tier), and new lower-tier teams start lower (`tierGap`).

**Evidence.**
- Learning from round share (A2) gains +0.0022 on all 2026 series and +0.0048 cross-region. It's worse at tier-1 LANs in both years it wasn't tuned on (2024 −0.010, 2026 −0.0021, CI spanning 0) and worse at Majors (2026-11-21).
- Tier 3+ is calibrated. Tier-2 online qualifiers are overconfident (slope 0.32 in 2026), likely from crowded schedules and integrity problems (2026-11-19).

**Would change it.** A2 holding the gate in 2027 without losing at tier-1 LANs (then keep it), or a tier-split version that passes.

### Big game changes make ratings stale for a while (Open)

**Belief.** CS2's launch (MR12, new smokes and movement) left CS:GO ratings partly stale, so the first CS2 year was harder to predict.

**Evidence.** Tier-1 LAN slope was 0.61 in 2024. Early-2024 tier 1 prefers `gameRegress` 0.3 to 0 (0.641 against 0.666), but the 2025 tune can't see the switch and set it to 0 (2026-11-21). For map reworks and pool rotations, offsets re-centre on the active pool and nothing else changes.

**Would change it.** The next major update or pool change. Test whether a short temperature after it helps.

## The scene

### Regional pools are anchored by sparse cross-region play (Held for Oceania only)

**In the model.** Oceania gets a −175 prior against other regions and a 1.4 temperature inside its own pool. Cross-region maps count at `crossRegionK` 0.75.

**Evidence.**
- Oceania sits 126–129 points overrated against the rest. Its travellers are underrated at home by 110–150 points, so the pool's internal gaps are compressed (2026-11-19, 2026-11-20).
- The rest of Asia is about 13 points overrated: steady, but too small to price. Insular Asian rosters are 35–59 points overrated, but pricing that doesn't help at tier-1 LANs (2026-11-21).
- Americas against Europe flips sign every year (2026-11-19).
- Oceania-internal series are 2% of the gate and of training, and are left out of shared-param fits and decisions. Leaving them out changed neither the player-blend verdict nor the lineage-retune verdict (2026-11-24).

**Would change it.** The 2027 recheck of the Oceania values, which were picked after a look at 2026.

### A team's results below its tier count like its tier-1 results (Lean)

**In the model.** `tierK` scales K by event tier for both sides alike. A tier-1 roster at a tier-3 cup isn't treated differently.

**Evidence.**
- At tier-1 LANs, rating changes a side picked up below tier 1 in the last 90 days don't revert more than its tier-1 changes. β_below − β_at is +0.13 (−0.12 to +0.36) on 2024–25, and the years disagree in sign (2026-11-24).
- Tier-1 changes themselves revert there: β_at −0.21 ± 0.09, about 2 points of win probability for a typical side. That's the over-reaction lead at tier 1, and it's untested as a lever.

**Would change it.** β_below falling clearly below β_at in a later year.

### LAN and online are the same game (Held)

**In the model.** `onlineK` is 1, with one series temperature for both.

**Evidence.** LAN calibration drifts (maps slope 0.66, 1.04, 1.13 across 2024–26) with no fixed LAN effect to price. Separate LAN and online temperatures were rejected (2026-11-18).

### Thin evidence doesn't need wider odds (Held)

**Evidence.** New, idle and just-changed rosters aren't more overconfident than established ones. The best ceiling for widening is 0.0001 (2026-10-20, 2026-11-21). Where Elo misses such teams, it puts them in the wrong place; its odds aren't too narrow.

### Outside rankings add nothing (Held)

**Evidence.** After the CS:GO warmup, VRS and HLTV add nothing beyond Elo (encompassing λ 0.01, 2026-11-21). The Supercomputer leans toward VRS and HLTV ranks, and that nets to zero at Majors ([simulator.md](simulator.md)).

## Untested

- **Stakes** (partly tested). Elimination and safety-net games calibrate alike, so the loser's stakes don't move results. Bracket games run slightly overconfident against calibrated league games, worth about 0.0002 (2026-11-24). At tier-1 LANs, the final bracket's calibration doesn't differ in a steady direction from earlier stages: slopes swing 0.3 to 0.8 a year in every stage (2026-11-24). Dead rubbers, already-qualified teams and VRS point chases are still untested.
- **Sides.** CT/T balance by map, and half scores. A side split gets built only if round share is kept.
- **Schedule and travel load.** Same-day load has no effect (2026-11-24). Travel is untested.
- **New rosters at LAN** (tested, kept). A new lineage's rating doesn't carry over to LAN at face value. Where Valve ranks one side and not the other, Elo overrated a new unranked side at LAN by about 0.06 of win probability in both 2024–25 and 2026. `newLanOffset` (160 points, fading over 10 maps) gains +0.0016 on unranked 2026 series, with the gate flat (2026-11-24).
- **Stale cores** (resolved, no effect). The 2.3% miss (2026-11-21) was young lineages in the "no change in 100 maps" bin. Measured on 100+ map lineages after `debutOffset`, stale cores sit within noise in both years, and lineages that recently played many debuts aren't overrated (2026-11-24).
