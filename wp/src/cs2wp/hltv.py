"""Rating 3.0 and Swing per player per map, read from the HLTV match pages the demo pipeline already cached.

Nothing here fetches: a series without a cached page simply has no HLTV numbers.
"""

from functools import lru_cache
import re
from pathlib import Path

import polars as pl
from cs2demos.liquipedia import demo_map_name
from cs2demos.paths import HLTV_CACHE

TAB = re.compile(r'<div class="(\d+) dynamic-map-name-full" id="\d+">([^<]+)</div>')
SECTION = re.compile(r'<div class="stats-content" id="(\d+)-content">')
TABLE = re.compile(r"<table\b([^>]*)>(.*?)</table>", re.S)
TR = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.S)
ROW = re.compile(
    r'<a href="/player/(\d+)/[^"]*"[^>]*>.*?<span class="player-nick">([^<]+)</span>.*?'
    r'<td class="roundSwing[^"]*">([^<]*)</td>.*?<td class="rating[^"]*">([^<]+)</td>',
    re.S,
)


def _pct(s: str) -> float | None:
    s = s.strip().rstrip("%")
    try:
        return float(s) / 100
    except ValueError:
        return None


def parse_match_page(html: str) -> list[dict]:
    """Per map (in page order): HLTV player id, nick, Swing (a fraction) and Rating 3.0."""
    names = {sid: name.strip() for sid, name in TAB.findall(html)}
    starts = [(m.start(), m.group(1)) for m in SECTION.finditer(html)]
    out = []
    for i, (pos, sid) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(html)
        seen: set[int] = set()
        for attrs, tbody in TABLE.findall(html[pos:end]):
            # HLTV renders totalstats followed by hidden ctstats and tstats tables per team.
            if "ctstats" in attrs or "tstats" in attrs:
                continue
            for tr in TR.findall(tbody):
                if "roundSwing" not in tr:
                    continue
                m = ROW.search(tr)
                if not m:
                    continue
                pid_s, nick, swing, rating = m.groups()
                pid = int(pid_s)
                if pid in seen:
                    continue
                try:
                    r = float(rating)
                except ValueError:
                    continue
                seen.add(pid)
                out.append({"mapstats_id": int(sid), "map_name": names.get(sid, ""), "hltv_player": pid,
                            "nick": nick.strip(), "swing": _pct(swing), "rating3": r})
    return out


@lru_cache(maxsize=2048)
def _cached_rows(page: Path) -> list[dict]:
    return parse_match_page(page.read_text(errors="replace"))


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def ratings_for(hltv_match_id: int, demo_map: str, occurrence: int, players: pl.DataFrame,
                cache: Path = HLTV_CACHE) -> pl.DataFrame:
    """Joins one map's HLTV rows to demo SteamIDs by nick, against the in-demo name or the Liquipedia page."""
    page = cache / f"match-{hltv_match_id}.html"
    empty = pl.DataFrame(schema={"steamid": pl.UInt64, "rating3": pl.Float64, "swing": pl.Float64})
    if not page.exists():
        return empty
    rows = [r for r in _cached_rows(page) if demo_map_name(r["map_name"]) == demo_map]
    ids = sorted({r["mapstats_id"] for r in rows})
    if occurrence >= len(ids):
        return empty
    rows = [r for r in rows if r["mapstats_id"] == ids[occurrence]]
    lookup: dict[str, int] = {}
    for p in players.iter_rows(named=True):
        for key in (_norm(p["name"]), _norm(p["lp_player"])):
            if key:
                lookup.setdefault(key, p["steamid"])
    matched = [{"steamid": lookup[_norm(r["nick"])], "rating3": r["rating3"], "swing": r["swing"]}
               for r in rows if _norm(r["nick"]) in lookup]
    return pl.DataFrame(matched, schema=empty.schema) if matched else empty
