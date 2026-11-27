import numpy as np
import polars as pl
import pytest

from cs2wp.heatmaps import _greedy_clusters
from cs2wp.protocols import (apply_overrides, assign_zones, find_zones, nearest_places, number_zones, round_classes,
                             round_hits, scope_rounds, split_half_gate, team_slug, team_stats, team_windows)
from cs2wp.states import CT, TICK_RATE, T


def _rounds(n_maps: int = 2, per_map: int = 10, team: str = "A", side: str = "t", date: str = "2026-06-01",
            cls: str = "gun", series_offset: int = 0) -> pl.DataFrame:
    return pl.DataFrame([
        {"map_key": f"{series_offset + m}/m1", "date": date, "map": "de_mirage", "round_num": r, "side": side,
         "lp_team": team, "series": str(series_offset + m), "cls": cls, "fast": False}
        for m in range(n_maps) for r in range(1, per_map + 1)
    ])


def _nade(map_key: str, round_num: int, px: float, py: float, t: float = 2.0, team: str = "A", steamid: int = 1,
          gtype: str = "smoke", place: str = "SnipersNest") -> dict:
    return {"map_key": map_key, "date": "2026-06-01", "map": "de_mirage", "lp_team": team, "steamid": steamid,
            "side": "t", "round_num": round_num, "type": gtype, "level": "upper", "throw_t": t, "land_px": px,
            "land_py": py, "throw_px": 100.0, "throw_py": 100.0, "land_place": place}


def test_team_slug_matches_the_site():
    assert team_slug("Team Vitality") == "team-vitality"
    assert team_slug("BC.Game Esports") == "bc-game-esports"
    assert team_slug("  9z Team ") == "9z-team"


def test_weighted_clusters_seed_on_the_heaviest_neighbourhood():
    xs = np.array([0.0, 10.0, 100.0])
    ys = np.zeros(3)
    assert [c.tolist() for c in _greedy_clusters(xs, ys, 20.0)] == [[0, 1], [2]]
    assert [c.tolist() for c in _greedy_clusters(xs, ys, 20.0, weights=np.array([1.0, 1.0, 5.0]))] == [[2], [0, 1]]


def test_nearest_places_takes_the_closest_sample():
    samples = np.array([[0.0, 0.0, 0.0], [100.0, 0.0, 0.0]])
    names = np.array(["A", "B"], dtype=object)
    assert nearest_places(np.array([[90.0, 5.0, 0.0], [1.0, 1.0, 0.0]]), samples, names).tolist() == ["B", "A"]
    assert nearest_places(np.zeros((0, 3)), samples, names).tolist() == []


def test_round_classes_from_buys_and_group_entries():
    pr = pl.DataFrame([
        {"map_key": "1/m1", "date": "2026-06-01", "map": "de_mirage", "round_num": r, "side": s, "lp_team": "A",
         "steamid": 1}
        for r in (1, 2, 3, 4) for s in ("t", "ct")
    ])
    res = pl.DataFrame({
        "key": ["1/m1"] * 4, "round_num": [1, 2, 3, 4], "side": [T, T, T, CT],
        "team_buy": ["eco", "full", "force", "full"], "pistol": [True, False, False, False],
    })
    fe = 1000
    tac = pl.DataFrame({
        "key": ["1/m1", "1/m1"], "round_num": [2, 3], "group_entry": [True, True],
        "exec_tick": [fe + 20 * TICK_RATE, fe + 40 * TICK_RATE], "freeze_end_tick": [fe, fe],
    })
    out = round_classes(pr, res, tac).sort("round_num", "side")
    t = {r["round_num"]: r for r in out.filter(pl.col("side") == "t").iter_rows(named=True)}
    assert [t[r]["cls"] for r in (1, 2, 3, 4)] == ["pistol", "gun", "light", None]
    assert [t[r]["fast"] for r in (1, 2, 3)] == [False, True, False]
    ct4 = out.filter((pl.col("side") == "ct") & (pl.col("round_num") == 4)).row(0, named=True)
    assert ct4["cls"] == "gun" and not ct4["fast"] and ct4["series"] == "1"


def test_find_zones_keeps_zones_used_on_enough_gun_rounds():
    rounds = _rounds(n_maps=2, per_map=10)
    nades = [_nade(f"{m}/m1", r, 400.0 + r % 3, 470.0) for m in range(2) for r in range(1, 9)]
    nades.append(_nade("0/m1", 9, 700.0, 700.0, place="Catwalk"))
    nades.append(_nade("0/m1", 10, 702.0, 701.0, place="Catwalk"))
    nades.append(_nade("1/m1", 1, 200.0, 200.0, place="Jungle"))
    zones = find_zones(pl.DataFrame(nades), rounds, min_rate=0.08)
    assert zones.height == 2
    window = zones.filter(pl.col("place") == "SnipersNest").row(0, named=True)
    assert window["throws"] == 16 and window["lx"] == 401 and window["origins"][0] == [100, 100, 16]
    assert zones.filter(pl.col("place") == "Catwalk")["throws"].to_list() == [2]


def test_assign_zones_picks_the_nearest_centre_within_radius():
    zones = pl.DataFrame({"map": ["de_mirage"] * 2, "side": ["t"] * 2, "type": ["smoke"] * 2, "level": ["upper"] * 2,
                          "cx": [100.0, 150.0], "cy": [100.0, 100.0], "radius": [32.0, 32.0], "id": [7, 8]})
    nades = pl.DataFrame([_nade("0/m1", 1, 110.0, 100.0), _nade("0/m1", 2, 140.0, 100.0), _nade("0/m1", 3, 300.0, 300.0)])
    out = assign_zones(nades, zones).sort("round_num")
    assert out["zone"].to_list() == [7, 8]


def test_round_hits_keep_the_first_throw_and_its_time_bin():
    rounds = _rounds(n_maps=1, per_map=2)
    assigned = pl.DataFrame([_nade("0/m1", 1, 0, 0, t=12.0), _nade("0/m1", 1, 0, 0, t=3.0, steamid=2),
                             _nade("0/m1", 2, 0, 0, t=60.0)]).with_columns(pl.lit(0).alias("zone"))
    h = round_hits(assigned, rounds).sort("round_num")
    assert h["first_t"].to_list() == [3.0, 60.0]
    assert h["bin"].to_list() == [0, 5]


def test_team_windows_cut_at_a_later_stint():
    rounds = pl.DataFrame({"lp_team": ["A", "B", "C"]})
    residuals = pl.DataFrame({
        "key": ["1", "2", "3", "4"], "date": ["2026-01-01", "2026-08-01", "2026-09-01", "2025-01-01"],
        "lp_team": ["A", "A", "A", "B"], "stint_id": ["A#0:x", "A#1:y", "A#1:y", "B#0:z"],
        "stint_label": ["A (x)", "A (y)", "A (y)", "B (z)"],
    })
    w = {r["lp_team"]: r for r in team_windows(rounds, residuals, "2026-05-11").iter_rows(named=True)}
    assert w["A"]["from"] == "2026-08-01" and w["A"]["stint_label"] == "A (y)"
    assert w["B"]["from"] == "2026-05-11"
    assert w["C"]["from"] == "2026-05-11" and w["C"]["stint_label"] is None


def test_scope_rounds_needs_min_maps_inside_the_window():
    rounds = pl.concat([_rounds(n_maps=3, team="A"), _rounds(n_maps=2, team="B", series_offset=10)])
    windows = pl.DataFrame({"lp_team": ["A", "B"], "from": ["2026-01-01", "2026-01-01"]})
    assert scope_rounds(rounds, windows, min_maps=3)["lp_team"].unique().to_list() == ["A"]
    late = pl.DataFrame({"lp_team": ["A", "B"], "from": ["2026-07-01", "2026-01-01"]})
    assert scope_rounds(rounds, late, min_maps=1)["lp_team"].unique().to_list() == ["B"]


def test_team_stats_rates_against_the_league_with_unused_zones():
    rounds = pl.concat([_rounds(n_maps=4, team="A"), _rounds(n_maps=4, team="B", series_offset=10)])
    zones = pl.DataFrame({"map": ["de_mirage"] * 2, "side": ["t"] * 2, "id": [0, 1]})
    hits = pl.DataFrame([
        {"map_key": f"{m}/m1", "map": "de_mirage", "round_num": r, "side": "t", "lp_team": "A", "zone": 0,
         "first_t": 2.0, "cls": "gun", "series": str(m), "date": "2026-06-01", "bin": 0}
        for m in range(4) for r in range(1, 10)
    ])
    league = pl.DataFrame({"map": ["de_mirage"] * 2, "side": ["t"] * 2, "cls": ["gun"] * 2, "zone": [0, 1],
                           "rate": [0.45, 0.2]})
    out = team_stats(rounds, hits, zones, league, resamples=200)
    a0 = out.filter((pl.col("lp_team") == "A") & (pl.col("zone") == 0)).row(0, named=True)
    assert a0["rounds"] == 40 and a0["hits"] == 36 and a0["rate"] == pytest.approx(0.9)
    assert a0["diff"] == pytest.approx(0.45) and a0["lo"] <= a0["diff"] <= a0["hi"]
    assert a0["t_med"] == 2.0 and a0["bins"] == [36, 0, 0, 0, 0, 0]
    b1 = out.filter((pl.col("lp_team") == "B") & (pl.col("zone") == 1)).row(0, named=True)
    assert b1["hits"] == 0 and b1["diff"] == pytest.approx(-0.2) and b1["t_med"] is None


def test_split_half_gate_finds_stable_team_differences():
    rng = np.random.default_rng(0)
    rounds_parts, hit_rows = [], []
    teams = [f"T{i}" for i in range(12)]
    zone_rate = {(t, z): rng.uniform(0.05, 0.95) for t in teams for z in range(6)}
    for i, team in enumerate(teams):
        r = _rounds(n_maps=8, per_map=12, team=team, series_offset=100 * i)
        r = r.with_columns(pl.col("map_key").str.split("/").list.first().cast(pl.Int64).alias("_d"))
        r = r.with_columns(pl.format("2026-06-{}", (pl.col("_d") % 28 + 1).cast(pl.String).str.zfill(2)).alias("date")).drop("_d")
        rounds_parts.append(r)
        for row in r.iter_rows(named=True):
            for z in range(6):
                if rng.random() < zone_rate[(team, z)]:
                    hit_rows.append({"map_key": row["map_key"], "round_num": row["round_num"], "side": "t",
                                     "lp_team": team, "zone": z, "map": "de_mirage"})
    rounds = pl.concat(rounds_parts)
    hits = pl.DataFrame(hit_rows)
    zones = pl.DataFrame({"map": ["de_mirage"] * 6, "side": ["t"] * 6, "id": list(range(6))})
    league = (hits.group_by("zone").len().with_columns((pl.col("len") / rounds.height).alias("rate"),
                                                       pl.lit("de_mirage").alias("map"), pl.lit("t").alias("side"),
                                                       pl.lit("gun").alias("cls")))
    gate = split_half_gate(rounds, hits, league, zones, resamples=100)
    assert gate["teams"] == 12 and gate["cells"] == 72
    assert gate["r"] > 0.8 and gate["passed"]


def _zone_row(zid: int, lx: int, ly: int, r: int = 12, throws: int = 10, place: str = "LongA",
              origins: list[list[int]] | None = None, gtype: str = "smoke", side: str = "t") -> dict:
    return {
        "map": "de_dust2", "side": side, "type": gtype, "level": "upper",
        "cx": float(lx), "cy": float(ly), "radius": 32.0,
        "lx": lx, "ly": ly, "r": r, "place": place,
        "origins": origins if origins is not None else [[100, 100, throws]],
        "throws": throws, "id": zid,
    }


def test_apply_overrides_matches_by_geometry_and_keeps_unmatched():
    zones = pl.DataFrame([
        _zone_row(0, 871, 457, r=14, throws=50, place="LongA"),
        _zone_row(1, 500, 500, r=40, throws=30, place="Middle"),
        _zone_row(2, 200, 200, r=12, throws=20, place="BombsiteB"),
    ])
    assigned = pl.DataFrame([_nade("0/m1", 1, 871, 457), _nade("0/m1", 2, 500, 500)]).with_columns(
        pl.Series("zone", [0, 1], dtype=pl.Int64)
    )
    overrides = {
        "dust2": [
            {"side": "t", "type": "smoke", "level": "upper", "match": [[885, 460]],
             "name": "Long cross smoke", "description": "Blocks pit.", "reviewed": False},
            {"side": "t", "type": "smoke", "level": "upper", "match": [[535, 500]],
             "name": "Xbox smoke", "reviewed": True},
        ]
    }
    out_z, out_a, errs = apply_overrides(zones, assigned, overrides)
    assert errs == []
    assert out_z.height == 3
    by_name = {r["name"]: r for r in out_z.iter_rows(named=True)}
    assert by_name["Long cross smoke"]["lx"] == 871 and by_name["Long cross smoke"]["description"] == "Blocks pit."
    assert by_name["Long cross smoke"]["reviewed"] is False
    assert by_name["Xbox smoke"]["lx"] == 500 and by_name["Xbox smoke"]["reviewed"] is True
    assert by_name[None]["lx"] == 200
    assert out_a.height == 2


def test_apply_overrides_merges_zones_and_counts_round_once():
    rounds = _rounds(n_maps=1, per_map=3).with_columns(pl.lit("de_dust2").alias("map"))
    zones = pl.DataFrame([
        _zone_row(0, 870, 450, r=12, throws=60, place="LongA", origins=[[100, 100, 40], [200, 200, 20]]),
        _zone_row(1, 910, 470, r=14, throws=40, place="LongDoors", origins=[[104, 102, 30], [300, 300, 10]]),
    ])
    # Round 1 hits both parts (t=4.0 on part 0, t=2.0 on part 1); round 2 hits only part 1.
    assigned = pl.DataFrame([
        {**_nade("0/m1", 1, 870, 450, t=4.0), "map": "de_dust2", "zone": 0},
        {**_nade("0/m1", 1, 910, 470, t=2.0), "map": "de_dust2", "zone": 1},
        {**_nade("0/m1", 2, 910, 470, t=5.0), "map": "de_dust2", "zone": 1},
    ])
    overrides = {
        "dust2": [{
            "side": "t", "type": "smoke", "level": "upper",
            "match": [[870, 450], [910, 470]],
            "name": "Long cross smoke", "description": "Blocks long.", "reviewed": False,
        }]
    }
    merged_z, merged_a, errs = apply_overrides(zones, assigned, overrides)
    assert errs == [] and merged_z.height == 1
    z = merged_z.row(0, named=True)
    # Hit-weighted centre: (870*60 + 910*40)/100 = 886, (450*60 + 470*40)/100 = 458.
    assert (z["lx"], z["ly"]) == (886, 458)
    # Radius covers both parts: max(hypot(16, 8) + 12, hypot(24, 12) + 14) = max(29.9, 40.8) = 41.
    assert z["r"] == 41
    # Nearby origins [100,100,40] and [104,102,30] merge into one with count 70, followed by 20 and 10.
    assert len(z["origins"]) == 3 and z["origins"][0][2] == 70
    assert z["place"] == "LongA" and z["throws"] == 100

    numbered_z, numbered_a = number_zones(merged_z, merged_a, rounds)
    hits = round_hits(numbered_a, rounds).sort("round_num")
    assert hits.height == 2
    assert hits["round_num"].to_list() == [1, 2]
    assert hits["first_t"].to_list() == [2.0, 5.0]
    assert numbered_z["id"].to_list() == [0]


def test_apply_overrides_errors_on_stale_and_double_claim():
    zones = pl.DataFrame([_zone_row(0, 871, 457, r=12)])
    assigned = pl.DataFrame([_nade("0/m1", 1, 871, 457)]).with_columns(pl.lit(0, pl.Int64).alias("zone"))

    stale = {"dust2": [{"side": "t", "type": "smoke", "level": "upper", "match": [[100, 100]], "name": "Missing"}]}
    with pytest.raises(ValueError, match="dust2.*\\[100, 100\\]"):
        apply_overrides(zones, assigned, stale)
    out_z, _, errs = apply_overrides(zones, assigned, stale, allow_stale=True)
    assert len(errs) == 1 and out_z.height == 1 and out_z["name"][0] is None

    double = {
        "dust2": [
            {"side": "t", "type": "smoke", "level": "upper", "match": [[871, 457]], "name": "First"},
            {"side": "t", "type": "smoke", "level": "upper", "match": [[875, 457]], "name": "Second"},
        ]
    }
    with pytest.raises(ValueError, match="already claimed"):
        apply_overrides(zones, assigned, double)
    out_z, _, errs = apply_overrides(zones, assigned, double, allow_stale=True)
    assert len(errs) == 1 and out_z["name"].to_list() == ["First"]
