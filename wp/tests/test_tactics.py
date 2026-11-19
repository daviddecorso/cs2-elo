import numpy as np
import polars as pl
from scipy.sparse import csr_matrix

from cs2wp.resources import COUNT_LAG, thrower_grenades
from cs2wp.states import CT, T
from cs2wp.tactics import (EXEC_WINDOW, first_entries, group_entry, hit_tick, per_team, season, site_hit, territory_share,
                           tactics_rounds)


def _line(n: int) -> csr_matrix:
    """Areas 0..n−1 in a line, both directions, unit edges."""
    rows = [*range(n - 1), *range(1, n)]
    cols = [*range(1, n), *range(n - 1)]
    return csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n))


def test_territory_splits_a_line_at_the_midpoint():
    sizes = np.ones(5)
    assert territory_share(_line(5), sizes, np.array([0]), np.array([4])) == 0.5
    assert territory_share(_line(5), sizes, np.array([0, 1]), np.array([4])) == 0.6


def test_territory_ignores_unreachable_areas_and_weights_by_size():
    g = _line(4)
    full = np.zeros((5, 5))
    full[:4, :4] = g.toarray()
    sizes = np.array([3.0, 1.0, 1.0, 1.0, 100.0])
    assert territory_share(csr_matrix(full), sizes, np.array([0]), np.array([3])) == 4 / 6


def test_territory_needs_both_sides():
    assert territory_share(_line(3), np.ones(3), np.array([0]), np.array([], dtype=np.int64)) is None


def test_first_entries_takes_each_players_earliest_tick():
    ticks = np.array([10, 10, 20, 30, 40])
    sids = np.array([1, 2, 1, 3, 2])
    assert first_entries(ticks, sids).tolist() == [10, 10, 30]


def test_group_entry_needs_three_within_the_window():
    assert group_entry(np.array([0, 100, EXEC_WINDOW])) == (0, EXEC_WINDOW)
    assert group_entry(np.array([0, 100, EXEC_WINDOW + 1])) is None
    assert group_entry(np.array([0, 2000, 2100, 2200])) == (2000, 2200)
    assert group_entry(np.array([0, 100])) is None


def test_site_hit_prefers_the_plant_then_the_earliest_second_entry():
    entries = {"A": np.array([50, 300]), "B": np.array([100, 200, 250])}
    assert site_hit("A", {"A": np.array([]), "B": entries["B"]}) == "A"
    assert site_hit(None, entries) == "B"
    assert site_hit(None, {"A": np.array([5]), "B": np.array([])}) is None


def test_hit_tick_is_the_first_entry_else_the_plant():
    assert hit_tick(np.array([120, 300]), 500) == 120
    assert hit_tick(np.array([], dtype=np.int64), 500) == 500


def test_season_splits_at_july():
    assert [season(d) for d in ("2026-06-30", "2026-07-01", "2025-12-31")] == ["2026H1", "2026H2", "2025H2"]


def _rounds():
    return pl.DataFrame({
        "key": ["m"] * 4, "round_num": [1, 2, 3, 4], "map": ["de_x"] * 4, "ct_lp_team": ["C"] * 4,
        "t_lp_team": ["D"] * 4, "ct_win": [True, False, True, False],
    })


def _raw():
    return pl.DataFrame({
        "key": ["m"] * 4, "round_num": [1, 2, 3, 4], "map": ["de_x"] * 4,
        "plant_site": [None, "A", None, "B"], "hit_site": ["A", "A", "B", "B"],
        "share30": [0.6, 0.4, 0.7, 0.5], "ct_alive30": [5, 5, 5, 4], "t_alive30": [5, 5, 5, 5],
        "share45": [None] * 4, "ct_alive45": [None] * 4, "t_alive45": [None] * 4,
        "share60": [None] * 4, "ct_alive60": [None] * 4, "t_alive60": [None] * 4,
        "defenders": [2, 0, 3, 1], "contact_ct_alive": [5, 5, 5, 5],
    }, schema_overrides={"share45": pl.Float64, "share60": pl.Float64, "ct_alive45": pl.Int64, "t_alive45": pl.Int64,
                         "ct_alive60": pl.Int64, "t_alive60": pl.Int64})


def test_centred_stats_sum_to_zero_per_cell_and_team_views_are_opposite():
    r = tactics_rounds(_raw(), _rounds())
    five = r.filter(pl.col("ct_alive30") == 5)
    assert abs(five["ctrl30"].sum()) < 1e-12
    assert r.filter(pl.col("ct_alive30") == 4)["ctrl30"].to_list() == [0.0]
    for site in ("A", "B"):
        assert abs(r.filter(pl.col("hit_site") == site)["contact"].sum()) < 1e-12
    assert r["take"].to_list() == [False, True, False, True]
    per = {x["lp_team"]: x for x in per_team(r).iter_rows(named=True)}
    for stat in ("ctrl30", "contact"):
        assert per["C"][stat] == -per["D"][stat]
    assert per["C"]["n_ctrl30"] == 4 and per["C"]["n_ctrl45"] == 0


def test_thrower_grenades_matches_each_type_to_its_count():
    grenades = pl.DataFrame({
        "tick": [100, 110, 200, 210], "round_num": [1, 1, 1, 1], "type": ["flashbang", "flashbang", "smoke", "smoke"],
        "entity_id": [1, 1, 2, 2], "entity_serial": [1, 1, 1, 1], "x": [0.0, 50.0, 500.0, 600.0],
        "y": [0.0, 0.0, 0.0, 0.0], "z": [0.0, 0.0, 0.0, 0.0],
    })
    rows = []
    for tick in (64, 100 + COUNT_LAG + 16, 200 + COUNT_LAG + 16):
        rows.append({"tick": tick, "round_num": 1, "steamid": 7, "side": T, "x": 0.0, "y": 0.0, "smoke_grenades": 0,
                     "flashbangs": 1 if tick == 64 else 0, "he_grenades": 0, "fire_grenades": 0})
        rows.append({"tick": tick, "round_num": 1, "steamid": 8, "side": CT, "x": 500.0, "y": 0.0,
                     "smoke_grenades": 1 if tick < 200 else 0, "flashbangs": 0, "he_grenades": 0, "fire_grenades": 0})
    out = thrower_grenades(grenades, pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64}))
    got = {x["type"]: (x["thrower"], x["side"], x["pop_tick"], x["x"]) for x in out.iter_rows(named=True)}
    assert got == {"flashbang": (7, T, 110, 50.0), "smoke": (8, CT, 210, 600.0)}
