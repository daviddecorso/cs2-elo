import numpy as np
import polars as pl
import pytest

from cs2wp.duels import DUEL_WINDOW, FEATURES, duels, event_folds, fit, oriented, predict, side_totals
from cs2wp.states import CT, T

A, V = 1, 2


def _kill(tick=1000, weapon="ak47"):
    return pl.DataFrame({"tick": [tick], "round_num": [1], "attacker_steamid": [A], "attacker_side": ["terrorist"],
                         "victim_steamid": [V], "victim_side": ["counter-terrorist"], "weapon": [weapon],
                         "attacker_x": [0.0], "attacker_y": [0.0], "attacker_z": [0.0], "victim_x": [300.0],
                         "victim_y": [400.0], "victim_z": [0.0]},
                        schema_overrides={"attacker_steamid": pl.UInt64, "victim_steamid": pl.UInt64})


def _ticks():
    rows = []
    for tick in range(0, 1001, 16):
        rows.append({"tick": tick, "round_num": 1, "steamid": A, "health": 100 if tick < 900 else 60, "armor": 100,
                     "has_helmet": True, "velocity": 250.0 if tick == 880 else 0.0,
                     "active_weapon": "ak47" if tick < 800 else "knife"})
        rows.append({"tick": tick, "round_num": 1, "steamid": V, "health": 100, "armor": 0, "has_helmet": False,
                     "velocity": 0.0, "active_weapon": "glock"})
    return pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64})


def _damages(ticks):
    return pl.DataFrame({"tick": ticks, "round_num": [1] * len(ticks), "attacker_steamid": [V] * len(ticks),
                         "victim_steamid": [A] * len(ticks)},
                        schema_overrides={"tick": pl.Int64, "round_num": pl.Int64, "attacker_steamid": pl.UInt64,
                                          "victim_steamid": pl.UInt64})


def _flashes(tick, duration, who=V, thrower=A, thrower_side="terrorist"):
    return pl.DataFrame({"tick": [tick], "round_num": [1], "victim_steamid": [who], "duration": [duration],
                         "attacker_steamid": [thrower], "attacker_side": [thrower_side]},
                        schema_overrides={"victim_steamid": pl.UInt64, "attacker_steamid": pl.UInt64})


def test_state_is_read_before_the_first_damage_between_the_pair():
    d = duels(_kill(), _damages([900, 950, 1000 - DUEL_WINDOW - 1]), _flashes(0, 0.1), _ticks()).row(0, named=True)
    assert d["start"] == 900
    assert d["a_hp"] == 100 and d["a_speed"] == 250.0 and d["a_gun"] == "Rifle" and d["v_gun"] == "Pistol"
    assert d["distance"] == pytest.approx(500.0)
    assert not d["v_blind"]


def test_flash_counts_only_if_it_overlaps_the_duel():
    assert duels(_kill(), _damages([900]), _flashes(800, 2.0), _ticks())["v_blind"].item()
    assert not duels(_kill(), _damages([900]), _flashes(800, 1.0), _ticks())["v_blind"].item()


def test_non_gun_kills_and_teamkills_are_dropped():
    assert duels(_kill(weapon="hegrenade"), _damages([]), _flashes(0, 0.1), _ticks()).height == 0
    tk = _kill().with_columns(pl.lit("terrorist").alias("victim_side"))
    assert duels(tk, _damages([]), _flashes(0, 0.1), _ticks()).height == 0


def _synthetic(n, seed=0):
    rng = np.random.default_rng(seed)
    hp_a, hp_b = rng.integers(1, 101, n), rng.integers(1, 101, n)
    win = rng.random(n) < 1 / (1 + np.exp(-(hp_a - hp_b) / 25))
    a = {"gun": "Rifle", "armor": 100, "helmet": True, "speed": 0.0, "blind": False}
    cols = {f"{p}_{c}": [v] * n for p in ("a", "v") for c, v in a.items()}
    return pl.DataFrame({**cols, "a_hp": np.where(win, hp_a, hp_b), "v_hp": np.where(win, hp_b, hp_a),
                         "distance": np.full(n, 800.0), "attacker_side": np.where(rng.random(n) < 0.5, CT, T)})


def test_prediction_is_antisymmetric_and_learns_hp():
    d = _synthetic(4000)
    model = fit(oriented(d), FEATURES, 50)
    p = predict(model, d, FEATURES)
    swapped = d.rename({c: ("v_" + c[2:] if c.startswith("a_") else "a_" + c[2:]) for c in d.columns
                        if c[:2] in ("a_", "v_")})
    swapped = swapped.with_columns(pl.when(pl.col("attacker_side") == CT).then(T).otherwise(CT).alias("attacker_side"))
    assert predict(model, swapped, FEATURES) == pytest.approx(1 - p)
    hi = d["a_hp"] > d["v_hp"] + 40
    assert p[hi.to_numpy()].mean() > 0.7


def test_side_totals_count_each_duel_for_both_players():
    d = pl.DataFrame({"key": ["k", "k"], "attacker": [A, V], "victim": [V, A], "attacker_side": [T, CT]},
                     schema_overrides={"attacker": pl.UInt64, "victim": pl.UInt64})
    out = {(r["steamid"], r["side"]): r for r in side_totals(d, np.array([0.7, 0.4])).iter_rows(named=True)}
    assert out[(A, T)]["duels"] == 2 and out[(A, T)]["wins"] == 1 and out[(A, T)]["expected"] == pytest.approx(1.3)
    assert out[(V, CT)]["expected"] == pytest.approx(0.7)


def test_event_folds_keep_events_whole():
    d = pl.DataFrame({"event": ["a"] * 5 + ["b"] * 3 + ["c"] * 2})
    f = event_folds(d, k=2)
    assert len(set(f[:5])) == 1 and len(set(f[5:8])) == 1 and f[0] != f[5]


def test_build_fails_fast_without_role_rounds(monkeypatch, tmp_path):
    import cs2wp.duels as duels_mod

    monkeypatch.setattr(duels_mod, "ROLE_ROUNDS", tmp_path / "missing.parquet")
    with pytest.raises(FileNotFoundError, match="cs2wp baselines"):
        duels_mod.build()
