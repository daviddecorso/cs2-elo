"""Event matches from the local Liquipedia store (`data/raw/`). Never calls the API."""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .paths import LP_RAW

DEMO_MAP_NAMES = {
    "Ancient": "de_ancient",
    "Anubis": "de_anubis",
    "Cache": "de_cache",
    "Dust II": "de_dust2",
    "Inferno": "de_inferno",
    "Mirage": "de_mirage",
    "Nuke": "de_nuke",
    "Overpass": "de_overpass",
    "Train": "de_train",
    "Vertigo": "de_vertigo",
}


@dataclass
class LpOpponent:
    page: str
    name: str
    shortname: str
    players: list[dict[str, str]]


@dataclass
class LpMap:
    number: int
    map_name: str
    demo_map: str
    scores: tuple[int, int]
    halfs: tuple[list[int], list[int]]
    first_half_sides: tuple[str, str]


@dataclass
class LpMatch:
    match2id: str
    pagename: str
    tier: str
    date: str
    hltv_id: int | None
    opponents: tuple[LpOpponent, LpOpponent]
    maps: list[LpMap] = field(default_factory=list)


def demo_map_name(lp_map: str) -> str:
    return DEMO_MAP_NAMES.get(lp_map, "de_" + re.sub(r"[^a-z0-9]", "", lp_map.lower()))


def hltv_match_id(links: object) -> int | None:
    if not isinstance(links, dict):
        return None
    url = (links.get("hltv") or {}).get("1", {}).get("1", "")
    m = re.search(r"/matches/(\d+)", str(url))
    return int(m.group(1)) if m else None


def _halfs(extradata: dict, key: str) -> list[int]:
    halfs = extradata.get(key) or {}
    return [int(halfs[k]) for k in sorted(halfs, key=int)] if isinstance(halfs, dict) else []


def _parse_map(game: dict, number: int) -> LpMap | None:
    scores = game.get("scores") or []
    if not game.get("map") or not str(game.get("winner", "")).strip() or len(scores) != 2:
        return None
    if not all(isinstance(s, int) for s in scores):
        return None
    extra = game.get("extradata") or {}
    sides = (extra.get("t1sides") or {}, extra.get("t2sides") or {}) if isinstance(extra, dict) else ({}, {})
    return LpMap(
        number=number,
        map_name=game["map"],
        demo_map=demo_map_name(game["map"]),
        scores=(scores[0], scores[1]),
        halfs=(_halfs(extra, "t1halfs"), _halfs(extra, "t2halfs")) if isinstance(extra, dict) else ([], []),
        first_half_sides=(str(sides[0].get("1", "")), str(sides[1].get("1", ""))),
    )


def _parse_opponent(op: dict) -> LpOpponent:
    tt = op.get("teamtemplate") or {}
    return LpOpponent(
        page=tt.get("page") or op.get("name", ""),
        name=tt.get("name") or op.get("name", ""),
        shortname=tt.get("shortname", ""),
        players=[
            {"name": p.get("name", ""), "displayname": p.get("displayname", "")}
            for p in op.get("match2players") or []
        ],
    )


def parse_match(row: dict) -> LpMatch | None:
    if row.get("game") != "cs2" or not row.get("finished") or row.get("walkover") or row.get("resulttype"):
        return None
    ops = row.get("match2opponents") or []
    if len(ops) != 2 or any(op.get("type") != "team" for op in ops):
        return None
    maps = [m for i, g in enumerate(row.get("match2games") or []) if (m := _parse_map(g, i + 1))]
    return LpMatch(
        match2id=row["match2id"],
        pagename=row["pagename"],
        tier=str(row.get("liquipediatier", "")),
        date=row.get("date", ""),
        hltv_id=hltv_match_id(row.get("links")),
        opponents=(_parse_opponent(ops[0]), _parse_opponent(ops[1])),
        maps=maps,
    )


def _load_rows(path: Path) -> list[dict]:
    return json.loads(path.read_text())


def load_event(pagename: str, raw_dir: Path = LP_RAW) -> list[LpMatch]:
    """Matches on exactly this tournament page; subpages (qualifiers, stages) are separate events."""
    sources = [raw_dir / "matches.json", *sorted((raw_dir / "archive").glob("matches-*.json"))]
    seen: dict[str, LpMatch] = {}
    for src in sources:
        if not src.exists():
            continue
        text = src.read_text()
        if pagename not in text:
            continue
        for row in json.loads(text):
            if row.get("pagename") != pagename:
                continue
            m = parse_match(row)
            if m and m.match2id not in seen:
                seen[m.match2id] = m
    return sorted(seen.values(), key=lambda m: m.date)


def load_steam_ids(raw_dir: Path = LP_RAW) -> dict[str, str]:
    """steam64 id → Liquipedia player page name, from `players.json` links."""
    out: dict[str, str] = {}
    path = raw_dir / "players.json"
    if not path.exists():
        return out
    for p in _load_rows(path):
        link = (p.get("links") or {}).get("steam64ID") if isinstance(p.get("links"), dict) else None
        m = re.search(r"(7656\d{13})", str(link or ""))
        if m:
            out[m.group(1)] = p["pagename"]
    return out
