# Player WAR

## Overview

Phase 6 of [spec.md](spec.md): wins above replacement, comparing each player with a replacement in the same role. Built so far: **CT positions** (item 1), **T roles** (item 2), **role validation** (item 3), **role baselines** (item 4), **expected duels** (item 5), **IGL tags** (item 6), **Wins Above Average & replacement hook** (item 7), and **bootstrap uncertainty & web publishing** (item 8). The code lives in `wp/` (`cs2wp positions`, `cs2wp roles`, `cs2wp validate-roles`, `cs2wp baselines`, `cs2wp duels`, `cs2wp igls`, `cs2wp war`, `cs2wp validate-war`). The public site publishes provisional WAA rankings at `/war` (`public/data/war/players.json`).

## CT positions

`wp/src/cs2wp/positions.py`. For every map played, each player gets one CT position. It's their most common position 15–25 s after freeze end in their CT rounds, including overtime.

```
cd wp
uv run cs2wp positions --callouts   # labeling aid: data/war/reports/callouts.md
uv run cs2wp positions              # data/war/ct-positions.parquet + data/war/reports/ct-positions.md
```

**The table.** `data/war/ct-positions.json` (committed, hand-made) maps each nav-mesh callout (`ticks.last_place_name`) to a per-map position, or to `null` for callouts that don't vote (CT spawn, transit areas, rare T-side spots). A callout missing from the table fails the run with its sample count, so a map update or rework can't silently drop votes. Positions:

| Map | Positions |
| --- | --- |
| Mirage | A, Connector, Mid (window), Short, B |
| Dust2 | Long, Short, Mid, B |
| Inferno | A, Apartments, Mid (top mid and arch), Banana, B |
| Ancient | A, Donut, Mid, Cave, B |
| Nuke | Outside, A, Heaven, Ramp, B |
| Overpass | A Long, A Short, Connector, B Short, B |
| Anubis | A, Mid, Connector, B |
| Cache | A, Mid, Checkers, B |
| Train | A, B (one map so far) |

The ambiguous callouts were decided from the labeling report, which lists each callout's centroid and the callouts the same player also stands in during the same window:

- Mirage `CTSpawn` is null. The window AWP stands there 76% of the rounds they're in window, so it's rotation, not a position.
- Nuke B anchors stand in `Tunnels` and `Observation`, not `BombsiteB` (0.7% of samples).
- Dust2 `UnderA` and `BombsiteA` are null. They split between long and short players.

**Assignment.** Alive CT samples (`side == 3`, `health > 0`) in the window, with `start_tick` standing in for a missing `freeze_end_tick`:

1. Callouts become positions first. Raw callouts are too fine to vote on: a player's top raw callout covers only 41% of their samples (median).
2. Each round votes once, for the position the player stood in most. Rounds with no voting sample don't count.
3. The map's position is the one with the most round votes. Ties go to the position with more raw samples.

Output columns: `key`, `date`, `map`, `lp_team`, `lp_player`, `steamid`, `position`, `share` (modal position's share of round votes), `rounds_voted`, `rounds_ct`, `votes` (every position's round count).

**Players are assigned independently.** Teams double positions often, and most doubles can't be split by callout: both players stand in the same nav area (two CTs in `BombsiteA` on Nuke 78% of the time, two in `BombsiteB` on Dust2 89%). Splitting Inferno arch from top mid and Ancient alley from B site was tried and rejected. One player often covers both areas in the window, so median share fell (Inferno 0.57 → 0.54, Ancient 0.57 → 0.50) and so did stability (0.69 → 0.66 and 0.70 → 0.66). Separating two players in one area would need positions within the area (x, y clustering), which isn't built.

**Results (2026-11-05, 1,312 maps, 13,120 player-maps).** Stability is the mean share of a player's maps (5+ on that map) at their most common position.

| Map | Maps | Median share | Stability | Most common setup |
| --- | --- | --- | --- | --- |
| Mirage | 268 | 0.60 | 0.76 | A / A / B / Connector / Short (28%) |
| Dust2 | 263 | 0.64 | 0.73 | B / B / Long / Long / Short (17%) |
| Inferno | 192 | 0.57 | 0.69 | A / A / B / Banana / Mid (10%) |
| Ancient | 181 | 0.57 | 0.70 | A / B / B / Cave / Mid (15%) |
| Nuke | 175 | 0.67 | 0.83 | A / A / Outside / Outside / Ramp (40%) |
| Overpass | 89 | 0.74 | 0.89 | A Long / A Long / B / B / B Short (49%) |
| Anubis | 87 | 0.70 | 0.79 | A / B / B / Mid / Mid (31%) |
| Cache | 56 | 0.62 | 0.83 | A / A / B / B / Mid (32%) |

Inferno and Ancient sit below the 0.6 median-share target. Their setups vary the most, and the CT window is fluid there.

Spot checks agree with known roles: donk and KSCERATO on Mirage connector, ropz on Mirage short, Nuke ramp and Dust2 B, ZywOo outside on Nuke. AWPers land on Mirage A more than window, which fits window players falling back toward CT spawn and A. See [Role validation](#role-validation) for the check against NER0cs's labels.

## T roles

`wp/src/cs2wp/roles.py`. For every map played, each player gets an entry share, an AWP share and a T role.

```
cd wp
uv run cs2wp roles   # data/war/t-roles.parquet + data/war/reports/t-roles.md
```

**Entry share** is the share of a player's T rounds where they're in the round's opening duel, counting opening kills and opening deaths. The opening duel is the first kill between opponents after freeze end; team kills, world and bomb deaths are skipped. Shares across a team sum to about 1.

**AWP share** is the share of buy rounds where the player has the AWP in hand while alive during buy time (the 20 s after freeze end). A buy round is one where the team's equipment value after buy time is at least 20,000, where team totals split cleanly between full buys and the rest. The window was chosen on 150 maps:

- Freeze time is excluded. Drops put the AWP in two players' hands, so 12% of T buy rounds showed two AWPs. In the buy-time window it's 1%.
- Later pickups are excluded. Counting the whole round adds 15% more AWP rounds, mostly players grabbing a dead teammate's AWP.

Both sides count toward `awp_share`, since the AWPer role carries across halves. `t_awp_share` is the T side alone. T sides hold an AWP in about half their buy rounds and CT sides in about 70%.

**T role**, per team per map: the player with the top AWP share is the AWPer if it's at least 0.3. Of the rest, the one with the top entry share is the Entry, and everyone else is a Rifler. A team's top AWP share clears 0.3 on 93% of team-maps, and the second-highest stays under it on 99%. Lurker and support aren't separated yet; the spec defines only the two shares.

Output columns: `key`, `date`, `map`, `lp_team`, `lp_player`, `steamid`, `t_role`, `entry_share`, `opening_kills`, `opening_deaths`, `t_rounds`, `awp_share`, `t_awp_share`, `t_awp_rounds`, `t_buy_rounds`, `ct_awp_rounds`, `ct_buy_rounds`.

**Results (2026-11-05, 1,312 maps, 13,121 player-maps).** Reliability is the correlation of a player's per-map share with their pooled share on their other maps (players with 10+ maps).

| Map | Maps | Team-maps with an AWPer | Median entry share: Entry / Rifler / AWPer | Entry reliability | AWP reliability |
| --- | --- | --- | --- | --- | --- |
| Mirage | 268 | 96% | 0.38 / 0.17 / 0.12 | 0.42 | 0.95 |
| Dust2 | 263 | 99% | 0.33 / 0.17 / 0.17 | 0.35 | 0.97 |
| Inferno | 192 | 87% | 0.42 / 0.17 / 0.08 | 0.45 | 0.92 |
| Ancient | 181 | 92% | 0.40 / 0.17 / 0.10 | 0.50 | 0.94 |
| Nuke | 175 | 91% | 0.40 / 0.17 / 0.10 | 0.41 | 0.93 |
| Overpass | 89 | 98% | 0.40 / 0.17 / 0.11 | 0.41 | 0.97 |
| Anubis | 87 | 95% | 0.38 / 0.17 / 0.17 | 0.41 | 0.96 |
| Cache | 56 | 94% | 0.40 / 0.17 / 0.17 | 0.76 | 0.85 |
| All | 1,312 | 94% | 0.40 / 0.17 / 0.12 | 0.38 | 0.94 |

**AWP share is reliable per map, and entry share isn't.** With about 12 T rounds a map, a player's entry share on one map correlates only 0.38 with their other maps. Players whose usual role is Entry get the label on 63% of their maps (base rate 20%); usual AWPers get AWPer on 94%. Role baselines (item 4) should pool entry share over a player's recent maps rather than trust one map's label. Also counting the first damage between opponents raised per-map reliability only to 0.42, so the spec's opening-duel definition stays.

Pooled over all maps, the ranking matches known roles. Highest entry share among riflers: YEKINDAR 0.35, donk 0.34, Makazze 0.33, FlameZ 0.32, XANTARES 0.30. Lowest: yuurih 0.12, ropz 0.14, both known lurkers. ZywOo, sh1ro, m0NESY and broky are AWPers on 85–98% of their maps. See [Role validation](#role-validation) for the check against NER0cs's labels.

## Role validation

`wp/src/cs2wp/rolecheck.py`. Pools each player's T roles and CT positions over their maps (10+ maps) and compares them with Harry Richards' (NER0cs) role labels.

```
cd wp
uv run cs2wp validate-roles   # data/war/reports/role-validation.md
```

**Source.** NER0cs's Positions Database is a Tableau Public viz with no download or API, so the labels come from the CS2 Playstyle & Roles Dataset (2024) by Jamie Packer, which carries them per SteamID: `role_t` (AWPer, Spacetaker, Half-Lurker, Lurker) and `role_ct` (AWPer, Anchor, Mixed, Rotator). It's vendored at `data/war/external/cs2-playstyle-roles-2024.csv`, from [GitHub](https://github.com/Jamie-Packer/cs2-playstyle-dataset-2024) commit `3b398f2` (CC BY 4.0). Of its 306 players, 188 have role labels. 120 of those have 10+ maps in our mirror for T, and 120 for CT.

The labels are from 2024 and our maps run Nov 2025 to Oct 2026, so real role changes show up as disagreements.

**Results (2026-11-05).**

| NER0cs T role | Players | Entry share | Maps as Entry | AWP share | Maps as AWPer |
| --- | --- | --- | --- | --- | --- |
| AWPer | 24 | 0.14 | 0% | 0.64 | 96% |
| Spacetaker | 48 | 0.23 | 31% | 0.00 | 0% |
| Half-Lurker | 12 | 0.21 | 19% | 0.00 | 0% |
| Lurker | 36 | 0.18 | 16% | 0.00 | 0% |

- **AWPer agrees on 117 of 120 players** (ours: AWPer on more than half their maps). The three disagreements are role changes since 2024: FalleN no longer AWPs (0.06 share over 165 maps), and Stavn (14 maps) and Yxngstxr (28 maps) now hold the AWP.
- **Pooled entry share orders the rifler roles correctly:** Spacetaker > Half-Lurker > Lurker. Spacetaker beats Lurker with AUC 0.77. Across years it correlates 0.73 with the dataset's own 2024 opening-attempt rate, which is the same measure.
- **CT: share of maps at A or B separates Anchors from Rotators** (median 0.60 vs 0.42, AUC 0.77). Mixed sits with Anchors (0.59), so a site-vs-rest split can't tell them apart.

Per-map labels stay noisy for Entry (spacetakers get Entry on only 31% of maps), which is why item 4 should use pooled entry share.

Displaying positions or roles on the site needs Liquipedia attribution beside them (`lp_player`, `lp_team`). The validation report also credits NER0cs and the Playstyle Dataset (CC BY 4.0); any public use of those labels needs the same line: "Role labels: Harry Richards (NER0cs) Positions Database, via the CS2 Playstyle & Roles Dataset (2024) by Jamie Packer, CC BY 4.0."

## Role baselines

`wp/src/cs2wp/baselines.py`. Computes the average credit per round for each map, side and role, partially pooled, for all three credit versions (`wpa`, `nwpa_event`, `nwpa_mancount`).

```
cd wp
uv run cs2wp baselines   # data/war/role-baselines.parquet, data/war/role-rounds.parquet, data/war/reports/role-baselines.md
```

**Inputs.** The source tables are the credit files from `cs2wp credit` and each map's `roster.parquet` (who played each round, on which side), plus T roles and CT positions.

- A player-map-side's credit is its rounds' summed credit. Rounds without any credit count as zeros.
- Mean credit per round isn't zero (CT 0.013, T 0.005), because the trade return, flash split and uncredited movement make credit non-zero-sum. So baselines are per side, never an assumed 0.

**Roles.**

- **T AWPer:** the per-map AWPer from [T roles](#t-roles). AWP share is fixed at buy time and doesn't depend on the outcome.
- **T Entry:** the team's non-AWPer with the highest entry share over their *other* maps. Below 5 other maps it falls back to that map's share, and `role_source` records which one was used. The map's own label leaks the outcome, since opening deaths count toward it: riflers outscore Entries by 0.0063 WPA/round under per-map labels, but only 0.0020 under leave-one-out labels.
- **T Rifler:** the rest of the T side.
- **CT AWPer:** the team's AWPer on that map. They average 0.026 WPA/round, against 0.010 for CT riflers, so leaving them inside positions would skew every position by its AWPer mix. NER0cs's CT labels make the same split.
- **CT, everyone else:** their CT position.

**Pooling.** Each cell shrinks toward a parent: baseline = w·raw + (1 − w)·parent, where w = n / (n + k), n is the cell's rounds, and k = σ²/τ².

- σ² is the per-round variance around the cell mean, measured on player-map-sides. It comes out at SD 0.209, close to the per-round 0.205, so rounds within a map are close to independent.
- τ² is the method-of-moments spread of true cell rates around their parents, with a floor.
- Parents:
  - T roles and the CT AWPer: the role's all-map mean on that side.
  - CT positions, which only exist on their own map: the map's CT non-AWPer mean, which shrinks toward the all-map one first.

**Results (2026-11-05, dry-run credits).** k is the number of rounds at which a cell gets half its weight from its own data. A big map's T roles and CT AWPer keep 0.65–0.90 of their own value. Positions mostly keep 0.15–0.55, so most of a position's baseline is its map's CT mean.

| Level | k (wpa) | k (nwpa_event) | k (nwpa_mancount) |
| --- | --- | --- | --- |
| T role | 1,843 | 1,980 | 2,327 |
| CT AWPer | 752 | 3,094 | 3,213 |
| CT map | 2,049 | 2,006 | 2,622 |
| CT position | 7,571 | 2,150 | 4,180 |

- **One tournament can't dominate.** Dropping any one of the 23 events moves a shrunk wpa cell by at most 0.0041, against 0.0455 raw, and no shrunk move exceeds one SE.
- **Split-half stability:** cell baselines fit before and after the median date correlate 0.82 shrunk, against 0.11 raw. Tiny cells like Train, Nuke B and Overpass A Short swing the raw value.
- Every player-map-side gets a role.

The per-cell table is in the report. `role-rounds.parquet` has one row per player-map-side, with `role`, `role_source`, the credit sums and `<version>_above` = credit − baseline · rounds. That's the input for the later items, not WAR itself.

The credits are from a dry-run model (the Phase 5 gate hasn't run), so rerun `cs2wp baselines` after the real `cs2wp credit`.

## Expected duels

`wp/src/cs2wp/duels.py`. Gives every gun kill between opponents a probability that the killer wins it, from both players' state before the fight. Kills above expected is wins minus that probability, summed over a player's duels (losses count as 0 − p).

```
cd wp
uv run cs2wp duels [--ablations]   # data/war/duels.parquet, data/war/duel-sides.parquet, data/war/reports/duels.md
```

It reads only the demo tables plus `role-rounds.parquet` for roles, so it doesn't wait on the Phase 5 gate. The build takes about 1.5 min, or 4 min with ablations.

**Duels.** One duel per kill whose weapon is a gun: grenade, fire, knife and world kills are dropped, and so are teamkills. Damage exchanged without a death isn't a duel. The duel starts at the first damage between the two players in the 3 s before the kill, or at the kill itself. Each player's state comes from the last 4 Hz tick before that start, so damage from the duel itself never feeds its own prediction.

| Input | Per player | Source |
| --- | --- | --- |
| Weapon | Class of the last gun in hand this round (AWP, Rifle, Cheap rifle, SMG, Pistol, Deagle, Scout, Auto, Heavy) | `ticks.active_weapon`, forward-filled so a knife or grenade in hand keeps the gun |
| Peeker vs holder | Top speed over the second before the start | `ticks.velocity`. Peekers counter-strafe before shooting, so speed at the shot reads near 0 for both |
| Flashed | Any flash blindness overlapping start → kill | `flashes` (tick + duration) |
| HP | Health, armor and helmet | `ticks` |
| Distance | Between the two at the kill (one value per duel) | `kills` coordinates |
| Side | Whether the player is CT | `kills` |

The killer's weapon is read from ticks the same way as the victim's, not from the kill row, so the killer's input carries no information about who fired last. It matches the kill weapon's class on 99.8% of duels.

**Model.** XGBoost (depth 4, learning rate 0.05, early-stopped tree count). Each duel goes in twice, once from each player's side, and predictions average the two (p and 1 − p of the swap). So P(A beats B) = 1 − P(B beats A) exactly, and nothing in the inputs says who won. HP and blindness are monotone. Predictions are out of fold: 5 folds of whole events, so no tournament predicts its own duels.

**Results (2026-11-13).** There are 437,356 duels on 3,123 maps from 55 events. Scores count each duel from both sides.

| Inputs | Trees | Log loss | AUC | Max bin gap | Slope |
| --- | --- | --- | --- | --- | --- |
| None (0.5) | - | 0.6931 | 0.500 | - | - |
| All | 1311 | 0.6050 | 0.726 | 0.011 | 0.995 |
| All + smoke support (experiment) | 1311 | 0.6049 | 0.726 | 0.011 | 0.995 |
| Weapons only | 647 | 0.6626 | 0.627 | 0.032 | 1.000 |

Single-group ablations on the earlier 1,312-map build (2026-11-05, `All` 0.5988) ordered feature importance as HP and armor (0.6360 without), peeker vs holder (0.6125), weapons (0.6125), distance (0.6049), flashed (0.6012), and side (0.5998).

What each input is worth: the average change in the killer's P(win) when one input is switched in every duel, from a model fit on all duels.

| Switch, for the attacker in every duel | Change in P(win) |
| --- | --- |
| Holding (speed 0) instead of moving at 250 | +0.251 |
| Not flashed instead of flashed | +0.083 |
| 100 HP instead of 50 | +0.190 |
| Rifle instead of Pistol | +0.167 |
| AWP instead of Rifle | −0.005 |
| AWP instead of Rifle, holding | +0.160 |
| AWP instead of Rifle, holding, duels at 1,500+ units | +0.288 |

An AWP is only an edge when it's held still, and the edge grows with range. Moving with one, or using it up close, loses to a rifle.

**Kills above expected separates AWP volume from entry difficulty.** Raw duel win rate differs by role, and the model explains nearly all of it:

| Side | Role | Player-map-sides | Duels per round | Win rate | Expected | Above per 100 duels | Above per 100 rounds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CT | AWPer | 5,746 | 1.30 | 0.583 | 0.582 | +0.05 | +0.07 |
| CT | Position | 25,472 | 1.29 | 0.530 | 0.530 | −0.01 | −0.01 |
| T | AWPer | 5,746 | 1.27 | 0.497 | 0.494 | +0.31 | +0.40 |
| T | Entry | 6,244 | 1.36 | 0.459 | 0.451 | +0.79 | +1.07 |
| T | Rifler | 19,230 | 1.28 | 0.450 | 0.454 | −0.37 | −0.47 |

- AWPers win more duels because they hold long angles, not because they're above average at them. Entries lose more because they peek first.
- Across the 288 players with 300+ duels, win rate correlates 0.76 with expected rate. Taking the expectation out cuts the spread between players from SD 0.032 to 0.021.
- **Month to month** (1,778 player-month pairs, 40+ duels each): win rate 0.45, expected rate 0.62, kills above expected per duel 0.31. Situations are a stable trait of a player's role, so raw win rate looks more stable than the skill left after removing them. On a month of duels alone, kills above expected sits under the 0.40 the WAR gate asks for, so WAR needs more than duels.
- **Smoke support (experiment): reject.** A teammate's smoke within 800 units of either player, popped in the 5 s before the duel, appears on 7.4% of winners' and 7.6% of losers' sides. Adding `x_smoke`/`y_smoke` gives a per-duel log-loss gain of +0.00003 (90% CI −0.00001, +0.00008, resampling whole events), so smoke support stays out of `FEATURES`.
- **Teammates' flashes on the opponent:** present on 6.5% of winners' and 5.6% of losers' sides; worth 4,504 kills over all duels (0.67 per 100 player-rounds), stored per player-map-side as `flash_gift` (the summed rise in `P(win)` from the opponent being blind from a teammate's flash).

`duels.parquet` has one row per duel with every input, support flags, `p` (attacker win probability) and `fold`. `duel-sides.parquet` has one row per player-map-side from `role-rounds.parquet`, with `duels`, `wins`, `expected`, `kills_above`, and `flash_gift`.

## IGL tags

`wp/src/cs2wp/igls.py`. Tags the in-game leader for each team-map in `role-rounds.parquet`.

```
cd wp
uv run cs2wp igls   # data/war/igls.parquet + data/war/reports/igls.md
```

**The table.** `data/war/igls.json` maps each `lp_team` to a list of caller stints (`player`, optional ISO `from` and `to` date bounds). Covering all 61 teams in the archive:

- Single-caller rosters take one entry without dates (e.g. `apEX` for Team Vitality, `Aleksib` for Natus Vincere, `FalleN` for FURIA).
- Mid-season transitions take bounded stints (e.g. FaZe: `Karrigan` through 2026-03-20, `Twistzz` from 2026-03-21; Falcons: `Kyxsan` through 2026-04-19, `Karrigan` from 2026-04-20; MOUZ: `Brollan` with a May stand-in stint by `XertioN` before permanently taking over on 2026-06-15).
- If a roster has no active caller in the table for a date, the team-map is marked as having no IGL (genuine stand-in series: Legacy, G2, GamerLegion, NiP stand-in runs).
- If multiple callers match on a single date, or a team is entirely unmapped, the build fails immediately.

**Offline Liquipedia signals audit.** The build evaluates `data/raw/squads.json` and `data/raw/players.json` without making API calls:

- `squads.json` (`role == "Captain"`): covers 2,041/2,624 (77.8%) team-maps with one Captain; 1,960 match the stint IGL, while 81 are misattributed due to lagged squad role updates during caller swaps.
- `players.json` (`extradata.roles` with `igl`): covers 1,917/2,624 (73.1%) with one IGL, but collides on 237 team-maps where two career IGLs share a lineup (e.g. electroNic + Magisk, arT + lux, Snax + ztr).
- `data/war/igls.json` achieves 2,595/2,624 (98.9%) team-map tagging with zero collisions.

**Raw IGL deficit.** Before adjustment, IGLs average `-0.75` WPA per 100 rounds below their role baseline (CT `-0.83`, T `-0.67`), while non-IGLs average `+0.20` because IGLs pull down the shared role baselines:

| Side | Group | Rounds | WPA / 100 rds | Neutral (man-count) / 100 | Neutral (event) / 100 |
| --- | --- | --- | --- | --- | --- |
| CT | IGL | 27,917 | -0.83 | -0.68 | -0.55 |
| CT | Non-IGL | 113,163 | +0.20 | +0.18 | +0.15 |
| T | IGL | 27,910 | -0.67 | -0.61 | -0.67 |
| T | Non-IGL | 113,170 | +0.20 | +0.17 | +0.19 |

## Wins Above Average and IGL adjustment

`wp/src/cs2wp/war.py`. Centers IGLs at league average, computes map-win conversion, resamples bootstrap intervals, and exports public rankings.

```
cd wp
uv run cs2wp war --model dryrun-regularized --publish --allow-ungated
# data/war/player-war.parquet + data/war/reports/war.md + public/data/war/players.json
```

**Positional adjustment.** To eliminate the IGL deficit without distorting individual variation, we compute:

$$\delta_{s,g} = -\frac{\sum_{i \in (s,g)} \text{above}_i}{\sum_{i \in (s,g)} \text{rounds}_i}$$

for each `(side, is_igl)` cell. Adding $\delta_{s,g}$ to each player's round-wins above role baseline shifts CT IGLs by `+0.83`, CT non-IGLs by `-0.20`, T IGLs by `+0.67`, and T non-IGLs by `-0.20` round-wins per 100 rounds.

Post-adjustment verification:
- IGL mean: `0.0000` / 100 rounds.
- League mean: `0.0000` / 100 rounds.
- Individual IGL variation is preserved: fragging callers score positive (huNter- `+6.10` WAA, xertioN `+5.62`, Jame `+4.80`, Twistzz `+3.96`), while low-fragging tactical callers score negative (apEX `-2.47`, FalleN `-2.51`, karrigan `-12.04`).

**Map-win conversion factor.** OLS regression of map outcome ($0/1$) on team summed round-wins above average ($wpa\_rw$) across 1,312 maps yields $5.38$ round-wins per map win (comparing to analytical MR12 coin-flip benchmark of $4.46$).

**Replacement-level hook.** The CLI supports `--replacement-rate <float>`. Specifying a non-zero rate shifts `<version>_rw` by $(\text{rate} \times \text{rounds})$ linearly, switching the metric label from `WAA` to `WAR` without recomputing baselines or re-running credits.

## Uncertainty (round-level bootstrap)

For each player, played rounds are resampled with replacement using multinomial weights (1,000 resamples, seeded):

$$\mathbf{w} \sim \text{Multinomial}(N_r, \mathbf{1}/N_r)$$

For each resample, the mean round-win above average is scaled to cumulative map wins ($N_r \cdot \bar{x} / r_{\text{win}}$) and per-100-round rate ($100 \cdot \bar{x}$). We extract the 5th, 50th, and 95th percentiles to form a 90% confidence interval `(p5, p95)` displayed alongside every point estimate on the web UI.

## Validation diagnostics

Measured on qualified players (300+ rounds across 23 events):

| Metric | M2M r (100+ rds) | M2M r (200+ rds) | M2M r (300+ rds) | Split-half r (SB) | r with K/D |
| --- | --- | --- | --- | --- | --- |
| WAA (WPA) | 0.214 (598) | 0.363 (297) | 0.548 (104) | 0.210 (0.347) | 0.498 |
| WAA (neutral man-count) | 0.286 (598) | 0.394 (297) | 0.523 (104) | 0.243 (0.391) | 0.633 |
| WAA (neutral event) | 0.325 (598) | 0.389 (297) | 0.448 (104) | 0.262 (0.415) | 0.700 |
| Raw WPA / round | 0.435 (598) | 0.591 (297) | 0.728 (104) | 0.467 (0.637) | n/a |
| Kills above expected / round | 0.402 (598) | 0.509 (297) | 0.608 (104) | 0.384 (0.555) | 0.737 |
| Rating 2.0 (approx) | 0.470 (598) | 0.591 (297) | 0.641 (104) | 0.480 (0.649) | 0.946 |
| HLTV Rating 3.0 | 0.455 (592) | 0.594 (295) | 0.697 (104) | 0.436 (0.607) | 0.880 |
| HLTV Swing | 0.432 (592) | 0.593 (295) | 0.700 (104) | 0.391 (0.562) | 0.886 |
| K/D | 0.516 (598) | 0.625 (297) | 0.675 (104) | 0.547 (0.707) | 1.000 |

- **K/D independence:** WAA (WPA) correlates only `0.498` with K/D, compared to `0.880` for HLTV Rating 3.0 and `0.946` for Rating 2.0. This confirms WPA measures game-state impact rather than box-score hunting.
- **Split-half stability:** Evaluated across alternating chronological series, so maps of one series stay in one half. WAA is the least stable metric in the table: half r 0.21 (Spearman-Brown 0.35), against 0.44 for HLTV 3.0 and 0.55 for K/D. See [WAR validation](#war-validation).

## WAR validation

`wp/src/cs2wp/warcheck.py`, `cs2wp validate-war [--test-from 2026-03-01]`, writes `data/war/reports/war-validation.md`. These checks don't need roster moves, so they run on the current archive. The roster-change test in [spec.md](spec.md) stays the deciding check. On the current archive it has about 13 usable moves, and the spec's power estimate needs 80–150.

**Split-half reliability.** Each player's series alternate into two halves (players with 300+ rounds). `k` = half rounds × (1 − r) / r is the number of rounds at which reliability reaches 0.5, so reliability at n rounds is n / (n + k). The same `k` sets the shrinkage in the prediction check.

**Does prior lineup WAR add to Elo?** For each test map, each player's rate uses only maps from before the map's event starts, shrunk toward the league mean by `k`. The feature is the difference in the two lineups' summed rates. A no-intercept logistic fit (team order is arbitrary) on the pre-map Elo logit plus that feature is scored by leave-one-event-out log loss against an Elo-only refit. A 90% interval on the gain comes from resampling whole series. HLTV 3.0 and K−D per round go through the same pipeline as comparators.

**Results (2026-11-06, dry-run credits, 1,312 maps).**

| Metric | Half r | k (rounds) | Rel. at 3,000 rds | Alone | Gain over Elo (90% CI) | r with Elo |
| --- | --- | --- | --- | --- | --- | --- |
| WAA (WPA) | 0.210 | 2,193 | 0.58 | 0.6899 | −0.0002 (−0.0019, +0.0016) | 0.36 |
| WAA (neutral event) | 0.262 | 1,641 | 0.65 | 0.6613 | −0.0009 (−0.0027, +0.0007) | 0.70 |
| WAA (neutral man-count) | 0.243 | 1,813 | 0.62 | 0.6639 | −0.0010 (−0.0021, +0.0000) | 0.70 |
| HLTV Rating 3.0 | 0.436 | 754 | 0.80 | 0.6632 | −0.0012 (−0.0030, +0.0005) | 0.69 |
| K−D / round | 0.519 | 540 | 0.85 | 0.6580 | −0.0009 (−0.0036, +0.0017) | 0.72 |

Test set: 1,064 maps (474 series, 19 events) from 2026-03-01. 88% of player slots have 100+ prior rounds. Elo log loss is 0.6388 as published and 0.6394 refit.

- **Nothing adds to Elo yet, including the box-score comparators.** Every interval covers zero. Over this window, Elo already carries what a lineup's past individual output says about the next map.
- **WAA needs 2–4× the rounds of box-score stats to be equally reliable.** At 3,000 rounds (about a season of tier-1 maps) WPA WAA reaches 0.58, while K−D reaches 0.85. Shrink accordingly. A player at 1,000 rounds keeps only about a third of their raw WAA.
- **WPA WAA is barely predictive on its own** (0.690, against 0.693 for a coin flip) and correlates only 0.36 with Elo, while the neutral versions sit with the box scores (0.66, r 0.70). The likely cause is that the WP model takes pre-map Elo as a feature (`elo_diff_ct`), so WPA credits play above what Elo already expects. The team-context check below supports this. The neutral versions predict better, so they're the better candidates for seeding.
- Leakage that remains: role baselines, the IGL adjustment and `k` are fit on the full archive, and the dry-run WP model was trained on some of these maps. All of it should favour WAR, so it doesn't explain the null result.

**Team-context leakage.** Units are player-team stints with 300+ rounds (188). Two checks:

- **Within-team ranks as form changes.** A player's within-team rate is their rate minus their team's rate on the same maps. Each stint is split three ways: alternating series, team pre-map Elo above or below the stint's median, and maps won or lost. Each half needs 100+ rounds. If credit moves between teammates with results, `k` under the form splits rises well above `k` under alternating series.
- **Team strength in player rates.** For each metric, three measures:
  - the correlation of stint rates with mean team Elo
  - the team share, 1 − var(within-team rate) / var(stint rate). Independent noise across five players gives about 0.2.
  - how concentrated the top 20 players are by team, using whole-archive shrunk rates and each player's main team

| Metric | Within-team k: alternating | Elo split | Won/lost | r with team Elo | Team share | Top 20: teams (most from one) |
| --- | --- | --- | --- | --- | --- | --- |
| WAA (WPA) | 1,025 | 1,482 | 1,506 | 0.13 | 0.08 | 17 (2) |
| WAA (neutral event) | 598 | 671 | 761 | 0.61 | 0.46 | 11 (5, Vitality) |
| WAA (neutral man-count) | 851 | 933 | 1,125 | 0.51 | 0.30 | 11 (4, Vitality) |
| HLTV Rating 3.0 | 386 | 476 | 513 | 0.38 | 0.22 | 13 (3, Vitality) |
| K−D / round | 221 | 269 | 332 | 0.42 | 0.26 | 13 (2) |

- **Within-team ranks hold about as well as box scores do.** Under the form splits, `k` rises by 1.1–1.5×, and K−D rises by the same 1.5×. Some rise is expected, since alternating halves have the closest mix of opponents. There's no sign that WAA moves credit between teammates when results change.
- **Neutral-event WAA carries team strength.** Its team share (0.46) is about double that of the box scores, and all five Vitality players are in its top 20. That's the spec's red flag. Man-count is in between. Box scores also lean toward strong teams (0.22–0.26, against 0.2 for noise), so some of this is real talent clustering, but neutral-event WAA has about twice as much.
- **WPA WAA leans the other way.** A team share of 0.08 is below the noise level, so teammates' WPA is negatively correlated, and it barely tracks team Elo. Because the WP model already conditions on Elo, players on strong teams get little credit for wins Elo expected. That includes their own share of why the team is strong, so WPA probably under-credits stars on top teams.
- Neither extreme is right. The two follow-ups below test fixes for this.

**Follow-up 1: WPA with the player's own team at average Elo (`wpa_opp`, 2026-11-06).** The credit is defined in [win-probability.md](win-probability.md). It uses the same `dryrun-constant` model, and the other three versions came out byte-identical when rerun.

| Metric | Split-half k | Alone | Gain over Elo (90% CI) | Within-team k | Team share | r with team Elo | Top 20: teams (most from one) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WAA (WPA) | 2,193 | 0.6899 | −0.0002 (−0.0019, +0.0016) | 1,025 | 0.08 | 0.13 | 17 (2) |
| WAA (`wpa_opp`) | **1,156** | 0.6655 | −0.0010 (−0.0022, +0.0002) | 1,024 | 0.31 | 0.51 | 14 (3) |

- **Kept as a candidate.** `wpa_opp` is the most reliable WAA version: reliability at 1,000 rounds is 0.46, against 0.31 for WPA and 0.38 for neutral-event. Its team share sits with the box scores, between WPA's deficit and neutral-event's surplus. It predicts on its own about as well as the box scores do.
- Within-team k is unchanged. The fix moves credit between teams, not between teammates, so all of the reliability gain is in the team component.
- It still adds nothing to Elo.

**Follow-up 2: within-team deviation as the player part of a seed.** The proposal is a player rating = within-team deviation + 1/5 of the team's Elo strength, so a roster change moves Elo by incoming minus outgoing deviations. `validate-war` now also scores the lineup difference in prior within-team deviations, shrunk by the within-team `k`, as a feature added to Elo (the "Within-team" rows).

- **No signal yet, and the current data can't really test it.** For a stable roster the deviations cancel, so the feature is near zero. Over all 1,064 test maps every within-team gain is between −0.0012 and −0.0006.
- **The lineup-change subset is too small.** There are 265 maps (120 series) where some player had played most of their prior rounds for another team. There, every feature (within-team or not) has a negative cross-validated gain of −0.001 to −0.006. That's what one extra parameter with no detectable signal costs on about 120 series.
- This is the roster-change test by another name. It needs the 80–150 changes from the power estimate, not more tuning now.

Rerun after the Phase 5 gate (final credits) and after the 2025 backfill. If neutral WAA still adds nothing to Elo with a full season of prior data per player, WAR seeding is unlikely to beat Elo averaging in the roster-change test.

## Resources: usage and conversion

`wp/src/cs2wp/resources.py` and `usage.py`. A player's WAA ignores what the team gave them. This splits it so receiving resources is never penalized, only failing to use them:

```
above role baseline = context + usage + conversion        (exact, per player-round)
  context    = g(map, side, role, team equip, opponent equip, both buy types, pistol) − role baseline
  usage      = f(g's inputs + the player's own resources) − g
  conversion = credit − f
```

The middle term is three-way rather than two: a rich team's rounds are worth more to everyone on it, and that's the team's economy, not a player's share of it. Without `context`, every Vitality player would show high usage.

```
cd wp
uv run cs2wp usage --map 2396614/m1   # print one map's resource rows
uv run cs2wp usage --device cpu       # data/war/resource-rounds.parquet, usage-rounds.parquet, usage.parquet,
                                      # data/war/reports/usage.md
uv run cs2wp war --model production   # joins usage.parquet: <v>_context/usage/conversion_per100 with intervals
uv run cs2wp validate-war             # scores context, usage and conversion (wpa_opp) like the WAA versions
```

**Resources per player-round** (`resource-rounds.parquet`, 676,581 rows). Economy is read during the 20 s after freeze end, so it's known before the fight:

- equipment value, the team's and the opponent's, the player's share of their team's, and both buy types (`evaluate.py` thresholds)
- best gun class held, AWP, armor, helmet, kit, and the four utility counts
- the pistol-round flag

**Drops are inferred**, because the parser stores no item events. Net transfer = equipment gained − money spent from round start to freeze end. A drop received is a net of +$1,000 or more with a teammate at −$1,000 or less in the same round; a replaced pistol nets about −$200 and doesn't count.

| Drop check (all 3,112 maps) | Result |
| --- | --- |
| Net transfer exactly 0 | 51% of player-rounds |
| ≥ +$1,000 / ≤ −$1,000 | 11.6% / 12.0% |
| Receivers with a matching giver | **97.4%** of 78,234 (gate 80%) |
| Givers with a matching receiver | 90.4% of 80,937 |
| Team net per round within ±$500 | 72% (median $0) |

Drops pass, so `net_transfer` and `drop_received` are inputs to f.

**Support** (descriptive only, because it only exists if a fight happened). Each duel from [Expected duels](#expected-duels) gains, for both players:

- `flash_support`: the opponent was blind from a teammate's flash during the duel. Own flashes are counted apart (`self_flash`), and enemy team-flashes count for neither.
- `smoke_support`: a teammate's smoke popped in the 5 s before the duel, within 800 units of either player.

`kills.victim_traded` gives traded deaths.

**Smoke throwers are inferred.** awpy's `grenades` table has a full trajectory per grenade, but `thrower_steamid` is null on every row. The thrower is the player within 300 units of the trajectory's first point whose `smoke_grenades` count drops across it. The count lags the projectile by up to two 4 Hz snapshots, so the "after" read is 0.5 s later. That attributes 95.3% of 441,707 smokes. The landing point is the trajectory's last point.

**Expected credit.** Two XGBoost regressors per credit version (depth 4, learning rate 0.1, squared error, early-stopped), g on the team inputs and f on those plus the player's own. f is monotone increasing in equipment value. Zero-credit rounds count, as in the role baselines. Folds are whole players (5, balanced by rounds), so no player's expectation is fit on their own rounds. That makes it a replacement-style baseline, not the player's own. The baseline is the average tier-1 player in that role until tier-2 demos define replacement level. The IGL adjustment lands in conversion.

**Results (2026-11-13, `production` credits, 3,112 maps, 674,310 player-rounds).**

- **Identity.** context + usage + conversion = credit above baseline to 2e-16 per round in all four versions, and to 9e-16 per player-map-side against `<v>_rw` once the IGL adjustment is included. The 60 player-rounds without resources keep missing inputs rather than being dropped, so the split stays exact.
- **Resources barely predict a single round.** RMSE for `wpa_opp` is 0.20818 for the role baseline, 0.20810 for g and 0.20788 for f. Per-round credit is mostly noise, so this is expected. The useful check is calibration: by gun class (every class with 500+ rounds), mean f tracks mean credit within 0.1 per 100 rounds, while g misses SMG rounds by 1.24, Pistol by 0.38 and AWP by 0.63.

| What f says a resource is worth (`wpa_opp`, per 100 rounds) | Change |
| --- | --- |
| Rifle instead of SMG, force-buy SMG rounds | +1.20 |
| AWP instead of rifle, full-buy rifle rounds | +0.18 |
| +$1,000 own equipment, full buys | +0.09 |
| Two more flashes, full buys | 0.00 |
| Drop received (+$1,500), force and full buys | −0.03 |
| Kit, CT full buys | −0.30 |

The AWP is worth little here because g already includes the role: an AWPer is expected to have one. The kit's negative value is selection, since kits go to the players expected to retake last. f is descriptive, not causal.

| Metric (`wpa_opp`, with the IGL adjustment) | Split-half k | Within-team k (alt. / Elo / won-lost) | Team share | r with team Elo | Gain over Elo (90% CI) |
| --- | --- | --- | --- | --- | --- |
| WAA | 984 | 1,102 / 1,118 / 1,104 | 0.26 | 0.45 | −0.0004 (−0.0027, +0.0018) |
| Context | 235 | 139 / 155 / 236 | 0.20 | 0.05 | −0.0007 (−0.0017, +0.0004) |
| Usage | **94** | 87 / 97 / 113 | 0.04 | −0.07 | −0.0006 (−0.0015, +0.0002) |
| Conversion | **1,042** | 1,230 / 1,252 / 1,221 | 0.28 | 0.46 | −0.0005 (−0.0026, +0.0017) |

- **Site gate passed.** Conversion's `k` (1,042) is within 2× WAA's (984), so it shipped. Usage and context are role and team-economy traits, stable within 100–250 rounds.
- **Team strength sits in conversion, not context.** The plan expected context to carry the team, but `wpa_opp` already prices the own team at average Elo, and economy alone barely tracks team Elo (r 0.05). Conversion has WAA's team share (0.28 vs 0.26). Within-team ranks hold under the form splits, so there's no sign of credit moving between teammates.
- **Usage vs conversion.** Within each T role they correlate positively (AWPer +0.21, Entry +0.46, Rifler +0.26), the opposite of basketball's tradeoff: here the best players also get the most. Kept as a hypothesis to watch, as the spec says.
- **Sense checks read right.** Top conversion: donk, ZywOo, SYPH0, m0NESY, KSCERATO, mizu, latto, HeavyGod. The biggest rises from WAA rank to conversion rank are support players and callers (HObbit +50 places, Kyxsan, mopoz, woxic, Boombl4, electroNic), and the biggest falls are high-usage riflers (Kvem, sausol, XANTARES, decenty, FL1T). High usage with negative conversion: lucaozy, bymas, dukefissura, kl1m, Sk0R.
- **Not met:** "AWPers top usage". AWPers average +0.02, everyone else −0.01, because f's AWP premium over an AWPer's expectation is small (above). Usage measures resources beyond what the role normally gets.
- Player means of conversion are about −0.35 unweighted, but +0.08 weighted by rounds. Players with fewer rounds tend to be below average.

**Duel support check (GPU run, 2026-11-13).** `cs2wp duels` added the support columns to `duels.parquet`, `flash_gift` to `duel-sides.parquet` (worth 4,504 kills over all duels, 0.67 per 100 player-rounds), and ran the smoke-support experiment, which was **rejected** (+0.00003 log-loss gain, 90% CI −0.00001 to +0.00008; see [Expected duels](#expected-duels)). `cs2wp war --model production --publish` published `flashGift` to `/war` (`public/data/war/players.json`).

## Public interface (`/war`)

The React application renders the live WAA leaderboards at route `/war`:
- Reads `public/data/war/players.json` with TanStack Query.
- Displays 90% bootstrap intervals next to every map win and rate value, accompanied by a visual interval bar (`aria-hidden="true"`).
- Role filters (`All`, `AWP`, `Entry`, `Rifle`, `IGL`) and credit toggles: `WPA (team-neutral)` (`wpa_opp`, the default since 2026-11-06 because it's the most reliable version and has no team-strength bias in either direction; see [WAR validation](#war-validation)), `WPA (raw)` (`?credit=wpa`), `Neutral man-count` and `Neutral event`.
- Usage and Conversion columns (per 100 rounds, 90% intervals) that follow the credit toggle.
- Expandable player details showing CT map callouts, duel counts, kills above expected, context / usage / conversion with their sum, the resource detail (equipment share by buy type, AWP rounds, drops received and given, duels with team flash or smoke, deaths traded), and backlinks to Liquipedia player/team pages.
- Provisional banner noting the 2026 dry-run credit source pending Phase 5 demo backfill completion.
- Full CC-BY-SA Liquipedia and HLTV demo attribution.
