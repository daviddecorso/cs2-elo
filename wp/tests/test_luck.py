import numpy as np
import polars as pl
import pytest

from cs2wp.luck import (consecutive_pairs, cross_fit, kill_stakes, other_event_residuals, player_priors, player_skill,
                        trailing_rows, with_skill)


def _duel_views() -> pl.DataFrame:
    """Player 1 beats player 2 in every duel: 100 in event a (January), 10 in event b (February)."""
    n = [100, 10]
    dates, events, keys = ["2025-01-01", "2025-02-01"], ["a", "b"], ["10/m1", "20/m1"]
    frames = [pl.DataFrame({"steamid": [who] * c, "opponent": [3 - who] * c, "event": [e] * c, "date": [d] * c,
                            "key": [k] * c, "exec": [0.5 if who == 1 else -0.5] * c})
              for c, d, e, k in zip(n, dates, events, keys) for who in (1, 2)]
    return pl.concat(frames)


def test_priors_use_only_duels_before_the_event():
    priors = player_priors(_duel_views(), k=100.0)
    theta = {(s, e): t for s, e, t in priors.iter_rows()}
    assert theta[(1, "a")] == 0.0 and theta[(2, "a")] == 0.0
    assert theta[(1, "b")] == pytest.approx(50 / 200)
    assert theta[(2, "b")] == pytest.approx(-50 / 200)


def test_skill_timeline_sums_each_series_and_drops_only_unmapped_players():
    # Series 10 has two maps sharing t = 100; series 20 is one map at t = 200.
    values = pl.DataFrame({"key": ["10/m1", "10/m1", "10/m2", "20/m1", "20/m1"], "steamid": [1, 2, 1, 1, 2],
                           "exec": [0.5, -0.5, 0.25, -0.5, 0.5]})
    players = pl.DataFrame({"key": ["10/m1", "10/m2", "20/m1", "10/m1", "20/m1"], "steamid": [1, 1, 1, 2, 2],
                            "lp_player": ["P1", "P1", "P1", None, None]})
    times = pl.DataFrame({"key": ["10/m1", "10/m2", "20/m1"], "t": [100, 100, 200]})
    timeline, dropped = player_skill(values, players, times)
    assert list(timeline) == ["P1"]
    assert timeline["P1"] == [[100, 0.75, 2], [200, -0.5, 1]]
    assert dropped == {"unmapped": pytest.approx(2 / 5), "untimed": 0.0}


def test_skill_and_luck_are_zero_sum_and_add_to_exec():
    values = _duel_views()
    teams = pl.DataFrame({"key": ["10/m1", "10/m1", "20/m1", "20/m1"], "steamid": [1, 2, 1, 2],
                          "lp_team": ["X", "Y", "X", "Y"]})
    team_maps = pl.DataFrame({"key": ["20/m1", "20/m1"], "lp_team": ["X", "Y"], "opponent": ["Y", "X"],
                              "exec": [5.0, -5.0]})
    out = with_skill(team_maps, values, teams, player_priors(values, k=100.0)).sort("lp_team")
    # 10 duels at θ_X − θ_Y = 0.5.
    assert out["exec_skill"].to_list() == pytest.approx([5.0, -5.0])
    assert out["exec_luck"].to_list() == pytest.approx([0.0, 0.0])


def test_value_weighted_luck_scales_each_duel_by_its_stake():
    values = _duel_views().with_columns(pl.when(pl.col("event") == "b").then(0.4).otherwise(1.0).alias("stake"),
                                        pl.when(pl.col("event") == "b").then(pl.col("exec") * 2).otherwise(pl.col("exec"))
                                        .alias("exec"))
    teams = pl.DataFrame({"key": ["20/m1", "20/m1"], "steamid": [1, 2], "lp_team": ["X", "Y"]})
    team_maps = pl.DataFrame({"key": ["20/m1", "20/m1"], "lp_team": ["X", "Y"], "opponent": ["Y", "X"],
                              "exec": [10.0, -10.0]})
    out = with_skill(team_maps, values, teams, player_priors(values, k=100.0)).sort("lp_team")
    # 10 duels of exec 1 at stake 0.4, less skill of 0.5 per duel at the same stake.
    assert out["exec_value"].to_list() == pytest.approx([4.0, -4.0])
    assert out["exec_luck_value"].to_list() == pytest.approx([2.0, -2.0])
    assert out["exec_skill_value"].to_list() == pytest.approx([2.0, -2.0])


def test_stake_adds_the_victims_counterfactual_kill_value():
    fine = pl.DataFrame({"event": ["kill"] * 3, "actor_side": [2, 3, 3], "pre_bomb_planted": [0.0, 0.0, 0.0],
                         "own_alive": [1.0, 2.0, 5.0], "opp_alive": [2.0, 1.0, 5.0], "v_mancount": [0.25, 0.10, 0.9],
                         "n_mancount": [500, 500, 10]}, schema_overrides={"pre_bomb_planted": pl.Float32,
                                                                         "own_alive": pl.Float32, "opp_alive": pl.Float32,
                                                                         "n_mancount": pl.UInt32})
    coarse = pl.DataFrame({"event": ["kill", "kill"], "actor_side": [2, 3], "pre_bomb_planted": [0.0, 0.0],
                           "v_event": [0.15, 0.13], "n_event": [1000, 1000]},
                          schema_overrides={"pre_bomb_planted": pl.Float32, "n_event": pl.UInt32})
    base = pl.DataFrame({"event": ["kill", "kill"], "actor_side": [2, 3], "v_base": [0.14, 0.14], "n_base": [1, 1]},
                        schema_overrides={"n_base": pl.UInt32})
    states = pl.DataFrame({"attacker_side": [2, 3], "pre_bomb_planted": [0.0, 0.0], "pre_ct_alive": [2.0, 5.0],
                           "pre_t_alive": [1.0, 5.0]},
                          schema_overrides={c: pl.Float32 for c in ("pre_bomb_planted", "pre_ct_alive", "pre_t_alive")})
    out = kill_stakes(states, {"fine": fine, "coarse": coarse, "base": base})
    # A T in a 1v2: its kill plus the CT's. The 5v5 CT bucket has under 200 events, so both sides fall back to coarse.
    assert out["stake"].to_list() == pytest.approx([0.25 + 0.10, 0.13 + 0.15])


def test_trailing_window_excludes_the_current_series_and_older_maps(monkeypatch):
    monkeypatch.setattr("cs2wp.luck.MIN_TRAILING_MAPS", 2)
    day = 86400
    # Team X: maps at days 0, 200, 210, then the scored series at day 220 (two maps sharing t).
    ts = [0, 200 * day, 210 * day, 220 * day, 220 * day]
    long = pl.DataFrame({"lp_team": ["X"] * 5 + ["Y"] * 5, "t": ts * 2,
                         "stat": [100.0, 1.0, 3.0, 50.0, 50.0] + [0.0] * 5})
    rows = pl.DataFrame({"lp_team": ["X", "X"], "opponent": ["Y", "Y"], "t": [220 * day, 210 * day]})
    out = trailing_rows(rows, long, ["stat"])
    assert out.height == 1
    assert out["trail_stat"][0] == pytest.approx(2.0)


def test_cross_fit_removes_the_execution_term():
    rng = np.random.default_rng(0)
    n = 400
    ex = rng.normal(0, 3, n)
    margin = np.round(0.8 * ex + rng.normal(0, 2, n))
    rows = pl.DataFrame({"margin": margin, "exec": ex, "y": (margin > 0).astype(int)})
    folds = np.arange(n) % 4
    beta, x_margin, y_hat = cross_fit(rows, folds)
    assert beta.mean() == pytest.approx(0.8, abs=0.1)
    assert np.allclose(x_margin, margin - beta * ex)
    assert ((y_hat > 0.5) == (x_margin > 0)).all()


def test_cross_fit_removes_two_terms_fit_jointly():
    rng = np.random.default_rng(1)
    n = 600
    duel = rng.normal(0, 2, n)
    conv = 0.5 * duel + rng.normal(0, 1, n)
    margin = 2.0 * duel + 1.5 * conv + rng.normal(0, 2, n)
    rows = pl.DataFrame({"margin": margin, "duel": duel, "conv": conv, "y": (margin > 0).astype(int)})
    beta, x_margin, _ = cross_fit(rows, np.arange(n) % 4, ["duel", "conv"])
    assert beta.mean(axis=0) == pytest.approx([2.0, 1.5], abs=0.15)
    assert np.allclose(x_margin, margin - beta[:, 0] * duel - beta[:, 1] * conv)


def test_residuals_use_other_events_only(monkeypatch):
    monkeypatch.setattr("cs2wp.luck.MIN_OTHER_DUELS", 100)
    per = pl.DataFrame({"steamid": [1] * 4, "event": ["a", "a", "b", "b"], "key": ["10/m1", "10/m2", "20/m1", "20/m2"],
                        "series": ["10", "10", "20", "20"], "date": ["2025-01-01"] * 2 + ["2025-02-01"] * 2,
                        "exec": [20.0, 0.0, -10.0, -10.0], "duels": [100.0, 100.0, 100.0, 100.0]})
    r = other_event_residuals(per, "steamid").sort("key")
    # Event a's baseline is event b's rate, -0.1 per duel.
    assert r.filter(pl.col("key") == "10/m1")["resid"][0] == pytest.approx(0.2 + 0.1)
    pairs = consecutive_pairs(r, "steamid")
    assert pairs.height == 2
    assert pairs["same_series"].all()
