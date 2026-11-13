import numpy as np
import polars as pl
import pytest

from cs2wp.baselines import MIN_OTHER_MAPS, TAU2_FLOOR, VERSIONS, assign_roles, fit, shrink_weights, side_rows
from cs2wp.states import CT, T


def test_side_rows_counts_uncredited_rounds_as_zero():
    roster = pl.DataFrame({"steamid": [1, 1, 1], "side": [T, T, CT], "key": ["k"] * 3, "round_num": [1, 2, 13]},
                          schema_overrides={"steamid": pl.UInt64, "side": pl.Int32, "round_num": pl.Int32})
    credits = pl.DataFrame({"key": ["k", "k"], "round_num": [1, 1], "steamid": [1, 1],
                            **{v: [0.1, 0.2] for v in VERSIONS}}, schema_overrides={"steamid": pl.UInt64})
    out = side_rows(roster, credits).sort("side")
    assert out.filter(pl.col("side") == T).row(0, named=True)["rounds"] == 2
    assert out.filter(pl.col("side") == T)["wpa"].item() == pytest.approx(0.3)
    assert out.filter(pl.col("side") == CT)["wpa"].item() == 0
    assert out["team"].to_list() == [T, T]


def _t_roles(n_maps: int, entry_now: tuple[int, int], entry_before: tuple[int, int]) -> pl.DataFrame:
    """Two riflers (1, 2) and an AWPer (3) on one team; player 1 opens on map 0, player 2 on every other map."""
    rows = []
    for m in range(n_maps):
        opens = entry_now if m == 0 else entry_before
        for sid, o in zip((1, 2, 3), (*opens, 0)):
            rows.append({"key": f"m{m}", "steamid": sid, "lp_team": "x", "lp_player": str(sid),
                         "t_role": "AWPer" if sid == 3 else "Rifler", "entry_share": o / 10,
                         "opening_kills": o, "opening_deaths": 0, "t_rounds": 10})
    return pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64})


def _sides(n_maps: int) -> pl.DataFrame:
    rows = [{"key": f"m{m}", "steamid": sid, "side": side, "team": T, "rounds": 12, **{v: 0.0 for v in VERSIONS}}
            for m in range(n_maps) for sid in (1, 2, 3) for side in (T, CT)]
    return pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64})


def _positions(n_maps: int) -> pl.DataFrame:
    return pl.DataFrame({"key": [f"m{m}" for m in range(n_maps) for _ in range(3)],
                         "steamid": [1, 2, 3] * n_maps, "position": ["A", "B", "Mid"] * n_maps},
                        schema_overrides={"steamid": pl.UInt64})


def test_entry_uses_other_maps_and_awper_overrides_ct_position():
    n = MIN_OTHER_MAPS + 1
    out = assign_roles(_sides(n), _t_roles(n, entry_now=(5, 0), entry_before=(0, 5)), _positions(n))
    m0 = {(r["steamid"], r["side"]): r for r in out.filter(pl.col("key") == "m0").iter_rows(named=True)}
    assert m0[(2, T)]["role"] == "Entry" and m0[(2, T)]["role_source"] == "pooled"
    assert m0[(1, T)]["role"] == "Rifler"
    assert m0[(3, T)]["role"] == "AWPer" and m0[(3, CT)]["role"] == "AWPer"
    assert m0[(1, CT)]["role"] == "A" and m0[(1, CT)]["role_source"] is None


def test_entry_falls_back_to_the_map_with_few_other_maps():
    n = MIN_OTHER_MAPS
    out = assign_roles(_sides(n), _t_roles(n, entry_now=(5, 0), entry_before=(0, 5)), _positions(n))
    r = out.filter((pl.col("key") == "m0") & (pl.col("steamid") == 1) & (pl.col("side") == T)).row(0, named=True)
    assert r["role"] == "Entry" and r["role_source"] == "map"


def test_shrink_weights_follow_sample_size_and_floor_tau():
    raw, parent = np.array([0.02, 0.0, 0.05]), np.zeros(3)
    w, k = shrink_weights(raw, np.array([100_000.0, 1_000.0, 10.0]), parent, s2=0.04)
    assert w[0] > 0.95 and w[2] < 0.2 and w[0] > w[1] > w[2]
    w, k = shrink_weights(np.zeros(3), np.array([100.0, 100.0, 100.0]), parent, s2=0.04)
    assert k == pytest.approx(0.04 / TAU2_FLOOR) and w.max() < 1e-3


def test_fit_parents():
    rng = np.random.default_rng(0)
    rows = []
    for map_ in ("de_a", "de_b"):
        for side, role, mean in ((T, "Rifler", 0.0), (T, "AWPer", 0.03), (CT, "AWPer", 0.03), (CT, "A", 0.01),
                                 (CT, "B", 0.01)):
            for i in range(50):
                wpa = rng.normal(mean, 0.2 / np.sqrt(12)) * 12
                rows.append({"map": map_, "side": side, "role": role, "rounds": 12, "event": "e", "date": "d",
                             **{v: wpa for v in VERSIONS}})
    cells, ks = fit(pl.DataFrame(rows))
    assert set(ks) == {"T role", "CT AWPer", "CT map", "CT position"}
    t_awp = cells.filter((pl.col("side") == T) & (pl.col("role") == "AWPer"))
    pooled = t_awp["wpa_raw"].mean()
    assert t_awp["wpa_parent"].to_list() == pytest.approx([pooled, pooled])
    ct_pos = cells.filter((pl.col("side") == CT) & (pl.col("role") != "AWPer") & (pl.col("map") == "de_a"))
    assert ct_pos["wpa_parent"].n_unique() == 1


def test_load_sides_raises_clear_error_when_inputs_missing(monkeypatch, tmp_path):
    import cs2wp.baselines as baselines_mod

    monkeypatch.setattr(baselines_mod, "CREDITS", tmp_path / "credits")
    monkeypatch.setattr(baselines_mod, "STATES", tmp_path / "states")
    with pytest.raises(FileNotFoundError, match="cs2wp credit"):
        baselines_mod.load_sides([])
