import math

import numpy as np
import polars as pl
import pytest

from cs2wp.baselines import VERSIONS
from cs2wp.data import MapRef
from cs2wp.states import CT, T
from cs2wp.teamfactor import (
    compute_residuals,
    fit_apm,
    fit_team_factor,
    split_half_team_factor,
)
from cs2wp.war import apply_igl_adjustment, bootstrap_players, fit_igl_adjustment
from cs2wp.warcheck import METRICS


def _make_ref(key: str, date: str, team_a: str, team_b: str) -> MapRef:
    h, m = key.split("/")
    return MapRef(
        key=key, hltv_match_id=int(h), map_number=int(m[1:]), map="de_mirage",
        lp_match2id=f"lp_{h}", lp_pagename="E", prefix="p", date=date,
        elo=((team_a, 1500.0), (team_b, 1500.0)),
    )


def _synth_pm_and_scores(n_events: int = 8, rounds: int = 24, noise_sd: float = 0.01, seed: int = 0):
    rng = np.random.default_rng(seed)
    teams = [f"T{i}" for i in range(4)]
    rosters = {t: [100 * i + j for j in range(5)] for i, t in enumerate(teams)}
    pm_rows, score_rows, refs = [], [], []
    match_id = 1
    for ev_i in range(n_events):
        date = f"2026-0{(ev_i % 9) + 1}-15"
        ev = f"ev_{ev_i}"
        for a_i in range(len(teams)):
            for b_i in range(a_i + 1, len(teams)):
                ta, tb = teams[a_i], teams[b_i]
                key = f"{match_id}/m1"
                match_id += 1
                refs.append(_make_ref(key, date, ta, tb))
                rw_a = int(np.clip(round(rounds * (0.5 + rng.normal(0, 0.08))), 0, rounds))
                rw_b = rounds - rw_a
                won_a = float(rw_a > rw_b)
                score_rows.append({"key": key, "lp_team": ta, "rounds_won": rw_a, "rounds": rounds, "won": won_a})
                score_rows.append({"key": key, "lp_team": tb, "rounds_won": rw_b, "rounds": rounds, "won": 1.0 - won_a})
                for team, sids in ((ta, rosters[ta]), (tb, rosters[tb])):
                    for k, sid in enumerate(sids):
                        pm_rows.append({
                            "key": key, "series": key.split("/")[0], "date": date, "event": ev,
                            "lp_team": team, "is_igl": k == 0, "steamid": sid, "rounds": rounds,
                            **{f"num_{m}": float(rng.normal(0, noise_sd * rounds)) for m in METRICS},
                        })
    pm = pl.DataFrame(pm_rows, schema_overrides={"steamid": pl.UInt64})
    scores = pl.DataFrame(score_rows)
    return refs, pm, scores


def test_residuals_are_antisymmetric_and_sum_to_zero():
    refs, pm, scores = _synth_pm_and_scores(n_events=8, rounds=24, seed=42)
    ks = {m: 200.0 for m in METRICS}
    maps, team_maps, stats = compute_residuals(refs, pm, scores, ks, mode="loeo")

    assert stats["maps_total"] == len(refs)
    assert stats["maps_all_covered"] == len(refs)
    assert team_maps.height == 2 * maps.height
    by_map = team_maps.group_by("key").agg(pl.col("residual").sum().alias("rsum"), pl.col("moe").sum().alias("msum"))
    assert by_map["rsum"].abs().max() < 1e-12
    assert by_map["msum"].abs().max() < 1e-12
    assert team_maps["residual"].sum() == pytest.approx(0.0, abs=1e-10)
    assert team_maps["moe"].sum() == pytest.approx(0.0, abs=1e-10)


def _synth_team_residual_maps(tau_true: dict[str, float], n_rounds_per_series: int = 2, n_rounds: int = 24, noise_sd: float = 0.04, seed: int = 0) -> pl.DataFrame:
    rng = np.random.default_rng(seed)
    teams = sorted(tau_true)
    rosters = {t: [100 * i + k for k in range(5)] for i, t in enumerate(teams)}
    rows = []
    sid_counter = 1
    for rep in range(n_rounds_per_series):
        for i in range(len(teams)):
            for j in range(i + 1, len(teams)):
                ta, tb = teams[i], teams[j]
                key = f"{sid_counter}/m1"
                series = str(sid_counter)
                date = f"2026-01-{1 + (sid_counter % 28):02d}"
                sid_counter += 1
                res_per_rd = (tau_true[ta] - tau_true[tb]) + float(rng.normal(0.0, noise_sd / math.sqrt(n_rounds)))
                rows.append({
                    "key": key, "series": series, "event": "e0", "date": date,
                    "team_a": ta, "team_b": tb, "stint_a": ta, "stint_b": tb,
                    "stint_label_a": ta, "stint_label_b": tb,
                    "igl_name_a": None, "igl_name_b": None,
                    "steamids_a": rosters[ta], "steamids_b": rosters[tb],
                    "igl_a": rosters[ta][0], "igl_b": rosters[tb][0],
                    "rounds": n_rounds, "resid_wpa_opp": res_per_rd * n_rounds,
                    "residual": res_per_rd * n_rounds, "moe": 0.0,
                    "elo_a": 1500.0, "elo_b": 1500.0, "all_covered": True,
                })
    return pl.DataFrame(rows, schema_overrides={
        "steamids_a": pl.List(pl.UInt64), "steamids_b": pl.List(pl.UInt64),
        "igl_a": pl.UInt64, "igl_b": pl.UInt64,
    })


def test_planted_team_factor_recovered_and_noise_shrinks_to_zero():
    tau_true = {f"T{i}": 0.08 - 0.0145 * i for i in range(12)}
    maps_sig = _synth_team_residual_maps(tau_true, n_rounds_per_series=3, noise_sd=0.04, seed=7)
    sh = split_half_team_factor(maps_sig, unit="stint", min_rounds=100, resamples=100, seed=1)
    assert sh["r"] > 0.75
    assert sh["r_ci"][0] > 0.0
    tf = fit_team_factor(maps_sig, unit="stint", alpha=sh["k_rounds"], resamples=50, seed=1)
    est = dict(tf.select("unit_id", "tau_per100").iter_rows())
    r_rec = np.corrcoef([tau_true[t] for t in tau_true], [est[t] for t in tau_true])[0, 1]
    assert r_rec > 0.95
    assert est["T0"] > 5.0 and est["T11"] < -5.0

    zeros = {t: 0.0 for t in tau_true}
    maps_null = _synth_team_residual_maps(zeros, n_rounds_per_series=3, noise_sd=0.04, seed=8)
    sh_null = split_half_team_factor(maps_null, unit="stint", min_rounds=100, resamples=100, seed=2)
    alpha_null = sh_null["k_rounds"] if (sh_null["k_rounds"] is not None and math.isfinite(sh_null["k_rounds"])) else math.inf
    tf_null = fit_team_factor(maps_null, unit="stint", alpha=alpha_null, resamples=20, seed=2)
    assert tf_null["tau_per100"].abs().max() < 1.5


def test_planted_player_effect_needs_two_lineups_and_stable_roster_splits_evenly():
    # T0 is stable with +0.10 planted on player 1 only -> ridge splits it evenly (0.02 each).
    # Player 10 (+0.10) plays in 3 distinct lineups while each core also plays with an average 5th -> 10 is recovered.
    stable_t0 = [1, 2, 3, 4, 5]
    cores = {
        "T1": [11, 12, 13, 14],
        "T2": [21, 22, 23, 24],
        "T3": [31, 32, 33, 34],
    }
    bench_t4 = [51, 52, 53, 41, 42]
    true_theta = {sid: 0.0 for sid in [*stable_t0, *(s for c in cores.values() for s in c), 10, *bench_t4]}
    true_theta[1] = 0.10
    true_theta[10] = 0.10

    lineups_by_phase = [
        {"T0": stable_t0, "T1": [10, *cores["T1"]], "T2": [52, *cores["T2"]], "T3": [53, *cores["T3"]], "T4": bench_t4},
        {"T0": stable_t0, "T1": [51, 21, 12, 13, 14], "T2": [10, 11, 22, 23, 24], "T3": [53, *cores["T3"]], "T4": bench_t4},
        {"T0": stable_t0, "T1": [51, *cores["T1"]], "T2": [52, 31, 22, 23, 24], "T3": [10, 21, 32, 33, 34], "T4": [51, 52, 11, 41, 42]},
    ]
    rows = []
    match_id = 1
    for phase, cur in enumerate(lineups_by_phase):
        teams = sorted(cur)
        for rep in range(3):
            for i in range(len(teams)):
                for j in range(i + 1, len(teams)):
                    ta, tb = teams[i], teams[j]
                    la, lb = cur[ta], cur[tb]
                    res = 24.0 * (sum(true_theta[s] for s in la) - sum(true_theta[s] for s in lb))
                    rows.append({
                        "key": f"{match_id}/m1", "series": str(match_id), "event": f"e{phase}_{rep}", "date": f"2026-0{phase+1}-01",
                        "team_a": ta, "team_b": tb, "stint_a": ta, "stint_b": tb,
                        "steamids_a": la, "steamids_b": lb, "igl_a": la[0], "igl_b": lb[0],
                        "rounds": 24, "residual": res, "all_covered": True,
                    })
                    match_id += 1

    maps_df = pl.DataFrame(rows, schema_overrides={
        "steamids_a": pl.List(pl.UInt64), "steamids_b": pl.List(pl.UInt64),
        "igl_a": pl.UInt64, "igl_b": pl.UInt64,
    })
    tp, _, p_ids, _ = fit_apm(maps_df, resid_col="residual", alpha=0.5, calling_ratio=0.0)
    est = dict(zip(p_ids, tp))
    stable_vals = [est[s] for s in stable_t0]
    assert max(stable_vals) - min(stable_vals) < 1e-8
    assert est[10] - est[11] > 0.085
    assert abs(est[11] - est[21]) < 0.01


def test_constant_added_to_every_igl_cancels():
    base_df = _synth_team_residual_maps({"T0": 0.04, "T1": 0.01, "T2": -0.02, "T3": -0.03}, n_rounds_per_series=3, noise_sd=0.01, seed=9)
    # Plant calling effect C_igl on igl_a/igl_b; adding any league-wide constant +K cancels in A - B.
    igl_eff = {0: 0.03, 100: -0.01, 200: 0.0, 300: -0.02}
    res_base = [
        r["residual"] + r["rounds"] * (igl_eff[r["igl_a"]] - igl_eff[r["igl_b"]])
        for r in base_df.iter_rows(named=True)
    ]
    res_shifted = [
        r["residual"] + r["rounds"] * ((igl_eff[r["igl_a"]] + 5.0) - (igl_eff[r["igl_b"]] + 5.0))
        for r in base_df.iter_rows(named=True)
    ]
    df1 = base_df.with_columns(pl.Series("residual", res_base))
    df2 = base_df.with_columns(pl.Series("residual", res_shifted))

    tp1, tc1, _, _ = fit_apm(df1, resid_col="residual", alpha=50.0, calling_ratio=2.0)
    tp2, tc2, _, _ = fit_apm(df2, resid_col="residual", alpha=50.0, calling_ratio=2.0)
    assert tp1 == pytest.approx(tp2, abs=1e-12)
    assert tc1 == pytest.approx(tc2, abs=1e-12)
    assert float(np.sum(tc1)) == pytest.approx(0.0, abs=1e-10)


def test_igl_adjustment_apm_keeps_mean_zero_identity_exact_and_widens_ci():
    rows = []
    for key, sid, side, is_igl, rds, ctx, usg, conv in (
        ("1/m1", 1, CT, True, 20, 0.2, 0.1, 0.3),
        ("1/m1", 2, CT, False, 20, -0.1, 0.0, -0.1),
        ("2/m1", 6, T, True, 10, 0.1, 0.1, -0.4),
        ("3/m1", 1, T, False, 15, 0.0, 0.1, 0.1),
    ):
        row = {"key": key, "steamid": sid, "side": side, "is_igl": is_igl, "rounds": rds, "role": "Rifler"}
        for v in VERSIONS:
            row[f"{v}_context"] = ctx
            row[f"{v}_usage"] = usg
            row[f"{v}_conversion"] = conv
            row[f"{v}_above"] = ctx + usg + conv
        rows.append(row)
    df = pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64})
    adj = fit_igl_adjustment(df)
    calling = pl.DataFrame({"steamid": pl.Series([1, 6], dtype=pl.UInt64), "theta_call": [0.06, -0.02]})

    fixed = apply_igl_adjustment(df, adj, replacement_rate=0.0, igl_calling=None)
    apm = apply_igl_adjustment(df, adj, replacement_rate=0.0, igl_calling=calling)

    for v in VERSIONS:
        igl_sub = apm.filter(pl.col("is_igl"))
        assert float(igl_sub[f"{v}_rw"].sum() / igl_sub["rounds"].sum()) == pytest.approx(0.0, abs=1e-12)
        diff = (apm[f"{v}_context"] + apm[f"{v}_usage"] + apm[f"{v}_conversion_rw"] - apm[f"{v}_rw"]).abs().max()
        assert diff == pytest.approx(0.0, abs=1e-12)

    # Player 1 on non-IGL map ("3/m1") must match fixed adjustment exactly.
    non_igl_fixed = fixed.filter(~pl.col("is_igl"))["wpa_rw"].to_list()
    non_igl_apm = apm.filter(~pl.col("is_igl"))["wpa_rw"].to_list()
    assert non_igl_apm == pytest.approx(non_igl_fixed, abs=1e-12)

    # Calling SE widens `rw` and `conversion` bootstrap intervals, leaving `context`/`usage` and zero-SE players unchanged.
    rv_rows = []
    for sid in (1, 2):
        for r_i in range(40):
            val = 0.02 if (r_i % 2 == 0) else -0.02
            entry = {"steamid": sid, "key": f"1/m{1 + (r_i // 20)}", "round_num": r_i + 1}
            for v in VERSIONS:
                entry[f"{v}_rw"] = val
                entry[f"{v}_context_r"] = val * 0.5
                entry[f"{v}_usage_r"] = 0.0
                entry[f"{v}_conversion_r"] = val * 0.5
            rv_rows.append(entry)
    rv = pl.DataFrame(rv_rows, schema_overrides={"steamid": pl.UInt64})
    cols = {**{v: f"{v}_rw" for v in VERSIONS}, **{f"{v}_{t}": f"{v}_{t}_r" for v in VERSIONS for t in ("context", "usage", "conversion")}}
    b0 = bootstrap_players(rv, [1, 2], r_win=9.0, resamples=300, seed=0, columns=cols)
    b1 = bootstrap_players(rv, [1, 2], r_win=9.0, resamples=300, seed=0, columns=cols, call_se={1: 0.05})
    r0 = {r["steamid"]: r for r in b0.iter_rows(named=True)}
    r1 = {r["steamid"]: r for r in b1.iter_rows(named=True)}
    assert (r1[1]["wpa_opp_per100_p95"] - r1[1]["wpa_opp_per100_p5"]) > (r0[1]["wpa_opp_per100_p95"] - r0[1]["wpa_opp_per100_p5"]) + 5.0
    assert (r1[1]["wpa_opp_conversion_per100_p95"] - r1[1]["wpa_opp_conversion_per100_p5"]) > (
        r0[1]["wpa_opp_conversion_per100_p95"] - r0[1]["wpa_opp_conversion_per100_p5"]
    ) + 5.0
    assert r1[1]["wpa_opp_context_per100_p95"] == pytest.approx(r0[1]["wpa_opp_context_per100_p95"])
    assert r1[2]["wpa_opp_per100_p95"] == pytest.approx(r0[2]["wpa_opp_per100_p95"])
