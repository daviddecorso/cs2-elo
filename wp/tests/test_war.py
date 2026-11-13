import json

import numpy as np
import polars as pl
import pytest

from cs2wp.baselines import VERSIONS
from cs2wp.states import CT, T
from cs2wp.war import (
    aggregate_players,
    analytical_mr12_rounds_per_win,
    apply_igl_adjustment,
    bootstrap_players,
    estimate_rounds_per_win,
    export_public,
    fit_igl_adjustment,
    report_lines,
    validation_metrics,
)


def _synthetic_sides() -> pl.DataFrame:
    rows = []
    for side in (CT, T):
        rows.append({"key": "m1", "date": "2026-05-01", "event": "e1", "map": "de_mirage", "lp_team": "A",
                     "lp_player": "igl_hi", "steamid": 1, "side": side, "role": "A", "rounds": 20, "is_igl": True,
                     **{f"{v}_baseline": 0.01 for v in VERSIONS}, **{v: 0.20 for v in VERSIONS},
                     **{f"{v}_above": -0.05 for v in VERSIONS}})
        rows.append({"key": "m2", "date": "2026-05-02", "event": "e1", "map": "de_mirage", "lp_team": "B",
                     "lp_player": "igl_lo", "steamid": 2, "side": side, "role": "A", "rounds": 20, "is_igl": True,
                     **{f"{v}_baseline": 0.01 for v in VERSIONS}, **{v: 0.20 for v in VERSIONS},
                     **{f"{v}_above": -0.25 for v in VERSIONS}})
        for sid, above in ((3, 0.20), (4, -0.04)):
            rows.append({"key": "m1", "date": "2026-05-01", "event": "e1", "map": "de_mirage", "lp_team": "A",
                         "lp_player": f"p{sid}", "steamid": sid, "side": side, "role": "Rifler", "rounds": 40,
                         "is_igl": False, **{f"{v}_baseline": 0.01 for v in VERSIONS}, **{v: 0.40 for v in VERSIONS},
                         **{f"{v}_above": above for v in VERSIONS}})
    return pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64, "side": pl.Int32})


def test_igl_adjustment_zeros_igl_and_league_means_while_preserving_igl_spread():
    rows = _synthetic_sides()
    adj = fit_igl_adjustment(rows)
    out = apply_igl_adjustment(rows, adj)
    for side in (CT, T):
        sub = out.filter(pl.col("side") == side)
        assert sub.filter(pl.col("is_igl"))["wpa_rw"].sum() == pytest.approx(0.0)
        assert sub["wpa_rw"].sum() == pytest.approx(0.0)
    by_player = out.group_by("steamid").agg(pl.col("wpa_rw").sum())
    vals = dict(by_player.iter_rows())
    assert vals[1] - vals[2] == pytest.approx(0.40)
    assert vals[1] > 0 > vals[2]


def test_replacement_rate_shifts_war_linearly_by_rounds():
    rows = _synthetic_sides()
    adj = fit_igl_adjustment(rows)
    waa = apply_igl_adjustment(rows, adj, replacement_rate=0.0)
    war = apply_igl_adjustment(rows, adj, replacement_rate=-0.005)
    diff = (war["wpa_rw"] - waa["wpa_rw"]).to_numpy()
    assert diff == pytest.approx(0.005 * rows["rounds"].to_numpy())


def test_estimate_rounds_per_win_recovers_linear_slope():
    assert 4.0 < analytical_mr12_rounds_per_win() < 5.0
    adjusted = pl.DataFrame({
        "key": [f"m{i}" for i in range(20) for _ in range(2)],
        "lp_team": ["A", "B"] * 20,
        "wpa_rw": [2.5 if i % 2 == 0 else -2.5 for i in range(40)],
    })
    outcomes = pl.DataFrame({
        "key": [f"m{i}" for i in range(20) for _ in range(2)],
        "lp_team": ["A", "B"] * 20,
        "won": [1.0 if i % 2 == 0 else 0.0 for i in range(40)],
    })
    assert estimate_rounds_per_win(adjusted, outcomes) == pytest.approx(5.0)


def test_bootstrap_is_deterministic_brackets_point_and_shrinks_with_sample_size():
    rng = np.random.default_rng(7)
    small_v = rng.normal(0.02, 0.20, size=100)
    big_v = np.tile(small_v, 9)
    df = pl.concat([
        pl.DataFrame({"steamid": np.uint64(1), "key": "m1", "round_num": np.arange(len(small_v)),
                      **{f"{v}_rw": small_v for v in VERSIONS}}),
        pl.DataFrame({"steamid": np.uint64(2), "key": "m1", "round_num": np.arange(len(big_v)),
                      **{f"{v}_rw": big_v for v in VERSIONS}}),
    ]).with_columns(pl.col("steamid").cast(pl.UInt64))
    b1 = bootstrap_players(df, [1, 2], r_win=5.0, resamples=500, seed=42)
    b2 = bootstrap_players(df, [1, 2], r_win=5.0, resamples=500, seed=42)
    assert b1.equals(b2)
    by_sid = {r["steamid"]: r for r in b1.iter_rows(named=True)}
    p1_point = float(small_v.sum() / 5.0)
    assert by_sid[1]["wpa_waa_p5"] < p1_point < by_sid[1]["wpa_waa_p95"]
    w1 = by_sid[1]["wpa_ per100_p95".replace(" ", "")] - by_sid[1]["wpa_per100_p5"]
    w2 = by_sid[2]["wpa_per100_p95"] - by_sid[2]["wpa_per100_p5"]
    assert w2 < w1 * 0.45


def test_export_public_blocks_ungated_without_flag_and_marks_provisional(tmp_path, monkeypatch):
    import cs2wp.war as war_mod

    models_dir = tmp_path / "models"
    (models_dir / "m").mkdir(parents=True)
    (models_dir / "m" / "report.json").write_text(json.dumps({"gate": {"passed": False, "log_loss": 0.45}}))
    monkeypatch.setattr(war_mod, "MODELS", models_dir)

    rows = _synthetic_sides()
    adj = fit_igl_adjustment(rows)
    adjusted = apply_igl_adjustment(rows, adj)
    players = pl.DataFrame([{
        "steamid": 1, "lp_player": "ApEX", "name": "apEX", "lp_team": "Team Vitality",
        "maps": 20, "rounds": 400, "is_igl": True, "igl_share": 1.0, "t_role": "Entry", "ct_role": "Rotator",
        "awp_share": 0.01, "entry_share": 0.25, "duels": 200, "kills_above": 3.2, "kills_above_per100": 0.8,
        "kd": 0.95, "adr": 72.1, "rating2_approx": 1.02, "rating3": 1.04, "swing": 0.5,
        **{f"{v}_waa": 1.2 for v in VERSIONS},
        **{f"{v}_waa_p5": 0.4 for v in VERSIONS},
        **{f"{v}_waa_p95": 2.0 for v in VERSIONS},
        **{f"{v}_per100": 1.5 for v in VERSIONS},
        **{f"{v}_per100_p5": 0.5 for v in VERSIONS},
        **{f"{v}_per100_p95": 2.5 for v in VERSIONS},
    }], schema_overrides={"steamid": pl.UInt64})
    val = {"month_to_month": {100: {}, 200: {}, 300: {}}, "split_half": {}, "with_kd": {}}
    lines = report_lines(adjusted, adj, players, val, 5.0, 300, 0.0, None)
    assert any("apEX" in line for line in lines)
    out_dir = tmp_path / "pub"

    assert export_public(players, {1: []}, adj, val, adjusted, 5.0, 300, 0.0, "m", False, out_dir) == 1
    assert not (out_dir / "players.json").exists()
    assert export_public(players, {1: []}, adj, val, adjusted, 5.0, 300, 0.0, "m", True, out_dir) == 0
    payload = json.loads((out_dir / "players.json").read_text())
    assert payload["provisional"] is True and payload["metric"] == "WAA" and len(payload["players"]) == 1


def test_validation_splits_by_series_and_deduplicates_box_rows():
    rows = []
    for sid, rate in ((1, 0.04), (2, 0.01), (3, -0.02), (4, -0.04)):
        for s_idx, month in ((1, "2026-05"), (2, "2026-06")):
            for m_idx in (1, 2):
                key = f"{100 + s_idx}/m{m_idx}"
                for side in (CT, T):
                    rows.append({
                        "key": key, "date": f"{month}-0{m_idx}", "event": f"e{s_idx}", "map": "de_mirage",
                        "lp_team": "A", "lp_player": f"p{sid}", "steamid": sid, "side": side, "role": "Rifler",
                        "rounds": 30, "is_igl": False,
                        **{f"{v}_baseline": 0.0 for v in VERSIONS},
                        **{v: rate * 30 for v in VERSIONS},
                        **{f"{v}_above": rate * 30 for v in VERSIONS},
                    })
    df = pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64, "side": pl.Int32})
    adjusted = apply_igl_adjustment(df, fit_igl_adjustment(df))
    duel_sides = pl.DataFrame({"key": ["101/m1"], "steamid": [1], "duels": [10], "kills_above": [1.5]},
                              schema_overrides={"steamid": pl.UInt64})
    box_rows = []
    for key in adjusted["key"].unique().to_list():
        for sid in (1, 2, 3, 4):
            for _ in range(2):  # duplicate per-map box row should not inflate rounds or kills
                box_rows.append({
                    "key": key, "date": "2026-05-01", "steamid": sid, "rounds": 60, "kills": 40 + sid,
                    "deaths": 40, "assists": 10, "damage": 4500, "kast_rounds": 42,
                    "wpa": 0.0, "nwpa_event": 0.0, "nwpa_mancount": 0.0,
                    "rating3": 1.0 + 0.05 * sid, "swing": 0.01 * sid, "lp_player": f"p{sid}", "name": f"p{sid}",
                })
    box = pl.DataFrame(box_rows, schema_overrides={"steamid": pl.UInt64})
    t_roles = pl.DataFrame({"key": ["101/m1"], "steamid": [1], "opening_kills": [2], "opening_deaths": [2],
                            "t_rounds": [30], "t_awp_rounds": [0], "ct_awp_rounds": [0],
                            "t_buy_rounds": [20], "ct_buy_rounds": [20]}, schema_overrides={"steamid": pl.UInt64})
    ct_pos = pl.DataFrame({"key": ["101/m1"], "steamid": [1], "role": ["A"]}, schema_overrides={"steamid": pl.UInt64})
    players, _ = aggregate_players(adjusted, duel_sides, box, t_roles, ct_pos, r_win=5.0)
    assert set(players["rounds"].to_list()) == {240}
    val = validation_metrics(adjusted, duel_sides, box, players, min_rounds=200)
    assert val["month_to_month"][100]["wpa_waa_r"]["pairs"] == 4
    assert val["month_to_month"][200]["wpa_waa_r"]["pairs"] == 0
    assert val["split_half"]["wpa_waa_r"]["r"] == pytest.approx(1.0)


def test_null_role_rows_are_excluded_from_aggregation_and_export(tmp_path, monkeypatch):
    import cs2wp.war as war_mod

    models_dir = tmp_path / "models"
    (models_dir / "m").mkdir(parents=True)
    (models_dir / "m" / "report.json").write_text(json.dumps({"gate": {"passed": True, "log_loss": 0.44}}))
    monkeypatch.setattr(war_mod, "MODELS", models_dir)

    rows = _synthetic_sides().with_columns(pl.lit(150).cast(pl.Int64).alias("rounds")).to_dicts()
    # Player 99 has 300+ rounds exclusively in null-role maps (must not get 0.0 WAA + null CIs)
    for m_idx in range(1, 7):
        for side in (CT, T):
            rows.append({
                "key": f"unroled/{m_idx}", "date": "2025-05-01", "event": "e0", "map": "de_mirage",
                "lp_team": "Z", "lp_player": "p99", "steamid": 99, "side": side, "role": None,
                "rounds": 30, "is_igl": False,
                **{f"{v}_baseline": None for v in VERSIONS},
                **{v: 0.1 for v in VERSIONS},
                **{f"{v}_above": None for v in VERSIONS},
            })
    # Player 3 also has extra un-roled rounds that must not dilute their rounds or per-100 rate
    for side in (CT, T):
        rows.append({
            "key": "unroled/extra", "date": "2025-05-02", "event": "e0", "map": "de_mirage",
            "lp_team": "A", "lp_player": "p3", "steamid": 3, "side": side, "role": None,
            "rounds": 50, "is_igl": False,
            **{f"{v}_baseline": None for v in VERSIONS},
            **{v: 0.1 for v in VERSIONS},
            **{f"{v}_above": None for v in VERSIONS},
        })

    df = pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64, "side": pl.Int32})
    adj = fit_igl_adjustment(df)
    adjusted = apply_igl_adjustment(df, adj)
    duel_sides = pl.DataFrame(schema={"key": pl.String, "steamid": pl.UInt64, "duels": pl.Int64, "kills_above": pl.Float64})
    box = pl.DataFrame([{
        "key": "m1", "date": "2026-05-01", "steamid": 3, "rounds": 300, "kills": 200,
        "deaths": 180, "assists": 40, "damage": 20000.0, "kast_rounds": 210,
        "wpa": 0.0, "nwpa_event": 0.0, "nwpa_mancount": 0.0,
        "rating3": 1.1, "swing": 0.01, "lp_player": "p3", "name": "p3",
    }], schema_overrides={"steamid": pl.UInt64})
    t_roles = pl.DataFrame(schema={"key": pl.String, "steamid": pl.UInt64, "opening_kills": pl.UInt32,
                                   "opening_deaths": pl.UInt32, "t_rounds": pl.UInt32, "t_awp_rounds": pl.UInt32,
                                   "ct_awp_rounds": pl.UInt32, "t_buy_rounds": pl.UInt32, "ct_buy_rounds": pl.UInt32})
    ct_pos = pl.DataFrame(schema={"key": pl.String, "steamid": pl.UInt64, "role": pl.String})

    players, ct_by_map = aggregate_players(adjusted, duel_sides, box, t_roles, ct_pos, r_win=5.0)
    assert 99 not in players["steamid"].to_list()
    assert players.filter(pl.col("steamid") == 3)["rounds"].item() == 300

    # Add synthetic bootstrap CI columns for roled players and verify export_public succeeds
    boot = pl.DataFrame([
        {
            "steamid": sid,
            **{f"{v}_waa_p5": 0.0 for v in VERSIONS},
            **{f"{v}_waa_p50": 0.1 for v in VERSIONS},
            **{f"{v}_waa_p95": 0.2 for v in VERSIONS},
            **{f"{v}_per100_p5": 0.0 for v in VERSIONS},
            **{f"{v}_per100_p50": 0.1 for v in VERSIONS},
            **{f"{v}_per100_p95": 0.2 for v in VERSIONS},
        }
        for sid in players["steamid"].to_list()
    ], schema_overrides={"steamid": pl.UInt64})
    players = players.join(boot, on="steamid", how="left")
    val = validation_metrics(adjusted, duel_sides, box, players, min_rounds=300)
    out_dir = tmp_path / "pub"
    assert export_public(players, ct_by_map, adj, val, adjusted, 5.0, 300, 0.0, "m", False, out_dir) == 0
