from pathlib import Path

import polars as pl

from cs2demos.archive import group_by_map
from cs2demos.liquipedia import LpMap
from cs2demos.parse import SIDE_CT, SIDE_T, _side_code, assign_rounds


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
