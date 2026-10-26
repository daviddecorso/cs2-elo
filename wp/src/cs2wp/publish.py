"""Writes the per-player WPA table for the site and, optionally, to R2."""

import json
from datetime import datetime, timezone

import polars as pl
from cs2demos.store import R2

from .paths import MODELS, PUBLIC_WPA, REPORTS

# Liquipedia's terms (AGENTS.md) need credit beside anything built on its data: events, teams and player pages here.
SOURCE = {
    "demos": "HLTV.org match demos, parsed with awpy",
    "attribution": "Events, rosters and player pages from Liquipedia (CC-BY-SA 3.0)",
    "liquipedia": "https://liquipedia.net/counterstrike/",
}
COLUMNS = ["steamid", "lp_player", "name", "rounds", "wpa", "wpa_p5", "wpa_p95", "nwpa_event", "nwpa_event_p5",
           "nwpa_event_p95", "nwpa_mancount", "nwpa_mancount_p5", "nwpa_mancount_p95", "kd", "adr", "rating2_approx",
           "rating3", "swing"]


def publish(model: str, upload: bool) -> int:
    report = json.loads((MODELS / model / "report.json").read_text())
    if not report["gate"]["passed"]:
        print(f"Model {model} hasn't passed the gate; not publishing.")
        return 1
    players = pl.read_parquet(REPORTS / "player_wpa.parquet")
    validation = json.loads((REPORTS / "validation.json").read_text())
    out = players.select([c for c in COLUMNS if c in players.columns]).with_columns(pl.col("steamid").cast(pl.Utf8))
    PUBLIC_WPA.mkdir(parents=True, exist_ok=True)
    (PUBLIC_WPA / "players.json").write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": model, "window_from": validation["window_from"], "gate": report["gate"],
        "validation": {k: validation[k] for k in ("month_to_month", "with_kd")},
        "source": SOURCE, "players": out.to_dicts(),
    }, indent=1))
    print(f"wrote {out.height} players to {PUBLIC_WPA / 'players.json'}")
    if upload:
        r2 = R2()
        key = f"wp/{model}/player_wpa.parquet"
        r2.client.upload_file(str(REPORTS / "player_wpa.parquet"), r2.bucket, key)
        print(f"uploaded {key}")
    return 0
