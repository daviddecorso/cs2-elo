import numpy as np
import polars as pl
import pytest

from cs2wp.credit import FLASH_SHARE, TRADE_RETURN, attribute, event_kind, neutral_tables, neutral_values, shares, with_values

CT, T = 3, 2


def event(**kw):
    base = {"event": "kill", "actor": 1, "victim": 2, "flash_assister": None, "traded": False,
            "alive_ct": [], "alive_t": []}
    return {**base, **kw}


def test_damage_and_kill_are_zero_sum():
    assert shares(event(event="damage_25-49")) == [(1, "damage_25-49", 1.0), (2, "damaged", -1.0)]
    assert shares(event()) == [(1, "kill", 1.0), (2, "death", -1.0)]


def test_flash_assist_splits_the_killers_part():
    rows = shares(event(flash_assister=3))
    assert rows == [(1, "kill", 1 - FLASH_SHARE), (3, "flash_assist", FLASH_SHARE), (2, "death", -1.0)]
    assert shares(event(flash_assister=1)) == [(1, "kill", 1.0), (2, "death", -1.0)]


def test_traded_death_gets_part_of_its_cost_back():
    assert (2, "trade_return", TRADE_RETURN) in shares(event(traded=True))


def test_plant_and_defuse_split_among_the_other_sides_alive_players():
    assert shares(event(event="plant", actor=5, alive_ct=[1, 2])) == [
        (5, "plant", 1.0), (1, "plant_against", -0.5), (2, "plant_against", -0.5)]
    assert shares(event(event="defuse", actor=1, alive_t=[])) == [(1, "defuse", 1.0)]


def test_team_and_self_damage_only_cost_the_one_responsible():
    assert shares(event(event="team_damage")) == [(1, "team_damage", 1.0)]
    assert shares(event(event="self_damage", actor=None)) == [(2, "self_damage", 1.0)]


def frame(rows):
    cols = {"kind": "damage", "actor": 1, "actor_side": CT, "victim": 2, "victim_side": T, "dmg": 30, "lethal": False,
            "flash_assister": None, "traded": False, "terminal": np.nan, "key": "1/m1", "date": "2026-01-01",
            "round_num": 1, "seq": 0, "pre_bomb_planted": 0.0, "pre_ct_alive": 5.0, "pre_t_alive": 5.0,
            "alive_ct": [[1]], "alive_t": [[2]]}
    return pl.DataFrame([{**cols, **r} for r in rows])


def test_event_kinds():
    f = frame([{}, {"lethal": True}, {"actor_side": T}, {"actor": None}, {"kind": "plant"}, {"dmg": 80}])
    assert f.select(event_kind(f))["kind"].to_list() == [
        "damage_25-49", "kill", "team_damage", "self_damage", "plant", "damage_50-99"]


def test_values_are_from_the_actors_side_and_terminal_states_are_pinned():
    f = frame([{}, {"actor": 2, "actor_side": T, "victim": 1, "victim_side": CT}, {"lethal": True, "terminal": 1.0}])
    v = with_values(f, np.array([0.5, 0.5, 0.6]), np.array([0.6, 0.6, 0.7]))["v"].to_list()
    assert v == pytest.approx([0.1, -0.1, 0.4])


def test_neutral_buckets_fall_back_when_thin():
    train = frame([{}] * 3).with_columns(pl.Series("event", ["kill"] * 3), pl.Series("v", [0.1, 0.2, 0.3]))
    out = neutral_values(train, neutral_tables(train))
    # Three events is under MIN_BUCKET, so both versions use the (event, side) mean.
    assert out["v_event"].to_list() == pytest.approx([0.2] * 3)
    assert out["v_mancount"].to_list() == pytest.approx([0.2] * 3)


def test_attribute_carries_all_three_versions():
    f = frame([{"lethal": True}]).with_columns(
        pl.lit("kill").alias("event"), pl.lit(0.2).alias("v"), pl.lit(0.1).alias("v_event"), pl.lit(0.05).alias("v_mancount"))
    out = attribute(f)
    assert out.select("steamid", "wpa", "nwpa_event", "nwpa_mancount").rows() == [(1, 0.2, 0.1, 0.05), (2, -0.2, -0.1, -0.05)]
