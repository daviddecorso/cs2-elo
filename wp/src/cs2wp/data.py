"""Inputs: the parsed map tables (mirrored from R2) and each map's date and pre-map Elo from the Elo backtest."""

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import polars as pl
from cs2demos.liquipedia import demo_map_name
from cs2demos.parse import PARSER_VERSION
from cs2demos.paths import MANIFEST
from cs2demos.store import R2, Manifest

from .paths import ELO_MAPS, MIRROR

TABLES = ("rounds", "players", "kills", "damages", "flashes", "bomb", "ticks")


@dataclass(frozen=True)
class MapRef:
    key: str
    hltv_match_id: int
    map_number: int
    map: str
    lp_match2id: str
    lp_pagename: str
    prefix: str
    date: str
    # Liquipedia opponent page -> rating plus map offset, before this map was played.
    elo: tuple[tuple[str, float], ...]

    @property
    def dir(self) -> Path:
        return MIRROR / self.prefix

    def table(self, name: str) -> pl.DataFrame:
        return pl.read_parquet(self.dir / f"{name}.parquet")

    @property
    def slug(self) -> str:
        return self.key.replace("/", "-")


def sync(force: bool = False) -> tuple[int, int]:
    """Copies every map parsed at the current parser version from R2. Returns (downloaded, already present)."""
    r2 = R2()
    manifest = Manifest(r2)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps({"maps": dict(sorted(manifest.maps.items()))}, indent=2) + "\n")
    got = have = 0
    for entry in manifest.maps.values():
        if entry["status"] != "parsed" or entry["parser_version"] != PARSER_VERSION:
            continue
        for key in entry["keys"]:
            if key.rsplit("/", 1)[1].removesuffix(".parquet") not in TABLES:
                continue
            dest = MIRROR / key
            if dest.exists() and not force:
                have += 1
                continue
            r2.download(key, dest)
            got += 1
    return got, have


def elo_index(path: Path = ELO_MAPS) -> dict[str, list[dict]]:
    """match2id -> its scored maps in play order, each with date, teams and pre-map ratings."""
    out: dict[str, list[dict]] = {}
    with path.open() as f:
        for line in f:
            row = json.loads(line)
            out.setdefault(row["match2id"], []).append(row)
    return out


def _elo_for(rows: list[dict], demo_map: str, occurrence: int) -> dict | None:
    same = [r for r in rows if demo_map_name(r["map"]) == demo_map]
    return same[occurrence] if occurrence < len(same) else None


def catalog(elo_path: Path = ELO_MAPS) -> list[MapRef]:
    """Every mirrored map with an Elo row. Maps are joined to Elo by match and map name."""
    if not elo_path.exists():
        raise SystemExit(f"{elo_path} is missing; run `npm run export-map-elo` first")
    manifest = Manifest(None)
    elo = elo_index(elo_path)
    by_series: dict[int, list[tuple[str, dict]]] = {}
    for key, e in manifest.maps.items():
        if e["status"] == "parsed" and e["parser_version"] == PARSER_VERSION:
            by_series.setdefault(int(key.split("/")[0]), []).append((key, e))

    refs = []
    for hltv_id, maps in by_series.items():
        maps.sort(key=lambda m: int(m[0].split("/m")[1]))
        seen: dict[str, int] = {}
        for key, e in maps:
            occurrence = seen.get(e["map"], 0)
            seen[e["map"]] = occurrence + 1
            row = _elo_for(elo.get(e["lp_match2id"], []), e["map"], occurrence)
            if row is None or not (MIRROR / e["prefix"] / "rounds.parquet").exists():
                continue
            refs.append(
                MapRef(
                    key=key,
                    hltv_match_id=hltv_id,
                    map_number=int(key.split("/m")[1]),
                    map=e["map"],
                    lp_match2id=e["lp_match2id"],
                    lp_pagename=e["lp_pagename"],
                    prefix=e["prefix"],
                    date=datetime.fromtimestamp(row["t"], timezone.utc).date().isoformat(),
                    elo=tuple(zip(row["teams"], row["ratings"])),
                )
            )
    return sorted(refs, key=lambda r: (r.date, r.key))
