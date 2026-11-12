import math

import polars as pl

from cs2wp.features import RUN_SPEED, with_derived


def _state(**kw):
    base = {"bomb_site": "A", "since_plant": 10.0, "ct_graph_a": 500.0, "ct_graph_b": 3000.0,
            "ct_kit_graph_a": 1500.0, "ct_kit_graph_b": 2000.0}
    return pl.DataFrame([{**base, **kw}])


def test_defuse_margin_takes_the_faster_of_nearest_ct_and_nearest_kit():
    # 30 s left. Nearest CT: 2 s run + 10 s defuse = 12 s. Kit CT: 6 s run + 5 s = 11 s.
    r = with_derived(_state()).row(0, named=True)
    assert r["ct_bomb_graph"] == 500.0
    assert math.isclose(r["defuse_margin"], 30 - (1500 / RUN_SPEED + 5))


def test_defuse_margin_without_kits_and_before_the_plant():
    no_kit = with_derived(_state(ct_kit_graph_a=float("nan"))).row(0, named=True)
    assert math.isclose(no_kit["defuse_margin"], 30 - (500 / RUN_SPEED + 10))
    before = with_derived(_state(bomb_site="none", since_plant=float("nan"))).row(0, named=True)
    assert before["defuse_margin"] is None and before["ct_bomb_graph"] is None


def test_events_use_prefixed_columns():
    ev = _state().rename(lambda c: f"pre_{c}")
    assert "pre_defuse_margin" in with_derived(ev, "pre_").columns
