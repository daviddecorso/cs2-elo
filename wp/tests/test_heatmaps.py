import awpy.data as awpy_data
import numpy as np
import polars as pl
import pytest

from cs2wp.heatmaps import (
    assign_phase,
    decode_grid,
    encode_grid,
    group_lineups,
    resolve_scope,
)
from cs2wp.nav import NAV_RELEASE
from cs2wp.radar import load_awpy_map_data, world_to_radar
from cs2wp.resources import COUNT_LAG, thrower_grenades
from cs2wp.states import CT, T


def test_world_to_radar_matches_awpy_and_splits_nuke_levels():
    raw = awpy_data.map_data(NAV_RELEASE)
    meta = load_awpy_map_data(NAV_RELEASE)

    for map_name, x, y, z in [
        ("de_mirage", -1230.0, -287.0, 0.0),
        ("de_ancient", 0.0, 0.0, 50.0),
        ("de_nuke", 500.0, -1000.0, -200.0),
        ("de_nuke", 500.0, -1000.0, -650.0),
        ("de_train", 100.0, 200.0, -100.0),
    ]:
        awpy_entry = raw[map_name]
        exp_px = (x - awpy_entry["pos_x"]) / awpy_entry["scale"]
        exp_py = (awpy_entry["pos_y"] - y) / awpy_entry["scale"]
        px, py, level = world_to_radar(map_name, x, y, z, meta=meta)
        assert px == pytest.approx(exp_px)
        assert py == pytest.approx(exp_py)
        lower = (awpy_entry.get("verticalsections") or {}).get("lower")
        exp_level = "lower" if lower and float(lower["AltitudeMin"]) <= z < float(lower["AltitudeMax"]) else "upper"
        assert level == exp_level

    # Exact Nuke boundary (-495): < -495 is lower, >= -495 is upper
    assert world_to_radar("nuke", 0.0, 0.0, -495.1, meta=meta)[2] == "lower"
    assert world_to_radar("nuke", 0.0, 0.0, -495.0, meta=meta)[2] == "upper"


def test_phase_assignment():
    assert assign_phase(0.0) == "setup"
    assert assign_phase(19.9) == "setup"
    assert assign_phase(20.0) == "mid"
    assert assign_phase(49.9) == "mid"
    assert assign_phase(50.0) == "late"
    assert assign_phase(95.0) == "late"
    # Post-plant overrides time buckets once planted
    assert assign_phase(15.0, has_plant=True, after_plant=True) == "post"
    assert assign_phase(55.0, has_plant=True, after_plant=False) == "late"
    assert assign_phase(55.0, has_plant=False, after_plant=True) == "late"


def test_sparse_grid_encode_decode_round_trip():
    original = {0: 4, 15: 12, 16: 1, 2048: 99, 4095: 7}
    enc = encode_grid(original)
    assert enc["max"] == 99
    assert enc["n"] == sum(original.values())
    assert enc["cells"] == [0, 4, 15, 12, 1, 1, 2032, 99, 2047, 7]

    dense = decode_grid(enc)
    assert dense.shape == (4096,)
    assert int(dense.sum()) == sum(original.values())
    for idx, val in original.items():
        assert dense[idx] == val
    assert np.count_nonzero(dense) == len(original)

    empty = encode_grid({})
    assert empty == {"max": 0, "n": 0, "cells": []}
    assert np.count_nonzero(decode_grid(empty)) == 0


def _throw_row(
    gtype: str,
    tx: float,
    ty: float,
    lx: float,
    ly: float,
    t: float = 10.0,
    level: str = "upper",
) -> dict:
    return {
        "type": gtype,
        "level": level,
        "throw_cell": int(ty // 32) * 32 + int(tx // 32),
        "land_cell": int(ly // 32) * 32 + int(lx // 32),
        "throw_px": tx,
        "throw_py": ty,
        "land_px": lx,
        "land_py": ly,
        "throw_t": t,
    }


def test_landing_zone_merges_across_32px_boundary():
    rows = [
        _throw_row("smoke", 200.0, 300.0, 638.0, 400.0, 12.0),
        _throw_row("smoke", 202.0, 301.0, 642.0, 400.0, 14.0),
        _throw_row("smoke", 201.0, 299.0, 641.0, 402.0, 16.0),
    ]
    assert len({r["land_cell"] for r in rows}) == 2
    zones = group_lineups(pl.DataFrame(rows))["smoke"]
    assert len(zones) == 1
    assert zones[0]["n"] == 3
    assert zones[0]["land"] == [640, 401]
    assert zones[0]["r"] >= 8
    assert zones[0]["tMed"] == pytest.approx(14.0)


def test_landing_zone_collects_multiple_origins_dominant_first():
    rows = [
        *(_throw_row("molotov", 150.0, 200.0, 500.0, 500.0, 5.0 + i) for i in range(4)),
        *(_throw_row("molotov", 320.0, 250.0, 506.0, 498.0, 9.0 + i) for i in range(2)),
    ]
    zones = group_lineups(pl.DataFrame(rows))["molotov"]
    assert len(zones) == 1
    z = zones[0]
    assert z["n"] == 6
    assert len(z["from"]) == 2
    assert z["from"][0] == [150, 200, 4]
    assert z["from"][1] == [320, 250, 2]
    assert sum(o[2] for o in z["from"]) == z["n"]


def test_landing_zone_separates_distinct_landings_filters_and_caps():
    rows = []
    # 12 distinct smoke landings spaced 80 px apart with counts 1..12
    for idx in range(12):
        count = idx + 1
        lx = 100.0 + (idx % 4) * 150.0
        ly = 100.0 + (idx // 4) * 150.0
        for k in range(count):
            rows.append(_throw_row("smoke", 50.0, 50.0, lx, ly, 10.0 + k))
    zones = group_lineups(pl.DataFrame(rows))["smoke"]
    assert len(zones) == 10
    assert zones[0]["n"] == 12
    assert zones[-1]["n"] == 3
    assert all(z["n"] >= 2 for z in zones)
    total_throws = sum(range(1, 13))
    assert zones[0]["share"] == pytest.approx(round(12 / total_throws, 3))
    assert zones[0]["tMed"] == pytest.approx(15.5)


def test_flash_radius_wider_than_smoke():
    # Two clusters 44 px apart: > smoke radius (32) so smoke splits, <= flash radius (56) so flash merges
    rows = [
        _throw_row("smoke", 200.0, 200.0, 400.0, 400.0, 8.0),
        _throw_row("smoke", 200.0, 200.0, 401.0, 400.0, 9.0),
        _throw_row("smoke", 200.0, 200.0, 444.0, 400.0, 10.0),
        _throw_row("smoke", 200.0, 200.0, 445.0, 400.0, 11.0),
        _throw_row("flash", 200.0, 200.0, 400.0, 400.0, 8.0),
        _throw_row("flash", 200.0, 200.0, 401.0, 400.0, 9.0),
        _throw_row("flash", 200.0, 200.0, 444.0, 400.0, 10.0),
        _throw_row("flash", 200.0, 200.0, 445.0, 400.0, 11.0),
    ]
    grouped = group_lineups(pl.DataFrame(rows))
    assert len(grouped["smoke"]) == 2
    assert len(grouped["flash"]) == 1
    assert grouped["flash"][0]["n"] == 4


def test_scope_prefers_current_team_and_falls_back_when_thin():
    rows = [
        # Player 1: moved from OldTeam to NewTeam.
        # On mirage: 3 maps on NewTeam -> uses team scope (3 maps)
        # On nuke: 2 maps on NewTeam + 2 on OldTeam -> falls back to all scope (4 maps)
        # On ancient: 1 map on NewTeam + 1 on OldTeam -> excluded (< 3 maps)
        {"steamid": 1, "map": "de_mirage", "map_key": "1/m1", "date": "2026-06-01", "lp_team": "OldTeam"},
        {"steamid": 1, "map": "de_mirage", "map_key": "2/m1", "date": "2026-09-01", "lp_team": "NewTeam"},
        {"steamid": 1, "map": "de_mirage", "map_key": "3/m1", "date": "2026-09-05", "lp_team": "NewTeam"},
        {"steamid": 1, "map": "de_mirage", "map_key": "4/m1", "date": "2026-09-10", "lp_team": "NewTeam"},
        {"steamid": 1, "map": "de_nuke", "map_key": "5/m1", "date": "2026-06-02", "lp_team": "OldTeam"},
        {"steamid": 1, "map": "de_nuke", "map_key": "6/m1", "date": "2026-06-03", "lp_team": "OldTeam"},
        {"steamid": 1, "map": "de_nuke", "map_key": "7/m1", "date": "2026-09-12", "lp_team": "NewTeam"},
        {"steamid": 1, "map": "de_nuke", "map_key": "8/m1", "date": "2026-09-15", "lp_team": "NewTeam"},
        {"steamid": 1, "map": "de_ancient", "map_key": "9/m1", "date": "2026-06-04", "lp_team": "OldTeam"},
        {"steamid": 1, "map": "de_ancient", "map_key": "10/m1", "date": "2026-09-20", "lp_team": "NewTeam"},
    ]
    df = pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64})
    res = {r["map"]: r for r in resolve_scope(df).iter_rows(named=True)}
    assert set(res) == {"de_mirage", "de_nuke"}
    assert res["de_mirage"]["scope_type"] == "team"
    assert res["de_mirage"]["scope_team"] == "NewTeam"
    assert res["de_mirage"]["maps"] == 3
    assert res["de_nuke"]["scope_type"] == "all"
    assert res["de_nuke"]["current_team"] == "NewTeam"
    assert res["de_nuke"]["scope_team"] is None
    assert res["de_nuke"]["maps"] == 4


def test_thrower_grenades_with_origin():
    t0 = 1000
    traj = pl.DataFrame({
        "tick": [t0, t0 + 32, t0 + 96],
        "round_num": [1, 1, 1],
        "type": ["smoke", "smoke", "smoke"],
        "entity_id": [7, 7, 7],
        "entity_serial": [1, 1, 1],
        "x": [10.0, 250.0, 500.0],
        "y": [20.0, 120.0, 220.0],
        "z": [64.0, 140.0, 12.0],
    })
    ticks = pl.DataFrame(
        [
            {"tick": t0 - 16, "round_num": 1, "steamid": 42, "side": T, "x": 15.0, "y": 25.0,
             "smoke_grenades": 1, "flashbangs": 0, "he_grenades": 0, "fire_grenades": 0},
            {"tick": t0 + COUNT_LAG, "round_num": 1, "steamid": 42, "side": T, "x": 20.0, "y": 30.0,
             "smoke_grenades": 0, "flashbangs": 0, "he_grenades": 0, "fire_grenades": 0},
        ],
        schema_overrides={"steamid": pl.UInt64},
    )

    without = thrower_grenades(traj, ticks, ("smoke",))
    assert "x0" not in without.columns and "t0" not in without.columns

    with_orig = thrower_grenades(traj, ticks, ("smoke",), with_origin=True)
    row = with_orig.row(0, named=True)
    assert row["thrower"] == 42
    assert row["side"] == T
    assert row["x0"] == 10.0 and row["y0"] == 20.0 and row["z0"] == 64.0 and row["t0"] == t0
    assert row["x"] == 500.0 and row["y"] == 220.0 and row["z"] == 12.0 and row["pop_tick"] == t0 + 96
