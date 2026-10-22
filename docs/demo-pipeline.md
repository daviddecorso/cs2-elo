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
uv run cs2demos prune [--days 30]
```

`--event` is the exact Liquipedia tournament page. Qualifiers and regional stages are separate pages and separate events. `report` exits 0 only when every map is parsed at the current parser version and, with R2, has all its tables uploaded.

Extracting archives needs `unar` for HLTV's RAR5 archives (Homebrew's `7zz` ships without the RAR codec) and `7zz` for anything else: `brew install unar sevenzip`.

## HLTV access

Decision: HLTV has no API for demos, and its terms don't allow automated access. Phase 4 accepts that, with the gentlest setup that works. (The no-scraping rule in `AGENTS.md` is about Liquipedia, and still holds absolutely.)

- **A real, headed browser profile, no fingerprint spoofing.** It's a persistent Chromium profile in `~/.cache/cs2-elo/hltv-profile`, outside the repo. `cs2demos login` opens HLTV and waits while you clear the Cloudflare check by hand.
- **A challenge stops the run.** It never retries or works around the challenge. Run `login` again.
- **Slow.** At least 15 s plus up to 10 s of jitter between requests, one download at a time, and `--max-pages` per run (default 30). An event costs one match page and one download per series.
- **Every match page is cached** in `data/demos/hltv-cache/`, so reruns don't refetch it.
- **Liquipedia supplies the HLTV match ID** (`links.hltv`), so the scraper never browses HLTV's results or event pages. Every tier-1 LAN since June 2026 has the link. A match without one is skipped (see open items).

## Data

Local, gitignored, under `data/demos/`:

| Path | Contents |
| --- | --- |
| `raw/<hltvMatchId>.<ext>` | Series archives. Kept 30 days (`prune`), and kept longer while any of their maps is quarantined. |
| `work/<hltvMatchId>/` | Extraction scratch, deleted after each series. |
| `parquet/` | Staging. Only kept with `--no-upload`. |
| `hltv-cache/` | HLTV match page HTML. |
| `manifest.json` | Mirror of the R2 manifest. |

Committed:

- `data/demos/steam-players.json`: SteamID → Liquipedia player page. It holds manual fixes and the auto-matches by in-demo name.
- `data/demos/unresolved-players.json`: SteamIDs left to fix by hand.

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
2. `cs2demos reparse --event <page> --all` for events whose raw demos are still on disk (30 days).
3. Older events need a fresh download.

## Open items

- **Matches without `links.hltv`** are skipped. A fallback needs HLTV's event results pages, joined on team names and date ±1 day.
- **Schedule** with launchd or a VPS cron once the gate passes. The headed profile only runs unattended while its Cloudflare cookies stay valid.
- **Backfill** tier-1 LANs for 2025–2026.
