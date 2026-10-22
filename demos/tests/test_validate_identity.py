import json

from cs2demos.identity import IdentityTable, match_opponent
from cs2demos.liquipedia import LpMap, LpMatch, LpOpponent, hltv_match_id, parse_match
from cs2demos.rounds import rebuild_rounds
from cs2demos.validate import validate_map

from .test_rounds import ends_from


def make_match() -> LpMatch:
    def op(page, players):
        return LpOpponent(page, page, page[:3].upper(), [{"name": p, "displayname": p.lower()} for p in players])

    return LpMatch(
        "x_R01-M001",
        "Event/2026",
        "1",
        "2026-10-18 15:00:00",
        123,
        (op("Alpha", ["A1", "A2", "A3", "A4", "A5"]), op("Bravo", ["B1", "B2", "B3", "B4", "B5"])),
    )


LP_MAP = LpMap(1, "Mirage", "de_mirage", (13, 5), ([9, 4], [3, 2]), ("ct", "t"))
WINNERS = "aaaaaaaaabbb" + "aaaabb"


def full_5v5(n):
    return {i: (5, 5) for i in range(1, n + 1)}


def test_valid_map_passes():
    rounds = rebuild_rounds(ends_from(WINNERS))
    assert validate_map(LP_MAP, "de_mirage", rounds, ("a", "b"), full_5v5(18)) == []


def test_wrong_score_sides_and_players_fail():
    rounds = rebuild_rounds(ends_from(WINNERS[:-1]))
    players = {**full_5v5(17), 4: (5, 6)}
    failures = validate_map(LP_MAP, "de_mirage", rounds, ("b", "a"), players)
    assert any("rounds" in f for f in failures)
    assert any("starts" in f for f in failures)
    assert any("not 5v5" in f for f in failures)


def test_halves_mismatch_fails():
    rounds = rebuild_rounds(ends_from("aaaaaaaabbbb" + "aaaaab"))
    failures = validate_map(LP_MAP, "de_mirage", rounds, ("a", "b"), full_5v5(18))
    assert failures and all("halves" in f for f in failures)


def test_identity_order(tmp_path):
    known = tmp_path / "known.json"
    known.write_text(json.dumps({"7": "Manual_Fix"}))
    table = IdentityTable.load({"1": "From_LP"}, known)
    match = make_match()
    assert table.resolve("1", "whatever", match, "") == "From_LP"
    assert table.resolve("7", "a1", match, "") == "Manual_Fix"
    assert table.resolve("9", "A-2!", match, "") == "A2"
    assert table.resolve("10", "nobody", match, "ctx") is None
    unresolved = tmp_path / "unresolved.json"
    table.save(known, unresolved)
    assert json.loads(known.read_text()) == {"7": "Manual_Fix", "9": "A2"}
    assert json.loads(unresolved.read_text()) == {"10": {"name": "nobody", "seen": "ctx"}}


def test_match_opponent_by_roster_then_name():
    match = make_match()
    assert match_opponent("clan x", ["B1", "B2", None, "A1"], match) == 1
    assert match_opponent("Alpha", [None], match) == 0
    assert match_opponent("ALP", [], match) == 0
    assert match_opponent("Unknown", [], match) is None


def test_parse_match_row():
    row = {
        "game": "cs2", "finished": 1, "walkover": "", "resulttype": "", "match2id": "m1", "pagename": "E",
        "liquipediatier": "1", "date": "2026-10-18 15:00:00",
        "links": {"hltv": {"1": {"1": "https://www.hltv.org/matches/2399417/match", "2": 0}}},
        "match2opponents": [
            {"type": "team", "name": "A", "teamtemplate": {"page": "A_Page", "name": "A", "shortname": "A"}, "match2players": []},
            {"type": "team", "name": "B", "teamtemplate": {"page": "B", "name": "B", "shortname": "B"}, "match2players": []},
        ],
        "match2games": [
            {"map": "Dust II", "winner": "2", "scores": [6, 13],
             "extradata": {"t1halfs": {"1": 4, "2": 2}, "t2halfs": {"1": 8, "2": 5}, "t1sides": {"1": "ct"}, "t2sides": {"1": "t"}}},
            {"map": "", "winner": "", "scores": [], "extradata": []},
        ],
    }
    m = parse_match(row)
    assert m.hltv_id == 2399417 and m.opponents[0].page == "A_Page"
    assert m.maps == [LpMap(1, "Dust II", "de_dust2", (6, 13), ([4, 2], [8, 5]), ("ct", "t"))]
    assert hltv_match_id([]) is None
