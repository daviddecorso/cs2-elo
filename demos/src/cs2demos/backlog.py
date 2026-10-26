"""Which LAN events `auto` works on, and in what order."""

from dataclasses import dataclass

from .liquipedia import LpMatch
from .parse import PARSER_VERSION
from .store import Manifest, map_key


@dataclass
class QueuedEvent:
    page: str
    start: str
    end: str
    matches: list[LpMatch]


def is_map_done(entry: dict | None, retry_quarantined: bool = False) -> bool:
    """Quarantines only come back on a parser version bump, or a `reparse` from the archive on disk."""
    if not entry or entry["parser_version"] != PARSER_VERSION:
        return False
    return entry["status"] == "parsed" or (entry["status"] == "quarantined" and not retry_quarantined)


def is_done(manifest: Manifest, m: LpMatch, retry_quarantined: bool = False) -> bool:
    if not m.hltv_id:
        return False
    return all(is_map_done(manifest.get(map_key(m.hltv_id, lp.number)), retry_quarantined) for lp in m.maps)


def build_queue(events: dict[str, list[LpMatch]], manifest: Manifest, include_done: bool = False) -> list[QueuedEvent]:
    """Newest event first, so a just-finished event goes ahead of the backfill."""
    queue = [
        QueuedEvent(page, min(m.date for m in ms)[:10], max(m.date for m in ms)[:10], ms)
        for page, ms in events.items()
        if include_done or not all(is_done(manifest, m) for m in ms)
    ]
    return sorted(queue, key=lambda e: (e.end, e.page), reverse=True)
