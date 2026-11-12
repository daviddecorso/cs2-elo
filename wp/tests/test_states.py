import math

import numpy as np
import polars as pl

from cs2wp.nav import LOOKUP_GRID, SiteDistance, dijkstra
from cs2wp.states import CT, T, _matrix, _player_slices, _round_matrices, side_features


def test_side_features_count_only_alive_players():
    side = np.array([CT, CT, T])
    hp = np.array([[100.0, 0.0, 40.0]])
    f = {k: np.array([[10.0, 1.0, 30.0]]) for k in ("graph_A", "graph_B", "euclid_A", "euclid_B")}
    f.update({"util": np.array([[2.0, 4.0, 1.0]]), "kit": np.array([[1.0, 1.0, 0.0]]), "defusing": np.array([[0.0, 1.0, 0.0]])})
    out = side_features(hp, side, f)
    assert out["ct_alive"][0] == 1 and out["t_alive"][0] == 1
    assert out["ct_hp"][0] == 100 and out["t_hp"][0] == 40
    # The dead CT is nearer the site and holds more utility, but doesn't count.
    assert out["ct_graph_a"][0] == 10 and out["ct_util"][0] == 2 and out["ct_kits"][0] == 1
    assert out["ct_defusing"][0] == 0


def test_a_side_with_nobody_alive_has_no_distance():
    out = side_features(np.zeros((1, 2)), np.array([CT, T]), {
        **{k: np.ones((1, 2)) for k in ("graph_A", "graph_B", "euclid_A", "euclid_B", "util", "kit")}})
    assert math.isnan(out["ct_graph_a"][0]) and out["ct_alive"][0] == 0
    assert math.isnan(out["ct_defusing"][0])


def test_dijkstra_walks_edges_backwards_to_the_nearest_source():
    # 1 -> 2 -> 3 (site), and 4 -> 3 directly but expensively; 3 -> 1 is one-way only.
    reverse = {2: [(1, 1.0)], 3: [(2, 1.0), (4, 5.0)], 1: [(3, 1.0)]}
    dist = dijkstra({3}, reverse)
    assert dist == {3: 0.0, 2: 1.0, 1: 2.0, 4: 5.0}


def test_round_matrices_match_single_column_matrix_and_handle_missing_data():
    snaps = pl.DataFrame({
        "steamid": [10, 20, 10, 20, 10],
        "tick": [100, 100, 132, 164, 196],
        "health": [100.0, 80.0, 60.0, None, 40.0],
        "util": [2.0, 1.0, 1.0, 0.0, 0.0],
    })
    players = [10, 20, 30]
    ticks = np.array([64, 100, 140, 196])
    slices = _player_slices(snaps, players, ("health", "util", "missing_col"))
    mats = _round_matrices(slices, players, ticks, ("health", "util", "missing_col"))
    for col in ("health", "util", "missing_col"):
        np.testing.assert_allclose(mats[col], _matrix(snaps, players, ticks, col), equal_nan=True)


def test_vectorized_distances_match_scalar_area_lookup():
    class StubNav:
        def find_area(self, pos):
            x, y, _ = pos
            return 1 if abs(x) < 10 and abs(y) < 10 else None

    sd = SiteDistance.__new__(SiteDistance)
    sd.nav = StubNav()
    sd._ids = np.array([2], dtype=np.int64)
    sd._xy = np.array([[50.0, 0.0]], dtype=np.float64)
    sd._dist = {"A": {1: 0.0, 2: 120.0}}
    sd.site_centroid = {"A": (0.0, 0.0, 0.0)}
    sd._cache = {}
    sd.stats = {"area": 0, "snapped": 0, "missed": 0}

    xs = np.array([1.0, 2.0, 60.0, 60.5, 500.0])
    ys = np.array([1.0, 2.0, 0.0, 0.5, 500.0])
    zs = np.zeros_like(xs)
    out = sd.distances(xs, ys, zs)
    assert out["graph_A"][:2].tolist() == [0.0, 0.0]
    assert out["graph_A"][2:4].tolist() == [120.0, 120.0]
    assert math.isnan(out["graph_A"][4])
    assert sd.stats == {"area": 2, "snapped": 2, "missed": 1}
    assert len(sd._cache) == len({(round(x / LOOKUP_GRID), round(y / LOOKUP_GRID), 0) for x, y in zip(xs, ys)})
