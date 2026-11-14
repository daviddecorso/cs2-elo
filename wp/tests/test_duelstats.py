import numpy as np
import polars as pl
import pytest

from cs2wp.duelstats import (OPEN, PARTS, STATS, duel_values, independence, long_team_maps, player_maps,
                             player_split_half, team_maps)
from cs2wp.states import CT, T
from cs2wp.teamfactor import fit_team_factor, split_half_team_factor
from cs2wp.warcheck import _alternating


def _probs(rng, n):
    return [np.clip(rng.uniform(0.2, 0.8, n), 0.01, 0.99) for _ in range(4)]


def _raw_duels(keys_teams, duels_per_map=40, seed=0):
    """Random duels between the two five-player rosters of each map; rosters are 100*i + j for team i."""
    rng = np.random.default_rng(seed)
    rows = []
    for key, map_name, ta, tb in keys_teams:
        a_ids, b_ids = [100 * ta + j for j in range(5)], [100 * tb + j for j in range(5)]
        for i in range(duels_per_map):
            a_wins = rng.random() < 0.5
            att, vic = (rng.choice(a_ids), rng.choice(b_ids)) if a_wins else (rng.choice(b_ids), rng.choice(a_ids))
            rows.append({"key": key, "map": map_name, "date": "2026-01-01", "event": "E", "round_num": i // 2 + 1,
                         "kill": i, "attacker": int(att), "victim": int(vic),
                         "attacker_side": int(CT if rng.random() < 0.5 else T), "opening": i % 2 == 0})
    d = pl.DataFrame(rows, schema_overrides={"attacker": pl.UInt64, "victim": pl.UInt64})
    p, base, pos, flash = _probs(rng, d.height)
    return d.with_columns(pl.Series("p", p), pl.Series("p_base", base), pl.Series("p_pos", pos), pl.Series("p_flash", flash))


def test_every_value_is_antisymmetric_and_parts_sum_to_quality():
    v = duel_values(_raw_duels([("1/m1", "de_mirage", 0, 1), ("2/m1", "de_nuke", 0, 1)]))
    per_duel = v.group_by("key", "kill").agg(pl.col(*STATS, "win", "expected").sum())
    for c in STATS:
        assert per_duel[c].abs().max() < 1e-12
    assert (per_duel["win"] == 1).all() and per_duel["expected"].to_numpy() == pytest.approx(1.0)
    assert (v["q_pos"] + v["q_flash"] + v["q_hp"]).to_numpy() == pytest.approx(v["quality"].to_numpy())
    centered = v.group_by("map", "side").agg(pl.col(*PARTS, "quality").mean())
    assert centered.select(pl.col(*PARTS, "quality").abs().max()).max_horizontal().item() < 1e-12


def test_missing_nested_columns_point_to_cs2wp_duels():
    with pytest.raises(ValueError, match="cs2wp duels"):
        duel_values(_raw_duels([("1/m1", "de_mirage", 0, 1)]).drop("p_pos"))


def _role_rounds(keys_teams):
    rows = []
    for key, _, ta, tb in keys_teams:
        for t in (ta, tb):
            for j in range(5):
                for side in (CT, T):
                    rows.append({"key": key, "steamid": 100 * t + j, "side": side, "rounds": 12, "date": "2026-01-01",
                                 "event": "E", "lp_team": f"T{t}", "lp_player": f"p{t}{j}"})
    return pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64, "rounds": pl.UInt32})


def _residuals(keys_teams):
    rows = []
    for key, _, ta, tb in keys_teams:
        for t, o, won in ((ta, tb, 1.0), (tb, ta, 0.0)):
            rows.append({"key": key, "series": key.split("/")[0], "event": "E", "date": "2026-01-01",
                         "lp_team": f"T{t}", "opponent": f"T{o}", "stint_id": f"T{t}#0", "stint_label": f"T{t}",
                         "igl_player": None, "rounds": 24, "won": won, "elo": 1500.0 + 10 * t})
    return pl.DataFrame(rows, schema_overrides={"igl_player": pl.String})


def test_team_maps_are_zero_sum_and_match_player_sums():
    kt = [("1/m1", "de_mirage", 0, 1), ("2/m1", "de_mirage", 2, 1), ("3/m1", "de_nuke", 0, 2)]
    v = duel_values(_raw_duels(kt))
    rr = _role_rounds(kt)
    maps = team_maps(v, rr, _residuals(kt))
    assert maps.height == 3 and (maps["team_a"] < maps["team_b"]).all()
    assert (maps["duels"] == 40).all() and (maps["duels_open"] == 20).all()
    long = long_team_maps(maps)
    assert long.group_by("key").agg(pl.col(*STATS, *OPEN).sum()).select(pl.col(*STATS, *OPEN).abs().max()).max_horizontal().item() < 1e-12
    pm = player_maps(v, rr)
    t0 = pm.filter((pl.col("key") == "1/m1") & (pl.col("steamid") < 100))
    assert maps.filter(pl.col("key") == "1/m1")["exec"].item() == pytest.approx(t0["exec"].sum())
    assert (pm["rounds"] == 24).all()


def _planted_maps(tau: dict[str, float], n_series=120, duels=150, noise=0.04, seed=0, indep=None):
    """Team-map rows in the `team_maps` shape with `exec` planted as tau_a − tau_b per duel plus noise; `quality`
    gets its own planted effect `indep` (or none)."""
    rng = np.random.default_rng(seed)
    teams = sorted(tau)
    rows = []
    for s in range(n_series):
        a, b = rng.choice(len(teams), 2, replace=False)
        ta, tb = sorted((teams[a], teams[b]))
        for m in range(2):
            q = 0.0 if indep is None else indep[ta] - indep[tb]
            rows.append({"key": f"{s}/m{m + 1}", "series": str(s), "event": f"E{s // 20}",
                         "date": f"2026-{1 + s // 20:02d}-{1 + s % 20:02d}", "team_a": ta, "team_b": tb,
                         "stint_a": ta, "stint_b": tb, "stint_label_a": ta, "stint_label_b": tb,
                         "igl_name_a": None, "igl_name_b": None, "elo_a": 1500.0, "elo_b": 1500.0, "rounds": 24,
                         "y": 1.0, "duels": float(duels), "duels_open": 24.0,
                         "exec": duels * (tau[ta] - tau[tb] + rng.normal(0, noise)),
                         "quality": duels * (q + rng.normal(0, noise)),
                         "exec_open": 24 * (tau[ta] - tau[tb] + rng.normal(0, noise)),
                         "quality_open": 24 * (q + rng.normal(0, noise))})
    return pl.DataFrame(rows, schema_overrides={"igl_name_a": pl.String, "igl_name_b": pl.String}).sort("date", "key")


TAU = {f"T{i}": 0.03 * (i - 5) / 5 for i in range(12)}


def test_ridge_recovers_a_planted_effect_and_finds_none_where_none_is_planted():
    maps = _planted_maps(TAU)
    sh = split_half_team_factor(maps, unit="team", resid_col="exec", min_rounds=500, resamples=100, weight_col="duels")
    assert sh["r"] > 0.7 and sh["r_ci"][0] > 0
    est = fit_team_factor(maps, unit="team", resid_col="exec", alpha=sh["k_rounds"], resamples=0, weight_col="duels")
    got = dict(est.select("unit_id", "tau_per_round").iter_rows())
    assert np.corrcoef([got[t] for t in TAU], list(TAU.values()))[0, 1] > 0.9
    null = split_half_team_factor(maps, unit="team", resid_col="quality", min_rounds=500, resamples=100, weight_col="duels")
    assert abs(null["r"]) < 0.6 and null["r_ci"][0] < 0


def test_independence_separates_a_planted_quality_effect_from_execution():
    rng = np.random.default_rng(1)
    own = {t: float(v) for t, v in zip(TAU, rng.normal(0, 0.05, len(TAU)))}
    r = independence(_planted_maps(TAU, indep=own), "team", "quality", "exec", min_w=500, resamples=100)
    assert r["resid"] > 0.6 and r["resid_ci"][0] > 0
    copy = independence(_planted_maps(TAU, indep=TAU), "team", "quality", "exec", min_w=500, resamples=100)
    assert copy["cross"] > 0.7 and copy["resid"] < r["resid"]


def test_player_split_half_finds_a_planted_skill():
    rng = np.random.default_rng(2)
    skill = rng.normal(0, 0.05, 40)
    rows = [{"steamid": p, "series": str(s), "date": f"2026-01-{1 + s % 28:02d}", "key": f"{s}/m1",
             "duels": 30.0, "exec": float(30 * skill[p] + rng.normal(0, 30 ** 0.5 * 0.5))}
            for p in range(40) for s in range(p, p + 40)]
    halves = _alternating(pl.DataFrame(rows), ["steamid"])
    r = player_split_half(halves, "exec", "duels", resamples=200)
    assert r["r"] > 0.3 and r["r_ci"][0] > 0 and r["k"] > 0
