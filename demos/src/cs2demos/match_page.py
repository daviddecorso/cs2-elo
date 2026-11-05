"""Series data parsed from cached HLTV match pages: the map veto, format, both teams' rankings and half scores."""

import html
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import polars as pl

from .hltv import is_server_error
from .liquipedia import LpMap, LpMatch, _names, _norm
from .paths import HLTV_CACHE

FORMAT_BOX = re.compile(r'class="standard-box veto-box"><div class="padding preformatted-text">(.*?)</div>', re.DOTALL)
VETO_BOX = re.compile(r'class="standard-box veto-box"><div class="padding">((?:<div>.*?</div>)+)</div></div>', re.DOTALL)
STEP = re.compile(r"<div>(.*?)</div>", re.DOTALL)
PICK_OR_BAN = re.compile(r"^(\d+)\. (.+) (removed|picked) (\S+)$")
LEFT_OVER = re.compile(r"^(\d+)\. (\S+) was left over$")
BEST_OF = re.compile(r"Best of (\d+) \((LAN|Online)\)")
LINEUP_TEAM = re.compile(r'<a href="/team/(\d+)/[^"]*" class="text-ellipsis">(.*?)</a>')
HLTV_RANK = re.compile(r'href="/ranking/teams/(\d{4}/\w+/\d+)/\d+" class="ranking-badge hltv-ranking"><span>HLTV: </span>#(\d+)')
VRS_RANK = re.compile(r'href="/valve-ranking/teams/(\d{4}/\w+/\d+)\?teamId=\d+" class="ranking-badge vrs-ranking"><span>VRS: </span>#(\d+)')
MAP_NAME = re.compile(r'class="mapname">([^<]+)</div>')
RESULT_TEAM = re.compile(r'class="results-teamname text-ellipsis">([^<]*)</div>')
HALF_SCORES = re.compile(r'class="results-center-half-score">(.*?)</div>', re.DOTALL)
# Each score span's class is the side that team played that half.
REGULATION_HALF = re.compile(r'<span class="(ct|t)">(\d+)</span><span class="">:</span><span class="(?:ct|t)">(\d+)</span>')
OVERTIME = re.compile(r'<span>(\d+)</span><span class="">:</span><span>(\d+)</span>')


@dataclass
class VetoStep:
    step: int
    team: str | None
    action: str  # "ban", "pick" or "decider"
    demo_map: str


@dataclass
class LineupTeam:
    hltv_team_id: int
    name: str
    hltv_rank: int | None
    hltv_ranking_date: str | None
    vrs_rank: int | None
    vrs_ranking_date: str | None


@dataclass
class SeriesInfo:
    best_of: int | None
    lan: bool | None
    note: str | None
    teams: list[LineupTeam]


@dataclass
class HltvMapScore:
    """One map's regulation half scores in Liquipedia opponent order. HLTV lumps all overtime into one score."""

    halves: tuple[list[int], list[int]]
    first_side: str  # opponent 1's side in the first half
    overtime: tuple[int, int]


def hltv_demo_map(name: str) -> str:
    return "de_" + re.sub(r"[^a-z0-9]", "", name.lower())


def parse_veto(page: str) -> list[VetoStep]:
    """The numbered veto steps; empty when the page has no veto box."""
    box = VETO_BOX.search(page)
    if not box:
        return []
    steps = []
    for line in STEP.findall(box.group(1)):
        line = html.unescape(line).strip()
        if m := PICK_OR_BAN.match(line):
            action = "pick" if m.group(3) == "picked" else "ban"
            steps.append(VetoStep(int(m.group(1)), m.group(2), action, hltv_demo_map(m.group(4))))
        elif m := LEFT_OVER.match(line):
            steps.append(VetoStep(int(m.group(1)), None, "decider", hltv_demo_map(m.group(2))))
        else:
            raise ValueError(f"unrecognised veto line: {line!r}")
    return steps


def _ranking_date(path: str) -> str:
    """HLTV's `2026/october/12` as `2026-10-12`."""
    return datetime.strptime(path, "%Y/%B/%d").date().isoformat()


def parse_series_info(page: str) -> SeriesInfo:
    box = FORMAT_BOX.search(page)
    text = html.unescape(box.group(1)).strip() if box else ""
    fmt = BEST_OF.search(text)
    notes = [line.strip().removeprefix("* ") for line in text.splitlines()[1:] if line.strip()]
    teams = []
    # Each lineup box opens with the team link and its ranking badges, ahead of the player table.
    for chunk in page.split('class="lineup standard-box"')[1:]:
        head = chunk.split('class="players"', 1)[0]
        team = LINEUP_TEAM.search(head)
        if not team:
            continue
        hltv, vrs = HLTV_RANK.search(head), VRS_RANK.search(head)
        teams.append(LineupTeam(
            int(team.group(1)), html.unescape(team.group(2)),
            int(hltv.group(2)) if hltv else None, _ranking_date(hltv.group(1)) if hltv else None,
            int(vrs.group(2)) if vrs else None, _ranking_date(vrs.group(1)) if vrs else None,
        ))
    return SeriesInfo(
        int(fmt.group(1)) if fmt else None,
        fmt.group(2) == "LAN" if fmt else None,
        "\n".join(notes) or None,
        teams,
    )


def opponent_numbers(m: LpMatch, teams: set[str]) -> dict[str, int]:
    """HLTV team name → Liquipedia opponent 1 or 2. One name matching is enough; the other team is the other side."""
    names = (_names(m.opponents[0]), _names(m.opponents[1]))
    found = {t: i + 1 for t in teams for i in (0, 1) if _norm(t) in names[i]}
    if len(teams) == 2 and len(found) == 1:
        (known, n), = found.items()
        found[next(iter(teams - {known}))] = 3 - n
    return found if len(set(found.values())) == len(found) == len(teams) else {}


def map_score(m: LpMatch, lp_map: LpMap, page: str) -> HltvMapScore | None:
    """None when the page has no half scores for this map or its teams don't match the opponents."""
    for holder in page.split('class="mapholder"')[1:]:
        name, scores = MAP_NAME.search(holder), HALF_SCORES.search(holder)
        if not name or not scores or hltv_demo_map(html.unescape(name.group(1))) != lp_map.demo_map:
            continue
        teams = [html.unescape(t) for t in RESULT_TEAM.findall(holder)[:2]]
        halves = REGULATION_HALF.findall(scores.group(1))
        numbers = opponent_numbers(m, set(teams)) if len(set(teams)) == 2 else {}
        if not numbers or not halves:
            return None
        left, right = [int(h[1]) for h in halves], [int(h[2]) for h in halves]
        overtime = [tuple(map(int, o)) for o in OVERTIME.findall(scores.group(1))]
        left_ot, right_ot = sum(o[0] for o in overtime), sum(o[1] for o in overtime)
        left_side = halves[0][0]
        if numbers[teams[0]] == 1:
            return HltvMapScore((left, right), left_side, (left_ot, right_ot))
        return HltvMapScore((right, left), "t" if left_side == "ct" else "ct", (right_ot, left_ot))
    return None


def veto_table(m: LpMatch, steps: list[VetoStep]) -> pl.DataFrame:
    """Raises when the veto doesn't fit the series: unknown teams, or picks that aren't the maps played."""
    teams = {s.team for s in steps if s.team}
    numbers = opponent_numbers(m, teams)
    if not numbers:
        raise ValueError(f"veto teams {sorted(teams)} don't match the Liquipedia opponents")
    order = [s.demo_map for s in steps if s.action != "ban"]
    played = [lp.demo_map for lp in m.maps]
    if order[: len(played)] != played:
        raise ValueError(f"veto map order {order} doesn't match the maps played {played}")
    return pl.DataFrame(
        {
            "hltv_match_id": [m.hltv_id] * len(steps),
            "lp_match2id": [m.match2id] * len(steps),
            "step": [s.step for s in steps],
            "opponent": [numbers.get(s.team) if s.team else None for s in steps],
            "team": [s.team for s in steps],
            "action": [s.action for s in steps],
            "map": [s.demo_map for s in steps],
            "map_number": [order.index(s.demo_map) + 1 if s.demo_map in order[: len(played)] else None for s in steps],
        },
        schema={"hltv_match_id": pl.Int64, "lp_match2id": pl.String, "step": pl.Int64, "opponent": pl.Int64,
                "team": pl.String, "action": pl.String, "map": pl.String, "map_number": pl.Int64},
    )


def series_table(m: LpMatch, info: SeriesInfo) -> pl.DataFrame:
    """One row per Liquipedia opponent. Raises when the lineup teams don't match the opponents."""
    numbers = opponent_numbers(m, {t.name for t in info.teams})
    if len(info.teams) != 2 or not numbers:
        raise ValueError(f"lineup teams {[t.name for t in info.teams]} don't match the Liquipedia opponents")
    teams = sorted(info.teams, key=lambda t: numbers[t.name])
    return pl.DataFrame(
        {
            "hltv_match_id": [m.hltv_id] * 2,
            "lp_match2id": [m.match2id] * 2,
            "best_of": [info.best_of] * 2,
            "lan": [info.lan] * 2,
            "note": [info.note] * 2,
            "opponent": [1, 2],
            "team": [t.name for t in teams],
            "hltv_team_id": [t.hltv_team_id for t in teams],
            "hltv_rank": [t.hltv_rank for t in teams],
            "hltv_ranking_date": [t.hltv_ranking_date for t in teams],
            "vrs_rank": [t.vrs_rank for t in teams],
            "vrs_ranking_date": [t.vrs_ranking_date for t in teams],
        },
        schema={"hltv_match_id": pl.Int64, "lp_match2id": pl.String, "best_of": pl.Int64, "lan": pl.Boolean,
                "note": pl.String, "opponent": pl.Int64, "team": pl.String, "hltv_team_id": pl.Int64,
                "hltv_rank": pl.Int64, "hltv_ranking_date": pl.String, "vrs_rank": pl.Int64,
                "vrs_ranking_date": pl.String},
    )


def cached_page(m: LpMatch, cache: Path = HLTV_CACHE) -> str | None:
    page = cache / f"match-{m.hltv_id}.html"
    if not (m.hltv_id and page.exists()):
        return None
    html = page.read_text()
    return None if is_server_error(html) else html


def match_page_tables(m: LpMatch, page: str) -> dict[str, pl.DataFrame]:
    """`veto` and `series` tables; one that fails its check is left out with a warning."""
    tables = {}
    for name, build in (("veto", lambda: veto_table(m, steps) if (steps := parse_veto(page)) else None),
                        ("series", lambda: series_table(m, parse_series_info(page)))):
        try:
            df = build()
        except ValueError as e:
            print(f"  {name} skipped for {m.hltv_id}: {e}")
            continue
        if df is not None:
            tables[name] = df
    return tables
