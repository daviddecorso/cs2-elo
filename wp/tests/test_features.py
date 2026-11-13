import polars as pl

from cs2wp.features import with_derived


def _state(**kw):
    base = {"bomb_site": "A", "since_plant": 10.0, "ct_graph_a": 500.0, "ct_graph_b": 3000.0}
    return pl.DataFrame([{**base, **kw}])


def test_ct_bomb_graph_picks_the_planted_site_and_is_null_before_plant():
    assert with_derived(_state()).row(0, named=True)["ct_bomb_graph"] == 500.0
    assert with_derived(_state(bomb_site="B")).row(0, named=True)["ct_bomb_graph"] == 3000.0
    assert with_derived(_state(bomb_site="none")).row(0, named=True)["ct_bomb_graph"] is None


def test_events_use_prefixed_columns():
    ev = _state().rename(lambda c: f"pre_{c}")
    assert with_derived(ev, "pre_").row(0, named=True)["pre_ct_bomb_graph"] == 500.0


def test_alive_diff_and_kit_frac():
    row = with_derived(_state(ct_alive=5, t_alive=4, ct_kits=3)).row(0, named=True)
    assert row["alive_diff"] == 1.0
    assert abs(row["kit_frac"] - 0.6) < 1e-6
    assert with_derived(_state(ct_alive=0, t_alive=2, ct_kits=0)).row(0, named=True)["kit_frac"] is None


def test_kit_time_scales_kits_by_bomb_seconds_left_and_is_null_before_plant():
    assert with_derived(_state(ct_kits=2)).row(0, named=True)["kit_time"] == 60.0
    assert with_derived(_state(ct_kits=2, since_plant=45.0)).row(0, named=True)["kit_time"] == 0.0
    assert with_derived(_state(ct_kits=2, since_plant=float("nan"))).row(0, named=True)["kit_time"] is None


def test_missing_inputs_skip_the_feature():
    assert "kit_time" not in with_derived(_state()).columns
