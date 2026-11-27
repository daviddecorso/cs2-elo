# Player WAR

## Overview

Phase 6 of [spec.md](spec.md): wins above replacement, comparing each player with a replacement in the same role. Built so far: **CT positions** (item 1), **T roles** (item 2), **role validation** (item 3), **role baselines** (item 4), **expected duels** (item 5), **IGL tags** (item 6), **Wins Above Average & replacement hook** (item 7), **bootstrap uncertainty & web publishing** (item 8), **team factor & APM** (`cs2wp team-factor`, gated off-site), and the Phase 7 team stats: **duel execution and quality** (`cs2wp duel-stats`), **team round stats** (`cs2wp team-stats`), **tactics stats** (`cs2wp tactics`), **T-side predictability** (`cs2wp predictability`) and **clutch and man-advantage conversion** (`cs2wp clutch`). The code lives in `wp/` (`cs2wp positions`, `cs2wp roles`, `cs2wp validate-roles`, `cs2wp baselines`, `cs2wp duels`, `cs2wp duel-stats`, `cs2wp igls`, `cs2wp usage`, `cs2wp war`, `cs2wp validate-war`, `cs2wp team-factor`, `cs2wp team-stats`, `cs2wp tactics`, `cs2wp predictability`, `cs2wp clutch`). The public site publishes one rating at `/players`, WAA per 100 rounds from `wpa_opp` credit [shrunk for sample size](#shrinkage), with a page per player at `/players/:player` (`public/data/war/players.json`).

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

Output columns: `key`, `date`, `map`, `lp_team`, `lp_player`, `steamid`, `position`, `share` (modal position's share of round votes), `subposition`, `sub_share`, `rounds_voted`, `rounds_ct`, `votes` (every position's round count).

**CT doubled-position x, y clustering (`cs2wp positions --subpositions`).** Teams double positions often, and both players usually share one nav area. Splitting Inferno arch from top mid and Ancient alley from B site by callout failed earlier (median share 0.57 → 0.54 and 0.57 → 0.50; stability 0.69 → 0.66 and 0.70 → 0.66). Pooling per-round `(x, y)` centroids of the voted position and running `KMeans(n_init=10, random_state=0)` (`k = min(modal count when doubled, 4)`) across all 22 `(map, position)` cells doubled on ≥25% of team-maps gave `data/war/reports/ct-subpositions.md`:
- **Gate 1 (pair separation ≥ 0.70 and ≥ +0.15 above chance, median `sub_share` ≥ 0.60, player 5+-map stability ≥ 0.70):** 1 of 22 passed — `de_dust2` `B` (`k = 2`, doubled 64% → 22%; pair sep `0.701` vs `0.495` chance, `+0.207` lift; median `sub_share` `0.667`; stability `0.722` across 92 players), yielding `B Doors` (`-1578, 2592`) and `B Tunnels` (`-1839, 1877`) in `data/war/ct-subpositions.json`. Spot checks showed intuitive separation elsewhere (`de_nuke` `A`: cluster 0 `(558, -1207)` hut-side e.g. FlameZ 474 vs cluster 1 `(714, -640)` site/mini e.g. Mezii 204, Vitality/Spirit A pairs split `44/67`; `de_mirage` `A` Vitality/Spirit pairs split `46/64`), but all 21 other candidates missed the Gate 1 thresholds (`de_mirage` `B` `0.644`, `de_nuke` `A` `0.592`, `de_dust2` `Long` `0.578`, `de_mirage` `A` `0.574`, `de_train` `A` `k=4` `0.042`) and stay unsplit.
- **Gate 2 (`cs2wp baselines`, 3rd pooling level `CT sub-position` shrinking toward parent `(map, position)`):** Passed. On `de_dust2` `B`, `B Doors` (`11,372` rounds, raw `+0.0189` → shrunk `+0.0178`) and `B Tunnels` (`8,446` rounds, raw `+0.0120` → shrunk `+0.0137`) differ by `2.26 SE` on `wpa` (`2.44 SE` on `wpa_opp`), and split-half shrunk cell correlation is `0.982` (`≥ 0.96`).
- **Gate 3 (`cs2wp war` / `cs2wp validate-war` without usage):** Passed. `wpa_opp` split-half `k` is `984` (`≤ 1,033`), and `de_dust2` CT side residual narrowed slightly (`+0.0074` vs `+0.0099` / 100 on `wpa`, `+0.0165` vs `+0.0193` on `wpa_opp`).
- **Decision:** Enabled `coalesce(subposition, position)` by default in `baselines.py` (`ctRole` continues to read parent `position`; `ctByMap` shows `B Doors` / `B Tunnels`). Queue `cs2wp usage --device cuda` on the GPU machine, then rerun `cs2wp war --model production --publish`, `cs2wp validate-war`, and `cs2wp team-factor`.

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
- **CT, everyone else:** `coalesce(subposition, position)`, carrying the parent `position` column.
- **Pooling levels:** CT positions shrink toward the map's CT non-AWPer mean, and any split sub-positions (`de_dust2` `B Doors` / `B Tunnels`) add a third `"CT sub-position"` level shrinking toward their parent `(map, position)` baseline; unsplit positions stay unchanged at Level 2.

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

`duels.parquet` has one row per duel with every input, support flags, `p` (attacker win probability), the nested baselines `p_base`, `p_pos` and `p_flash` (next section), `opening` (the round's first duel by start tick) and `fold`. `duel-sides.parquet` has one row per player-map-side from `role-rounds.parquet`, with `duels`, `wins`, `expected`, `kills_above`, and `flash_gift`.

## Duel execution and quality

`wp/src/cs2wp/duelstats.py`. Phase 7, order 1 ([spec.md](spec.md)). Splits each duel into how well it was fought (execution) and how good it was to take (quality), for players and for teams.

```
cd wp
uv run cs2wp duels                     # GPU machine: adds p_base, p_pos, p_flash and opening to duels.parquet
uv run cs2wp team-factor               # stints, rounds and Elo per team-map
uv run cs2wp duel-stats [--min-duels 300] [--min-rounds 300] [--resamples 1000] [--publish]
```

`duel-stats` fits no models, so it runs on CPU in about 10 minutes at 1,000 resamples. It writes `data/war/duel-team-maps.parquet` (per map and team, every stat), `duel-teams.parquet` (ridge estimate per stint and per team, per 100 duels and per 100 rounds, with p5 / p95), `duel-players.parquet` (player execution with split-half reliability `n / (n + k)`, and the opponent-adjusted estimate) and `reports/duel-stats.md`.

**Definitions.** Every duel is scored from both players' views, and every value is antisymmetric, so each stat is zero-sum inside a map and fits the team factor's `τ_A − τ_B` ridge.

| Per duel, from player x's view | Formula | Meaning |
| --- | --- | --- |
| Execution | `win − p` | Won more than the situation predicted |
| Quality | `p − p_base`, centered per map × side | Situation was better than the buy and side predict |
| Positioning part | `p_pos − p_base` | Peek vs hold, distance |
| Flash part | `p_flash − p_pos` | Opponent blind, self not blind |
| HP part | `p − p_flash` | Fighting damaged opponents (trades, crossfires, utility damage) |

The baselines are cross-fit on the same event folds as `p`, each adding one input group: `p_base` has weapons, armor, helmet and side; `p_pos` adds speed and distance; `p_flash` adds blindness; `p` adds HP. The parts sum to quality exactly. The order is fixed, so the split is descriptive: flashes are credited after position, HP after both.

Raw mean `p` would be mostly economy: a team that wins rounds has better guns, and so a higher `p`, which rediscovers Elo. Quality takes the buy out by subtracting `p_base`, and centering per map × side takes out map layout (`p_base` doesn't know the map). Centering keeps the antisymmetry, because every duel has one CT and one T view on the same map.

**Opening variants** use only each round's first duel. Earlier execution in the round can't affect them, so they're the clean read on whether quality is tactics or a by-product of winning the previous fight (a won first duel leaves the next opponent damaged or outnumbered).

**Limitation.** Duels are gun kills only, so damage traded without a death isn't counted.

**Team stats.** Per map, a team's stat is the sum over its players' duel views (the other team's is the negative), with the map's duel count as the weight (opening duels for the opening variants). Units are IGL stints, the same ones `cs2wp team-factor` assigns, and plain `lp_team`. Every map with both teams' stints and Elo counts; the team factor's full-WAR-coverage filter doesn't apply, because these stats need no player priors. Split-half, ridge estimates with 90% intervals, and the walk-forward check reuse `teamfactor.split_half_team_factor`, `fit_team_factor` and `forward_team_factor` with `weight_col="duels"`. The minimum sample is 300 rounds' worth of duels.

**Gates.**

- Player execution: alternating-series split-half r, 90% interval from resampling series, lower bound above 0. Players need 300+ duels.
- Quality, stability: stint split-half r lower bound above 0.
- Quality, independence: quality's stint split-half r after regressing out same-half execution keeps its lower bound above 0. The report also gives the cross-half correlation (quality in one half against execution in the other, which shares no maps). If full quality fails and opening-only passes, opening-only becomes the published definition.
- A quality part whose split-half interval includes zero is dropped from the headline number (`quality_headline` in `duel-teams.parquet`), and the report says which.
- Beyond Elo, which decides only the label: leave-one-event-out log loss of the map result from `Elo logit` against `Elo logit + walk-forward stat difference`, with an event-resampled 90% interval. A stat that passes split-half but not this ships as descriptive.

`--publish` writes `public/data/war/team-duels.json` with only the stats that pass, each with `descriptive: true|false`, and refuses if none pass.

**Results (2026-11-13).** 437,356 duels on 3,123 maps; 3,111 maps have both teams' stints and Elo. The nested baselines order as they should, with cross-fit log loss `p_base` 0.6432 > `p_pos` 0.6274 > `p_flash` 0.6252 > `p` 0.6050 (unchanged).

| Metric (290 players, 300+ duels) | Half (median) | Split-half r | 90% CI | k |
| --- | --- | --- | --- | --- |
| Execution per duel | 994 duels | 0.452 | (0.369, 0.529) | 1,207 duels |
| Execution per round | 777 rounds | 0.451 | (0.368, 0.531) | 945 rounds |
| Duel win rate | 994 duels | 0.579 | (0.505, 0.646) | 723 duels |
| Expected win rate | 994 duels | 0.761 | (0.715, 0.801) | 312 duels |

Team stats by IGL stint (62 stints with 300+ rounds; forward gain is walk-forward weighted MSE gain as a % of predicting zero; Elo gain is the log-loss change from adding the stat to Elo):

| Stat | Split-half r | 90% CI | k (maps) | Forward gain % | r with Elo | Elo + stat gain (90% CI) |
| --- | --- | --- | --- | --- | --- | --- |
| Execution | 0.490 | (0.328, 0.621) | 38 | +5.10 | 0.86 | +0.0001 (−0.0010, +0.0012) |
| Quality | 0.550 | (0.388, 0.678) | 29 | +4.99 | 0.59 | −0.0003 (−0.0008, +0.0001) |
| Positioning | 0.438 | (0.225, 0.604) | 46 | +1.64 | 0.39 | −0.0006 (−0.0010, −0.0002) |
| Flashes | 0.347 | (0.168, 0.505) | 68 | +3.78 | 0.21 | −0.0003 (−0.0006, −0.0000) |
| HP | 0.570 | (0.383, 0.703) | 27 | +2.97 | 0.61 | −0.0001 (−0.0006, +0.0003) |
| Execution (opening) | 0.210 | (0.003, 0.397) | 136 | +1.49 | 0.60 | +0.0002 (−0.0007, +0.0011) |
| Quality (opening) | 0.099 | (−0.122, 0.313) | 331 | +0.56 | 0.45 | −0.0005 (−0.0008, −0.0002) |

By plain `lp_team` (46 teams) every split-half r is higher (execution 0.609, quality 0.685) and the Elo test reads the same.

Independence of quality from execution (stints, all duels): same-half r 0.504, cross-half r 0.293 (0.134, 0.427), and quality's split-half r after regressing out same-half execution 0.519 (0.370, 0.648). Opening-only: residualised r 0.058 (−0.162, 0.271). Shares of quality's stint variance: HP 0.56, positioning 0.33, flashes 0.11 (opening: 0.38 / 0.45 / 0.18).

- **Quality over all duels passes stability and independence**, so it is the published definition, with all three parts in the headline.
- **Opening-duel quality fails both**: one duel per round is too little sample at the stint level (`k` 331 maps).
- **No team stat adds to Elo**, so every published stat is descriptive. Execution is mostly Elo (r 0.86), and positioning and flashes slightly worsen Elo's log loss. Quality and its parts describe how a team plays, not how much it wins beyond its rating.

`team-duels.json` publishes execution, quality, positioning, flashes and HP for the 62 stints, shown on the Duels tab of `/rankings` and on each team page.

**Player execution passes.** It is less reliable than raw win rate because raw win rate also carries the player's situations (role, weapon, peeking), which are stable. Execution is the skill left after those come out.

**Opponent adjustment (experiment).** A sparse ridge over duels, `win − p = θ_x − θ_y`, with alpha set to the raw per-duel `k`, fit per alternating-series half. The comparator is the same ridge without opponent terms (`sum / (duels + alpha)`), not the raw rate: shrinkage alone raises split-half r by pulling small samples toward zero, and that isn't what the experiment tests.

Result (2026-11-13, alpha 1,207 duels, 290 players, 200 series resamples): split-half r 0.452 for the raw rate, 0.710 for the ridge without opponents, 0.748 with them. The gain over the ridge without opponents is +0.038 (90% CI +0.025, +0.052): **keep**. `duel-players.parquet` carries it as `exec_adj_per100`.

## Team round stats

`wp/src/cs2wp/teamstats.py`. Phase 7, order 2 ([spec.md](spec.md)). Five team stats measured on rounds, none with team Elo in its expectation.

```
cd wp
uv run cs2wp team-stats [--min-rounds 300] [--resamples 1000] [--publish]
```

It needs `team-map-residuals.parquet` (`cs2wp team-factor`), `resource-rounds.parquet` (`cs2wp usage`), `duels.parquet` (`cs2wp duels`) and `data/wp/reports/conservation.parquet` (`cs2wp credit`). It runs on CPU in about 10 minutes at 1,000 resamples, and writes:

- `data/war/team-rounds.parquet`: per round, with `p_econ` and `p_duel`
- `team-stat-maps.parquet`: per team-map
- `team-stats.parquet`: ridge estimates per stint and per team, with p5 and p95
- `team-side-ratings.parquet`: adjusted T and CT ratings
- `reports/team-stats.md`

**Round expectations.** Both models are XGBoost, cross-fit by event, with monotone constraints on equipment and kills.

- `p_econ` is P(CT wins the round) from map, both teams' equipment at the end of buy time, pistol round and overtime. Its log loss is 0.6015, against 0.6922 for the base rate.
- `p_duel` adds the round's gun kills per side and the side that won the opening duel. Its log loss is 0.0926.

Calibration by buy pair is within 0.03 for both, on every bucket with 200+ rounds.

**Stats.** Each stat is summed from the team's view over a map's rounds and is zero-sum between the two teams. The weight is the number of rounds the stat covers.

| Stat | Per round, CT view (T view is the negative) |
| --- | --- |
| Time-and-position value (`tpv`) | WP drift between events (`credit.conservation`), centered per map so the side offset of about −0.076 cancels |
| Round wins over expected, economy (`rwoe_econ`) | `ct_win − p_econ` |
| Round conversion over duels (`conv`) | `ct_win − p_duel`: post-plants, saves, utility and bomb kills. Trades are duel wins, so they count in execution, not here |
| Round wins over expected, player WAR (`rwoe_war`) | `resid_wpa_opp` from `cs2wp team-factor` (Stage 1), on maps where all ten players have priors |

The battery is the one `duel-stats` uses: alternating-series split-half, ridge estimates, walk-forward, r with Elo, and the Elo + stat log-loss test (`duelstats.team_results`).

`teamfactor.window_persistence` adds a quarter-to-quarter test. It fits τ per unit in each calendar quarter, at alpha 1 as the split-half does. It then correlates τ in quarter q with τ in q+1, pooling every consecutive pair in which the unit has half the minimum sample in both quarters. The 90% interval comes from resampling series.

**Adjusted T and CT ratings.** `logit P(CT wins) = logit(p_econ) + d[CT unit] − o[T unit]` is fit as a logistic ridge (L-BFGS with a fixed offset). The offset controls for map, side and economy, and the pairing controls for the opponent.

The comparator is each unit's raw CT and T round win rate above the league rate, shrunk by `k` rounds, on the same offset. Gating is walk-forward by event: alpha and `k` are tuned on the first half of events, and the second half is scored per round, with a 90% interval from resampling events. Ratings are published as win-rate points per 100 rounds on that side, at the league CT rate.

**Gates.**

- Every stat must pass stint split-half, with the lower CI bound above 0.
- Conversion and the player-WAR version must also persist across quarters (lower CI bound above 0).
- Time-and-position value and the economy version are descriptive, as the spec says.
- Adjusted T and CT must beat raw win rates. They have no Elo test, so they are labelled descriptive.

**Results (2026-11-13).** 67,409 rounds on 3,111 maps. The player-WAR version uses the 2,671 maps where every player has priors.

| Stat (62 stints, 300+ rounds) | Split-half r (90% CI) | k (rounds) | Quarter persistence r (90% CI) | r with Elo | Elo + stat gain (90% CI) | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Time-and-position value | 0.415 (0.239, 0.577) | 1,102 | 0.379 (0.238, 0.496) | −0.48 | +0.0005 (−0.0007, +0.0016) | Published, descriptive; hidden on the site since 2026-11-22 |
| Round wins over expected, economy | 0.662 (0.529, 0.764) | 399 | 0.570 (0.477, 0.644) | 0.93 | −0.0001 (−0.0012, +0.0009) | Published, descriptive |
| Round conversion over duels | 0.323 (0.118, 0.508) | 1,641 | 0.065 (−0.066, 0.194) | 0.19 | −0.0003 (−0.0009, +0.0002) | **Fails persistence** |
| Round wins over expected, player WAR | 0.239 (−0.018, 0.467) | 2,290 | 0.094 (−0.035, 0.219) | 0.56 | +0.0013 (−0.0006, +0.0030) | **Fails** both (same as Stage 1) |

Adjusted T and CT ratings, by stint:

- Alpha 100, raw `k` 800 rounds.
- On 32,748 rounds in 26 test events, log loss is 0.6004 for the offset only, 0.5987 for raw win rates and 0.5985 adjusted.
- The gain over raw is **+0.00023 (+0.00008, +0.00039): passes.** By `lp_team` it is +0.00035 (+0.00019, +0.00052).
- Split-half r is 0.606 for CT and 0.632 for T. They correlate 0.88 (CT) and 0.79 (T) with Elo, so mostly they measure strength, split by side.

Findings:

- **The economy version is Elo without Elo** (r 0.93). It measures strength honestly, but adds nothing to Elo.
- **Time-and-position value is not Elo-free.** Drift comes from the WP model, which includes `elo_diff_ct`. A favourite's p0 already prices its edge, so strong teams tend to lose drift (r −0.48). Don't read it as positioning skill.
- **Time-and-position value is hidden on the site until it's reworked (decided 2026-11-22).** It read as backwards: the 10 best stints by the economy version are all negative and 9 of the worst 10 are positive. Checked on the stored reports of 2026-11-12 (67,425 rounds):
  - The sign is correct: drift is CT-positive, the T team gets its negative, and side labels agree with every round's winner.
  - Favourites average +0.74 per 100 rounds from events, −0.39 from drift and −0.03 after the last event. The likely cause, inferred and not tested, is that expected kills are priced in and decay while none happen.
  - Elo may not be the whole cause. By team (46 with 300+ rounds) drift is r −0.47 with Elo and −0.42 with event value. After a linear adjustment for mean Elo edge, 7 of the top 10 Elo teams are still negative. Holding Elo at 0 in the model hasn't been tested.
- **Conversion is reliable inside a window but doesn't carry across quarters for stints.** By `lp_team` it does: r 0.162 (0.031, 0.278). Rosters and callers change between quarters, so a whole team carries it better than an IGL stint. It isn't published until the stint test passes.
- **The player-WAR version** reproduces Stage 1 and fails for the same reason: too little archive.

`team-stats.json` publishes `tpv`, `rwoe_econ`, `ct_def` and `t_off` for 62 stints. All but `tpv` appear on the Rounds tab of `/rankings` (`src/pages/TeamRounds.tsx`) and on each team page.

## Tactics stats

`wp/src/cs2wp/tactics.py`. Phase 7, order 4 ([spec.md](spec.md)): execute success, post-plant conversion, map control and numbers at contact.

```
cd wp
uv run cs2wp tactics [--min-rounds 300] [--resamples 1000] [--rebuild] [--publish]
```

It needs `team-map-residuals.parquet` (`cs2wp team-factor`) and `team-rounds.parquet` (`cs2wp team-stats`, for teams, buys and `p_econ`). It runs on CPU. The per-map geometry takes about 3 minutes on 6 workers and is cached in `data/war/tactics-raw.parquet`; new maps are added incrementally, and `--rebuild` recomputes every map after a code change. It writes:

- `tactics-rounds.parquet`: per round, with hit site, execute flags, `p_take`, `p_post`, territory and defenders
- `tactics-maps.parquet`: per team-map
- `tactics.parquet`: ridge estimates for the zero-sum stats
- `tactics-side-ratings.parquet`: T and CT ratings for executes and post-plants
- `reports/tactics.md`

No expectation includes team Elo. The spec asked for execute success to control for Elo, but that contradicts its own Elo-circularity rule, so Elo only enters the beyond-Elo label test.

**Geometry.** Sites come from the nav mesh and the plant positions (`nav.SiteDistance`): a position is in a site within 500 nav-path units of its plant areas, and within its holds inside 1,000. Thrower sides come from `resources.thrower_grenades`, which generalises the smoke-thrower inference to every grenade type. It attributes about 70% of flashes and 92–100% of smokes, HEs and molotovs.

- **Site hit**: the plant site, otherwise the site where a second T entered first, otherwise none (about 80% of rounds).
- **Execute**: 3+ Ts enter the hit site within 5 s, and 2+ T grenades land in its holds between 8 s before the first entry and the third entry. That's 10% of T rounds on Dust2 and up to 28% on Inferno.
- **Map control** at 30, 45 and 60 s after freeze end, on rounds still live with no plant yet: multi-source Dijkstra over the nav graph from each side's alive players. Each area goes to the side that reaches it first (ties split), and CT share is the area-weighted share of reachable nav area. It's centred per map and men alive on each side, so territory taken by kills cancels.
- **Numbers at contact**: first damage between opponents with the T inside the hit site's holds, or the plant if that comes first. Defenders are the alive CTs inside the holds at that moment, centred per map, site and CTs alive (mean 1.3 on Dust2 to 2.1 on Nuke).

**Stats.**

- Map control and numbers at contact are zero-sum (CT view as is, T view negated). They run through the `duel-stats` battery (`duelstats.team_results`) plus quarter persistence.
- Execute success and post-plant conversion are rated per side, like the adjusted T and CT ratings: `logit P(CT stops it) = logit(1 − p) + d[CT unit] − o[T unit]`, with `p` from XGBoost cross-fit by event.
  - `p_take` (execute → plant) uses map, site, both buys and men alive at the third entry.
  - `p_post` (plant → T win) uses map, site, both buys, men alive and CT kits at the plant.

**Gates** (stints):

| Stat | Test from the spec | Implementation |
| --- | --- | --- |
| Execute success, post-plant conversion | Noise check by season | T offense `o`: split-half and half-year season persistence (split at 1 July), both with lower CI above 0 |
| Map control | Adds beyond WAR? | Split-half, and leave-one-event-out map-result log loss of the summed-prior-WAR expectation (`expected_win_prob` from `cs2wp team-factor`) with and without the walk-forward stat, on WAR-covered maps |
| Numbers at contact | Signal in modern CT play? | Split-half, and leave-one-event-out round log loss of `logit(p_econ)` with and without the defender excess |

**Results (2026-11-15).** 67,409 rounds on 3,111 maps (2,671 WAR-covered). Expectations: `p_take` 0.4616 log loss against 0.5753 base, on 13,189 executes (take rate 0.738). `p_post` 0.3080 against 0.5396, on 36,618 plants (T win 0.770).

| Stat (stints) | Split-half r (90% CI) | Own test | Verdict |
| --- | --- | --- | --- |
| Map control at 30 s | 0.412 (0.173, 0.595) | WAR + stat −0.0000 (−0.0008, +0.0008) | **Fails**: adds nothing beyond WAR |
| Map control at 45 s | 0.387 (0.187, 0.558) | +0.0001 (−0.0010, +0.0011) | **Fails** |
| Map control at 60 s | 0.231 (0.004, 0.458) | +0.0000 (−0.0012, +0.0012) | **Fails** |
| Numbers at contact | 0.352 (0.162, 0.522) | Round gain +0.00124 (+0.00082, +0.00166) | Published, descriptive |
| Execute success (T) | 0.029 (−0.205, 0.259) | Season r 0.002 (−0.202, 0.187) | **Fails** both |
| Post-plant conversion (T) | 0.280 (0.130, 0.457) | Season r 0.367 (0.221, 0.498) | Published, descriptive |

Findings:

- **Map control is a stable team trait, but it isn't skill WAR misses.** It persists across quarters (r 0.29–0.32) and correlates only 0.14–0.27 with Elo, but adding it to the WAR expectation doesn't change map-result log loss. Adding it to Elo slightly worsens log loss at 30 s. The spec's worry holds: in modern CT play, territory is style, not an edge.
- **Execute success on the T side is noise.** The CT side carries signal: defending executes has split-half r 0.50 and season r 0.24 (0.06, 0.41). Stopping executes is a team trait; landing them isn't.
- **Post-plant conversion persists across seasons on both sides** (T 0.37, CT 0.33). It correlates 0.49 with Elo, so it's partly strength.
- **Numbers at contact** has split-half r 0.35 and quarter r 0.23. The round test confirms the extra defenders matter beyond economy. It doesn't add to Elo (−0.0001), so it's descriptive.

`tactics.json` publishes `contact`, `post_t_off` and `post_ct_def` for 75 stints. They appear on the Tactics tab of `/rankings` (`src/pages/TeamTactics.tsx`) and on each team page, as Post-plant T, Retake CT and Numbers at contact.

`tactics-raw.parquet` also records `freeze_end_tick` and `hit_tick`, which is the first T entry into the hit site, or the plant if no T entered. T-side predictability uses them. A cache without `hit_tick` rebuilds on the next run.

## T-side predictability

`wp/src/cs2wp/predictability.py`. Phase 7, order 5 ([spec.md](spec.md)).

```
cd wp
uv run cs2wp predictability [--resamples 1000] [--publish]
```

It needs `tactics-rounds.parquet` (`cs2wp tactics`) and `team-map-residuals.parquet` (`cs2wp team-factor`). It runs on CPU in about 2 minutes and writes:

- `predictability-rounds.parquet`
- `predictability-maps.parquet`
- `predictability.parquet`
- `reports/predictability.md`

**The stat.** It asks how much better a scout who studied the team's earlier T rounds predicts the next one than a league prior does.

- **Outcome per T round:**
  - site hit: A, B or none
  - timing bin: seconds from freeze end to the first T entry, in <20, 20–40, 40–60 or 60+
  - whether it was an execute
- **Given economy:** each distribution is conditioned on map and T buy (eco, force, full or pistol).
- **League prior:** add-one smoothed over every earlier date.
- **Scout:** the unit's own rounds on that map and buy from earlier dates, Dirichlet-smoothed toward the league prior with strength m = 20.
- **Per round:** `pred` = league surprise − scout surprise, in nats, summed over site, timing given site and execute given site. Positive means predictable.
- **Eligibility:** a round counts once the unit has 30 earlier T rounds on the map.

**Gates.**

- Stint split-half of `pred` (alternating series, 75+ rounds a half).
- **Prepared opponents** (the spec's test):
  - Team predictability at map time is the team's earlier `pred`, shrunk by 100 rounds.
  - The test is leave-one-event-out map log loss of `elo_logit + Δpred`, against that plus `Δpred × prepared`, on maps where both teams have 50+ earlier eligible rounds.
  - It passes if the gain's 90% CI (resampling series) is above 0 and the interaction is negative.
- **Prepared** means the two teams met in an earlier series within 60 days (25% of maps).
- Bo3+ is a diagnostic only. Residual `series` ids are HLTV match ids, which don't join to Liquipedia's `bestOf`, so Bo3+ is "the series ran past one map". That's 94% of demo maps, so it barely varies.

**Results (2026-11-15): fails. Not published.**

| Test | Result |
| --- | --- |
| Mean gain per eligible round (49,687) | −0.0062 nats at m 20, −0.0201 at m 10, +0.0012 at m 40 |
| Stint split-half | 0.103 (−0.152, 0.340), 46 stints: **fails** |
| Team (`lp_team`) split-half | 0.327 (0.043, 0.559); quarter r 0.143 (0.032, 0.267) |
| Rematch: gain over Elo + Δpred | −0.00057 (−0.00138, +0.00024); interaction coefficient +0.048: **fails** |
| Bo3+ (diagnostic) | +0.00045 (−0.00114, +0.00196); interaction +0.318 |

Findings:

- **A team's own history barely beats the league prior.** At m 20 the scout is slightly worse on average. Site choice given map and buy is about as predictable for every team as for the league.
- **What predictability exists is a weak team trait** (team split-half 0.33). It doesn't survive IGL stints.
- **Predictable teams don't lose to prepared opponents.** The interaction points the other way and isn't significant.

## Clutch and man-advantage conversion

`wp/src/cs2wp/clutch.py`. Phase 7, order 5 ([spec.md](spec.md)).

```
cd wp
uv run cs2wp clutch [--model production] [--resamples 1000] [--publish]
```

It needs `team-rounds.parquet` (`cs2wp team-stats`), `team-map-residuals.parquet` (`cs2wp team-factor`), each map's `data/wp/states/<slug>/events.parquet` and the WP model book. It runs on CPU in about 5 minutes and writes:

- `clutch-entries.parquet`
- `clutch.parquet`
- `reports/clutch.md`

**Entries.** For each side in each round, the first post-event state in each class, skipping events that end the round:

- `clutch`: 1 alive against 1 or more. It belongs to the survivor.
- `adv`: more alive than the opponent.
- `disadv`: fewer alive than the opponent.

**Expectation.** Each entry state is valued with the map's own out-of-sample WP fold (`pipeline.map_predictor`, which `cs2wp credit` also uses), with `elo_diff_ct` set to 0 so team strength stays out.

- Conversion = win − p, centred per class, X v Y and side, so leftover model bias in rare states cancels.
- The uncentred bias is large in late states. 1v1 wins run 6–10 points above the model (CT 0.548 actual against 0.450 predicted), and 2v1 and 3v2 advantages convert 4–6 points below it. That's worth a look in [win-probability.md](win-probability.md) calibration by man count.

**Gate.** The spec's test is year-to-year: each unit's mean conversion in 2025 against 2026, over units with 30 entries (players) or 60 (stints, teams) in both years. The 90% CI resamples series. A class that fails stays off the site. Half-year persistence, split-half and r with mean Elo are reported as diagnostics (`unitstats.py`, which also serves predictability).

**Results (2026-11-15).** 249,281 entries on 3,111 maps.

| Class | Unit | Year r (90% CI, units) | Split-half r (90% CI) | r with Elo | Verdict |
| --- | --- | --- | --- | --- | --- |
| Clutch | Player | 0.152 (0.034, 0.274), 142 | 0.009 (−0.097, 0.118) | — | Published |
| Clutch | Stint | 0.269 (0.021, 0.483), 25 | 0.219 (0.038, 0.406) | 0.13 | Published |
| Clutch | Team | 0.249 (0.032, 0.449), 34 | 0.326 (0.090, 0.544) | 0.21 | Passes |
| Man advantage | Stint | 0.260 (−0.091, 0.560), 25 | 0.003 (−0.206, 0.218) | 0.63 | **Fails** |
| Man advantage | Team | 0.215 (−0.123, 0.525), 34 | −0.058 (−0.310, 0.225) | 0.63 | **Fails** |
| Man disadvantage | Stint | 0.355 (0.099, 0.566), 26 | 0.343 (0.128, 0.535) | 0.70 | Published |
| Man disadvantage | Team | 0.323 (0.074, 0.536), 35 | 0.403 (0.143, 0.621) | 0.71 | Passes |

Findings:

- **Team clutching is a stable trait that isn't strength** (r with Elo 0.13–0.21).
- **Player clutching barely carries:** year r 0.15 and split-half 0.01. It's published as a tendency, not a skill.
- **Coming back from behind is mostly strength** (r 0.70 with Elo), because the expectation is deliberately Elo-free.
- **Closing out an advantage isn't stable.**

`clutch.json` publishes stint `clutch` and `disadv` (81 stints with 120+ entries) on the Tactics tab of `/rankings` (`src/pages/TeamClutch.tsx`), and player clutches (230 players with 60+) on the Clutch view of `/players` and each player page (`src/pages/PlayerClutch.tsx`). Rates are round wins per 100 entries. Hopeless 1v4 and 1v5 entries are in the denominator, which keeps team rates small.

## Style and archetypes

`wp/src/cs2wp/style.py`. It gives each player percentile bars for production and style, and names their nearest archetype, for the Style section of the player page.

```
cd wp
uv run cs2wp style [--rebuild] [--resamples 200] [--publish]
```

It reads `public/data/war/players.json` (run `cs2wp war --publish` first) and `clutch.json`, plus `resource-rounds.parquet`, `duels.parquet` and `team-rounds.parquet`. It writes:

- `style-rounds.parquet`: per player-round counts from the raw tables, parsed incrementally (0.1 s a map, so `--rebuild` takes about a minute)
- `player-style.parquet`
- `reports/style.md`
- with `--publish`, `public/data/war/style.json`

**Metrics.** Each metric is a mean over its own observations. Duels are oriented to each player as in `duelstats.py`.

| Key | Label | Observation | Value |
| --- | --- | --- | --- |
| `firepower` | Firepower | duel | 100 × (win − expected) |
| `openingWin` | Opening duels | opening duel | 100 × (win − expected) |
| `tradeKills` | Trading | player-round | 100 × trade kills (`kills.is_trade`) |
| `utilityDamage` | Utility damage | player-round | HE and molotov health damage to enemies |
| `flashAssists` | Flash assists | player-round | 100 × flash assists |
| `survival` | Survival | player-round | 100 × survived |
| `pace` | Early fights | player-round with a duel | seconds from freeze end to the first duel's start; lower ranks higher |
| `opening` | Opening attempts | player-round | 100 × in the round's first duel |
| `peeking` | Peeking | duel | top speed in the second before the duel (`a_speed`/`v_speed`), on maps with velocity |
| `range` | Duel range | duel | distance |
| `isolation` | Isolation | T player-round | distance to the nearest living teammate at the first tick 20 s after freeze end |
| `utilityThrown` | Utility thrown | player-round | grenades thrown (`resources.thrower_grenades`) |
| `flashing` | Flashing | player-round | enemy blind seconds from the player's flashes |
| `support` | Supported duels | duel | 100 × a teammate's flash or smoke supported it |
| `traded` | Deaths traded | player-round with a death | 100 × traded |
| `resourceShare` | Resource share | full-buy player-round | 100 × share of team equipment |
| `headshot` | Headshots | rifle kill | 100 × headshot |

ADR, clutch conversion and WAA per 100 (`wpa_opp`) are copied from `players.json` and `clutch.json`, which gate them. They're shown but never feed archetypes.

**Older demos have no velocity.** Before mid-2025 the parse has no velocity, so speed is null, or 0 on the few duels that have it. With those maps in, peeking passed split-half (0.86) but failed year to year (0.14), because the year split mostly measured which parse a map came from. Peeking now skips maps where every duel's speed is null or 0.

**Gate.** A metric ships when its split-half r is at least 0.5. Split-half uses alternating series, needs 40+ observations per half, and runs over the 267 qualified players (`unitstats.split_half`). Year-to-year r is reported as a diagnostic.

**Percentiles.** The average rank in the pool, scaled to 0–100. Production and overall metrics rank everyone together. Style metrics rank AWPers (`tRole` AWPer) against AWPers and everyone else against non-AWPers, so range and pace aren't just measuring the AWP.

**Archetypes.** The `ARCHETYPES` table in `style.py`. Each archetype has the T roles it applies to and target percentiles on 3–4 shipped metrics. A player gets the archetype with the smallest RMS distance over the targets they have values for (2+ needed), and the runner-up is published too.

| Archetype | Roles | Targets |
| --- | --- | --- |
| Aggressive AWP | AWPer | pace 80, opening 80, peeking 75, range 40 |
| Anchor AWP | AWPer | pace 20, opening 30, peeking 25, range 80 |
| Hybrid AWP | AWPer | opening 50, peeking 50, utility thrown 65, trading 60 |
| Spacetaker | Entry, Rifler | opening 85, pace 85, traded 75, survival 25 |
| Star Entry | Entry | opening 80, opening duels 80, firepower 75 |
| Trader | Entry, Rifler | trading 85, pace 60, isolation 30 |
| Star Rifler | Entry, Rifler | firepower 85, resource share 80, survival 65 |
| Lurker | Rifler | isolation 85, pace 20, opening 30, traded 25 |
| Support | Rifler | utility thrown 80, flashing 75, flash assists 75, resource share 25 |
| Closer | Rifler | survival 85, pace 25, isolation 55, firepower 60 |

**Results (2026-11-21).** 9.78M observations for 267 players.

| Metric | Split-half r (90% CI) | Year-to-year r (90% CI) | Ships |
| --- | --- | --- | --- |
| Firepower | 0.51 (0.42, 0.59) | 0.49 (0.40, 0.58) | yes |
| Opening duels | 0.29 (0.19, 0.39) | 0.37 (0.24, 0.47) | **no** |
| Trading | 0.53 (0.46, 0.62) | 0.31 (0.22, 0.40) | yes |
| Utility damage | 0.79 (0.75, 0.82) | 0.72 (0.66, 0.76) | yes |
| Flash assists | 0.83 (0.79, 0.85) | 0.80 (0.75, 0.84) | yes |
| Survival | 0.67 (0.59, 0.73) | 0.71 (0.64, 0.77) | yes |
| Early fights | 0.81 (0.76, 0.84) | 0.63 (0.56, 0.69) | yes |
| Opening attempts | 0.79 (0.75, 0.83) | 0.66 (0.60, 0.71) | yes |
| Peeking | 0.85 (0.82, 0.88) | 0.86 (0.82, 0.89) | yes |
| Duel range | 0.91 (0.89, 0.92) | 0.87 (0.84, 0.89) | yes |
| Isolation | 0.85 (0.82, 0.88) | 0.68 (0.63, 0.72) | yes |
| Utility thrown | 0.94 (0.92, 0.95) | 0.81 (0.78, 0.84) | yes |
| Flashing | 0.91 (0.89, 0.92) | 0.82 (0.80, 0.85) | yes |
| Supported duels | 0.82 (0.79, 0.85) | 0.73 (0.69, 0.77) | yes |
| Deaths traded | 0.57 (0.50, 0.64) | 0.47 (0.36, 0.56) | yes |
| Resource share | 0.99 (0.99, 0.99) | 0.94 (0.93, 0.95) | yes |
| Headshots | 0.73 (0.66, 0.78) | 0.67 (0.61, 0.72) | yes |

What the results show:

- **Opening-duel win rate isn't a trait** at this sample size, so Star Entry falls back to opening volume and firepower.
- **Archetypes are moderately stable.** When archetypes are assigned on each half separately, 162 of 267 players (61%) get the same one. Groups range from 9 players (Anchor AWP) to 46 (Support). Examples: s1mple and MartinezSa are Aggressive AWP, Jame and torzsi Anchor AWP, NiKo and XANTARES Star Rifler, KSCERATO and frozen Lurker.
- **Isolation finds lurkers.** Among 143 non-AWPers matched to the 2024 NER0cs labels, isolation ranks labelled Lurkers above Spacetakers with AUC 0.79, and above every other label with AUC 0.75. The Lurker archetype catches 18 of 46 labelled Lurkers and only 4 of 82 other players. Some of the misses will be role changes since 2024.

### Comps

Each player gets two lists of 5 nearest peers (`compSize: 5` in `style.json`), computed from the same 267 whole-window percentile profiles:

- **Production comps:** the 7 shipped `production` axes (Firepower, Damage, Trading, Utility damage, Flash assists, Survival, Clutch; Rating is left out because it summarises the others). Everyone is compared with everyone.
- **Style comps:** the 11 shipped `style` axes. Players are only compared within their own pool (AWPers with AWPers, everyone else with non-AWPers), because style percentiles are only meaningful inside a pool.

Distance is the unweighted RMS percentile gap over the axes both players have, requiring at least 70% of axes in common (so missing clutch or peeking values don't distort pairs). Similarity is `100 − RMS`. A random pair of uniform percentiles averages about 41 RMS, or ~59 similarity, so a score in the high 70s or 80s is a genuine match rather than middling.

**Validation (2026-11-21, alternating-series halves).** Production split-half checks use only the 5 `own` axes (Firepower, Trading, Utility damage, Flash assists, Survival), because ADR, clutch and rating don't exist per half.

| Group | Players | Top-1 ID (chance) | Top-5 ID (chance) | Top-5 overlap (chance) | Teammate share |
| --- | --- | --- | --- | --- | --- |
| Production | 267 | 15.0% (0.4%) | 35.6% (1.9%) | 0.61 (0.09) | 24/1335 (1.8%) |
| Style | 267 | 51.3% (0.7%) | 75.3% (3.7%) | 1.29 (0.19) | 26/1335 (1.9%) |

- **Identification is well above chance.** On style, a player's own half-1 profile is the single nearest match to their half-0 profile 51% of the time (70× chance) and lands in the top 5 for 75% of players (20× chance). Production is noisier (15% top-1, 36% top-5), as expected with fewer and lower-reliability axes, but still ~19–40× chance.
- **Top-5 lists are moderately stable.** Mean overlap between halves is 1.29 of 5 on style (7× chance) and 0.61 on production (6.5× chance): the neighbourhood is real, though individual rank order shifts with sample noise.
- **No team-system inflation.** Only 1.8% of production comps and 1.9% of style comps share a current Liquipedia team, right around the ~1.5% base rate for 5-player rosters, so comps reflect individual profiles rather than team systems.

## Luck-adjusted Elo

`wp/src/cs2wp/luck.py`, plus `luckWeight` in the Elo engine. Phase 7, order 3 ([spec.md](spec.md)). The question: would Elo predict better if each map's update used the margin the teams "should" have had, with every duel at its expected rate?

```
npm run export-map-elo
cd wp && uv run cs2wp luck [--resamples 1000]
cd .. && npm run backtest-elo -- --luck
```

`cs2wp luck` needs `duel-team-maps.parquet` and `duel-players.parquet` (`cs2wp duel-stats`), `team-map-residuals.parquet` (`cs2wp team-factor`) and `team-stat-maps.parquet` (`cs2wp team-stats`). It writes `data/war/luck-maps.parquet`, `data/elo/luck-maps.jsonl` (read by the backtest, keyed by `match2id` and scored-map index), `data/elo/player-skill.json` (read by `backtest-elo --skill`, see [Player-skill term](#player-skill-term)) and `reports/luck.md`. `backtest-elo --luck` takes `--luck-variant raw|skill|value|full|skillonly` (default `skill`).

**Expected margin.** No round simulation. `exec` is the teams[0] view of duels won minus expected (`duel-team-maps`). β, the rounds of margin per duel won above expectation, is a no-intercept OLS of signed round margin on `exec`, cross-fit over 5 event folds. Then `x_margin = margin − β · exec`, and `y_hat = P(win | x_margin)` is a one-feature logistic, also cross-fit.

**Engine.** With weight w on a map that has a luck row, the update uses `(1 − w)·y + w·y_hat` as the result and `(1 − w)·margin + w·x_margin` as the margin. The damping term takes the winner's sign from the blended margin. Predictions and scoring always use the real result. At w = 0, or on maps without a row, ratings are identical to before (`engine.test.ts`). `export-map-elo` pins w to 0 so WP credits don't move.

**Treated set.** Series where both lineages have 5+ luck maps in the prior 120 days. w is tuned on 2025 treated series over 0–1 in steps of 0.1, with every other parameter frozen, and scored on 2026 treated series. The 90% interval on the log-loss gain resamples events.

**Hot-hand check.** Execution per duel on each map, minus the unit's rate on every *other* event. Demeaning within the event would make neighbouring maps correlate negatively. Each map is paired with the unit's next map in the same event. Same-series pairs share an opponent, whose strength the duel model doesn't see, so only next-series pairs test form.

**Results (2026-11-14).** 3,111 maps on 53 events.

- β = 0.825 rounds per duel above expectation; `exec` explains 69% of margin variance. `x_margin` points the other way from the real result on 29% of maps.
- Hot hand, next-series pairs: player r −0.009 (−0.022, +0.005) on 9,808 pairs; team r −0.017 (−0.052, +0.023). Same-series pairs are positive (player +0.051, team +0.152), which fits the shared opponent. Duel residuals don't carry over between series, so they behave like luck.
- 844 treated series in 2025 and 822 in 2026. 2025 log loss is lowest at w = 0.2 (0.62358 against 0.62512 at w = 0).
- 2026 treated series: 0.6287 at w = 0.2 against 0.6277 at w = 0. **Gain −0.0010, 90% CI −0.0037 to +0.0019: FAIL.** Treated maps: 0.6562 against 0.6566. The full gate set doesn't move (0.6150 against 0.6151).

**Reading (raw variant).** Even though the residuals look like luck, discounting them doesn't help Elo out of sample. `exec` is mostly skill across events (the player split-half passes in [Duel execution and quality](#duel-execution-and-quality)), so `x_margin` strips out real strength along with the noise. That matches order 1, where team execution added nothing beyond Elo.

### Skill-adjusted luck

The duel model has no player identity, so `exec` is measured against a league-average player and holds duel skill as well as luck. The skill variant removes only what a player's own record doesn't predict.

- **θ.** Each player's execution per duel from duels dated before the event's first day, shrunk by k = 1,207 duels (the player split-half `k`, read back from `duel-players.parquet`). It is prior-only, so no future result reaches a rating. Players with no earlier duels get 0.
- **Split.** `exec_skill` sums `θ_self − θ_opponent` over a team's duels, and `exec_luck = exec − exec_skill`. Both are zero-sum between the two teams.
- **Margin.** `x_margin_skill = margin − β · exec_luck`, with β and `y_hat_skill` cross-fit as before. `luck-maps.jsonl` carries both variants.

**Carryover test.** This asks the question directly, without the engine: once Elo is in the model, does a team's recent luck predict its next map? If Elo has absorbed luck, it must, with a negative sign.

- Maps where both teams have 5+ demo maps in the 120 days before the series (the backtest's treated rule). Maps of the same series are never in the window.
- Each feature is a trailing per-map mean in rounds of margin (duel stats × β), team minus opponent.
- Primary: the feature's coefficient in a no-intercept OLS of the map's round margin on the Elo logit and the feature. The round margin is continuous, so it has more power than win/loss. Secondary: leave-one-event-out log-loss gain over Elo alone (`warcheck.cv_losses`). Intervals are 90%, resampling events.
- Pre-registered reading: the idea is alive only if the luck part's coefficient is negative with its interval below 0.

**Results (2026-11-14).**

- θ is calibrated: the slope of `exec` on `exec_skill` per map is 1.03. `exec_skill` has SD 1.26 duels per map against 6.07 for `exec`, and explains 4.6% of its variance. So per map almost all of `exec` is luck, but the skill part is the part that repeats.
- `x_margin_skill` predicts the map result better than `x_margin` (log loss 0.5608 against 0.5861) and flips 27.8% of maps against 29.3%.

Carryover, 2,677 maps on 51 events (Elo alone: 0.6451):

| Trailing feature | SD (rounds) | Margin coefficient (90% CI) | Log-loss gain (90% CI) |
| --- | --- | --- | --- |
| Execution (skill + luck) | 1.71 | +0.00 (−0.12, +0.14) | −0.0004 (−0.0006, −0.0002) |
| Skill part | 0.99 | +0.38 (+0.16, +0.62) | +0.0009 (−0.0012, +0.0028) |
| Luck part | 1.44 | **−0.17 (−0.31, −0.04)** | +0.0006 (−0.0008, +0.0018) |
| Round conversion over duels | 0.23 | −0.86 (−1.63, −0.05) | −0.0000 (−0.0010, +0.0009) |

Engine, skill variant: 2025 treated log loss is lowest at w = 0.5 (0.62067 against 0.62512 at w = 0). On 2026 treated series it scores 0.6263 against 0.6277: **gain +0.0013, 90% CI −0.0047 to +0.0076, FAIL.** Treated maps 0.6545 against 0.6566; gate set 0.6147 against 0.6151.

**Reading.**

- **Elo does carry duel luck forward.** Raw execution predicts nothing beyond Elo because its two parts cancel: the skill part is positive and the luck part is negative. That is why the raw variant and order 1's "execution adds nothing to Elo" both came out flat.
- **The engine gain points the right way but doesn't pass, and it is parked.** Every 2026 row improves, and the interval is too wide for 822 series to settle a gain of this size. Scoring the same ratings on next-map round margin doesn't settle it either (+0.16% MSE at w = 0.6, CI −0.20 to +0.31 on 1,931 maps). The run already uses the whole tier-1 LAN archive, so `luckWeight` stays 0 unless demo coverage widens.
- **Not all of the gain need be luck removal.** `x_margin_skill` adds θ, which Elo doesn't have, and trailing skill is positive beyond Elo. A player-skill term in Elo would be a separate experiment.
- **Round conversion over duels** has the same sign, which fits it failing quarter persistence, but it is one of four features and wasn't the pre-registered one.

### Value-weighted luck

The two variants above count every duel the same. This one weights each duel's luck by its **stake**, the round win probability riding on it: the man-count value of the attacker's kill plus the value of the victim's kill had it gone the other way. Both come from `data/wp/credits/neutral-fine.parquet` (side, bomb planted, own and opposing players alive), with the credit pipeline's fallback to the coarse table for buckets under 200 events. The full win-probability model isn't used because the stake needs the counterfactual kill, which only the table gives by lookup.

- `exec_luck_value = Σ (win − p − (θ_self − θ_opponent)) · stake`, in rounds, and `x_margin_value = margin − β · exec_luck_value`.
- Stakes are found for 98.9% of duels (joined to the state events by round, tick and victim); the rest get the mean. Mean stake 0.287, quartiles 0.178 / 0.306 / 0.390, top 1% above 0.745.
- β is 2.61 rounds of margin per round of luck. A round is worth 2 of margin, and the rest is probably luck that travels with duel luck but isn't in it (damage, trades).

Two checks were declared before running, and both pass:

| Check | Unweighted luck | Value-weighted luck |
| --- | --- | --- |
| Same-map margin variance explained (out of fold) | 64.9% | 68.6% |
| Carryover margin coefficient (90% CI) | −0.17 (−0.31, −0.04) | −0.19 (−0.32, −0.06) |
| Carryover log-loss gain over Elo (90% CI) | +0.0006 (−0.0008, +0.0018) | +0.0009 (−0.0007, +0.0024) |

Engine, `--luck-variant value` (exploratory, since 2026 had been seen): the 2025 tune picks w = 0.6 on both scores. On 2026 treated series it scores 0.6241 against 0.6277: **gain +0.0036, 90% CI −0.0034 to +0.0106, FAIL.** Treated maps 0.6527 against 0.6566; gate set 0.6144 against 0.6151; round-margin MSE 31.857 against 32.045 (+0.59%, CI −0.08 to +0.44 in MSE).

**Reading.** Weighting by stake is the better form: it wins on every comparison with the unweighted variant and about triples the engine gain. Neither score's interval excludes 0, so `luckWeight` stays 0.

### Non-duel luck and the skill control

Two follow-ups to the value variant, both exploratory.

**`full`: duel luck plus round conversion.** `conv` is rounds won minus the rounds expected from each round's buys, gun kills and opening duel (`cs2wp team-stats`), so it is luck in how duels turned into rounds. `x_margin_full = margin − β_v · exec_luck_value − β_c · conv`, with both βs fit jointly out of fold.

- `conv` is present on every map and is uncorrelated with value-weighted duel luck (r = 0.01). Joint β: 2.61 on duel luck, 1.76 on `conv`.
- Checks declared beforehand, the carryover one on 2025 maps only (1,441 maps): same-map margin variance 72.9% against 68.6% (pass); 2025 tuned log loss 0.61714 against 0.61994 (pass); trailing combined luck's carryover gain +0.0013 against +0.0006 (pass), but its coefficient is −0.16 (−0.34, +0.00), so the interval isn't below 0 (miss).
- Engine: w = 0.6, 2026 treated series 0.6243 against 0.6277, **gain +0.0034, 90% CI −0.0039 to +0.0106, FAIL.** That is level with the value variant's 0.6241, so the better 2025 fit didn't carry over.

**`skillonly`: the control.** The value-adjusted margin is `margin − β·exec_value + β·exec_skill_value`, so it gives Elo each player's prior duel skill as well as removing luck. `x_margin_skillonly = margin + β · exec_skill_value` keeps the first and drops the second.

- Engine: tuned w = 1 (the grid's edge), 2026 treated series 0.6256 against 0.6277, gain +0.0020, CI −0.0040 to +0.0080.
- It reproduces 31% of the value variant's 2025 gain and 56% of its 2026 gain.

**Reading.** Round-conversion luck is real on the same map but adds nothing to Elo out of sample, so the value variant stays the best form. Luck removal is the larger share of its gain on the tuning year, and player skill is a real second part: the control improves at every weight up to 1, which points at a player-skill term in Elo as its own experiment. `backtest-elo --luck` takes `--luck-variant raw|skill|value|full|skillonly`.

### Player-skill term

`skillWeight` in the Elo engine feeds prior duel skill into the prediction itself instead of through the update target. `cs2wp luck` also writes `data/elo/player-skill.json`: per Liquipedia player page (`lp_player` from `role-rounds.parquet`), `[t, exec, duels]` for each demo series, where `t` is the Elo feed's series time. 0.5% of duel views have no player page and are dropped.

- **θ at a series** is execution summed over the player's series with an earlier `t`, divided by their duels plus k = 1,207. Unlike the luck variants' θ, which stops at the event's first day, this one includes earlier series of the same event.
- **Engine.** `skillGap` is the mean θ of teams[0]'s lineup minus teams[1]'s. A player with no history takes the mean θ of teammates who have it, and the gap is 0 unless both sides have at least 3 players with history. Every map's expected score and the series probability use the rating gap plus `skillWeight · skillGap`, and the update uses that shifted expectation. The margin multiplier's damping still uses the unshifted rating gap. At 0, ratings and predictions are unchanged (`engine.test.ts`).
- `backtest-elo --skill` tunes `skillWeight` on the luck runs' treated set, on a grid of 0–100 Elo points per SD of the 2025 treated `skillGap`. `--luck-weight w --luck-variant v` holds the luck adjustment fixed while it tunes, and `--skill-weight w` scores one weight with no grid; the baseline is always no adjustment.

**Results (2026-11-14).** Skill alone tunes to 20 pts/SD and gains +0.0008 on 2026 treated series (CI −0.0006 to +0.0022): **FAIL**, and a third of what the skill-only control gave. With `value` luck at w = 0.6, the 2025 tune moves to 60 pts/SD and the 2025 loss (0.61618) is below both single runs; 2026 treated-series gain +0.0060, CI −0.0022 to +0.0144: **FAIL**. Tables in [elo-experiments.md](elo-experiments.md).

**Reading.** Prior skill on its own adds little to Elo, which already tracks team strength from results. It helps once luck is taken out of the updates: the two are separate effects, and the combined form is the best scored so far. Neither passes the gate, so both weights stay 0. Unknown players first counted as θ = 0 (the tier-1 LAN average), which cost a little outside the treated set; the teammate-mean rule removed that on 2025. Wider demo coverage in 2025–26 wouldn't add enough treated series, so the combined form gets one registered test on backfilled 2023-10 to 2024 demos, judged by an encompassing λ gate ([roadmap.md](roadmap.md), [elo-experiments.md](elo-experiments.md)).

**Registered 2024 test (2026-11-27): pass.** Encompassing λ 1.126 (CI 0.088 to 2.386), treated-series gain +0.0020 on 833 series, so `skillWeight` 8,458 and `luckWeight` 0.6 with the `value` variant are live ([elo-model.md](elo-model.md)). `cs2wp luck` also writes `data/elo/luck-live.jsonl`, the `value` columns only. Commit it and `player-skill.json` after each rerun; the nightly build reads them and doesn't run the chain. `luck-maps.jsonl` keeps every variant for backtest experiments and stays local. That includes `reliability`, the decayed-θ columns `xMarginValueH*`, and the opponent-adjusted `xMarginValueAdj` with its gitignored `player-skill-adj.json`, all read by `backtest-elo --luck-form`. All runs are logged in [elo-experiments.md](elo-experiments.md).

## Veto value lost

`wp/src/cs2wp/veto.py`. Phase 7, order 3. How much series win probability each veto step gave up against the best option, judged by a map-strength model on information from before the series.

```
npm run export-map-elo   # writes data/wp/elo-series.jsonl too
cd wp && uv run cs2wp veto [--resamples 1000] [--publish]
```

It needs the HLTV veto tables (`data/demos/hltv/veto/`, from `cs2demos match-pages`) and `elo-series.jsonl`, which has each series' lineage ids, pre-series base ratings, and map offsets over the active pool. It runs on CPU in a few minutes, and writes `data/war/veto-steps.parquet` (one row per step: options, chosen, best, both values, `lost`, `model_version`), `veto-teams.parquet` (per stint and `lp_team`) and `reports/veto.md`.

**Map model.** Elo's map offsets are too weak to judge vetoes (`kMap` 4, `mapShrink` 0.02), so the veto model has its own. Walk-forward over all 126,732 maps in the Elo feed:

`logit P(A wins map) = base Elo logit + c_u·(u[A,map] − u[B,map]) + γ·pick + δ_ban·Δban rate + δ_pick·Δpick rate`

- `u` is the lineage's decayed sum of residuals against base Elo on that map, over `decayed maps + k`, centred on the lineage's unweighted mean `u` over the series' pool (the veto's maps, else the active pool). Uncentred, `u` also carries "this team beats its Elo overall", which predicts its next maps with the wrong sign (coefficient −8.4 ± 1.0 when split out), and the single fitted `c_u` compromised between the two. Every other map feature was already centred.
- The ban and pick rates are the lineage's own, from earlier vetoes, centred on its pool mean and shrunk by 2 vetoes. The ban rate keeps permabans from looking like mistakes: a never-played map has no residuals, but it does have a ban history.
- `pick` is +1 when A picked the map, −1 when B did, and 0 for a decider or a series without a veto.

k and the decay are tuned on a grid, with the coefficients fit by logistic regression with base Elo as a fixed offset, all on 2025. Tuned values (`veto-v2`, centred `u`): k = 40 maps, decay 365 days, c_u = 3.09, γ = −0.036, δ_ban = −0.49, δ_pick = +0.18. k sits at the top of the grid, but 2025 loss is nearly flat there (0.63575 at k 40 vs 0.63585 at k 20). Picking a map carries no extra edge once map strength is known.

**Model gate.** Log loss on played 2026 maps, against Elo's map probability at the series start, with events resampled. Elo's in-series probability, after earlier maps in the same series, is reported for reference only, since the veto can't see those results.

| Maps | n | Elo map (series start) | Elo map (in series) | Model | Gain (90% CI) |
| --- | --- | --- | --- | --- | --- |
| All | 38,206 | 0.6329 | 0.6284 | 0.6313 | +0.0015 (+0.0011, +0.0020): **PASS** |
| Vetoed series only | 1,347 | 0.6486 | 0.6451 | 0.6471 | +0.0015 (−0.0023, +0.0048) |

Before centring (`veto-v1`) the gain was +0.0009 on all maps and +0.0004 on vetoed series.

The gate passes on all maps, but on the tier-1 series that have vetoes the gain is within noise. Treat the values below as the model's view, not as settled map strength.

**Value lost per step.** Series probability from per-map probabilities is exact for Bo1, Bo3 and Bo5, with every map played (order doesn't matter when maps are independent). Bo3 and Bo5 logits are scaled by `seriesMapTemp` (0.8). Each step is solved by backward induction: the step order and the acting team come from the veto table, and both teams play the model's best option afterwards. `lost = V_best − V_chosen`, from the acting team's view, so it's never negative. Side choice isn't in HLTV's veto box, so it's ignored.

**Results (2026-11-15, `veto-v2`).** 1,370 series (Bo1 187, Bo3 1,148, Bo5 35), 8,220 steps, none skipped.

- Mean lost per step: bans 1 to 4 about 0.005, picks 1 and 2 about 0.0055, Bo1's fifth and sixth bans 0.015 and 0.023. About 40–50% of steps lose anything at all. First bans aren't the main source, so the permaban check holds.
- **Persistence** (mean lost per series, 90% CI resampling series): stint split-half r 0.613 (0.465, 0.738) on 35 stints, quarter-to-quarter r 0.443 (0.353, 0.529). By `lp_team`: 0.686 and 0.390. **PASS.**
- **Hidden information:** on 2,420 played picks, slope −0.76 (−2.57, +1.00). No signal.

The rest of this section is from `veto-v1` (2026-11-14) and hasn't been rerun:

- Robustness: the persistence isn't format mix (Bo3 only: r 0.72) or series-probability compression. Heavy favourites lose less in probability because their options are close, but in log-odds r is 0.65, and after regressing out `p(1 − p)` it's 0.62. Lowest lost: Spirit (0.006 per series), Vitality (0.010). Highest: HEROIC (0.033), Liquid (0.026), M80 (0.026).
- Hidden information (`veto-v1`): on 2,402 played picks, the picker's `y − p_model` against the pick's `lost` has slope −0.98 (−2.65, +0.84). There's no sign that picks the model calls costly keep winning, but the interval is wide.

**Not published.** Persistence passes, but vetoes come from HLTV, so publishing waits on the same HLTV terms check as the WPA page. When it clears, `cs2wp veto --publish` writes `public/data/war/team-veto.json`: stints, labelled descriptive and a team decision (coaches share vetoes), with the Liquipedia credit. The Teams column on `/rankings` isn't built yet. Since the model gate is within noise on vetoed series, describe the stat as disagreement with the model.

**Series gate.** The report ends with series log loss on vetoed series against Elo's v1 series probability. It compares the actual veto's maps under Elo and under the map model, and the map model averaged over the pool. On 2026 the map model on the veto's maps loses (−0.0017, CI −0.0047 to +0.0010), so Elo's series odds stay pool-averaged ([elo-experiments.md](elo-experiments.md)).

The same map model drives the simulator's veto experiment (`cs2wp sim-veto`). It predicts real bans and picks well, but with centred `u` it only ties the current simulator on series log loss; see "Veto simulation" in [simulator.md](simulator.md).

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
uv run cs2wp war --model production --publish
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

**IGL adjustment mode (`--igl-adjustment {fixed,apm}`).** `fixed` (the default) applies $\delta_{s,g}$ only. `apm` keeps that overall level and adds the centered per-IGL calling deviation $\theta_{\text{call}}$ from [Team factor](#team-factor) on the player's tagged IGL maps so both `<v>_rw` and `<v>_conversion_rw` absorb the calling term (`context + usage + conversion_rw == rw` stays exact and the rounds-weighted IGL mean remains `0.0000`), widening IGL 90% intervals by $\theta_{\text{call}}$'s series-bootstrap SE. Default stays `fixed` until Stage 2's lineup-change gate passes.

## Uncertainty (round-level bootstrap)

For each player, played rounds are resampled with replacement using multinomial weights (1,000 resamples, seeded):

$$\mathbf{w} \sim \text{Multinomial}(N_r, \mathbf{1}/N_r)$$

For each resample, the mean round-win above average is scaled to cumulative map wins ($N_r \cdot \bar{x} / r_{\text{win}}$) and per-100-round rate ($100 \cdot \bar{x}$). We extract the 5th, 50th, and 95th percentiles to form a 90% confidence interval `(p5, p95)` displayed alongside every point estimate on the web UI.

## Validation diagnostics

Measured on the 267 qualified players (300+ rounds across 53 events), production credits, as published 2026-11-13:

| Metric | M2M r (100+ rds) | M2M r (200+ rds) | M2M r (300+ rds) | Split-half r (SB) | r with K/D |
| --- | --- | --- | --- | --- | --- |
| **WAA (`wpa_opp`, shown on the site)** | 0.299 (1475) | 0.398 (669) | 0.455 (276) | 0.461 (0.631) | not yet published |
| WAA (WPA) | 0.208 (1475) | 0.323 (669) | 0.401 (276) | 0.312 (0.476) | 0.467 |
| WAA (neutral man-count) | 0.283 (1475) | 0.399 (669) | 0.461 (276) | 0.364 (0.533) | 0.577 |
| WAA (neutral event) | 0.318 (1475) | 0.440 (669) | 0.462 (276) | 0.405 (0.577) | 0.620 |
| Raw WPA / round | 0.417 (1475) | 0.558 (669) | 0.610 (276) | 0.576 (0.731) | n/a |
| Kills above expected / round | 0.371 (1475) | 0.504 (669) | 0.546 (276) | 0.508 (0.674) | 0.738 |
| Rating 2.0 (approx) | 0.475 (1475) | 0.611 (669) | 0.651 (276) | 0.577 (0.732) | 0.945 |
| HLTV Rating 3.0 | 0.425 (1455) | 0.582 (659) | 0.659 (272) | 0.538 (0.700) | 0.870 |
| HLTV Swing | 0.380 (1455) | 0.552 (659) | 0.634 (272) | 0.502 (0.669) | 0.903 |
| K/D | 0.513 (1475) | 0.642 (669) | 0.659 (276) | 0.673 (0.805) | 1.000 |

- **K/D independence:** every WAA version that reports it is further from K/D (0.47–0.62) than HLTV Rating 3.0 (0.870) or Rating 2.0 (0.945).
- **Stability:** WAA is less stable than the box scores in every column, so the site shrinks it. See [Shrinkage](#shrinkage).

## WAR validation

`wp/src/cs2wp/warcheck.py`, `cs2wp validate-war [--test-from 2026-03-01]`, writes `data/war/reports/war-validation.md`. These checks don't need roster moves, so they run on the current archive. The roster-change test in [spec.md](spec.md) stays the deciding check. On the current archive it has about 13 usable moves, and the spec's power estimate needs 80–150.

**Split-half reliability.** Each player's series alternate into two halves (players with 300+ rounds). `k` = half rounds × (1 − r) / r is the number of rounds at which reliability reaches 0.5, so reliability at n rounds is n / (n + k). The same `k` sets the shrinkage in the prediction check and on the site ([Shrinkage](#shrinkage)).

**Does prior lineup WAR add to Elo?** For each test map, each player's rate uses only maps from before the map's event starts, shrunk toward the league mean by `k`. The feature is the difference in the two lineups' summed rates. A no-intercept logistic fit (team order is arbitrary) on the pre-map Elo logit plus that feature is scored by leave-one-event-out log loss against an Elo-only refit. A 90% interval on the gain comes from resampling whole series. HLTV 3.0 and K−D per round go through the same pipeline as comparators.

**Current results (2026-11-13, `production` credits, 3,112 maps, 267 players).** The test set is 1,161 maps from 2026-03-01.

| Metric | Half r | k (rounds) | Within-team r | Team share | r with team Elo | Alone | Gain over Elo (90% CI) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **WAA (`wpa_opp`)** | **0.461** | 984 | 0.400 | 0.263 | 0.449 | 0.6576 | −0.0004 (−0.0027, +0.0018) |
| WAA (neutral event) | 0.405 | 1,234 | **0.554** | 0.381 | 0.495 | 0.6572 | −0.0006 (−0.0031, +0.0018) |
| WAA (neutral man-count) | 0.364 | 1,472 | 0.442 | 0.239 | 0.392 | 0.6611 | −0.0008 (−0.0027, +0.0010) |
| WAA (WPA) | 0.312 | 1,852 | 0.392 | 0.089 | 0.076 | 0.6781 | −0.0011 (−0.0019, −0.0003) |
| HLTV Rating 3.0 | 0.538 | 702 | 0.617 | 0.179 | 0.306 | 0.6565 | −0.0002 (−0.0033, +0.0027) |

**Decision (2026-11-22): the site lists one rating, `wpa_opp`.** The other three stay in `players.json` and the reports as diagnostics.

- `wpa_opp` is the most reliable version over a player's whole record and keeps real leverage.
- It is **not** free of team strength: its team share and r with team Elo are both above HLTV 3.0's. "Own team at average Elo" describes the credit, so don't label it team-neutral.
- Neutral event is the version to revisit. It separates teammates better and is slightly steadier month to month, but a team share of 0.381 and four Vitality players in its top 20 are too much team strength for a player rating.
- Raw WPA under-credits players on strong teams.
- None of them improves on Elo, and none beats HLTV 3.0 at prediction or stability. WAA says what a player's actions were worth. It isn't a forecast.

### Shrinkage

`cs2wp war` shrinks every version's rate toward the league mean: `(rw + k·mean) / (rounds + k)`, the formula `shrunk_rates` in `warcheck.py` uses (both call `shrunk_rate` in `war.py`). k is each version's split-half k from `warcheck.split_half`, recomputed on the same rows `cs2wp war` publishes (same window and IGL mode), so it never goes stale. The mean is measured from those rows too: 0 for WAA, and −replacement rate for WAR, since `<v>_rw` subtracts it. (The old TS formula used +replacement rate, which would have been wrong for any WAR publish.)

`players.json` carries `metrics.<v>.per100Shrunk`, `shrinkRounds` (k per version) and `leagueMeanPer100`, and lists players by shrunk `wpa_opp`. The site's `waaRate` in `src/war/players.ts` reads `per100Shrunk`, and the `/players` subtitle reads `shrinkRounds`. `--publish` refuses when `wpa_opp`'s k can't be estimated (fewer than 10 paired players, or r ≤ 0). The `war.md` report prints every k and ranks its tables by the shrunk rate. Map wins, the 90% intervals, context, usage, conversion, `vs HLTV` and the style percentiles stay unshrunk.

On the 2026-11-23 publish (`production` credits, 3,112 maps, 267 players), k is 984 for `wpa_opp`, 1,237 neutral event, 1,476 neutral man-count and 1,854 WPA, the same as `validate-war`.

Out-of-sample check (2026-11-22): rates from before each cutoff predict rates after it, for players with 300+ rounds on both sides. Errors are squared, per 100 rounds, weighted by later rounds. Run on the local `role-rounds.parquet`, which is slightly newer than the published file (rates differ by 0.032 at most).

| Cutoff | Players | k fit before cutoff | MSE raw | MSE, fitted k | MSE, k = 984 | Rank r raw | Rank r, k = 984 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2025-10-01 | 145 | 847 | 0.694 | 0.555 | 0.561 | 0.594 | 0.592 |
| 2026-01-01 | 139 | 1,142 | 0.692 | 0.589 | 0.584 | 0.549 | 0.555 |
| 2026-03-01 | 141 | 981 | 0.779 | 0.699 | 0.699 | 0.492 | 0.513 |
| 2026-06-01 | 132 | 825 | 0.813 | 0.679 | 0.683 | 0.549 | 0.549 |

Shrinkage cuts error by 10–19% at every cutoff without losing rank order, and the fixed k matches a refitted one.

### Interval calibration

`validate-war` checks whether the 90% round-bootstrap intervals are too narrow (the spec's "interval calibration" candidate). Rounds within a map share an opponent, a team and an economy, so they might not be independent. Rerunning a 1,000-draw bootstrap for every split is too slow, so the check uses the SEs the bootstraps converge to: round SE = sd(round values) / √n, and the map-cluster SE of the ratio estimator, √Σ(sₘ − rate·nₘ)² / n. A spot check on 20 players confirms the round SE matches the published bootstrap (median half-width ratio 0.998).

For each player, z = (rate₀ − rate₁) / √(se₀² + se₁²) between two halves of their record, and coverage is the share with |z| < 1.645:
- **Alternating series** (players with 300+ rounds): the true rate doesn't change between halves, so calibrated intervals cover 90%.
- **Next period**: 300+ rounds on each side of 2025-10-01, 2026-01-01, 2026-03-01 and 2026-06-01. Real change lowers coverage, so this is context, not the test.

`c` is the 90th percentile of |z| / 1.645, the factor intervals would need to widen by.

Rule set before the run: keep round resampling if `wpa_opp`'s alternating coverage is 85% or more. Otherwise, switch the published bootstrap to whole maps if map-cluster coverage lands in 85–95%.

2026-11-23, `production` credits, 267 players, 557 next-period pairs:

| Metric | Alternating: round | map | c round | c map | Next: round | map | c round | c map |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **WAA (`wpa_opp`)** | **90%** | 90% | 1.01 | 1.03 | 87% | 85% | 1.09 | 1.12 |
| WAA (WPA) | 89% | 89% | 1.04 | 1.02 | 85% | 85% | 1.15 | 1.17 |
| WAA (neutral man-count) | 88% | 87% | 1.07 | 1.06 | 84% | 87% | 1.15 | 1.10 |
| WAA (neutral event) | 81% | 85% | 1.33 | 1.15 | 83% | 85% | 1.30 | 1.14 |

- **Kept round resampling.** The site's `wpa_opp` intervals cover 90% on alternating series, and resampling whole maps changes nothing. Round credits are mostly win-probability changes, which barely correlate from one round to the next within a map.
- Next period loses only 3 points (87%), so real change between seasons is small next to sampling noise. That's consistent with k near 1,000.
- Neutral event's round intervals are about a third too narrow (81%, c 1.33). Its context-average values share more within a map. It's a diagnostic only, so nothing changes, but use map resampling if it's ever published.

**Earlier results (2026-11-06, dry-run credits, 1,312 maps).** These and the two follow-ups are the history behind `wpa_opp`. Current numbers are above.

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

**Follow-up 3: blended event values (2026-11-23). Rejected.** The question was whether a blend of state-specific and context-average values is steadier than either one. The blend is V = w · V(`wpa_opp`) + (1 − w) · V(`nwpa_event` bucket mean). Every version splits an event's value with the same weights, so blending credit rows is exactly blending event values. The blend columns come from the existing credit files, and the WP model doesn't run again. The bucket means are fit on plain `v` (both teams at their real Elo), not on `v_opp`. Averaged over all training events, that's close to Elo-neutral.

```
cd wp
uv run cs2wp baselines --blend    # data/war/role-baselines.blend.parquet, role-rounds.blend.parquet (BLENDS in baselines.py)
uv run cs2wp validate-war --role-rounds ../data/war/role-rounds.blend.parquet   # reports/war-validation.blend.md
```

Rule set before the run:
- Pick w by split-half r.
- Adopt over `wpa_opp` only if the paired Δ split-half r has a 90% interval above 0. The interval resamples players on the same alternating halves.
- Guards: team share no more than `wpa_opp`'s + 0.05, no team with 5 of the top 20, and the gain-over-Elo lower bound no worse than `wpa_opp`'s by more than 0.001.

`production` credits, 267 players and 310 stints with 300+ rounds, test maps from 2026-03-01. The endpoints match the table above (`wpa_opp` k 984; neutral event 1,237 against 1,234, from refitting baselines on current role inputs).

| w | Split-half k | Δ half r vs `wpa_opp` (90% CI) | Within-team k | Team share | r with team Elo | Top 20: most from one team | Gain over Elo (90% CI) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 (neutral event) | 1,237 | −0.056 (−0.141, +0.020) | 597 | 0.381 | 0.488 | 4 | −0.0010 (−0.0029, +0.0007) |
| 0.25 | 1,050 | −0.016 (−0.081, +0.043) | 639 | 0.346 | 0.474 | 4 | −0.0010 (−0.0028, +0.0007) |
| 0.50 | 954 | +0.008 (−0.036, +0.046) | 741 | 0.313 | 0.451 | 4 | −0.0010 (−0.0027, +0.0007) |
| 0.625 | 936 | +0.013 (−0.020, +0.041) | 813 | 0.298 | 0.437 | 3 | −0.0009 (−0.0026, +0.0007) |
| 0.75 | **935** | +0.013 (−0.009, +0.031) | 898 | 0.285 | 0.422 | 3 | −0.0009 (−0.0026, +0.0007) |
| 0.875 | 952 | +0.008 (−0.002, +0.018) | 995 | 0.273 | 0.405 | 3 | −0.0009 (−0.0025, +0.0006) |
| 1 (`wpa_opp`) | 984 | — | 1,105 | 0.263 | 0.388 | 3 | −0.0009 (−0.0024, +0.0005) |

- **Not adopted.** The best blend (w ≈ 0.62–0.75) gains about 0.013 in split-half r (k 935 against 984), and every interval covers 0. w = 0.75 passes every guard, so the only failure is the gain being too small to show.
- **Overall, the state-specific part doesn't add noise.** On current credits, `wpa_opp` is already steadier than neutral event over a player's whole record (k 984 against 1,237). The within-team gap from 2026-11-06 is still there, though: 1,105 for `wpa_opp` against 597.
- **Blending trades within-team for team strength.** Moving w toward 0 lowers within-team k from 1,105 to 597, and raises team share from 0.26 to 0.38 and r with team Elo from 0.39 to 0.49. Context-average values separate teammates better because they also give players on strong teams more credit. Split-half reliability can't choose between those, so it's not a reason to move off `wpa_opp`.
- Revisit only with roughly twice the players (the interval is ±0.02 at 267), or if the roster-change test favours within-team separation.

## WAA vs HLTV 3.0

`hltv_gap` in `wp/src/cs2wp/war.py` standardizes `gap_v = z(v_per100) − z(rating3)` over all qualified players (`300+` rounds with a non-null `rating3`, IGLs included). The 90% interval standardizes `p5` and `p95` with the same pool mean and SD, holding HLTV 3.0 fixed; players without HLTV 3.0 get `null`. Because `z(WAA) − z(HLTV)` correlates negatively with extreme HLTV ratings by regression to the mean, very high HLTV ratings lean negative even without a role penalty.

Across `266` qualified players with `rating3` (`wpa_opp`, `r = 0.722` with HLTV 3.0), the gap tracks role and resource allocation (`r = -0.406` with usage/100, `r = +0.432` with conversion/100):
- **IGL flag:** IGLs (`n = 51`) average `+1.086` SD vs `-0.258` SD for non-IGLs (`n = 215`). All 10 largest positive gaps are IGLs (`s1n +2.09`, `alex  +1.94`, `exit +1.85`, `Aleksib +1.81`, `nitr0 +1.69`, `cadiaN +1.68`, `gafolo +1.67`, `MAJ3R +1.65`, `apEX +1.64`, `alex666 +1.59`).
- **T role:** AWPer (`n = 53`) `-0.588` SD, Entry (`n = 49`) `-0.400` SD, Rifler (`n = 164`) `+0.310` SD. Of the 10 largest negative gaps, 7 are AWPers (`kl1m -2.65`, `s1mple -1.50`, `hades -1.45`, `hyped -1.27`, `s1zzi -1.26`, `story -1.21`, `slaxz- -1.16`) and 3 are Entries (`Shr -2.05`, `xKacpersky -1.23`, `chelo -1.23`).
- **CT role:** AWPer (`n = 53`) `-0.588` SD, Anchor (`n = 123`) `+0.230` SD, Rotator (`n = 90`) `+0.032` SD.

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

## Public interface (`/players`)

`/players` (`src/pages/Players.tsx`) is laid out like `/rankings`: a search box and a view switch (`?view=`) for WAA (the default), Clutch (`clutch.json`) and Validation (the stability diagnostics for `wpa_opp`, before shrinkage). `/war` redirects here, keeping the query string. Every player name links to `/players/:player` (`src/pages/PlayerPage.tsx`), keyed by the in-game name, which is unique across published players; lookup falls back to a case-insensitive match. The player page shows the one WAA rating with its rank among IGLs or non-IGLs, map wins, the unshrunk rate, context, usage, conversion and `vs HLTV`, then Style (`style.json`: the archetype, production and style percentile bars (not the `rating` metric, which is the unshrunk rate and would contradict the rank) drawn with `src/components/PercentileRow.tsx`, and the 5 nearest production and style comps; see [Style and archetypes](#style-and-archetypes)), then the profile (roles, CT positions by map, duels and box score, resources), clutch conversion when published, and teammates on the same Liquipedia team.

The WAA view:
- Reads `public/data/war/players.json` with TanStack Query.
- Headlines and ranks on the [shrunk](#shrinkage) rate per 100 rounds, colored only when the unshrunk 90% interval excludes zero. The tooltip has the unshrunk rate and interval.
- Map wins is secondary: the unshrunk total, with its 90% bootstrap interval and interval bar (`aria-hidden="true"`).
- Role filters (`All`, `AWP`, `Entry`, `Rifle`). There's no credit toggle: `?credit=` is ignored.
- `vs HLTV` gap column (`z(unshrunk WAA/100) − z(HLTV 3.0)` in SD units, sortable, `"–"` when HLTV 3.0 is missing), with the 90% interval in its tooltip.
- Usage and Conversion columns (per 100 rounds, unshrunk, 90% intervals).
- Provisional banner, shown only when the file was published from a model that failed the gate.
- Full CC-BY-SA Liquipedia and HLTV demo attribution.
- Team names link to the team page (`/teams/:team`). Team stat tables live on `/rankings`, not here.

## Team factor

`wp/src/cs2wp/teamfactor.py`. Measures round-wins over player-WAR expectation (`team-map-residuals.parquet`), estimates Ridge team factors `τ` (`team-factors.parquet`), fits sparse player/calling adjusted plus-minus `θ` (`player-apm.parquet`), and runs both shipping gates (`data/war/reports/team-factor.md`).

```
cd wp
uv run cs2wp team-factor   # writes data/war/team-map-residuals.parquet, team-factors.parquet, player-apm.parquet, reports/team-factor.md
```

**Design constraints.**
- **Out-of-sample expectation, no team Elo.** Same-map WPA credits sum to round outcomes minus drift, so expectation uses out-of-sample shrunk player rates (`loeo` across all other events by default; `prior` strictly before the event start for forward tests) with `wpa_opp` as the primary credit and no Elo in the expectation.
- **Unidentifiable average calling level.** Every 5-man lineup has one tagged IGL, so a constant caller offset cancels in $A - B$. Only differences *between* IGLs are identified from plus-minus; replacing the fixed offset keeps "the average IGL is league average (`0.0000`)" as the baseline level and adds centered per-IGL deviations on top.

**Stage 1: Team-map residual & team factor `τ`.** Across 3,111 5v5 maps, `2,671` (`85.9%` of maps, `96.7%` of player slots) have all 10 players at `>= 100` out-of-sample rounds (`r_win = 5.68`). Linear `share − 0.5 = β·x` is fit leave-one-event-out weighted by rounds with no intercept, giving antisymmetric residuals `rounds × (share − 0.5 − β·x)`. Ridge (`residual = τ_A − τ_B`) fits `lp_team × IGL stint` (and plain `lp_team`), penalized by alternating-series split-half `k` with series-bootstrap 90% CIs.

- **Stage 1 gate: FAIL.** For `wpa_opp` across `58` stints with 300+ rounds, split-half reliability is `r = 0.239`, 90% CI `(-0.017, +0.467)` (`k = 2,285` rounds / `105` maps; plain `lp_team` `r = 0.265`, 90% CI `-0.044, +0.523`, `k = 2,818` rounds / `129` maps across 43 teams). Walk-forward `prior` gain is `+0.40 × 1e-4` (90% CI `-1.11, +1.81`), and correlation with `team Elo − summed-WAR Elo` is `0.616`. Because the 90% CI includes 0, `cs2wp team-factor --publish` does not ship Teams to `/war`.

| Metric (58 stints, 300+ rds) | β | Split-half r (90% CI) | k (rds / maps) | Forward prior gain × 1e-4 (90% CI) | Sanity r |
| --- | --- | --- | --- | --- | --- |
| `wpa_opp` (primary) | `1.548` | `0.239 (-0.017, +0.467)` | `2,285 / 105` | `+0.40 (-1.11, +1.81)` | `0.616` |
| `wpa` | `2.176` | `0.586 (+0.405, +0.724)` | `508 / 23` | `+8.35 (+5.18, +11.36)` | `0.816` |
| `nwpa_mancount` | `1.689` | `0.378 (+0.139, +0.574)` | `1,185 / 54` | `+2.06 (-0.19, +4.23)` | `0.700` |
| `nwpa_event` | `1.321` | `0.387 (+0.151, +0.582)` | `1,139 / 52` | `+1.42 (-0.76, +3.52)` | `0.709` |
| `rating3` | `0.183` | `0.350 (+0.114, +0.550)` | `1,336 / 61` | `+1.33 (-0.77, +3.36)` | `0.677` |
| `kd_diff` | `0.196` | `0.293 (+0.052, +0.503)` | `1,731 / 79` | `+0.72 (-1.21, +2.63)` | `0.656` |

Raw `wpa` reaches `r = 0.586` mainly because it still mixes opponent/team strength into player credit; `wpa_opp` strips own-team Elo pricing. Spec sense checks line up directionally on `wpa_opp` (`τ / 100 rounds`, 90% CI, maps over expected):
- Positive calling/tactical environments: The MongolZ (`BLitz`) `+2.10 (+1.24, +3.03)` (`+22.57w`, 275 maps), Team Vitality (`ApEX`) `+0.74 (-0.12, +1.68)` (`+8.53w`, 308 maps), FURIA (`FalleN`) `+0.73 (-0.21, +1.58)` (`+9.40w`, 333 maps).
- Stint & IGL contrasts: FaZe Clan (`Karrigan`) `+1.08 (-0.04, +2.21)` vs (`Twistzz`) `-0.10 (-0.94, +0.78)`; Team Falcons (`Karrigan`) `+0.65 (-0.19, +1.48)` vs (`Kyxsan`) `-0.14 (-1.16, +0.79)`; MOUZ (`XertioN`, June stint) `+1.53 (+0.39, +2.66)` (`+4.02w`) vs (`Brollan`) `-0.60 (-1.59, +0.35)` (`-4.88w`); G2 (`HuNter-`) `+0.22 (-0.86, +1.38)` vs (`Snax`) `-0.72 (-1.77, +0.35)`; Team Spirit (`Chopper`) `+0.77 (-0.24, +1.63)` vs (`Magixx`) `-0.17 (-1.41, +1.12)`.

**Stage 2: Adjusted plus-minus (`θ_play`, `θ_call`).** Sparse weighted Ridge decomposes the same residual into per-player playing columns and per-IGL calling columns (active only on tagged IGL maps), tuned over `(alpha_play, calling_ratio)` by LOEO MSE:
- **Calling vs playing shrinkage finding:** LOEO picks `alpha_play = 640,000` rounds and `calling_ratio = 64` (`alpha_call = 10,000` rounds), yielding `+0.299 × 1e-4` LOEO MSE gain over zero vs `+0.096 × 1e-4` peak for playing-only (`ratio = 0`, at `alpha_play = 80,000`) — roughly 3× the out-of-fold gain.
- **Stage 2 gate: FAIL.** On the `89` maps (`89` series) where a lineup differs from its team's previous lineup, player+calling APM beats Stage 1 stint by `+2.046 × 1e-4`, 90% CI `(-0.805, +5.160)` (not significant). Player `θ_play` split-half across players with `2+` lineups is `-0.133` (`n = 178`; `-0.149` at 300+ rds, `n = 243`), reflecting sparse roster overlap on the current archive. Top calling terms (`θ_call / 100` rounds, 90% CI): `BLitz +1.03 (+0.58, +1.51)`, `XertioN +0.64 (+0.22, +1.07)`, `MAJ3R +0.57 (+0.09, +1.03)`, `Karrigan +0.53 (+0.06, +0.99)`, `HooXi +0.35 (-0.13, +0.80)`, `ApEX +0.34 (-0.11, +0.82)` vs `Brollan -0.34 (-0.79, +0.10)`, `S1n -0.35 (-0.70, -0.04)`, `Nitr0 -0.39 (-0.67, -0.13)`.

**Stage 3: `fixed` vs `apm` side-by-side (`wpa_opp`, `production` model).** Both modes keep IGL mean `-0.0000 / 100`, league mean `+0.0000 / 100`, and `context + usage + conversion_rw == rw` exact; `fixed` remains default.

| Player | `--igl-adjustment fixed` (per 100 / WAA) | `--igl-adjustment apm` (per 100 / WAA) | Shift (`Δ / 100`, CI half-width `Δw`) |
| --- | --- | --- | --- |
| `bLitz` | `+0.97 [+0.56, +1.41]` / `+10.67w` | `+1.90 [+1.28, +2.53]` / `+20.97w` | `+0.93`, `+0.40` |
| `apEX` | `+0.62 [+0.22, +1.00]` / `+7.54w` | `+0.86 [+0.26, +1.49]` / `+10.54w` | `+0.24`, `+0.44` |
| `FalleN` | `-0.30 [-0.67, +0.06]` / `-4.18w` | `-0.07 [-0.61, +0.57]` / `-0.95w` | `+0.23`, `+0.46` |
| `karrigan` | `-1.95 [-2.36, -1.55]` / `-20.65w` | `-1.52 [-2.11, -0.88]` / `-16.15w` | `+0.43`, `+0.41` |
| `xertioN` | `+0.90 [+0.49, +1.32]` / `+11.28w` | `+1.07 [+0.65, +1.51]` / `+13.51w` | `+0.17`, `+0.03` |
| `Brollan` | `+0.41 [-0.08, +0.89]` / `+3.48w` | `-0.03 [-0.72, +0.62]` / `-0.27w` | `-0.44`, `+0.38` |
| `ZywOo` (control) | `+2.86 [+2.41, +3.29]` / `+36.57w` | `+2.86 [+2.40, +3.31]` / `+36.69w` | `+0.00` |

## Map tendencies (`cs2wp heatmaps`)

`wp/src/cs2wp/radar.py` and `wp/src/cs2wp/heatmaps.py`. Per-map positional heatmaps, repeated utility lineups and callout summaries rendered over Valve's 1024 px radars on `/players/:player`.

```bash
cd wp
uv run cs2wp radars                                   # public/radar/*.webp + data/war/radar.json
uv run cs2wp heatmaps [--months 6] [--from DATE] [--rebuild] [--publish] [--upload]
```

**Radar assets (`cs2wp radars`).** Reads `awpy.data.map_data(NAV_RELEASE)` (`pos_x`, `pos_y`, `scale`, lower-level `z` bounds), commits the active-pool subset to `data/war/radar.json`, and converts awpy's radar PNGs (including `_lower` variants for Nuke, Train and Vertigo) to 1024 px WebPs in `public/radar/<map>.webp`. `world_to_radar(map, x, y, z)` matches `awpy.plot.world_to_pixel`: `px = (x - pos_x) / scale`, `py = (pos_y - y) / scale`, split into `upper` and `lower` levels by `z`.

**Extraction and caching.** `map_layers(ref)` runs across 6 worker processes and caches incrementally in `data/war/heatmaps-raw.parquet` (plus companion `heatmaps-lineups-raw.parquet`, `heatmaps-callouts-raw.parquet`, `heatmaps-rounds-raw.parquet`, all gitignored), keyed on `map_key`.

- **Grid:** 64×64 over the 1024 px radar (16 px cells, ~80 game units).
- **Phases** (measured from `freeze_end_tick`): **Setup** `0–20 s`, **Mid** `20–50 s`, **Late** `50 s+` before the bomb plant, and **Post-plant** from `finish_plant` onward. Rounds without a plant have no post-plant phase.
- **Layers:** `presence` (alive 4 Hz ticks per phase, normalized by rounds played on that side), `kills` (attacker position), `deaths` (victim position), `open_kill` / `open_death` (from `roles.openings()`), `plant` (T only, from `bomb.finish_plant`), and `util_land:<type>` (`smoke`, `flash`, `he`, `molotov` via `resources.thrower_grenades(with_origin=True)`).
- **Lineups (landing zones):** Greedy density clustering in radar px per `(side, type, level)` with type-specific landing radii (smoke 32, molotov 36, HE 40, flash 56 px). Within each landing zone, throw origins are clustered with a 24 px radius, sorted by count descending and capped at 8 (`from: [[px, py, n], ...]`, dominant origin first). Zones with ≥2 throws are kept, sorted by `n` desc then `tMed`, capped at top 10 per `(type, side)` as `{ land: [px, py], r, n, share, tMed, level, from }` where `r` is the 80th-percentile landing distance from the zone center (clamped to ≥8 px). `land_cell` and `throw_cell` remain in the cached parquet to avoid a forced `--rebuild`.
- **Callouts:** Alive time per `last_place_name` per side and phase, plus kill and death callouts (backward `join_asof` onto `ticks` within 1 s), opening-duel W/L and traded-death share.

**Window and scope.** Default `--months 6` (from the latest map date in the mirror). Each player's current `lp_team` is their most recent non-null team in the window. On a given map, a player uses only maps with their current team when they have ≥3 maps there (`scope.type = "team"`); otherwise that map falls back to all teams in the window (`scope.type = "all"`). Player-maps under 3 maps are omitted; maps under 8 carry `lowSample: true`.

**Encoding and baselines.** Every grid is sparse, sorted by flattened cell index and delta-coded: `{ max, n, cells: [dIdx, v, ...] }`. Average baselines (`v2/_avg/<map>.json`) average all qualifying players' per-round rates per `(side, level, layer, phase)` and store them scaled by `10000` in the same sparse encoding to drive the frontend's diverging "vs average" view.

**Outputs, budget and R2 layout.** Schema `v2`, written under `public/data/war/heatmaps/` (gitignored) with `--publish` and synced to the public R2 bucket under `heatmaps/v2/` with `--upload`:

- `heatmaps/v2/<steamid>/index.json`: map list, sample counts, scope, `lowSample`, levels, top 5 callouts per phase/kills/deaths, opening-duel W/L and traded-death share.
- `heatmaps/v2/<steamid>/<map>.json`: grids and utility landing zones.
- `heatmaps/v2/_avg/<map>.json`: per-map average baselines.

Budget enforced on every run: ≤30 KB gzipped per player-map file and ≤15 MB gzipped total (2026-11-21 6-month run: 942 maps, 221 players, 1,018 player-maps, 7.76 MB gzipped total, 15.5 KB largest player-map). Old `heatmaps/v1/` keys on R2 are not deleted by the `v2/` sync and need manual cleanup.

**R2 and env vars.** `--upload` uses `R2.public()` (`R2_PUBLIC_BUCKET` in `.env`, keeping `R2_BUCKET` private for the HLTV cache), uploads deterministic gzip (`mtime=0`) with `ContentType: application/json`, `ContentEncoding: gzip`, `Cache-Control: public, max-age=3600`, skips unchanged keys by matching MD5 against the remote ETag, and deletes stale keys under `heatmaps/v2/`. The frontend reads `VITE_HEATMAPS_URL` (e.g. `https://<public-r2-origin>/heatmaps`, falling back to `${BASE_URL}data/war/heatmaps/` in local dev).

**Frontend.** `src/components/heatmap/MapTendencies.tsx` (lazy-loaded in `PlayerPage.tsx` after `ProfileSection`), `RadarHeatmap.tsx`, `CalloutList.tsx`, `src/war/heatmap.ts`, `src/war/heatmapTypes.ts`. Decodes sparse grids, normalizes per round, applies separable Gaussian blur (`σ = 1` cell), colorizes with a perceptually uniform sequential ramp (or blue–orange diverging ramp for "vs average", emerald/rose overlay for opening duels), and upscales onto the radar `<canvas>` with SVG utility landing-zone rings, dominant arrows and throw-spot overlays on top.

## Team utility protocols (`cs2wp protocols`)

`wp/src/cs2wp/protocols.py`. How often each team lands utility in each of the league's landing zones on a map and side, how early, and who throws it, against every team on the same map, side and round type. It's shown on team pages (Utility protocols) and, per player, under Map tendencies.

```bash
cd wp
uv run cs2wp protocols [--months 6] [--rebuild] [--resamples 1000] [--publish] [--upload] [--allow-stale-overrides]
```

It needs the demo mirror, `resource-rounds.parquet` (`cs2wp usage`, for buys), `tactics-raw.parquet` (`cs2wp tactics`, for group entries) and `team-map-residuals.parquet` (`cs2wp team-factor`, for IGL stints). It runs on CPU: extraction takes a few minutes on 6 workers the first time and is incremental after, and the stats take about 15 s.

**Extraction.** `map_rows` reuses the heatmaps grenade path (`heatmaps.round_nades`: `resources.thrower_grenades` with origins, live play only, radar coordinates), keeps attributed grenades that land and start on the radar, and takes the team from the round's `ct_lp_team` / `t_lp_team` for the thrower's side. Each landing gets `land_place`, the `last_place_name` of the nearest player tick sample on that map (3D), so zones get callouts without a nav place table. The caches are `data/war/protocols-raw.parquet` (one row per grenade, with `round_num`), `protocols-rounds-raw.parquet` (player-rounds, for denominators) and `protocols-attribution-raw.parquet` (grenades and attributed grenades per map and type). The heatmaps lineup cache has no `round_num`, so it can't give per-round rates.

**Round classes.** `gun` (full buy, not a pistol round; the default view), `pistol`, and `light` (eco or force), from `resource-rounds.parquet`'s `team_buy` and `pistol`. A T round is a fast hit when tactics' group entry (3+ Ts in the site within 5 s) comes before 30 s. That's 1–10% of gun T rounds per map, too few for a per-team class, so it's published only as each team's round mix next to the league's. Single-player first entries were the first candidate, but their timing has no fast/slow split to cut at, and on Nuke they fire at 10–15 s on B in about 2,000 rounds without a plant (a site-geometry quirk in `tactics`, see below).

**League zones.** Per (map, side, grenade type, radar level), over every attributed throw in the window: landings are binned to 8 px cells and clustered with the heatmaps greedy density clustering, weighted by throws per cell, at the heatmaps landing radius (smoke 32, molotov 36, HE 40, flash 56 px). `_greedy_clusters` now builds its neighbour matrix sparsely (`cKDTree`), which gives identical clusters to the dense version and scales to league-wide counts. A zone is kept when the league lands that grenade type in it on 5%+ of the side's gun rounds; every throw then goes to the nearest kept centre within the radius. Zone ids are unique per map, ordered by side and then the league's median first-throw time on gun rounds.

**Zone overrides and merging (`data/war/protocol-zones.json`).** Committed JSON (`{ version: 1, maps: { <mapSlug>: [{ side, type, level, match: [[px, py], ...], name, description?, source, confidence, reviewed, note }] } }`) keyed by geometry because zone ids renumber with league timing.
- **Matching:** each `match` point claims the nearest kept zone of that `(map, side, type, level)` whose `land` centre is within `max(r, 30 px)`. Unmatched zones keep their default `"<Type> <formatted place>"` label. Any point matching nothing or claiming an already-claimed zone fails the run with the map and point unless `--allow-stale-overrides` is passed.
- **Merging:** runs after the 5% kept-zone threshold and throw assignment, and before round hits, rates, timing, throwers, the bootstrap and the gate. Multi-point entries merge their parts into one zone: `land` is the throw-weighted centre, `r` encloses every part's ring, `from` is the combined top 3 throw spots (re-clustered at `ORIGIN_RADIUS_PX`), and `assigned` throws remap to the merged zone so a round counts once even if it hits multiple parts. `name`, `description` and `reviewed` are published on the league zone.

**Stats.** A round counts for a zone when the team lands at least one grenade of the zone's type in it.

- `rate`: share of the team's rounds in the class with a hit. `league`: the same over every team's rounds in the 6-month window (the team included).
- `diff = rate − league`, with a 90% interval from resampling the team's series (1,000 draws; rounds in a series share opponents and economy).
- Timing: per hit round, the first throw's seconds from freeze end. Median, and counts in `0–5, 5–10, 10–20, 20–35, 35–50, 50+` s.
- Throwers: per player, the share of the team's hit rounds they threw into the zone, and their own per-round rate. A player page lists gun-round zones at 20%+ of the player's own rounds.

**Window.** The last 6 months, cut at the start of the team's current IGL stint (its latest `stint_id` in `team-map-residuals.parquet`) when that began later. A team-map needs 5+ maps in the window; under 10 is flagged low sample. Demo coverage, not the stint cut, limits the team count: the cut costs 1 team (29 → 28).

**Gate (stability, since this is descriptive).** Split-half over alternating series per team and map: the correlation of `rate − league` between halves, pooled over every (team, map, side, zone) cell on gun rounds with 30+ rounds a half, with a 90% interval resampling teams. It publishes when the lower bound is above 0.5. Per-zone reliability, `1 − mean bootstrap variance / variance of team rates` over 5+ teams, is report-only. Hiding the league comparison on low-reliability zones was tried and dropped: Mirage's T window smoke has reliability 0.13 because nearly every team throws it (league 91%), so the rule hid exactly the comparison this exists for. The interval already shows how sure each difference is.

**Attribution.** Flashes are attributed about 69% of the time, smokes 95%, HEs and molotovs 98%. A uniform miss cancels in `diff` but lowers every flash `rate`. The report flags team-types 10+ points off the league; both teams on a map share its rate, so only large gaps show.

**Results (2026-11-26, window 2026-05-11 → 2026-11-11).** 942 maps, 40,666 team-side rounds (27,980 gun), 705 zones (down from 767 raw zones after 58 merges absorbing 62 duplicates via `data/war/protocol-zones.json`), 28 teams on 130 team-maps.

| Check | Result |
| --- | --- |
| Split-half r, pooled (6,470 cells, 147 team-map-sides, 22 teams) | **0.601** (0.558, 0.633): passes (pre-merge 767 zones: 0.612 (0.578, 0.640)) |
| Per map | Ancient 0.635, Nuke 0.630, Inferno 0.604, Anubis 0.599, Mirage 0.594, Dust2 0.577, Cache 0.504 |
| Zone reliability (705 zones) | median 0.603, quartiles 0.365 / 0.742 |
| Attribution flags | NRG smokes 0.81 against 0.95 |

Findings:

- **Protocols are stable team habits.** A team's deviation from the league in one half of its series predicts the other half at r 0.61.
- **The league defaults show up as expected.** Mirage T: window smoke (`SnipersNest`) on 91% of gun rounds at a median 0.4 s, top-mid smoke 69% at 0.5 s, then a mid molotov 37% at 8 s. Ancient T: top-mid smoke 82% at 0.5 s.
- **Example.** Vitality smoke window on 96% of Mirage T gun rounds, +4.9 points (+1.7, +7.6) over the league, mostly thrown by ZywOo (38%).

**Outputs.** Schema `v1`, written under `public/data/war/protocols/` (gitignored) with `--publish`, synced to R2 `protocols/v1/` with `--upload` (as heatmaps). Publishing refuses when the gate fails or a file is over budget (40 KB gzipped per team, 8 MB total; the 2026-11-26 run is 0.76 MB, largest 38 KB).

- `v1/_league/<map>.json`: zones (side, type, level, radar `land`, `r`, `place`, optional `name`, `description`, `reviewed`, top 3 throw spots), league `rate`, `tMed`, `bins` per class, reliability, rounds per class and the league fast-hit share.
- `v1/teams/<teamSlug>.json`: window and stint, player names, and per map and side the round mix, fast-hit share and per class the zone rows (`rate`, `diff`, `lo`, `hi`, `tMed`, `bins`, up to 3 throwers with 10%+ share). Zones the team never used are kept only on gun rounds and only when the league uses them on 10%+ of rounds.

**Frontend.** `src/components/protocols/TeamProtocols.tsx` (lazy-loaded on `TeamPage.tsx`) shows a map picker, side, round type and radar level, a radar with rings coloured by grenade type and labelled with the team's rate, and a timeline table (median first throw, zone, team-vs-league dot plot with rates and difference, timing histogram, top thrower). The dot plot puts the team's rate (dot) and the league's (tick) on one 0–100% scale; the interval is in its tooltip. A zone is an outlier, with a coloured line and ▲/▼ (blue more, orange less) and a chip in the "Stands out" line above the table, when the 90% interval excludes zero, the gap is at least 10 points, the team or league uses the zone on 10%+ of rounds, and the team has 30+ rounds of that type. Hovering a row highlights its zone and the reverse; `RadarHeatmap` takes per-zone colour, weight, label and description plus a controlled active index for this. Rows under 10% are hidden unless the team clearly over- or under-uses a common zone, or "Show all zones" is on. `src/components/protocols/PlayerProtocols.tsx` adds the player list under Map tendencies. Helpers live in `src/war/protocols.ts`. The site reads `VITE_PROTOCOLS_URL` (e.g. `https://<public-r2-origin>/protocols`), falling back to `${BASE_URL}data/war/protocols/`.
