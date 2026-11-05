import math

import numpy as np

from cs2wp.nav import dijkstra
from cs2wp.states import CT, T, side_features


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
