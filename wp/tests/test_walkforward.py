import tempfile
from pathlib import Path

import numpy as np
import polars as pl
import xgboost as xgb

from cs2wp import evaluate as ev
from cs2wp.book import design, monday, recal_on
from cs2wp.pipeline import _make_qdm, _predict_booster, _predict_frame, _train_booster, resolve_device
from cs2wp.walkforward import (
    HALF_LIVES,
    PARAM_SETS,
    PARAMS,
    VARIANTS,
    _bucket_kits,
    _month_end,
    _months,
    _next_month,
    _weights,
    recalibrate,
)


def _states(dates: list[str]) -> pl.DataFrame:
    return pl.DataFrame({"key": [f"m{i}" for i in range(len(dates))], "round_num": [1] * len(dates), "date": dates})


def test_weights_keep_round_total_and_halve_per_half_life():
    assert None not in HALF_LIVES and HALF_LIVES == (365, 180, 90)
    assert not {"base_defuse_margin", "base_alive_kits", "base_kit_time"} & set(VARIANTS)
    df = _states(["2026-01-01", "2025-12-02"])
    w = _weights(df, "2026-01-01", 30)
    assert np.isclose(w.sum(), 2)
    assert np.isclose(w[1] / w[0], 0.5)
    assert np.allclose(_weights(df, "2026-01-01", None), 1)


def test_cross_fit_weights_decay_both_ways_from_the_held_out_month():
    df = _states(["2025-04-01", "2025-05-31", "2025-06-30"])
    w = _weights(df, "2025-05-01", 30, after="2025-05-31")
    assert np.isclose(w[0], w[2])
    assert np.isclose(w[1] / w[0], 2)


def test_month_helpers():
    assert _next_month("2025-12") == "2026-01"
    assert _month_end("2026-02") == "2026-02-28"


def test_intercept_matches_observed_rate():
    rng = np.random.default_rng(0)
    logit = rng.normal(size=20000)
    y = (rng.random(20000) < 1 / (1 + np.exp(-(logit + 0.3)))).astype(float)
    b = ev.intercept_shift(logit, y)
    assert abs(b - 0.3) < 0.05
    assert np.isclose((1 / (1 + np.exp(-(logit + b)))).mean(), y.mean())


def test_months_takes_warmup_before_test_from():
    df = _states(["2025-10-05", "2025-11-05", "2025-12-05", "2026-01-05", "2026-02-05"])
    assert _months(df, "2026-01-01") == (["2025-11", "2025-12"], ["2026-01", "2026-02"])


def test_recalibrate_uses_only_earlier_rounds():
    # Warm-up week is all CT wins at p=0.5, so the first scored week shifts up; nothing before it gets shifted.
    pred = pl.DataFrame({
        "key": ["a"] * 4 + ["b"] * 4, "round_num": [1, 2, 3, 4] * 2,
        "date": ["2026-01-05"] * 4 + ["2026-01-12"] * 4,
        "ct_win": [True, True, True, False] + [False] * 4, "p": [0.5] * 8,
        "scored": [False] * 4 + [True] * 4,
    })
    p, shifts = recalibrate(pred)
    assert np.allclose(p[:4], 0.5)
    assert np.allclose(p[4:], 0.75)
    assert shifts == [{"week": "2026-01-12", "shift": shifts[0]["shift"], "rounds": 4}]


def test_recal_window_covers_the_month_after_an_economy_patch():
    assert monday("2026-03-12") == "2026-03-09"
    assert not recal_on("2026-03-09", ["2026-03-10"])
    assert recal_on("2026-03-10", ["2026-03-10"])
    assert recal_on("2026-04-09", ["2026-03-10"])
    assert not recal_on("2026-04-10", ["2026-03-10"])


def test_readouts_split_pistols_buys_and_elo_gaps():
    df = pl.DataFrame({
        "key": ["a"] * 4, "round_num": [1, 2, 3, 4], "map": ["de_nuke"] * 4, "ct_win": [True, False, True, True],
        "ct_equip": [4000.0, 3000.0, 25000.0, 12000.0], "t_equip": [4000.0, 22000.0, 24000.0, 2000.0],
        "elo_diff_ct": [120.0, 120.0, float("nan"), -30.0],
    })
    r = ev.readouts(df, np.array([0.5, 0.2, 0.6, 0.7]))
    assert {row["buy"] for row in r["buy"]} == {"pistol", "eco/full", "full/full", "force/eco"}
    assert {row["elo_gap"] for row in r["elo_gap"]} == {"100..200", "no rating", "-50..0"}
    assert r["map"][0]["rounds"] == 4


def test_param_sets_vary_only_depth_and_child_weight():
    assert PARAM_SETS["d4w5"] == PARAMS
    for params in PARAM_SETS.values():
        assert {k: v for k, v in params.items() if k not in ("max_depth", "min_child_weight")} == {
            k: v for k, v in PARAMS.items() if k not in ("max_depth", "min_child_weight")}


def test_bucket_kits_splits_flagged_buckets_and_pools_three_plus():
    df = pl.DataFrame({
        "key": ["a", "a", "b", "c", "d"], "round_num": [1, 1, 1, 1, 1],
        "ct_alive": [5, 5, 5, 5, 4], "t_alive": [4, 4, 4, 4, 4], "bomb_planted": [True] * 5,
        "ct_kits": [0, 0, 3, 5, 0], "ct_win": [False, False, True, True, True],
    })
    rows = _bucket_kits(df, np.array([0.2, 0.4, 0.5, 0.7, 0.9]))
    assert [(r["bucket"], r["kits"], r["rounds"]) for r in rows] == [("5v4", "0", 1), ("5v4", "3+", 2)]
    assert np.isclose(rows[0]["gap"], 0.3)
    assert np.isclose(rows[1]["gap"], -0.4)


def _paired_frame(rounds: int = 400, per_round: int = 20, seed: int = 0):
    rng = np.random.default_rng(seed)
    rid = np.repeat(np.arange(rounds), per_round)
    p = np.repeat(rng.uniform(0.05, 0.95, rounds), per_round)
    y = np.repeat(rng.random(rounds), per_round) < p
    group = np.where(np.arange(rid.size) % 2 == 0, rid % 2, -1)
    return rid, y, p, {"g": group}


def test_paired_bootstrap_identical_runs_give_zero_deltas():
    rid, y, p, groups = _paired_frame()
    r = ev.paired_bootstrap(rid, y, p, p.copy(), groups, n=50, bins=4)
    assert r["log_loss"]["delta"] == 0 and r["log_loss"]["ci"] == [0.0, 0.0]
    assert r["max_bin_gap"]["a"] > 0 and np.allclose(r["max_bin_gap"]["ci"], 0)
    assert all(np.isclose(row["delta"], 0) and np.allclose(row["ci"], 0) for row in r["groups"]["g"])
    assert [row["rounds"] for row in r["groups"]["g"]] == [200, 200]


def test_paired_bootstrap_shifted_run_gives_an_interval_excluding_zero():
    rid, y, p, groups = _paired_frame()
    r = ev.paired_bootstrap(rid, y, p, np.clip(p + 0.15, 0, 0.999), groups, n=100)
    assert r["log_loss"]["ci"][0] > 0
    assert all(row["ci"][0] > 0 for row in r["groups"]["g"])


def test_quantiledmatrix_booster_saves_and_matches_xgbclassifier():
    rng = np.random.default_rng(0)
    n = 300
    df = pl.DataFrame({
        "map": rng.choice(["de_mirage", "de_inferno"], size=n),
        "bomb_site": rng.choice(["none", "A", "B"], size=n),
        "seconds": rng.uniform(0, 90, size=n),
        "ct_equip": rng.uniform(2000, 25000, size=n),
    })
    y = (df["seconds"].to_numpy() < 45).astype(np.int8)
    features, maps = ["map", "bomb_site", "seconds", "ct_equip"], ["de_inferno", "de_mirage"]
    assert resolve_device("cpu") == "cpu"

    fit, val = df[:200], df[200:]
    qdm_fit = _make_qdm(fit, features, maps, y[:200])
    qdm_val = _make_qdm(val, features, maps, y[200:], ref=qdm_fit)
    bst = _train_booster(qdm_fit, {"max_depth": 3, "learning_rate": 0.2}, n_estimators=30,
                         evals=[(qdm_val, "val")], early_stopping_rounds=3, device="cpu")
    p_val = _predict_booster(bst, qdm_val)
    p_frame = _predict_frame(bst, val, features, maps)
    np.testing.assert_allclose(p_val, p_frame, atol=1e-6)

    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "m.json"
        bst.save_model(path)
        clf = xgb.XGBClassifier()
        clf.load_model(path)
        p_clf = clf.predict_proba(design(val, features, maps))[:, 1]
        assert len(p_clf) == len(val)
