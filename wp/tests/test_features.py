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


def test_missing_inputs_skip_the_feature():
    assert "ct_bomb_graph" not in with_derived(_state().drop("ct_graph_b")).columns
