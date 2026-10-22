"""SteamID → Liquipedia player page name, and demo clan name → Liquipedia opponent."""

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .liquipedia import LpMatch, LpOpponent


def normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _page(name: str) -> str:
    return name.replace(" ", "_")


@dataclass
class IdentityTable:
    liquipedia: dict[str, str]
    # Committed manual fixes plus earlier auto-matches by in-demo name.
    known: dict[str, str]
    unresolved: dict[str, dict] = field(default_factory=dict)
    added: bool = False

    @classmethod
    def load(cls, liquipedia: dict[str, str], known_path: Path) -> "IdentityTable":
        known = json.loads(known_path.read_text()) if known_path.exists() else {}
        return cls(liquipedia, known)

    def resolve(self, steamid: str, demo_name: str, match: LpMatch, context: str) -> str | None:
        if page := self.liquipedia.get(steamid) or self.known.get(steamid):
            return page
        wanted = normalize(demo_name)
        candidates = {
            _page(p["name"])
            for op in match.opponents
            for p in op.players
            if wanted and wanted in (normalize(p["name"]), normalize(p["displayname"]))
        }
        if len(candidates) == 1:
            page = candidates.pop()
            self.known[steamid] = page
            self.added = True
            return page
        self.unresolved[steamid] = {"name": demo_name, "seen": context}
        return None

    def save(self, known_path: Path, unresolved_path: Path) -> None:
        if self.added:
            known_path.parent.mkdir(parents=True, exist_ok=True)
            known_path.write_text(json.dumps(dict(sorted(self.known.items())), indent=2) + "\n")
        existing = json.loads(unresolved_path.read_text()) if unresolved_path.exists() else {}
        merged = {k: v for k, v in {**existing, **self.unresolved}.items() if k not in self.known and k not in self.liquipedia}
        unresolved_path.parent.mkdir(parents=True, exist_ok=True)
        unresolved_path.write_text(json.dumps(dict(sorted(merged.items())), indent=2) + "\n")


def match_opponent(clan: str, players: list[str | None], match: LpMatch) -> int | None:
    """Index (0/1) of the Liquipedia opponent a demo team is, by roster overlap, then by name."""
    rosters = [{_page(p["name"]) for p in op.players} for op in match.opponents]
    votes = Counter(i for page in players if page for i, roster in enumerate(rosters) if page in roster)
    if votes:
        (best, n), *rest = votes.most_common()
        if not rest or rest[0][1] < n:
            return best
    wanted = normalize(clan)
    hits = [i for i, op in enumerate(match.opponents) if wanted and wanted in _names(op)]
    return hits[0] if len(hits) == 1 else None


def _names(op: LpOpponent) -> set[str]:
    return {normalize(n) for n in (op.page, op.name, op.shortname) if n}
