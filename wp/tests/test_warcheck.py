import math

import numpy as np
import polars as pl
import pytest

from cs2wp.baselines import VERSIONS
from cs2wp.data import MapRef
from cs2wp.warcheck import METRICS, lineup_rows, paired_ci, shrunk_rates, split_half, team_context_maps


def _pm(rows: list[dict]) -> pl.DataFrame:
    base = {f"num_{m}": 0.0 for m in METRICS}
    return pl.DataFrame([{**base, **r} for r in rows], schema_overrides={"steamid": pl.UInt64})


def test_split_half_recovers_k_from_signal_and_noise():
    rng = np.random.default_rng(1)
    signal_sd, noise_sd, rounds = 0.02, 0.5, 50
    rows = []
    for sid in range(400):
        true = rng.normal(0, signal_sd)
        for s in range(20):
            rows.append({"key": f"{sid * 100 + s}/m1", "series": str(sid * 100 + s), "date": f"2026-01-{1 + s:02d}",
                         "steamid": sid, "rounds": rounds,
                         **{f"num_{m}": float(rounds * true + rng.normal(0, noise_sd * math.sqrt(rounds))) for m in METRICS}})
    rel = split_half(_pm(rows), min_rounds=300)
    expected_k = noise_sd**2 / signal_sd**2
    assert rel["wpa"]["half_rounds"] == 500
    assert rel["wpa"]["k"] == pytest.approx(expected_k, rel=0.3)


def test_shrunk_rates_pull_small_samples_to_the_mean():
    prior = _pm([
        {"key": "1/m1", "steamid": 1, "rounds": 1000, **{f"num_{m}": 20.0 for m in METRICS}},
        {"key": "1/m1", "steamid": 2, "rounds": 10, **{f"num_{m}": 2.0 for m in METRICS}},
    ])
    out = {r["steamid"]: r for r in shrunk_rates(prior, {m: 100.0 for m in METRICS}).iter_rows(named=True)}
    mean = 22.0 / 1010
    assert out[1]["wpa"] == pytest.approx((20 + 100 * mean) / 1100 - mean)
    assert out[2]["wpa"] == pytest.approx((2 + 100 * mean) / 110 - mean)
    assert abs(out[2]["wpa"]) < 0.2 - mean


def test_lineup_rows_use_only_maps_before_the_event():
    rows = []
    for key, date, event, good in (("1/m1", "2026-01-01", "e0", 1.0), ("2/m1", "2026-03-01", "e1", -1.0), ("3/m1", "2026-03-02", "e1", -1.0)):
        for sid in range(10):
            team = "A" if sid < 5 else "B"
            rows.append({"key": key, "series": key.split("/")[0], "date": date, "event": event, "lp_team": team,
                         "steamid": sid, "rounds": 20, **{f"num_{v}": good * (1 if team == "A" else -1) for v in VERSIONS}})
    pm = _pm(rows)
    refs = [MapRef(key=k, hltv_match_id=int(k[0]), map_number=1, map="de_mirage", lp_match2id="x", lp_pagename="p",
                   prefix="p", date=d, elo=(("A", 1000.0), ("B", 1000.0))) for k, d in (("2/m1", "2026-03-01"), ("3/m1", "2026-03-02"))]
    outcomes = pl.DataFrame([{"key": k, "lp_team": t, "won": float(t == "A")} for k in ("2/m1", "3/m1") for t in ("A", "B")])
    out = lineup_rows(refs, pm, outcomes, {m: 10.0 for m in METRICS}, "2026-02-01")
    assert out.height == 2
    # Only e0 is prior, where A was better; e1's own maps (where A was worse) must not leak in.
    assert (out["wpa"] > 0).all()
    assert out["elo_logit"].to_list() == [0.0, 0.0]


def test_team_context_maps_deviations_sum_to_zero_per_team():
    rows = [{"key": "1/m1", "series": "1", "date": "2026-01-01", "event": "e0", "lp_team": "A" if sid < 5 else "B",
             "steamid": sid, "rounds": 20, **{f"num_{m}": float(sid) for m in METRICS}} for sid in range(10)]
    ref = MapRef(key="1/m1", hltv_match_id=1, map_number=1, map="de_mirage", lp_match2id="x", lp_pagename="p",
                 prefix="p", date="2026-01-01", elo=(("A", 1100.0), ("B", 1000.0)))
    outcomes = pl.DataFrame([{"key": "1/m1", "lp_team": t, "won": float(t == "A")} for t in ("A", "B")])
    tc = team_context_maps(_pm(rows), [ref], outcomes)
    sums = tc.group_by("lp_team").agg(pl.col("dev_wpa").sum(), pl.col("team_elo").first()).sort("lp_team")
    assert sums["dev_wpa"].to_list() == pytest.approx([0.0, 0.0])
    assert sums["team_elo"].to_list() == [1100.0, 1000.0]
    assert tc.filter(pl.col("steamid") == 0)["dev_wpa"][0] == pytest.approx(-2.0)


def test_paired_ci_resamples_whole_series():
    diff = np.array([1.0, 1.0, -1.0, -1.0])
    lo, hi = paired_ci(diff, np.array(["a", "a", "b", "b"]), n=500)
    assert lo == pytest.approx(-1.0) and hi == pytest.approx(1.0)
