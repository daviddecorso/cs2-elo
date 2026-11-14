import numpy as np
import polars as pl
import pytest
from scipy.special import expit

from cs2wp.teamfactor import window_persistence
from cs2wp.teamstats import (STATS, fit_logit_ridge, long_maps, per_team, raw_ratings, side_design, side_gate,
                             stat_maps)


def _residuals(maps):
    rows = []
    for key, ta, tb, covered in maps:
        for t, o, won in ((ta, tb, 1.0), (tb, ta, 0.0)):
            rows.append({"key": key, "series": key.split("/")[0], "event": "E", "date": "2026-01-01", "lp_team": t,
                         "opponent": o, "stint_id": f"{t}#0", "stint_label": t, "igl_player": None, "rounds": 4,
                         "won": won, "elo": 1500.0, "all_covered": covered,
                         "resid_wpa_opp": (0.7 if t < o else -0.7) if covered else None})
    return pl.DataFrame(rows, schema_overrides={"igl_player": pl.String})


def _rounds(maps, drift_offset=0.0, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for key, ta, tb, _ in maps:
        for n in range(1, 5):
            ct, t = (ta, tb) if n <= 2 else (tb, ta)
            rows.append({"key": key, "round_num": n, "map": "de_mirage", "ct_lp_team": ct, "t_lp_team": t,
                         "ct_win": bool(rng.random() < 0.5), "drift": drift_offset + rng.normal(0, 0.05),
                         "p_econ": rng.uniform(0.2, 0.8), "p_duel": rng.uniform(0.05, 0.95)})
    return pl.DataFrame(rows)


MAPS = [("1/m1", "A", "B", True), ("2/m1", "B", "C", False), ("3/m1", "A", "C", True)]


def test_round_stats_are_zero_sum_per_map():
    res = _residuals(MAPS)
    maps = stat_maps(per_team(_rounds(MAPS), res), res)
    assert maps.height == 3 and (maps["team_a"] < maps["team_b"]).all()
    assert (maps["n_tpv"] == 4).all() and (maps["n_econ"] == 4).all()
    long = long_maps(maps)
    sums = long.group_by("key").agg(pl.col(*STATS).sum())
    assert sums.select(pl.col(*STATS).abs().max()).max_horizontal().item() < 1e-12
    assert maps.filter(pl.col("key") == "1/m1")["rwoe_war"].item() == pytest.approx(0.7)
    assert maps["war_covered"].to_list() == [True, False, True]


def test_rwoe_econ_is_wins_minus_economy_expectation():
    res = _residuals(MAPS)
    r = _rounds(MAPS)
    maps = stat_maps(per_team(r, res), res)
    m1 = r.filter(pl.col("key") == "1/m1")
    a_view = (m1["ct_win"].cast(pl.Float64) - m1["p_econ"]) * np.where(m1["ct_lp_team"] == "A", 1, -1)
    assert maps.filter(pl.col("key") == "1/m1")["rwoe_econ"].item() == pytest.approx(float(a_view.sum()))


def test_tpv_centering_removes_a_constant_side_offset():
    res = _residuals(MAPS)
    plain = stat_maps(per_team(_rounds(MAPS), res), res)["tpv"].to_numpy()
    shifted = stat_maps(per_team(_rounds(MAPS, drift_offset=-0.08), res), res)["tpv"].to_numpy()
    assert shifted == pytest.approx(plain)


def _side_rounds(effect: float, n_units=12, n_events=24, maps_per_event=30, seed=0):
    """Rounds between random unit pairs, with a planted CT defense `effect * (u − mean)` and no T offense."""
    rng = np.random.default_rng(seed)
    d_true = effect * (np.arange(n_units) - (n_units - 1) / 2) / n_units
    rows = []
    for e in range(n_events):
        date = f"2026-{1 + e // 4:02d}-{1 + 7 * (e % 4):02d}"
        for m in range(maps_per_event):
            a, b = rng.choice(n_units, 2, replace=False)
            key = f"{e}-{m}"
            for n in range(24):
                ct, t = (a, b) if n < 12 else (b, a)
                p_econ = rng.uniform(0.3, 0.7)
                p = expit(np.log(p_econ / (1 - p_econ)) + d_true[ct])
                rows.append({"key": key, "series": key, "event": f"E{e:02d}", "date": date, "ct_unit": f"U{ct:02d}",
                             "t_unit": f"U{t:02d}", "ct_win": bool(rng.random() < p), "p_econ": p_econ})
    return pl.DataFrame(rows), d_true


def test_logit_ridge_recovers_a_planted_defense_effect():
    r, d_true = _side_rounds(effect=2.0)
    units = sorted(set(r["ct_unit"].to_list()))
    idx = {u: i for i, u in enumerate(units)}
    ct = np.array([idx[u] for u in r["ct_unit"].to_list()])
    t = np.array([idx[u] for u in r["t_unit"].to_list()])
    p = r["p_econ"].to_numpy()
    b = fit_logit_ridge(side_design(ct, t, len(units)), r["ct_win"].cast(pl.Float64).to_numpy(), np.log(p / (1 - p)), 10.0)
    assert np.corrcoef(b[:len(units)], d_true)[0, 1] > 0.9
    assert np.abs(b[len(units):]).max() < np.abs(b[:len(units)]).max() / 2


def test_raw_ratings_shrink_toward_zero():
    ct, t = np.array([0, 0, 1, 1]), np.array([1, 1, 0, 0])
    y = np.array([1.0, 1.0, 0.0, 0.0])
    d0, _ = raw_ratings(ct, t, y, 2, k=0.0)
    d, _ = raw_ratings(ct, t, y, 2, k=2.0)
    assert d0[0] == pytest.approx(0.5) and d[0] == pytest.approx(0.25)


def test_side_gate_beats_raw_only_when_there_is_an_effect():
    r, _ = _side_rounds(effect=2.0)
    g = side_gate(r, min_prior_rounds=500)
    assert g["gain_vs_offset"] > 0 and g["gain_vs_offset_ci"][0] > 0
    null, _ = _side_rounds(effect=0.0, seed=1)
    g0 = side_gate(null, min_prior_rounds=500)
    assert g0["gain_vs_offset_ci"][0] < 0


def _persistence_maps(signal: float, seed=0, n_units=16):
    rng = np.random.default_rng(seed)
    tau = rng.normal(0, 1, n_units)
    rows = []
    for q, month in enumerate(("01", "04", "07", "10")):
        for m in range(160):
            a, b = rng.choice(n_units, 2, replace=False)
            y = signal * (tau[a] - tau[b]) + rng.normal(0, 1)
            rows.append({"key": f"{q}-{m}", "series": f"{q}-{m}", "date": f"2026-{month}-15", "stint_a": f"U{a:02d}",
                         "stint_b": f"U{b:02d}", "rounds": 20.0, "stat": 20.0 * y})
    return pl.DataFrame(rows)


def test_window_persistence_separates_signal_from_noise():
    strong = window_persistence(_persistence_maps(1.0), resid_col="stat", min_window=100, resamples=50)
    noise = window_persistence(_persistence_maps(0.0), resid_col="stat", min_window=100, resamples=50)
    assert strong["windows"] == 4 and strong["r"] > 0.8 and strong["r_ci"][0] > 0.5
    assert abs(noise["r"]) < 0.4 and noise["r_ci"][0] < 0
