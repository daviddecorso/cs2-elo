import numpy as np
import polars as pl

from cs2wp.pipeline import ABLATIONS, FEATURES, _monotone_constraints, _xy


def test_weights_are_constant_and_sum_to_round_count():
    df = pl.DataFrame({
        "key": ["m1", "m1", "m1", "m1", "m2", "m2"],
        "round_num": [1, 1, 1, 2, 1, 1],
        "ct_win": [1, 1, 1, 0, 0, 0],
        "map": ["de_mirage"] * 6,
        "bomb_site": ["none"] * 6,
        "seconds": [1.0, 2.0, 3.0, 1.0, 1.0, 2.0],
    })
    _, _, w = _xy(df, ["map", "bomb_site", "seconds"], ["de_mirage"])
    assert np.allclose(w, 0.5)
    assert np.isclose(w.sum(), 3.0)


def test_monotone_constraints_matches_feature_order():
    for name, features in {**FEATURES, **ABLATIONS}.items():
        mc = _monotone_constraints(features)
        assert len(mc) == len(features)
        for feat, val in zip(features, mc):
            if feat in ("ct_alive", "ct_hp", "ct_kits"):
                assert val == 1, f"Expected +1 for {feat} in {name}"
            elif feat in ("t_alive", "t_hp"):
                assert val == -1, f"Expected -1 for {feat} in {name}"
            else:
                assert val == 0, f"Expected 0 for {feat} in {name}"
