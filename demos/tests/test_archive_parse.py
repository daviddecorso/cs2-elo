from pathlib import Path

import polars as pl

from cs2demos.archive import group_by_map
from cs2demos.liquipedia import LpMap
from cs2demos.parse import SIDE_CT, SIDE_T, _side_code, _to_polars, assign_rounds, fill_round_starts, rounds_from_events


def lp(n, name, demo):
    return LpMap(n, name, demo, (13, 0), ([], []), ("", ""))


def test_group_by_map_number_parts_and_name_fallback():
    maps = [lp(1, "Inferno", "de_inferno"), lp(2, "Nuke", "de_nuke"), lp(3, "Dust II", "de_dust2")]
    dems = [
        Path("9z-vs-aurora-m1-inferno.dem"),
        Path("9z-vs-aurora-m2-nuke-p2.dem"),
        Path("9z-vs-aurora-m2-nuke-p1.dem"),
        Path("9z-vs-aurora-dust2.dem"),
    ]
    groups = group_by_map(dems, maps)
    assert groups[1] == [dems[0]]
    assert [p.name for p in groups[2]] == ["9z-vs-aurora-m2-nuke-p1.dem", "9z-vs-aurora-m2-nuke-p2.dem"]
    assert groups[3] == [dems[3]]


def test_group_by_map_ignores_team_name_like_map_number():
    maps = [lp(1, "Cache", "de_cache"), lp(2, "Cache", "de_cache")]
    dems = [Path("spirit-vs-m80-m1-cache.dem"), Path("spirit-vs-m80-m2-cache-p1.dem")]
    groups = group_by_map(dems, maps)
    assert groups == {1: [dems[0]], 2: [dems[1]]}


def test_side_code():
    df = pl.DataFrame({"side": ["counter-terrorist", "terrorist", "ct", "3", None]})
    assert df.select(_side_code("side"))["side"].to_list() == [SIDE_CT, SIDE_T, SIDE_CT, SIDE_CT, None]


def test_assign_rounds_keeps_post_round_and_drops_gaps():
    windows = pl.DataFrame(
        {"round_num": [1, 2], "window_start": [100, 500], "window_end": [300, 900]},
        schema={"round_num": pl.Int32, "window_start": pl.Int64, "window_end": pl.Int64},
    )
    # 50: warmup; 250: post-round of 1; 400: a dropped (replayed) round; 950: after the map.
    events = pl.DataFrame({"tick": [50, 150, 250, 400, 600, 950]})
    out = assign_rounds(events, windows)
    assert out["tick"].to_list() == [150, 250, 600]
    assert out["round_num"].to_list() == [1, 1, 2]


def test_rounds_from_events_matches_awpy_rounds():
    events = {
        "round_start": pl.DataFrame({"round": [1, 17, 18], "tick": [1, 4, 3189]}),
        "round_freeze_end": pl.DataFrame({"tick": [1496, 4469]}),
        "round_end": pl.DataFrame(
            {"reason": [None, "t_killed", "bomb_exploded"], "round": [17, 18, 19], "tick": [4, 2869, 9750],
             "winner": [None, "CT", "T"]}
        ),
        "round_officially_ended": pl.DataFrame({"tick": [4, 3189]}),
    }
    out = rounds_from_events(events)
    assert out.select("start_tick", "freeze_end_tick", "end_tick", "official_end_tick").rows() == [
        (4, 1496, 2869, 3189),
        (3189, 4469, 9750, 9750),
    ]
    assert out["winner"].to_list() == [SIDE_CT, SIDE_T]
    assert out["reason_name"].to_list() == ["ct_win", "target_bombed"]


def test_rounds_from_events_restart_and_restore():
    # Ticks from G2 vs BIG (2397605) m3: a match restart before round 1, and a backup restore during round 13.
    events = {
        "round_start": pl.DataFrame({"tick": [1, 3231, 3552, 18758, 92710, 96601, 96909, 115013]}),
        "round_freeze_end": pl.DataFrame({"tick": [1676, 3358, 13664, 20038, 94406, 112013, 116293]}),
        "round_end": pl.DataFrame(
            {"reason": ["ct_killed", "bomb_defused", "ct_killed", None, None, "ct_killed"],
             "tick": [2924, 18438, 92166, 96601, 96909, 114693], "winner": ["T", "CT", "T", None, None, "T"]}
        ),
        "round_officially_ended": pl.DataFrame({"tick": [18758, 92710, 96601, 96909, 115013]}),
    }
    out = rounds_from_events(events)
    assert out.select("start_tick", "freeze_end_tick", "end_tick", "official_end_tick").rows() == [
        (1, 1676, 2924, 2924),
        (3552, 13664, 18438, 18758),
        (18758, 20038, 92166, 92710),
        (96909, 112013, 114693, 115013),
    ]


def test_fill_round_starts_after_restore_stub():
    rounds = pl.DataFrame(
        {"start_tick": [None, 96601, None], "freeze_end_tick": [500, None, 112013],
         "end_tick": [92166, 96909, 114693], "official_end_tick": [92710, None, 115013]},
        schema={c: pl.Int32 for c in ("start_tick", "freeze_end_tick", "end_tick", "official_end_tick")},
    )
    assert fill_round_starts(rounds)["start_tick"].to_list() == [500, 96601, 96909]


def test_to_polars_accepts_empty_event_list():
    assert _to_polars([]).is_empty()
