import json
import os
import time

from cs2demos.backlog import build_queue
from cs2demos.cli import prune_raw
from cs2demos.liquipedia import LpMap, LpMatch, LpOpponent, load_event, load_lan_events, resolve_from_results
from cs2demos.parse import PARSER_VERSION
from cs2demos.store import Manifest


def row(match2id, pagename, parent, date, hltv=None, tier="1", type_="Offline", score=(13, 7), team1="Vitality"):
    return {
        "game": "cs2", "finished": 1, "walkover": "", "resulttype": "", "match2id": match2id,
        "pagename": pagename, "parent": parent, "liquipediatier": tier, "type": type_, "date": date,
        "links": {"hltv": {"1": {"1": f"https://www.hltv.org/matches/{hltv}/x"}}} if hltv else [],
        "match2opponents": [
            {"type": "team", "name": team1, "teamtemplate": {"page": f"Team_{team1}", "name": f"Team {team1}", "shortname": team1}},
            {"type": "team", "name": "FaZe", "teamtemplate": {"page": "FaZe_Clan", "name": "FaZe Clan", "shortname": "FaZe"}},
        ],
        "match2games": [{"map": "Mirage", "winner": "1", "scores": list(score), "extradata": {}}],
    }


def write_store(tmp_path, archive_rows, hot_rows, lan_rows=None, links=None):
    raw = tmp_path / "raw"
    (raw / "archive").mkdir(parents=True)
    (raw / "archive" / "matches-2025-06.json").write_text(json.dumps(archive_rows))
    (raw / "matches.json").write_text(json.dumps(hot_rows))
    lan = tmp_path / "lan-series.json"
    if lan_rows is not None:
        lan.write_text(json.dumps(lan_rows))
    links_path = tmp_path / "hltv-links.json"
    links_path.write_text(json.dumps(links or {}))
    return {"raw_dir": raw, "lan_series": lan, "links": links_path}


def test_load_event_by_parent_with_links_overlay_and_newest_row(tmp_path):
    paths = write_store(
        tmp_path,
        archive_rows=[
            row("a", "Major/2025/Stage_1", "Major/2025", "2025-06-03"),
            row("b", "Major/2025", "Major/2025", "2025-06-20", score=(10, 13)),
            row("q", "Major/2025/Qualifier", "Major/2025/Qualifier", "2025-05-01"),
        ],
        hot_rows=[],
        lan_rows=[row("b", "Major/2025", "Major/2025", "2025-06-20", hltv=999)],
        links={"a": {"hltv": 111, "source": "liquipedia"}},
    )
    matches = load_event("Major/2025", **paths)
    assert [(m.match2id, m.hltv_id, m.pagename) for m in matches] == [
        ("a", 111, "Major/2025/Stage_1"),
        ("b", 999, "Major/2025"),
    ]
    assert matches[1].maps[0].scores == (13, 7)


def test_load_lan_events_filters_tier_type_and_date(tmp_path):
    paths = write_store(
        tmp_path,
        archive_rows=[
            row("a", "E/Stage_1", "E", "2025-06-03"),
            row("old", "Old", "Old", "2024-12-30"),
            row("online", "On", "On", "2025-06-03", type_="Online"),
            row("t2", "T2", "T2", "2025-06-03", tier="2"),
        ],
        hot_rows=[row("c", "F", "F", "2026-05-01", hltv=5)],
    )
    events = load_lan_events(**paths)
    assert sorted(events) == ["E", "F"]


def lp_match(match2id, date, hltv_id=None, scores=((13, 7),)):
    ops = (LpOpponent("Team_Vitality", "Team Vitality", "Vitality", []), LpOpponent("FaZe_Clan", "FaZe Clan", "FaZe", []))
    maps = [LpMap(i + 1, "Mirage", "de_mirage", s, ([], []), ("", "")) for i, s in enumerate(scores)]
    return LpMatch(match2id, "E", "1", date, hltv_id, ops, maps)


def test_resolve_from_results():
    bo3 = lp_match("m", "2025-06-03", scores=((13, 7), (5, 13), (13, 11)))
    rows = [
        {"id": 1, "team1": "FaZe", "team2": "Vitality", "score1": 1, "score2": 2},
        {"id": 2, "team1": "Vitality", "team2": "MOUZ", "score1": 2, "score2": 1},
    ]
    assert resolve_from_results(bo3, rows) == 1
    assert resolve_from_results(bo3, [{**rows[0], "score1": 2, "score2": 1}]) is None
    assert resolve_from_results(bo3, [rows[0], {**rows[0], "id": 3}]) is None
    bo1 = lp_match("m", "2025-06-03")
    assert resolve_from_results(bo1, [{"id": 4, "team1": "Vitality", "team2": "FaZe Clan", "score1": 13, "score2": 7}]) == 4


def manifest_with(tmp_path, entries):
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"maps": entries}))
    return Manifest(None, path)


def test_build_queue_newest_first_and_drops_done(tmp_path):
    manifest = manifest_with(tmp_path, {"10/m1": {"status": "parsed", "parser_version": PARSER_VERSION}})
    events = {
        "Done": [lp_match("d", "2026-09-01", hltv_id=10)],
        "Old": [lp_match("o", "2025-02-01", hltv_id=11)],
        "New": [lp_match("n", "2026-10-15"), lp_match("n2", "2026-10-18", hltv_id=12)],
    }
    queue = build_queue(events, manifest)
    assert [(e.page, e.start, e.end) for e in queue] == [("New", "2026-10-15", "2026-10-18"), ("Old", "2025-02-01", "2025-02-01")]
    assert [e.page for e in build_queue(events, manifest, include_done=True)] == ["New", "Done", "Old"]


def test_prune_raw_size_cap_keeps_quarantined(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    for i, name in enumerate(["1.rar", "2.rar", "3.rar", "4.rar.part"]):
        p = raw / name
        p.write_bytes(b"x" * 1000)
        os.utime(p, (time.time(), time.time() - 1000 + i))
    manifest = manifest_with(tmp_path, {"1/m1": {"status": "quarantined", "parser_version": PARSER_VERSION}})
    deleted = prune_raw(manifest, days=30, max_gb=1500 / 1024**3, raw_dir=raw)
    assert [p.name for p in deleted] == ["2.rar", "3.rar"]
    assert sorted(p.name for p in raw.iterdir()) == ["1.rar", "4.rar.part"]
