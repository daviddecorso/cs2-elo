import pytest

from cs2demos.liquipedia import LpMap, LpMatch, LpOpponent
from cs2demos.match_page import HltvMapScore, map_score, parse_series_info, parse_veto, series_table, veto_table

PAGE = (
    '<div class="standard-box veto-box"><div class="padding preformatted-text">Best of 3 (LAN)\n\n'
    "* Grand final\n* Spirit start with a 1-0 map advantage</div></div>"
    '<div class="standard-box veto-box"><div class="padding"><div>1. Spirit removed Inferno</div>'
    "<div>2. MOUZ removed Anubis</div><div>3. Spirit picked Dust2</div><div>4. MOUZ picked Mirage</div>"
    "<div>5. Spirit removed Cache</div><div>6. MOUZ removed Ancient</div><div>7. Nuke was left over</div>"
    '</div></div><div class="flexbox-column">'
    '<div class="lineup standard-box"><div class="flex-align-center"><a href="/team/4494/mouz" class="text-ellipsis">MOUZ</a>'
    '</div><div class="teamRanking"><a href="/ranking/teams/2026/october/12/4494" class="ranking-badge hltv-ranking">'
    '<span>HLTV: </span>#3</a></div></div><div class="players"><a href="/team/1/not-this" class="text-ellipsis">x</a></div>'
    '<div class="lineup standard-box"><div class="flex-align-center"><a href="/team/7020/spirit" class="text-ellipsis">Spirit</a>'
    '</div><div class="teamRanking"><a href="/ranking/teams/2026/september/28/7020" class="ranking-badge hltv-ranking">'
    '<span>HLTV: </span>#1</a><a href="/valve-ranking/teams/2026/october/5?teamId=7020" class="ranking-badge vrs-ranking">'
    '<span>VRS: </span>#2</a></div></div><div class="players"></div>'
)


def match(maps, team1=("Team_Spirit", "Team Spirit", "Spirit")):
    return LpMatch(
        "m1", "Event/2026", "1", "2026-10-01", 123,
        (LpOpponent(*team1, []), LpOpponent("MOUZ", "MOUZ", "MOUZ", [])),
        [LpMap(i + 1, name, demo, (13, 7), ([], []), ("", "")) for i, (name, demo) in enumerate(maps)],
    )


def test_parse_veto_skips_format_box():
    steps = parse_veto(PAGE)
    assert [(s.step, s.team, s.action, s.demo_map) for s in steps][2:] == [
        (3, "Spirit", "pick", "de_dust2"), (4, "MOUZ", "pick", "de_mirage"), (5, "Spirit", "ban", "de_cache"),
        (6, "MOUZ", "ban", "de_ancient"), (7, None, "decider", "de_nuke"),
    ]
    assert parse_veto("<html></html>") == []


def test_veto_table_numbers_opponents_and_played_maps():
    df = veto_table(match([("Dust II", "de_dust2"), ("Mirage", "de_mirage")]), parse_veto(PAGE))
    assert df["opponent"].to_list() == [1, 2, 1, 2, 1, 2, None]
    assert df["map_number"].to_list() == [None, None, 1, 2, None, None, None]


def test_veto_table_infers_the_other_team_by_elimination():
    m = match([("Dust II", "de_dust2"), ("Mirage", "de_mirage"), ("Nuke", "de_nuke")],
              team1=("BetBoom_Team", "BetBoom Team", "BB"))
    df = veto_table(m, parse_veto(PAGE))
    assert df["opponent"].to_list()[:2] == [1, 2]
    assert df["map_number"].to_list()[6] == 3


def test_veto_table_rejects_maps_that_were_not_played():
    with pytest.raises(ValueError, match="map order"):
        veto_table(match([("Mirage", "de_mirage")]), parse_veto(PAGE))


def test_series_table_orders_teams_by_opponent_with_rankings():
    info = parse_series_info(PAGE)
    assert (info.best_of, info.lan, info.note) == (3, True, "Grand final\nSpirit start with a 1-0 map advantage")
    df = series_table(match([("Dust II", "de_dust2"), ("Mirage", "de_mirage")]), info)
    assert df.select("opponent", "team", "hltv_team_id", "hltv_rank", "hltv_ranking_date", "vrs_rank",
                     "vrs_ranking_date").rows() == [
        (1, "Spirit", 7020, 1, "2026-09-28", 2, "2026-10-05"),
        (2, "MOUZ", 4494, 3, "2026-10-12", None, None),
    ]


MAP_HOLDER = (
    '<div class="mapholder"><div class="played"><div class="mapname">Mirage</div></div>'
    '<div class="results-left lost"><div class="results-teamname text-ellipsis">MOUZ</div></div>'
    '<div class="results-center-half-score"><span> (</span><span class="ct">7</span><span class="">:</span>'
    '<span class="t">5</span><span>; </span><span class="t">5</span><span class="">:</span><span class="ct">7</span>'
    '<span></span><span>)</span><span> (</span><span>0</span><span class="">:</span><span>4</span><span>)</span></div>'
    '<span class="results-right won"><div class="results-teamname text-ellipsis">Spirit</div></span></div>'
)


def test_map_score_orders_halves_and_sides_by_opponent():
    m = match([("Dust II", "de_dust2"), ("Mirage", "de_mirage")])
    score = map_score(m, m.maps[1], MAP_HOLDER)
    assert score == HltvMapScore(([5, 7], [7, 5]), "t", (4, 0))
    assert map_score(m, m.maps[0], MAP_HOLDER) is None


def test_series_table_rejects_unknown_teams():
    with pytest.raises(ValueError, match="lineup teams"):
        series_table(match([], team1=("Astralis", "Astralis", "AST")),
                     parse_series_info(PAGE.replace("MOUZ</a>", "Heroic</a>")))
