from cs2wp.data import MapRef, _elo_for
from cs2wp.hltv import parse_match_page
from cs2wp.pipeline import split


def ref(key, date):
    return MapRef(key, int(key.split("/")[0]), int(key.split("/m")[1]), "de_mirage", "x", "E", "p", date, ())


def test_split_is_by_date_and_never_shares_a_map():
    refs = [ref(f"{i}/m1", f"2025-0{1 + i % 9}-01") for i in range(9)] + [ref("99/m1", "2026-02-01")]
    fit, val, train, test = split(refs, "2026-01-01")
    assert [r.key for r in test] == ["99/m1"]
    assert {r.key for r in fit} | {r.key for r in val} == {r.key for r in train}
    assert not {r.key for r in fit} & {r.key for r in val}
    assert max(r.date for r in fit) <= min(r.date for r in val)


def test_elo_join_handles_a_map_played_twice():
    rows = [{"map": "Mirage", "i": 0}, {"map": "Dust II", "i": 1}, {"map": "Mirage", "i": 2}]
    assert _elo_for(rows, "de_mirage", 1)["i"] == 2
    assert _elo_for(rows, "de_dust2", 0)["i"] == 1
    assert _elo_for(rows, "de_nuke", 0) is None


PAGE = """
<div class="241616 dynamic-map-name-full" id="241616">Inferno</div>
<div class="stats-content" id="all-content"><a href="/player/1/a">x</a></div>
<div class="stats-content" id="241616-content"><table><tr><td class="players">
<a href="/player/20394/luchov"><div>Luciano '<span class="player-nick">luchov</span>' Herrera</div></a></td>
<td class="kd text-center traditional-data">38-20</td><td class="roundSwing text-center won">+6.61%</td>
<td class="adr text-center traditional-data">97.4</td><td class="rating text-center ratingPositive">1.61</td></tr></table></div>
"""


def test_cached_hltv_page_gives_swing_and_rating_per_map():
    assert parse_match_page(PAGE) == [{"mapstats_id": 241616, "map_name": "Inferno", "hltv_player": 20394,
                                        "nick": "luchov", "swing": 0.0661, "rating3": 1.61}]
