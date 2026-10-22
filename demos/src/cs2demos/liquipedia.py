"""Event matches from the local Liquipedia store (`data/raw/`). Never calls the API."""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .paths import HLTV_LINKS, LAN_SERIES, LP_RAW

LAN_SINCE = "2025-01-01"
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


def event_of(row: dict) -> str:
    return row.get("parent") or row.get("pagename", "")


def _sources(raw_dir: Path, lan_series: Path) -> list[Path]:
    """Oldest first, so a later source's copy of a row wins."""
    return [*sorted((raw_dir / "archive").glob("matches-*.json")), raw_dir / "matches.json", lan_series]


def _collect(rows_filter, raw_dir: Path, lan_series: Path, links: Path, prefilter: str | None = None) -> list[LpMatch]:
    rows: dict[str, dict] = {}
    for src in _sources(raw_dir, lan_series):
        if not src.exists():
            continue
        text = src.read_text()
        if prefilter and prefilter not in text:
            continue
        for row in json.loads(text):
            if rows_filter(row):
                rows[row["match2id"]] = row
    known = load_links(links)
    out = []
    for row in rows.values():
        m = parse_match(row)
        if m:
            m.hltv_id = m.hltv_id or known.get(m.match2id)
            out.append(m)
    return sorted(out, key=lambda m: m.date)


def load_event(event: str, raw_dir: Path = LP_RAW, lan_series: Path = LAN_SERIES, links: Path = HLTV_LINKS) -> list[LpMatch]:
    """Matches on this tournament page or any of its subpages (stages); qualifiers have their own parent."""
    return _collect(lambda r: r.get("pagename") == event or r.get("parent") == event, raw_dir, lan_series, links, event)


def is_tier1_lan(row: dict, since: str = LAN_SINCE) -> bool:
    return (
        row.get("game") == "cs2"
        and str(row.get("liquipediatier", "")) == "1"
        and row.get("type") == "Offline"
        and str(row.get("date", "")) >= since
    )


def load_lan_events(since: str = LAN_SINCE, raw_dir: Path = LP_RAW, lan_series: Path = LAN_SERIES,
                    links: Path = HLTV_LINKS) -> dict[str, list[LpMatch]]:
    """Every tier-1 LAN event since `since`, keyed by parent page."""
    events: dict[str, list[LpMatch]] = {}
    pages: dict[str, str] = {}

    def keep(row: dict) -> bool:
        if is_tier1_lan(row, since):
            pages[row["match2id"]] = event_of(row)
            return True
        return False

    for m in _collect(keep, raw_dir, lan_series, links):
        events.setdefault(pages[m.match2id], []).append(m)
    return events


def load_links(path: Path = HLTV_LINKS) -> dict[str, int]:
    if not path.exists():
        return {}
    return {k: int(v["hltv"]) for k, v in json.loads(path.read_text()).items()}


def save_link(match2id: str, hltv_id: int, source: str, path: Path = HLTV_LINKS) -> None:
    data = json.loads(path.read_text()) if path.exists() else {}
    data[match2id] = {"hltv": hltv_id, "source": source}
    path.write_text(json.dumps(dict(sorted(data.items())), indent=2) + "\n")


def _norm(name: str) -> str:
    n = re.sub(r"[^a-z0-9]", "", name.lower())
    return n[4:] if n.startswith("team") and len(n) > 4 else n


def _names(op: LpOpponent) -> set[str]:
    return {_norm(n) for n in (op.name, op.shortname, op.page) if n} - {""}


def _series_scores(m: LpMatch) -> set[tuple[int, int]]:
    """HLTV shows maps won, or the round score for a single map."""
    won = (sum(a > b for a, b in (lp.scores for lp in m.maps)), sum(b > a for a, b in (lp.scores for lp in m.maps)))
    return {won, m.maps[0].scores} if len(m.maps) == 1 else {won}


def resolve_from_results(m: LpMatch, results: list[dict]) -> int | None:
    """HLTV match id for `m` among HLTV results rows (`id`, `team1`, `team2`, `score1`, `score2`), if exactly one fits."""
    names = (_names(m.opponents[0]), _names(m.opponents[1]))
    scores = _series_scores(m) if m.maps else set()
    hits = set()
    for r in results:
        t1, t2 = _norm(r["team1"]), _norm(r["team2"])
        s = (r["score1"], r["score2"])
        if t1 in names[0] and t2 in names[1] and s in scores:
            hits.add(r["id"])
        elif t1 in names[1] and t2 in names[0] and s[::-1] in scores:
            hits.add(r["id"])
    return hits.pop() if len(hits) == 1 else None


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
