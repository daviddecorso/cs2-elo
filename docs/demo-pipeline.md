# Demo pipeline

## Overview

`demos/` is a self-contained Python project (uv) that turns HLTV series demos into validated Parquet tables in Cloudflare R2. It runs on your own machine, not in CI or on Workers: HLTV's bot protection and 50–150 MB per map rule those out. It shares nothing with `src/` or `scripts/` and isn't part of the nightly `Update data` workflow, so a broken scraper stops new demos and nothing else.

For each map it:

1. Takes the series from the local Liquipedia store (`data/raw/`), with no API calls.
2. Downloads the series archive from HLTV.
3. Parses it with awpy and demoparser2.
4. Rebuilds the counted rounds.
5. Checks them against Liquipedia's official result.
6. Uploads Parquet to R2, or quarantines the map.

The gate is one full event with every map parsed: Thunderpick World Championship 2026, 14 series and 37 maps. It passed on 2026-10-22. `report` shows 37/37, and R2 holds 296 tables plus the manifest. That's 8.2 GB of raw demos and 78 MB of Parquet. One map needed the truncated multipart repair (below).

## Commands

From `demos/`:

```bash
uv sync && uv run playwright install chromium
uv run pytest
uv run cs2demos login
uv run cs2demos run --event Thunderpick/World_Championship/2026 [--match <hltv id>] [--max-pages 30] [--no-upload]
uv run cs2demos report --event Thunderpick/World_Championship/2026
uv run cs2demos reparse --event <page> [--all]
uv run cs2demos prune [--days 30] [--max-gb 10]
uv run cs2demos auto [--max-pages 60] [--dry-run]
uv run cs2demos status
```

`--event` is a Liquipedia tournament page. It also takes the page's stages (rows whose `parent` is that page). Qualifiers have their own parent, so they're separate events. `report` exits 0 only when every map is parsed at the current parser version and, with R2, has all its tables uploaded.

Extracting archives needs `unar` for HLTV's RAR5 archives (Homebrew's `7zz` ships without the RAR codec) and `7zz` for anything else: `brew install unar sevenzip`.

## HLTV access

Decision: HLTV has no API for demos, and its terms don't allow automated access. Phase 4 accepts that, with the gentlest setup that works. (The no-scraping rule in `AGENTS.md` is about Liquipedia, and still holds absolutely.)

- **A real, headed browser profile, no fingerprint spoofing.** It's a persistent Chromium profile in `~/.cache/cs2-elo/hltv-profile`, outside the repo. `cs2demos login` opens HLTV and waits while you clear the Cloudflare check by hand.
- **A challenge stops the run.** It never retries or works around the challenge. Run `login` again.
- **Slow.** At least 15 s plus up to 10 s of jitter between requests, one download at a time, and `--max-pages` per run (default 30). An event costs one match page and one download per series.
- **Every match page is cached** in `data/demos/hltv-cache/`, so reruns don't refetch it.
- **Liquipedia supplies the HLTV match ID** (`links.hltv`).
  - The hot store has it on every row.
  - The archive (`data/raw/archive/`) was fetched without `links`. `npm run backfill-hltv-links` fills that gap once, with one links-only `/match` query for tier-1 offline matches from 2025-01 to the hot store's start (2 requests). It writes the committed `data/demos/hltv-links.json`. On 2026-10-22 it linked 919/919 series, so every tier-1 LAN map since 2025 has an ID.
- **Fallback for a series without a link:** HLTV's results for its day, then the days either side (`/results?startDate=D&endDate=D`, 1–3 pages per day, cached once the day is two days old).
  - It picks the one result where both team names match the opponent's name, short name or page (case and punctuation ignored, a leading "Team" dropped) and the score matches. The score is maps won, or rounds for a Bo1.
  - Zero or several candidates skip the series.
  - A hit is saved to `hltv-links.json` with `source: "hltv-results"`. Validation still catches a wrong join.

## Data

Local, gitignored, under `data/demos/`:

| Path | Contents |
| --- | --- |
| `raw/<hltvMatchId>.<ext>` | Series archives (see Raw retention). |
| `work/<hltvMatchId>/` | Extraction scratch, deleted after each series. |
| `parquet/` | Staging. Only kept with `--no-upload`. |
| `hltv-cache/` | HLTV match page HTML and per-day results. |
| `lp/lan-series.json` | Recent tier-1 LAN rows from the nightly CI artifact. |
| `manifest.json` | Mirror of the R2 manifest. |

Committed:

- `data/demos/steam-players.json`: SteamID → Liquipedia player page. It holds manual fixes and the auto-matches by in-demo name.
- `data/demos/unresolved-players.json`: SteamIDs left to fix by hand.
- `data/demos/hltv-links.json`: Liquipedia match2id → HLTV match ID, for rows without `links.hltv`. This is Liquipedia data (CC-BY-SA), plus results-page joins.

**Raw retention.** A full series is about 0.6–1 GB, and the backfill is about 1,350 series, so raw demos are capped rather than kept for 30 days.

- Quarantined series are always kept.
- Parsed series are deleted after 30 days, and then oldest first while `raw/` is over 10 GB (`prune --max-gb`). `run` and `auto` prune at the end.
- A download is refused below 10 GB free disk, and the run stops cleanly.

R2 (bucket in `R2_BUCKET`):

- `manifest.json`: per map (`<hltvMatchId>/m<n>`), the status (`parsed` or `quarantined`), reason, official score, rounds, prefix and parser version.
- `v<parserVersion>/<lpPagename>/<hltvMatchId>/m<n>-<map>/<table>.parquet`, zstd compressed. The parser version is in the path, so a re-parse after an upgrade writes a new tree beside the old one.

Every table carries `hltv_match_id`, `map_number`, `map`, `lp_match2id`, `lp_pagename`, `tier` and `parser_version`. Event tables carry `round_num`, which is the rebuilt round. Rows from dropped rounds (warmup, knife, replayed) are removed.

| Table | Source |
| --- | --- |
| `rounds` | Rebuilt rounds: ticks, CT/T team, winner, Liquipedia team pages, score after the round, end reason |
| `players` | Demo roster with `lp_player` and `lp_team` |
| `kills`, `damages`, `grenades`, `bomb` | awpy |
| `flashes` | awpy `blinds`, rebuilt from flash state because GOTV demos omit `player_blind` |
| `ticks` | awpy snapshots every 16 ticks (4 Hz) plus demoparser2's `last_place_name` callout |

Displaying any of this on the site needs Liquipedia attribution beside it, because tier, event and roster come from Liquipedia.

## Round rebuild

`rounds.py`. demoparser2 reads each team's clan name and `team_rounds_total` 32 ticks after every round end in awpy's `rounds`. The rule: **a round end with total score T replaces everything from round T on.**

- Warmup and knife rounds drop out, because the real round 1 has T = 1.
- Backup restores and replayed rounds drop out the same way.
- Duplicate round-end events collapse into one.
- A jump in score (missing rounds, e.g. a demo that starts mid-map) fails the rebuild.

Each kept round must add exactly one round to exactly one team.

**Broken recordings.**

- A server restart splits a map into parts (`-p1`, `-p2`). Each part is parsed on its own. Its ticks are then shifted by the length of the parts before it, so `tick` is map-wide, and every table carries `part`.
- A part cut off mid-write (a crash) makes awpy fail with "unexpected end of data" at a byte offset. The work copy is cut at that command boundary and parsed again, and the manifest notes it. The raw archive is never modified.
- In PARIVISION vs BetBoom (Thunderpick 2026, Ancient), part 1 crashed after round 16 and part 2 resumed from a backup at round 17. The rebuild stitches them to the official 13–10. A round owns its ticks from its start until the next round starts, so exit frags stay with it.

Halves are 12 rounds each in regulation and 3 in overtime.

## Validation

`validate.py`. Any failure quarantines the map, records the reason and keeps the raw demo. Fix the rule or the parser, then `reparse`. Never edit outputs by hand.

- The demo header's map matches Liquipedia's map.
- Rounds won per team equal Liquipedia's `scores`, and per half equal `t1halfs`/`t2halfs`.
- Opponent 1's first-half side equals `t1sides["1"]`.
- Each round has exactly 5 distinct SteamIDs on each side between freeze end and round end.

Demo teams map to Liquipedia opponents by roster overlap first, then by clan name against the team page, name and short name.

## Identity

`identity.py`. A SteamID resolves through, in order:

1. `steam64ID` in `data/raw/players.json` (about 1,200 players).
2. `data/demos/steam-players.json`.
3. A unique match of the normalized in-demo name against that series' `match2players` name or display name. The match is written back to `steam-players.json`.

Anything left goes to `unresolved-players.json`. It doesn't quarantine a map.

## Parser upgrades

awpy, demoparser2 and polars are pinned exactly in `demos/pyproject.toml`. After an upgrade:

1. `uv lock`.
2. `cs2demos reparse --event <page> --all` for events whose raw demos are still on disk (under the retention cap).
3. Everything else needs a fresh download. `auto` does this on its own, because a map counts as done only at the current parser version.

## Scheduling and backfill

`cs2demos auto` is the scheduled entry point. Its scope is every tier-1 (`liquipediatier` 1) offline event since 2025-01-01, grouped by parent page: 38 events, 1,360 series and 3,043 maps as of 2026-10-22. Each run:

1. Takes a lock (`data/demos/auto.lock`). A second run exits.
2. Pulls the `lan-series` artifact from the latest successful `Update data` run on main with `gh`. CI's `export-lan-series` step writes it from `data/raw/matches.json`: tier-1 offline rows from the last 30 days, with no extra API calls. This machine has no fresh `data/raw/`, so new events reach it this way. If the pull fails, it uses the copy on disk.
3. Orders events newest first, dropping events with every map parsed at the current parser version. A just-finished event goes ahead of the backfill.
4. Works through them in one browser session with a 60-request budget, about 30 series a night. That puts the full backfill at about 45 nights.
5. Stops on the budget, low disk or a challenge, prunes raw demos, and prints maps parsed and quarantined, requests used and series left.

On a challenge it exits 2 and posts a macOS notification asking you to run `uv run cs2demos login`. `status` prints per-event counts (parsed, quarantined, without an HLTV link) from the local manifest.

**launchd.** `demos/launchd/org.cs2elo.demos.plist` runs `auto` at 04:00 local. It's a LaunchAgent, so it runs in your GUI session and can open the headed browser. A run missed while asleep fires on wake. Install from the repo root:

```bash
mkdir -p ~/Library/Logs/cs2-elo
sed -e "s#__REPO__#$PWD#" -e "s#__HOME__#$HOME#" demos/launchd/org.cs2elo.demos.plist > ~/Library/LaunchAgents/org.cs2elo.demos.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.cs2elo.demos.plist
launchctl kickstart gui/$(id -u)/org.cs2elo.demos     # one run now
tail -f ~/Library/Logs/cs2-elo/demos.log
launchctl bootout gui/$(id -u)/org.cs2elo.demos       # uninstall
```

Optional: `sudo pmset repeat wake MTWRFSU 03:55:00` wakes the Mac for it. Unattended runs last only while the profile's Cloudflare cookies stay valid.
