"""Team factor residuals, split-half/forward validation, and adjusted plus-minus IGL calling (Phase 6)."""

from datetime import datetime, timezone
import json
import math
from pathlib import Path

import numpy as np
import polars as pl
from scipy.sparse import csr_matrix, hstack
from sklearn.linear_model import LogisticRegression, Ridge

from . import warcheck
from .baselines import VERSIONS
from .data import MapRef, catalog
from .igls import load_table as load_igl_table
from .paths import PLAYER_APM, PUBLIC_WAR, TEAM_FACTORS, TEAM_MAP_RESIDUALS, WAR_REPORTS
from .pipeline import player_rounds
from .publish import SOURCE
from .war import estimate_rounds_per_win, load_adjusted, map_outcomes, map_scores

PRIMARY_METRIC = "wpa_opp"
COMPARATORS = ("wpa_opp", "wpa", "nwpa_mancount", "nwpa_event", "rating3", "kd_diff")
DEFAULT_RESAMPLES = 1000
APM_ALPHA_GRID = (10000.0, 20000.0, 40000.0, 80000.0, 160000.0, 320000.0, 640000.0)
APM_RATIO_GRID = (0.0, 0.25, 1.0, 4.0, 9.0, 16.0, 36.0, 64.0)
MIN_HALF_TEAMS = 10
MIN_PRIOR_MAPS = 20


def _stint_index(table: dict[str, list[dict]]) -> dict[str, list[dict]]:
    by_team: dict[str, list[dict]] = {}
    for team, stints in table.items():
        player_counts: dict[str, int] = {}
        for s in stints:
            player_counts[s["player"]] = player_counts.get(s["player"], 0) + 1
        entries = []
        for idx, s in enumerate(stints):
            player = s["player"]
            f_date = s.get("from") or "0000-01-01"
            t_date = s.get("to") or "9999-12-31"
            if player_counts[player] == 1:
                label = f"{team} ({player})"
            else:
                span = f"{s.get('from') or '..'}..{s.get('to') or '..'}"
                label = f"{team} ({player}, {span})"
            entries.append({
                "from": f_date,
                "to": t_date,
                "stint_id": f"{team}#{idx}:{player}",
                "igl_player": player,
                "label": label,
            })
        by_team[team] = entries
    return by_team


def _lookup_stint(team: str, date: str, igl_steamid: int | None, index: dict[str, list[dict]] | None) -> tuple[str, str | None, str]:
    if index is not None and team in index:
        for entry in index[team]:
            if entry["from"] <= date <= entry["to"]:
                return entry["stint_id"], entry["igl_player"], entry["label"]
        return f"{team}#none", None, f"{team} (no IGL stint)"
    if igl_steamid is not None:
        return f"{team}#{igl_steamid}", str(igl_steamid), f"{team} ({igl_steamid})"
    return team, None, f"{team} (no IGL)"


def assign_stints(maps_df: pl.DataFrame, igl_table: dict[str, list[dict]] | None = None) -> pl.DataFrame:
    """Attach `stint_a`, `stint_b` (lp_team x date-bounded IGL stint) and readable labels to 1-row-per-map data."""
    index = _stint_index(igl_table) if igl_table is not None else None
    sa, na, la, sb, nb, lb = [], [], [], [], [], []
    for r in maps_df.select("team_a", "team_b", "date", "igl_a", "igl_b").iter_rows(named=True):
        s1, n1, l1 = _lookup_stint(r["team_a"], r["date"], r["igl_a"], index)
        s2, n2, l2 = _lookup_stint(r["team_b"], r["date"], r["igl_b"], index)
        sa.append(s1); na.append(n1); la.append(l1)
        sb.append(s2); nb.append(n2); lb.append(l2)
    return maps_df.with_columns(
        pl.Series("stint_a", sa, dtype=pl.String),
        pl.Series("igl_name_a", na, dtype=pl.String),
        pl.Series("stint_label_a", la, dtype=pl.String),
        pl.Series("stint_b", sb, dtype=pl.String),
        pl.Series("igl_name_b", nb, dtype=pl.String),
        pl.Series("stint_label_b", lb, dtype=pl.String),
    )


def _loeo_linear_residual(
    x: np.ndarray,
    y_share: np.ndarray,
    w: np.ndarray,
    events: np.ndarray,
    covered_mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, float]:
    pred = np.zeros_like(y_share, dtype=np.float64)
    for ev in np.unique(events):
        in_ev = events == ev
        tr = (~in_ev) & covered_mask
        if tr.any():
            xt, yt, wt = x[tr], y_share[tr], w[tr]
            denom = float(np.sum(wt * xt * xt))
            beta = float(np.sum(wt * xt * yt) / denom) if denom > 1e-12 else 0.0
        else:
            beta = 0.0
        pred[in_ev] = beta * x[in_ev]
    denom_all = float(np.sum(w[covered_mask] * x[covered_mask] ** 2)) if covered_mask.any() else 0.0
    beta_all = float(np.sum(w[covered_mask] * x[covered_mask] * y_share[covered_mask]) / denom_all) if denom_all > 1e-12 else 0.0
    return w * (y_share - pred), pred, beta_all


def _loeo_logistic_prob(
    x: np.ndarray,
    y_win: np.ndarray,
    w: np.ndarray,
    events: np.ndarray,
    covered_mask: np.ndarray,
) -> tuple[np.ndarray, float]:
    prob = np.full_like(y_win, 0.5, dtype=np.float64)
    for ev in np.unique(events):
        in_ev = events == ev
        tr = (~in_ev) & covered_mask
        if tr.sum() >= 2 and np.unique(y_win[tr]).size >= 2 and not np.allclose(x[tr], 0.0):
            clf = LogisticRegression(fit_intercept=False, C=1e4, max_iter=500)
            clf.fit(x[tr].reshape(-1, 1), y_win[tr], sample_weight=w[tr])
            prob[in_ev] = clf.predict_proba(x[in_ev].reshape(-1, 1))[:, 1]
    gamma = 0.0
    if covered_mask.sum() >= 2 and np.unique(y_win[covered_mask]).size >= 2 and not np.allclose(x[covered_mask], 0.0):
        clf = LogisticRegression(fit_intercept=False, C=1e4, max_iter=500)
        clf.fit(x[covered_mask].reshape(-1, 1), y_win[covered_mask], sample_weight=w[covered_mask])
        gamma = float(clf.coef_[0, 0])
    return prob, gamma


def compute_residuals(
    refs: list[MapRef],
    pm: pl.DataFrame,
    scores: pl.DataFrame,
    ks: dict[str, float],
    mode: str = "loeo",
    metrics: tuple[str, ...] = COMPARATORS,
    igl_table: dict[str, list[dict]] | None = None,
) -> tuple[pl.DataFrame, pl.DataFrame, dict]:
    """Compute out-of-sample lineup expectations and antisymmetric team-map residuals in round-wins.

    `maps_df` has 1 row per map (`team_a` vs `team_b`); `team_maps_df` expands each map into two
    antisymmetric `(key, lp_team)` rows suitable for `TEAM_MAP_RESIDUALS`.
    """
    ml = warcheck.map_lineups(
        refs, pm, scores, ks, test_from="", mode=mode, require_elo=False, include_sides=True
    ).filter(pl.col("rounds").is_not_null() & (pl.col("rounds") > 0))
    if ml.is_empty():
        return ml, pl.DataFrame(), {"maps_total": 0, "maps_all_covered": 0, "pct_all_covered": 0.0, "mean_slot_covered": 0.0, "betas": {}, "logistic_gamma": 0.0}

    maps = assign_stints(ml, igl_table)
    events = maps["event"].to_numpy()
    y_share = maps["share_diff"].to_numpy().astype(np.float64)
    y_win = maps["y"].to_numpy().astype(np.float64)
    w = maps["rounds"].to_numpy().astype(np.float64)
    cov_mask = maps["all_covered"].to_numpy().astype(bool)

    betas: dict[str, float] = {}
    extra_cols: list[pl.Series] = []
    for m in metrics:
        # `map_lineups` stores `100 * (sum_a - sum_b)`; dividing by 100 puts beta in round-share units.
        x = maps[m].to_numpy().astype(np.float64) / 100.0
        resid, pred, beta_all = _loeo_linear_residual(x, y_share, w, events, cov_mask)
        betas[m] = beta_all
        extra_cols.append(pl.Series(f"resid_{m}", resid, dtype=pl.Float64))
        if m == PRIMARY_METRIC:
            prob, gamma = _loeo_logistic_prob(x, y_win, w, events, cov_mask)
            extra_cols.extend([
                pl.Series("residual", resid, dtype=pl.Float64),
                pl.Series("pred_share_diff", pred, dtype=pl.Float64),
                pl.Series("expected_win_prob", prob, dtype=pl.Float64),
                pl.Series("moe", y_win - prob, dtype=pl.Float64),
            ])
    maps = maps.with_columns(extra_cols)

    resid_cols = [f"resid_{m}" for m in metrics]
    side_a = maps.select(
        "key", "series", "event", "date",
        pl.col("team_a").alias("lp_team"), pl.col("team_b").alias("opponent"),
        pl.col("stint_a").alias("stint_id"), pl.col("stint_label_a").alias("stint_label"),
        pl.col("igl_name_a").alias("igl_player"), pl.col("igl_a").alias("igl_steamid"),
        "rounds", pl.col("rounds_won_a").alias("rounds_won"),
        pl.col("share_a").alias("share"), pl.col("y").alias("won"),
        "covered", "all_covered", pl.col("elo_a").alias("elo"),
        "residual", "pred_share_diff", "expected_win_prob", "moe",
        *resid_cols,
        *(pl.col(f"{m}_a").alias(f"war_{m}") for m in metrics),
    )
    side_b = maps.select(
        "key", "series", "event", "date",
        pl.col("team_b").alias("lp_team"), pl.col("team_a").alias("opponent"),
        pl.col("stint_b").alias("stint_id"), pl.col("stint_label_b").alias("stint_label"),
        pl.col("igl_name_b").alias("igl_player"), pl.col("igl_b").alias("igl_steamid"),
        "rounds", pl.col("rounds_won_b").alias("rounds_won"),
        (1.0 - pl.col("share_a")).alias("share"), (1.0 - pl.col("y")).alias("won"),
        "covered", "all_covered", pl.col("elo_b").alias("elo"),
        (-pl.col("residual")).alias("residual"),
        (-pl.col("pred_share_diff")).alias("pred_share_diff"),
        (1.0 - pl.col("expected_win_prob")).alias("expected_win_prob"),
        (-pl.col("moe")).alias("moe"),
        *((-pl.col(c)).alias(c) for c in resid_cols),
        *(pl.col(f"{m}_b").alias(f"war_{m}") for m in metrics),
    )
    team_maps = pl.concat([side_a, side_b], how="vertical").sort("date", "key", "lp_team")
    stats = {
        "maps_total": maps.height,
        "maps_all_covered": int(cov_mask.sum()),
        "pct_all_covered": float(cov_mask.mean()),
        "mean_slot_covered": float(maps["covered"].mean()),
        "betas": betas,
        "logistic_gamma": gamma if PRIMARY_METRIC in metrics else 0.0,
    }
    return maps, team_maps, stats


def _pair_matrix(col_a: np.ndarray, col_b: np.ndarray, n_cols: int) -> csr_matrix:
    n = len(col_a)
    rows_idx = []
    cols_idx = []
    vals = []
    valid_a = col_a >= 0
    if valid_a.any():
        idx = np.flatnonzero(valid_a)
        rows_idx.append(idx)
        cols_idx.append(col_a[idx])
        vals.append(np.ones(len(idx), dtype=np.float64))
    valid_b = col_b >= 0
    if valid_b.any():
        idx = np.flatnonzero(valid_b)
        rows_idx.append(idx)
        cols_idx.append(col_b[idx])
        vals.append(-np.ones(len(idx), dtype=np.float64))
    if not rows_idx:
        return csr_matrix((n, n_cols), dtype=np.float64)
    r = np.concatenate(rows_idx)
    c = np.concatenate(cols_idx)
    v = np.concatenate(vals)
    return csr_matrix((v, (r, c)), shape=(n, n_cols), dtype=np.float64)


def _group_grams(X: csr_matrix, y: np.ndarray, w: np.ndarray, group_ids: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Precompute `X_g^T diag(w_g) X_g` and `X_g^T (w_g * y_g)` per group for fast exact Ridge refits."""
    n_groups = int(group_ids.max()) + 1 if len(group_ids) else 0
    p = X.shape[1]
    Gs = np.zeros((n_groups, p, p), dtype=np.float64)
    bs = np.zeros((n_groups, p), dtype=np.float64)
    order = np.argsort(group_ids, kind="mergesort")
    g_sorted = group_ids[order]
    splits = np.flatnonzero(np.diff(g_sorted)) + 1
    starts = np.concatenate(([0], splits))
    ends = np.concatenate((splits, [len(order)]))
    for s, e in zip(starts, ends):
        idx = order[s:e]
        g = int(g_sorted[s])
        Xg = X[idx]
        wg = w[idx]
        yg = y[idx]
        Xw = Xg.multiply(wg[:, None])
        Gs[g] = (Xw.T @ Xg).toarray()
        bs[g] = np.asarray(Xg.T @ (wg * yg)).ravel()
    rds_g = np.zeros((n_groups, p), dtype=np.float64)
    Xabs = abs(X)
    for s, e in zip(starts, ends):
        idx = order[s:e]
        g = int(g_sorted[s])
        rds_g[g] = np.asarray(Xabs[idx].T @ w[idx]).ravel()
    return Gs, bs, rds_g


def _unit_cols(unit: str) -> tuple[str, str]:
    if unit == "stint":
        return "stint_a", "stint_b"
    if unit == "team":
        return "team_a", "team_b"
    raise ValueError(f"Unknown unit: {unit}")


def split_half_team_factor(
    maps_df: pl.DataFrame,
    unit: str = "stint",
    resid_col: str = "resid_wpa_opp",
    min_rounds: int = 300,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int = 0,
    half_alpha: float = 1.0,
    weight_col: str = "rounds",
) -> dict:
    """Split-half reliability and `k` (maps, and `weight_col` units as `k_rounds`) across alternating series for `unit`.

    The target is `resid_col / weight_col` per map, weighted by `weight_col`; `min_rounds` is in `weight_col` units too.
    """
    col_a, col_b = _unit_cols(unit)
    sub = maps_df.filter(pl.col("all_covered")) if "all_covered" in maps_df.columns else maps_df
    if sub.is_empty():
        return {"r": None, "r_ci": (None, None), "k_rounds": None, "k_maps": None, "units": 0, "half_rounds": None}

    long_df = pl.concat([
        sub.select("key", "series", "date", pl.col(col_a).alias("unit"), pl.col(weight_col).alias("rounds")),
        sub.select("key", "series", "date", pl.col(col_b).alias("unit"), pl.col(weight_col).alias("rounds")),
    ])
    totals = long_df.group_by("unit").agg(pl.col("rounds").sum())
    elig_units = sorted(totals.filter(pl.col("rounds") >= min_rounds)["unit"].to_list())
    if len(elig_units) < MIN_HALF_TEAMS:
        return {"r": None, "r_ci": (None, None), "k_rounds": None, "k_maps": None, "units": len(elig_units), "half_rounds": None}

    halved = warcheck._alternating(long_df, ["unit"])
    half_lookup = {(r["key"], r["unit"]): int(r["half"]) for r in halved.select("key", "unit", "half").iter_rows(named=True)}
    all_units = sorted(totals["unit"].to_list())
    uidx = {u: i for i, u in enumerate(all_units)}

    ha = np.array([2 * uidx[r[col_a]] + half_lookup[(r["key"], r[col_a])] for r in sub.iter_rows(named=True)], dtype=np.int64)
    hb = np.array([2 * uidx[r[col_b]] + half_lookup[(r["key"], r[col_b])] for r in sub.iter_rows(named=True)], dtype=np.int64)
    X_half = _pair_matrix(ha, hb, 2 * len(all_units))
    w = sub[weight_col].to_numpy().astype(np.float64)
    y = sub[resid_col].to_numpy().astype(np.float64) / w

    coef = Ridge(alpha=half_alpha, fit_intercept=False).fit(X_half, y, sample_weight=w).coef_
    rds_half = np.asarray(abs(X_half).T @ w).ravel()
    elig_idx = np.array([uidx[u] for u in elig_units], dtype=np.int64)
    rds0, rds1 = rds_half[2 * elig_idx], rds_half[2 * elig_idx + 1]
    keep = (rds0 > 0) & (rds1 > 0)
    if keep.sum() < MIN_HALF_TEAMS:
        return {"r": None, "r_ci": (None, None), "k_rounds": None, "k_maps": None, "units": int(keep.sum()), "half_rounds": None}

    c0, c1 = coef[2 * elig_idx[keep]], coef[2 * elig_idx[keep] + 1]
    r_obs = float(np.corrcoef(c0, c1)[0, 1]) if (np.std(c0) > 0 and np.std(c1) > 0) else 0.0
    half_rounds = float(np.median(np.concatenate([rds0[keep], rds1[keep]])))
    mean_rds_map = float(w.mean())
    k_rounds = half_rounds * (1.0 - r_obs) / r_obs if r_obs > 0 else math.inf
    k_maps = k_rounds / mean_rds_map if (math.isfinite(k_rounds) and mean_rds_map > 0) else math.inf

    series_arr = sub["series"].to_numpy()
    _, s_ids = np.unique(series_arr, return_inverse=True)
    n_series = int(s_ids.max()) + 1
    Gs, bs, rds_s = _group_grams(X_half, y, w, s_ids)
    eye = half_alpha * np.eye(X_half.shape[1], dtype=np.float64)
    rng = np.random.default_rng(seed)
    boot_r = []
    if resamples > 0 and n_series > 1:
        mults = rng.multinomial(n_series, np.full(n_series, 1.0 / n_series), size=resamples).astype(np.float64)
        for mult in mults:
            Gb = np.tensordot(mult, Gs, axes=(0, 0)) + eye
            bb = mult @ bs
            rb = mult @ rds_s
            r0b, r1b = rb[2 * elig_idx], rb[2 * elig_idx + 1]
            kb = (r0b > 0) & (r1b > 0)
            if kb.sum() < 5:
                continue
            cb = np.linalg.solve(Gb, bb)
            v0, v1 = cb[2 * elig_idx[kb]], cb[2 * elig_idx[kb] + 1]
            if np.std(v0) > 1e-12 and np.std(v1) > 1e-12:
                boot_r.append(float(np.corrcoef(v0, v1)[0, 1]))
    if len(boot_r) >= 10:
        zb = np.arctanh(np.clip(boot_r, -0.9999, 0.9999))
        z_obs = math.atanh(max(-0.9999, min(0.9999, r_obs)))
        # Center on `z_obs`: resampling series with replacement drops ~37% of series, attenuating raw `boot_r`.
        zc = zb - float(np.mean(zb)) + z_obs
        ci = (float(np.tanh(np.quantile(zc, 0.05))), float(np.tanh(np.quantile(zc, 0.95))))
    else:
        ci = (None, None)
    return {
        "r": r_obs,
        "r_ci": ci,
        "k_rounds": k_rounds,
        "k_maps": k_maps,
        "units": int(keep.sum()),
        "half_rounds": half_rounds,
        "mean_rounds_per_map": mean_rds_map,
    }


def _unit_meta(sub: pl.DataFrame, unit: str, resid_col: str) -> pl.DataFrame:
    col_a, col_b = _unit_cols(unit)
    lbl_a, lbl_b = ("stint_label_a", "stint_label_b") if unit == "stint" else ("team_a", "team_b")
    igl_cols_a = [pl.col("igl_name_a").alias("igl_player")] if unit == "stint" else [pl.lit(None, pl.String).alias("igl_player")]
    igl_cols_b = [pl.col("igl_name_b").alias("igl_player")] if unit == "stint" else [pl.lit(None, pl.String).alias("igl_player")]
    has_moe = "moe" in sub.columns
    long = pl.concat([
        sub.select(
            pl.col(col_a).alias("unit_id"), pl.col(lbl_a).alias("label"), pl.col("team_a").alias("lp_team"),
            *igl_cols_a, "rounds", pl.col(resid_col).alias("resid"),
            (pl.col("moe") if has_moe else pl.lit(0.0)).alias("moe"),
            pl.col("elo_a").alias("elo"),
        ),
        sub.select(
            pl.col(col_b).alias("unit_id"), pl.col(lbl_b).alias("label"), pl.col("team_b").alias("lp_team"),
            *igl_cols_b, "rounds", (-pl.col(resid_col)).alias("resid"),
            ((-pl.col("moe")) if has_moe else pl.lit(0.0)).alias("moe"),
            pl.col("elo_b").alias("elo"),
        ),
    ])
    return long.group_by("unit_id").agg(
        pl.col("label").first(),
        pl.col("lp_team").first(),
        pl.col("igl_player").first(),
        pl.len().cast(pl.Int64).alias("maps"),
        pl.col("rounds").sum().cast(pl.Int64),
        pl.col("resid").sum().alias("raw_resid_rw"),
        pl.col("moe").sum().alias("moe_sum"),
        ((pl.col("elo") * pl.col("rounds")).filter(pl.col("elo").is_not_null()).sum()
         / pl.col("rounds").filter(pl.col("elo").is_not_null()).sum()).alias("elo_mean"),
    )


def fit_team_factor(
    maps_df: pl.DataFrame,
    unit: str = "stint",
    resid_col: str = "resid_wpa_opp",
    alpha: float | None = 1.0,
    r_win: float = 9.0,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int = 0,
    weight_col: str = "rounds",
) -> pl.DataFrame:
    """Ridge team factor `tau` on `resid_col / weight_col = tau_A - tau_B` with series-bootstrap 90% intervals.

    `tau` is per unit of `weight_col`; the `tau_waa` columns assume that unit is rounds.
    """
    col_a, col_b = _unit_cols(unit)
    sub = maps_df.filter(pl.col("all_covered")) if "all_covered" in maps_df.columns else maps_df
    meta = _unit_meta(sub, unit, resid_col)
    if sub.is_empty():
        return meta
    units = sorted(meta["unit_id"].to_list())
    uidx = {u: i for i, u in enumerate(units)}
    ca = np.array([uidx[u] for u in sub[col_a].to_list()], dtype=np.int64)
    cb = np.array([uidx[u] for u in sub[col_b].to_list()], dtype=np.int64)
    X = _pair_matrix(ca, cb, len(units))
    w = sub[weight_col].to_numpy().astype(np.float64)
    y = sub[resid_col].to_numpy().astype(np.float64) / w

    if alpha is None or not math.isfinite(alpha):
        zeros = np.zeros(len(units), dtype=np.float64)
        p5 = p50 = p95 = se = zeros
        tau = zeros
    else:
        alpha_f = max(float(alpha), 1e-6)
        tau = Ridge(alpha=alpha_f, fit_intercept=False).fit(X, y, sample_weight=w).coef_
        if resamples > 0:
            _, s_ids = np.unique(sub["series"].to_numpy(), return_inverse=True)
            n_series = int(s_ids.max()) + 1
            Gs, bs, _ = _group_grams(X, y, w, s_ids)
            eye = alpha_f * np.eye(len(units), dtype=np.float64)
            rng = np.random.default_rng(seed)
            mults = rng.multinomial(n_series, np.full(n_series, 1.0 / n_series), size=resamples).astype(np.float64)
            boots = np.empty((resamples, len(units)), dtype=np.float64)
            for i, mult in enumerate(mults):
                boots[i] = np.linalg.solve(np.tensordot(mult, Gs, axes=(0, 0)) + eye, mult @ bs)
            p5, p50, p95 = np.quantile(boots, [0.05, 0.50, 0.95], axis=0)
            se = np.std(boots, axis=0)
        else:
            p5 = p50 = p95 = tau
            se = np.zeros(len(units), dtype=np.float64)

    est = pl.DataFrame({
        "unit_id": units,
        "tau_per_round": tau,
        "tau_per100": 100.0 * tau,
        "tau_per100_p5": 100.0 * p5,
        "tau_per100_p50": 100.0 * p50,
        "tau_per100_p95": 100.0 * p95,
        "tau_per100_se": 100.0 * se,
    })
    return (
        meta.join(est, on="unit_id", how="left")
        .with_columns(
            (pl.col("rounds") * pl.col("tau_per_round") / r_win).alias("tau_waa"),
            (pl.col("rounds") * (pl.col("tau_per100_p5") / 100.0) / r_win).alias("tau_waa_p5"),
            (pl.col("rounds") * (pl.col("tau_per100_p95") / 100.0) / r_win).alias("tau_waa_p95"),
        )
        .sort("tau_per100", descending=True)
    )


def _series_weighted_ci(gain_num: np.ndarray, weights: np.ndarray, series: np.ndarray, resamples: int = DEFAULT_RESAMPLES, seed: int = 0) -> tuple[float, float]:
    """90% CI on rounds-weighted mean of `gain_num / weights` resampling whole series."""
    if len(gain_num) == 0 or np.sum(weights) <= 0:
        return (0.0, 0.0)
    _, s_ids = np.unique(series, return_inverse=True)
    n_series = int(s_ids.max()) + 1
    if n_series < 2:
        val = float(np.sum(gain_num) / np.sum(weights))
        return (val, val)
    sg = np.bincount(s_ids, weights=gain_num, minlength=n_series)
    sw = np.bincount(s_ids, weights=weights, minlength=n_series)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, n_series, size=(resamples, n_series))
    w_tot = sw[idx].sum(axis=1)
    means = np.where(w_tot > 0, sg[idx].sum(axis=1) / w_tot, 0.0)
    lo, hi = np.quantile(means, [0.05, 0.95])
    return float(lo), float(hi)


def forward_team_factor(
    prior_maps_df: pl.DataFrame,
    unit: str = "stint",
    resid_col: str = "resid_wpa_opp",
    k_rounds: float | None = None,
    min_prior_maps: int = MIN_PRIOR_MAPS,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int = 0,
    weight_col: str = "rounds",
) -> dict:
    """Walk-forward test: `prior`-mode `tau` fit strictly before event starts predicts that event's residuals.

    Also returns `pred` (per map, in `date, key` order; 0 where not evaluated) and the `evaluated` mask.
    """
    col_a, col_b = _unit_cols(unit)
    sub = (prior_maps_df.filter(pl.col("all_covered")) if "all_covered" in prior_maps_df.columns else prior_maps_df).sort("date", "key")
    if sub.height < min_prior_maps + 5:
        return {"maps": 0, "mse_zero": None, "mse_pred": None, "gain": None, "gain_ci": (None, None)}

    units = sorted(set(sub[col_a].to_list()) | set(sub[col_b].to_list()))
    uidx = {u: i for i, u in enumerate(units)}
    ca = np.array([uidx[u] for u in sub[col_a].to_list()], dtype=np.int64)
    cb = np.array([uidx[u] for u in sub[col_b].to_list()], dtype=np.int64)
    X = _pair_matrix(ca, cb, len(units))
    w = sub[weight_col].to_numpy().astype(np.float64)
    y = sub[resid_col].to_numpy().astype(np.float64) / w
    dates = sub["date"].to_numpy()
    events = sub["event"].to_numpy()
    series = sub["series"].to_numpy()

    ev_order = sub.group_by("event").agg(pl.col("date").min().alias("start")).sort("start", "event")
    alpha_f = float(k_rounds) if (k_rounds is not None and math.isfinite(k_rounds)) else None

    pred = np.zeros(len(y), dtype=np.float64)
    eval_mask = np.zeros(len(y), dtype=bool)
    for row in ev_order.iter_rows(named=True):
        ev, start = row["event"], row["start"]
        tr = dates < start
        te = events == ev
        if tr.sum() < min_prior_maps:
            continue
        eval_mask |= te
        if alpha_f is None:
            continue
        tau = Ridge(alpha=alpha_f, fit_intercept=False).fit(X[tr], y[tr], sample_weight=w[tr]).coef_
        pred[te] = X[te] @ tau

    if eval_mask.sum() < 10:
        return {"maps": 0, "mse_zero": None, "mse_pred": None, "gain": None, "gain_ci": (None, None)}
    we, ye, pe = w[eval_mask], y[eval_mask], pred[eval_mask]
    mse_zero = float(np.average(ye**2, weights=we))
    mse_pred = float(np.average((ye - pe) ** 2, weights=we))
    gain_num = we * (ye**2 - (ye - pe) ** 2)
    ci = _series_weighted_ci(gain_num, we, series[eval_mask], resamples=resamples, seed=seed)
    return {"maps": int(eval_mask.sum()), "mse_zero": mse_zero, "mse_pred": mse_pred, "gain": mse_zero - mse_pred, "gain_ci": ci,
            "pred": pred, "evaluated": eval_mask}


def _quarter(date: str) -> str:
    return f"{date[:4]}Q{(int(date[5:7]) - 1) // 3 + 1}"


def window_persistence(
    maps_df: pl.DataFrame,
    unit: str = "stint",
    resid_col: str = "resid_wpa_opp",
    min_window: float = 150.0,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int = 0,
    half_alpha: float = 1.0,
    weight_col: str = "rounds",
    window=_quarter,
) -> dict:
    """Does a unit's residual carry from one calendar quarter (or other `window(date)`) to the next?

    Fits `tau` per unit per quarter (alpha `half_alpha`, as the split-half does) and correlates `tau` in quarter q
    with q + 1, pooling every consecutive pair where the unit has `min_window` of `weight_col` in both. The 90%
    interval resamples series, centered in Fisher z as in `split_half_team_factor`.
    """
    empty = {"r": None, "r_ci": (None, None), "pairs": 0, "units": 0, "windows": 0}
    col_a, col_b = _unit_cols(unit)
    sub = (maps_df.filter(pl.col("all_covered")) if "all_covered" in maps_df.columns else maps_df)
    sub = sub.filter(pl.col(weight_col) > 0).with_columns(pl.col("date").map_elements(window, return_dtype=pl.String)
                                                          .alias("_window"))
    windows = sorted(sub["_window"].unique().to_list())
    if len(windows) < 2:
        return empty
    units = sorted(set(sub[col_a].to_list()) | set(sub[col_b].to_list()))
    uidx = {u: i for i, u in enumerate(units)}
    n_u = len(units)
    _, s_ids = np.unique(sub["series"].to_numpy(), return_inverse=True)
    n_series = int(s_ids.max()) + 1
    eye = half_alpha * np.eye(n_u, dtype=np.float64)

    # Each window is its own block of the design, so grams are kept per window: (series in window, units, units).
    blocks = []
    for wd in windows:
        part = sub.filter(pl.col("_window") == wd)
        mask = (sub["_window"] == wd).to_numpy()
        ca = np.array([uidx[u] for u in part[col_a].to_list()], dtype=np.int64)
        cb = np.array([uidx[u] for u in part[col_b].to_list()], dtype=np.int64)
        X = _pair_matrix(ca, cb, n_u)
        w = part[weight_col].to_numpy().astype(np.float64)
        y = part[resid_col].to_numpy().astype(np.float64) / w
        present, local = np.unique(s_ids[mask], return_inverse=True)
        Gs, bs, rds = _group_grams(X, y, w, local)
        blocks.append((present, Gs, bs, rds))

    def corr(mult: np.ndarray | None) -> tuple[float | None, int, int]:
        coefs, weights = [], []
        for present, Gs, bs, rds in blocks:
            m = np.ones(len(present)) if mult is None else mult[present]
            coefs.append(np.linalg.solve(np.tensordot(m, Gs, axes=(0, 0)) + eye, m @ bs))
            weights.append(m @ rds)
        a_vals, b_vals, seen = [], [], set()
        for i in range(len(windows) - 1):
            ok = (weights[i] >= min_window) & (weights[i + 1] >= min_window)
            a_vals.append(coefs[i][ok])
            b_vals.append(coefs[i + 1][ok])
            seen.update(np.flatnonzero(ok).tolist())
        va, vb = np.concatenate(a_vals), np.concatenate(b_vals)
        if len(va) < MIN_HALF_TEAMS or np.std(va) < 1e-12 or np.std(vb) < 1e-12:
            return None, len(va), len(seen)
        return float(np.corrcoef(va, vb)[0, 1]), len(va), len(seen)

    r_obs, pairs, n_units = corr(None)
    if r_obs is None:
        return {**empty, "pairs": pairs, "units": n_units, "windows": len(windows)}
    rng = np.random.default_rng(seed)
    boot = []
    for mult in rng.multinomial(n_series, np.full(n_series, 1.0 / n_series), size=resamples).astype(np.float64):
        rb, _, _ = corr(mult)
        if rb is not None:
            boot.append(rb)
    ci = (None, None)
    if len(boot) >= 10:
        zb = np.arctanh(np.clip(boot, -0.9999, 0.9999))
        zc = zb - float(np.mean(zb)) + math.atanh(max(-0.9999, min(0.9999, r_obs)))
        ci = (float(np.tanh(np.quantile(zc, 0.05))), float(np.tanh(np.quantile(zc, 0.95))))
    return {"r": r_obs, "r_ci": ci, "pairs": pairs, "units": n_units, "windows": len(windows)}


def sanity_check_elo(
    maps_df: pl.DataFrame,
    tf_df: pl.DataFrame,
    unit: str = "stint",
    metric: str = PRIMARY_METRIC,
    min_rounds: int = 300,
) -> tuple[dict, pl.DataFrame]:
    """Correlate `tau` with `(team Elo - Elo implied by summed player WAR)` across eligible stints."""
    col_a, col_b = _unit_cols(unit)
    sub = maps_df.filter(pl.col("all_covered") & pl.col("elo_a").is_not_null() & pl.col("elo_b").is_not_null())
    if sub.is_empty():
        return {"r": None, "units": 0}, tf_df.with_columns(pl.lit(None, pl.Float64).alias("elo_excess"))

    war_df = pl.concat([
        sub.select(pl.col(col_a).alias("unit_id"), "rounds", pl.col("elo_a").alias("elo"), pl.col(f"{metric}_a").alias("war")),
        sub.select(pl.col(col_b).alias("unit_id"), "rounds", pl.col("elo_b").alias("elo"), pl.col(f"{metric}_b").alias("war")),
    ]).group_by("unit_id").agg(
        ((pl.col("elo") * pl.col("rounds")).sum() / pl.col("rounds").sum()).alias("elo_mean_cov"),
        ((pl.col("war") * pl.col("rounds")).sum() / pl.col("rounds").sum()).alias("war_mean"),
        pl.col("rounds").sum().alias("cov_rounds"),
    )
    joined = tf_df.join(war_df, on="unit_id", how="left")
    elig = joined.filter((pl.col("rounds") >= min_rounds) & pl.col("elo_mean_cov").is_not_null() & pl.col("war_mean").is_not_null())
    if elig.height < 5:
        return {"r": None, "units": elig.height}, joined.with_columns(pl.lit(None, pl.Float64).alias("elo_excess")).drop("elo_mean_cov", "cov_rounds")

    wm = elig["war_mean"].to_numpy()
    em = elig["elo_mean_cov"].to_numpy()
    slope, intercept = np.polyfit(wm, em, 1) if np.std(wm) > 1e-12 else (0.0, float(np.mean(em)))
    excess_elig = em - (intercept + slope * wm)
    taus = elig["tau_per100"].to_numpy()
    r = float(np.corrcoef(taus, excess_elig)[0, 1]) if (np.std(taus) > 1e-12 and np.std(excess_elig) > 1e-12) else None
    joined = joined.with_columns((pl.col("elo_mean_cov") - (intercept + slope * pl.col("war_mean"))).alias("elo_excess")).drop("elo_mean_cov", "cov_rounds")
    return {"r": r, "units": elig.height, "slope_elo_per_war": float(slope)}, joined


def _apm_matrices(maps_df: pl.DataFrame) -> tuple[csr_matrix, csr_matrix, list[int], list[int]]:
    p_set = sorted({sid for col in ("steamids_a", "steamids_b") for lst in maps_df[col].to_list() for sid in lst})
    i_set = sorted({int(sid) for col in ("igl_a", "igl_b") for sid in maps_df[col].to_list() if sid is not None})
    pidx = {s: i for i, s in enumerate(p_set)}
    iidx = {s: i for i, s in enumerate(i_set)}

    pr, pc, pv = [], [], []
    for r_i, (la, lb) in enumerate(zip(maps_df["steamids_a"].to_list(), maps_df["steamids_b"].to_list())):
        for s in la:
            pr.append(r_i); pc.append(pidx[s]); pv.append(1.0)
        for s in lb:
            pr.append(r_i); pc.append(pidx[s]); pv.append(-1.0)
    Xp = csr_matrix((pv, (pr, pc)), shape=(maps_df.height, len(p_set)), dtype=np.float64)

    ia = np.array([iidx[int(s)] if s is not None else -1 for s in maps_df["igl_a"].to_list()], dtype=np.int64)
    ib = np.array([iidx[int(s)] if s is not None else -1 for s in maps_df["igl_b"].to_list()], dtype=np.int64)
    Xc = _pair_matrix(ia, ib, len(i_set))
    return Xp, Xc, p_set, i_set


def _solve_apm_gram(G: np.ndarray, b: np.ndarray, n_p: int, n_c: int, alpha: float, ratio: float) -> tuple[np.ndarray, np.ndarray]:
    if ratio <= 0.0 or n_c == 0:
        Gp = G[:n_p, :n_p] + alpha * np.eye(n_p, dtype=np.float64)
        tp = np.linalg.solve(Gp, b[:n_p]) if n_p > 0 else np.zeros(0, dtype=np.float64)
        return tp, np.zeros(n_c, dtype=np.float64)
    pen = np.concatenate([np.full(n_p, alpha), np.full(n_c, alpha / ratio)])
    sol = np.linalg.solve(G + np.diag(pen), b)
    return sol[:n_p], sol[n_p:]


def fit_apm(
    maps_df: pl.DataFrame,
    resid_col: str = "resid_wpa_opp",
    alpha: float = 10000.0,
    calling_ratio: float = 1.0,
) -> tuple[np.ndarray, np.ndarray, list[int], list[int]]:
    """Fit sparse weighted Ridge on player playing columns plus scaled IGL calling columns."""
    sub = maps_df.filter(pl.col("all_covered")) if "all_covered" in maps_df.columns else maps_df
    Xp, Xc, player_ids, igl_ids = _apm_matrices(sub)
    w = sub["rounds"].to_numpy().astype(np.float64)
    y = sub[resid_col].to_numpy().astype(np.float64) / w
    if calling_ratio <= 0.0 or len(igl_ids) == 0:
        tp = Ridge(alpha=alpha, fit_intercept=False).fit(Xp, y, sample_weight=w).coef_ if len(player_ids) else np.zeros(0)
        return tp, np.zeros(len(igl_ids), dtype=np.float64), player_ids, igl_ids
    scale = math.sqrt(calling_ratio)
    X = hstack([Xp, Xc.multiply(scale)], format="csr")
    coef = Ridge(alpha=alpha, fit_intercept=False).fit(X, y, sample_weight=w).coef_
    n_p = len(player_ids)
    return coef[:n_p], coef[n_p:] * scale, player_ids, igl_ids


def tune_apm(
    maps_df: pl.DataFrame,
    resid_col: str = "resid_wpa_opp",
    alphas: tuple[float, ...] = APM_ALPHA_GRID,
    ratios: tuple[float, ...] = APM_RATIO_GRID,
) -> tuple[float, float, list[dict]]:
    """Leave-one-event-out grid over `(alpha, calling_ratio)` selecting the penalty and variance ratio."""
    sub = maps_df.filter(pl.col("all_covered")) if "all_covered" in maps_df.columns else maps_df
    Xp, Xc, p_ids, i_ids = _apm_matrices(sub)
    X_all = hstack([Xp, Xc], format="csr")
    n_p, n_c = len(p_ids), len(i_ids)
    w = sub["rounds"].to_numpy().astype(np.float64)
    y = sub[resid_col].to_numpy().astype(np.float64) / w
    _, ev_ids = np.unique(sub["event"].to_numpy(), return_inverse=True)
    n_ev = int(ev_ids.max()) + 1
    Ge, be, _ = _group_grams(X_all, y, w, ev_ids)
    G_tot, b_tot = Ge.sum(axis=0), be.sum(axis=0)
    ev_rows = [np.flatnonzero(ev_ids == e) for e in range(n_ev)]

    grid_results = []
    mse_zero = float(np.average(y**2, weights=w))
    for alpha in alphas:
        for ratio in ratios:
            pred = np.zeros_like(y)
            for e, rows_e in enumerate(ev_rows):
                tp, tc = _solve_apm_gram(G_tot - Ge[e], b_tot - be[e], n_p, n_c, alpha, ratio)
                pred[rows_e] = X_all[rows_e] @ np.concatenate([tp, tc])
            mse = float(np.average((y - pred) ** 2, weights=w))
            grid_results.append({"alpha": alpha, "ratio": ratio, "loeo_mse": mse, "gain_over_zero": mse_zero - mse})
    best = min(grid_results, key=lambda r: r["loeo_mse"])
    return float(best["alpha"]), float(best["ratio"]), grid_results


def bootstrap_apm(
    maps_df: pl.DataFrame,
    resid_col: str = "resid_wpa_opp",
    alpha: float = 10000.0,
    calling_ratio: float = 1.0,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int = 0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[int], list[int]]:
    """Series-bootstrap SEs and intervals for Stage 2 APM `(theta_p, theta_c)`."""
    sub = maps_df.filter(pl.col("all_covered")) if "all_covered" in maps_df.columns else maps_df
    Xp, Xc, p_ids, i_ids = _apm_matrices(sub)
    X_all = hstack([Xp, Xc], format="csr")
    n_p, n_c = len(p_ids), len(i_ids)
    w = sub["rounds"].to_numpy().astype(np.float64)
    y = sub[resid_col].to_numpy().astype(np.float64) / w
    if resamples <= 0 or sub.height == 0:
        zeros_p, zeros_c = np.zeros(n_p), np.zeros(n_c)
        return zeros_p, zeros_c, zeros_c, zeros_c, p_ids, i_ids

    _, s_ids = np.unique(sub["series"].to_numpy(), return_inverse=True)
    n_series = int(s_ids.max()) + 1
    Gs, bs, _ = _group_grams(X_all, y, w, s_ids)
    rng = np.random.default_rng(seed)
    mults = rng.multinomial(n_series, np.full(n_series, 1.0 / n_series), size=resamples).astype(np.float64)
    bp = np.empty((resamples, n_p), dtype=np.float64)
    bc = np.empty((resamples, n_c), dtype=np.float64)
    for i, mult in enumerate(mults):
        tp, tc = _solve_apm_gram(np.tensordot(mult, Gs, axes=(0, 0)), mult @ bs, n_p, n_c, alpha, calling_ratio)
        bp[i] = tp
        bc[i] = tc
    p_se = np.std(bp, axis=0) if n_p else np.zeros(0)
    if n_c:
        c_se = np.std(bc, axis=0)
        c_p5, c_p95 = np.quantile(bc, [0.05, 0.95], axis=0)
    else:
        c_se = c_p5 = c_p95 = np.zeros(0)
    return p_se, c_se, c_p5, c_p95, p_ids, i_ids


def split_half_apm(
    maps_df: pl.DataFrame,
    lineup_counts: dict[int, int],
    resid_col: str = "resid_wpa_opp",
    alpha: float = 10000.0,
    calling_ratio: float = 1.0,
    min_rounds: int = 300,
) -> dict:
    """Alternating-series split-half correlation of player `theta_p`, reported for multi-lineup and all players."""
    sub = maps_df.filter(pl.col("all_covered")) if "all_covered" in maps_df.columns else maps_df
    if sub.is_empty():
        return {"r_multi": None, "n_multi": 0, "r_all": None, "n_all": 0}

    long_rows = []
    for r in sub.select("key", "series", "date", "rounds", "steamids_a", "steamids_b").iter_rows(named=True):
        for s in r["steamids_a"] + r["steamids_b"]:
            long_rows.append({"key": r["key"], "series": r["series"], "date": r["date"], "steamid": int(s), "rounds": r["rounds"]})
    long_df = pl.DataFrame(long_rows, schema={"key": pl.String, "series": pl.String, "date": pl.String, "steamid": pl.UInt64, "rounds": pl.Int64})
    halved = warcheck._alternating(long_df, ["steamid"])
    half_lookup = {(r["key"], int(r["steamid"])): int(r["half"]) for r in halved.select("key", "steamid", "half").iter_rows(named=True)}

    _, Xc, p_ids, i_ids = _apm_matrices(sub)
    pidx = {s: i for i, s in enumerate(p_ids)}
    pr, pc, pv = [], [], []
    for r_i, r in enumerate(sub.select("key", "steamids_a", "steamids_b").iter_rows(named=True)):
        for s in r["steamids_a"]:
            pr.append(r_i); pc.append(2 * pidx[int(s)] + half_lookup[(r["key"], int(s))]); pv.append(1.0)
        for s in r["steamids_b"]:
            pr.append(r_i); pc.append(2 * pidx[int(s)] + half_lookup[(r["key"], int(s))]); pv.append(-1.0)
    Xp_half = csr_matrix((pv, (pr, pc)), shape=(sub.height, 2 * len(p_ids)), dtype=np.float64)
    w = sub["rounds"].to_numpy().astype(np.float64)
    y = sub[resid_col].to_numpy().astype(np.float64) / w

    if calling_ratio > 0.0 and len(i_ids) > 0:
        scale = math.sqrt(calling_ratio)
        X = hstack([Xp_half, Xc.multiply(scale)], format="csr")
        n_ph = 2 * len(p_ids)
        G = (X.multiply(w[:, None]).T @ X).toarray()
        b = np.asarray(X.T @ (w * y)).ravel()
        # With calling column scaled by `sqrt(ratio)`, uniform penalty `alpha` applies to both.
        coef = np.linalg.solve(G + alpha * np.eye(G.shape[0]), b)[:n_ph]
    else:
        coef = Ridge(alpha=alpha, fit_intercept=False).fit(Xp_half, y, sample_weight=w).coef_

    rds_half = np.asarray(abs(Xp_half).T @ w).ravel()
    t0, t1, multi_mask = [], [], []
    for i, sid in enumerate(p_ids):
        r0, r1 = rds_half[2 * i], rds_half[2 * i + 1]
        if r0 > 0 and r1 > 0 and (r0 + r1) >= min_rounds:
            t0.append(coef[2 * i])
            t1.append(coef[2 * i + 1])
            multi_mask.append(lineup_counts.get(sid, 0) >= 2)
    t0_a, t1_a, mm = np.array(t0), np.array(t1), np.array(multi_mask, dtype=bool)
    r_all = float(np.corrcoef(t0_a, t1_a)[0, 1]) if (len(t0_a) >= 5 and np.std(t0_a) > 0 and np.std(t1_a) > 0) else None
    r_multi = float(np.corrcoef(t0_a[mm], t1_a[mm])[0, 1]) if (mm.sum() >= 5 and np.std(t0_a[mm]) > 0 and np.std(t1_a[mm]) > 0) else None
    return {"r_multi": r_multi, "n_multi": int(mm.sum()), "r_all": r_all, "n_all": len(t0_a)}


def lineup_change_flags(all_maps_df: pl.DataFrame) -> dict[str, dict[str, bool]]:
    """Flag maps with roster/lineup transitions by key: immediate previous lineup and prior-team majority transfer."""
    ordered = all_maps_df.sort("date", "key")
    prev_lineup: dict[str, tuple[int, ...]] = {}
    player_team_rounds: dict[int, dict[str, int]] = {}
    pending_date: str | None = None
    day_updates: list[tuple[int, str, int]] = []

    differs_prev: dict[str, bool] = {}
    prior_other_team: dict[str, bool] = {}
    for r in ordered.select("key", "date", "team_a", "team_b", "steamids_a", "steamids_b", "rounds").iter_rows(named=True):
        if pending_date is not None and r["date"] != pending_date:
            for sid, team, rds in day_updates:
                d = player_team_rounds.setdefault(sid, {})
                d[team] = d.get(team, 0) + rds
            day_updates.clear()
        pending_date = r["date"]

        lu_a = tuple(sorted(int(s) for s in r["steamids_a"]))
        lu_b = tuple(sorted(int(s) for s in r["steamids_b"]))
        changed = False
        for team, lu in ((r["team_a"], lu_a), (r["team_b"], lu_b)):
            if team in prev_lineup and prev_lineup[team] != lu:
                changed = True
            prev_lineup[team] = lu
        differs_prev[r["key"]] = changed

        transfer = False
        for team, lu in ((r["team_a"], lu_a), (r["team_b"], lu_b)):
            for sid in lu:
                hist = player_team_rounds.get(sid)
                if hist:
                    modal_team = max(hist.items(), key=lambda kv: kv[1])[0]
                    if modal_team != team:
                        transfer = True
                day_updates.append((sid, team, int(r["rounds"])))
        prior_other_team[r["key"]] = transfer

    return {"differs_prev": differs_prev, "prior_other_team": prior_other_team}


def apm_oof_gate(
    maps_df: pl.DataFrame,
    all_maps_df: pl.DataFrame,
    resid_col: str,
    k_stint: float | None,
    k_team: float | None,
    alpha_apm: float,
    ratio_apm: float,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int = 0,
) -> dict:
    """Out-of-fold LOEO MSE comparison of Stage 2 APM vs Stage 1 team models on lineup-change subsets."""
    sub = maps_df.filter(pl.col("all_covered")) if "all_covered" in maps_df.columns else maps_df
    flags = lineup_change_flags(all_maps_df)
    keys = sub["key"].to_list()
    mask_prev = np.array([flags["differs_prev"].get(k, False) for k in keys], dtype=bool)
    mask_transfer = np.array([flags["prior_other_team"].get(k, False) for k in keys], dtype=bool)

    w = sub["rounds"].to_numpy().astype(np.float64)
    y = sub[resid_col].to_numpy().astype(np.float64) / w
    series = sub["series"].to_numpy()
    _, ev_ids = np.unique(sub["event"].to_numpy(), return_inverse=True)
    n_ev = int(ev_ids.max()) + 1
    ev_rows = [np.flatnonzero(ev_ids == e) for e in range(n_ev)]

    def _oof_unit(unit: str, alpha_u: float | None) -> np.ndarray:
        if alpha_u is None or not math.isfinite(alpha_u):
            return np.zeros_like(y)
        col_a, col_b = _unit_cols(unit)
        units = sorted(set(sub[col_a].to_list()) | set(sub[col_b].to_list()))
        uidx = {u: i for i, u in enumerate(units)}
        ca = np.array([uidx[u] for u in sub[col_a].to_list()], dtype=np.int64)
        cb = np.array([uidx[u] for u in sub[col_b].to_list()], dtype=np.int64)
        Xu = _pair_matrix(ca, cb, len(units))
        Ge, be, _ = _group_grams(Xu, y, w, ev_ids)
        Gt, bt = Ge.sum(axis=0), be.sum(axis=0)
        eye = max(float(alpha_u), 1e-6) * np.eye(len(units), dtype=np.float64)
        pred = np.zeros_like(y)
        for e, rows_e in enumerate(ev_rows):
            coef = np.linalg.solve(Gt - Ge[e] + eye, bt - be[e])
            pred[rows_e] = Xu[rows_e] @ coef
        return pred

    pred_stint = _oof_unit("stint", k_stint)
    pred_team = _oof_unit("team", k_team)

    Xp, Xc, p_ids, i_ids = _apm_matrices(sub)
    X_all = hstack([Xp, Xc], format="csr")
    n_p, n_c = len(p_ids), len(i_ids)
    Ge_a, be_a, _ = _group_grams(X_all, y, w, ev_ids)
    Gt_a, bt_a = Ge_a.sum(axis=0), be_a.sum(axis=0)
    pred_apm = np.zeros_like(y)
    for e, rows_e in enumerate(ev_rows):
        tp, tc = _solve_apm_gram(Gt_a - Ge_a[e], bt_a - be_a[e], n_p, n_c, alpha_apm, ratio_apm)
        pred_apm[rows_e] = X_all[rows_e] @ np.concatenate([tp, tc])

    def _subset_eval(mask: np.ndarray, base_pred: np.ndarray) -> dict:
        if mask.sum() < 5:
            return {"maps": int(mask.sum()), "series": 0, "gain": None, "ci": (None, None), "mse_base": None, "mse_apm": None}
        wm, ym, bm, am = w[mask], y[mask], base_pred[mask], pred_apm[mask]
        mse_base = float(np.average((ym - bm) ** 2, weights=wm))
        mse_apm = float(np.average((ym - am) ** 2, weights=wm))
        gain_num = wm * ((ym - bm) ** 2 - (ym - am) ** 2)
        ci = _series_weighted_ci(gain_num, wm, series[mask], resamples=resamples, seed=seed)
        return {
            "maps": int(mask.sum()),
            "series": int(np.unique(series[mask]).size),
            "mse_base": mse_base,
            "mse_apm": mse_apm,
            "gain": mse_base - mse_apm,
            "ci": ci,
        }

    return {
        "prev_vs_stint": _subset_eval(mask_prev, pred_stint),
        "prev_vs_team": _subset_eval(mask_prev, pred_team),
        "transfer_vs_stint": _subset_eval(mask_transfer, pred_stint),
        "transfer_vs_team": _subset_eval(mask_transfer, pred_team),
        "all_vs_stint": _subset_eval(np.ones(len(y), dtype=bool), pred_stint),
    }


def _player_stats(
    maps_df: pl.DataFrame,
    adjusted_rows: pl.DataFrame,
    tf_stint: pl.DataFrame,
) -> pl.DataFrame:
    """Per-player lineup counts, team counts, IGL counts, and rounds-weighted average `tau / 5`."""
    sub = maps_df.filter(pl.col("all_covered")) if "all_covered" in maps_df.columns else maps_df
    tau_lookup = dict(tf_stint.select("unit_id", "tau_per100").iter_rows())
    names = (
        adjusted_rows.filter(pl.col("lp_player").is_not_null())
        .sort("date", "key")
        .group_by("steamid")
        .agg(pl.col("lp_player").last().alias("lp_player"))
    )
    rows = []
    for r in sub.select("team_a", "team_b", "stint_a", "stint_b", "steamids_a", "steamids_b", "igl_a", "igl_b", "rounds").iter_rows(named=True):
        rds = int(r["rounds"])
        for team, stint, sids, igl in (
            (r["team_a"], r["stint_a"], r["steamids_a"], r["igl_a"]),
            (r["team_b"], r["stint_b"], r["steamids_b"], r["igl_b"]),
        ):
            lu_key = tuple(sorted(int(s) for s in sids))
            tau_fifth = tau_lookup.get(stint, 0.0) / 5.0
            for sid in lu_key:
                rows.append({
                    "steamid": sid,
                    "lp_team": team,
                    "lineup_key": str(lu_key),
                    "is_igl_map": igl is not None and int(sid) == int(igl),
                    "rounds": rds,
                    "tau_fifth_w": rds * tau_fifth,
                })
    df = pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64})
    primary_team = (
        df.group_by("steamid", "lp_team").agg(pl.col("rounds").sum())
        .sort(["steamid", "rounds", "lp_team"], descending=[False, True, False])
        .unique("steamid", keep="first")
        .select("steamid", pl.col("lp_team").alias("primary_team"))
    )
    agg = df.group_by("steamid").agg(
        pl.col("lp_team").n_unique().cast(pl.Int64).alias("teams"),
        pl.col("lineup_key").n_unique().cast(pl.Int64).alias("lineups"),
        pl.len().cast(pl.Int64).alias("maps"),
        pl.col("rounds").sum().cast(pl.Int64),
        pl.col("is_igl_map").sum().cast(pl.Int64).alias("maps_as_igl"),
        (~pl.col("is_igl_map")).sum().cast(pl.Int64).alias("maps_non_igl"),
        (pl.col("tau_fifth_w").sum() / pl.col("rounds").sum()).alias("team_tau_fifth_per100"),
    )
    return agg.join(names, on="steamid", how="left").join(primary_team, on="steamid", how="left")


def build_apm_table(
    maps_df: pl.DataFrame,
    adjusted_rows: pl.DataFrame,
    tf_stint: pl.DataFrame,
    theta_p: np.ndarray,
    theta_c: np.ndarray,
    p_se: np.ndarray,
    c_se: np.ndarray,
    c_p5: np.ndarray,
    c_p95: np.ndarray,
    player_ids: list[int],
    igl_ids: list[int],
) -> pl.DataFrame:
    """Assemble `player-apm.parquet` with calling estimates and identification diagnostics."""
    stats = _player_stats(maps_df, adjusted_rows, tf_stint)
    p_df = pl.DataFrame({
        "steamid": pl.Series(player_ids, dtype=pl.UInt64),
        "theta_play": theta_p,
        "theta_play_per100": 100.0 * theta_p,
        "theta_play_se_per100": 100.0 * p_se,
    })
    c_df = pl.DataFrame({
        "steamid": pl.Series(igl_ids, dtype=pl.UInt64),
        "is_igl_caller": pl.Series([True] * len(igl_ids), dtype=pl.Boolean),
        "theta_call": theta_c,
        "theta_call_se": c_se,
        "theta_call_per100": 100.0 * theta_c,
        "theta_call_se_per100": 100.0 * c_se,
        "theta_call_p5_per100": 100.0 * c_p5,
        "theta_call_p95_per100": 100.0 * c_p95,
    })
    return (
        stats.join(p_df, on="steamid", how="left")
        .join(c_df, on="steamid", how="left")
        .with_columns(
            pl.col("is_igl_caller").fill_null(False),
            pl.col("theta_call").fill_null(0.0),
            pl.col("theta_call_se").fill_null(0.0),
            pl.col("theta_call_per100").fill_null(0.0),
            pl.col("theta_call_se_per100").fill_null(0.0),
            pl.col("theta_call_p5_per100").fill_null(0.0),
            pl.col("theta_call_p95_per100").fill_null(0.0),
        )
        .with_columns(
            (pl.col("theta_play_per100") - pl.col("team_tau_fifth_per100")).alias("diff_from_fifth_per100"),
            (pl.col("lineups") >= 2).alias("identified"),
        )
        .sort("rounds", descending=True)
    )


def _fmt_f(v: float | None, digits: int = 3, signed: bool = False) -> str:
    if v is None or not math.isfinite(v):
        return "n/a"
    return f"{v:{'+' if signed else ''}.{digits}f}"


def _fmt_ci(ci: tuple[float | None, float | None], digits: int = 3, signed: bool = False) -> str:
    if ci[0] is None or ci[1] is None:
        return "n/a"
    return f"({_fmt_f(ci[0], digits, signed)}, {_fmt_f(ci[1], digits, signed)})"


def _fmt_k(k: float | None) -> str:
    if k is None or not math.isfinite(k):
        return "∞"
    return f"{k:,.0f}"


def report_lines(
    res_stats: dict,
    comp_results: list[dict],
    tf_stint: pl.DataFrame,
    tf_team: pl.DataFrame,
    apm_info: dict,
    apm_df: pl.DataFrame,
    min_rounds: int,
    r_win: float,
) -> list[str]:
    primary = next(c for c in comp_results if c["metric"] == PRIMARY_METRIC)
    s1_pass = primary["r_ci"][0] is not None and primary["r_ci"][0] > 0.0
    s2_pass = apm_info["gate"]["prev_vs_stint"]["ci"][0] is not None and apm_info["gate"]["prev_vs_stint"]["ci"][0] > 0.0

    lines = [
        "# Team factor and adjusted plus-minus",
        "",
        f"5v5 maps with scores: {res_stats['maps_total']:,}. Full 10-player coverage (`>= {warcheck.COVERED_ROUNDS}` out-of-sample rounds each): "
        f"{res_stats['maps_all_covered']:,} ({100 * res_stats['pct_all_covered']:.1f}% of maps, {100 * res_stats['mean_slot_covered']:.1f}% of player slots). "
        f"Marginal rounds per map win (`r_win`): {r_win:.2f}.",
        "",
        f"Stage 1 gate (`{PRIMARY_METRIC}` stint split-half r lower 90% CI > 0): **{'PASS' if s1_pass else 'FAIL'}** "
        f"(r = {_fmt_f(primary['r'])}, 90% CI {_fmt_ci(primary['r_ci'])}).",
        f"Stage 2 gate (lineup-change LOEO MSE gain vs Stage 1 lower 90% CI > 0): **{'PASS' if s2_pass else 'FAIL'}**.",
        "",
        "## Stage 1: comparator sweep (unit = `lp_team × IGL stint`, 300+ rounds)",
        "",
        "| Metric | LOEO β | Stints | Split-half r | 90% CI | k (rounds) | k (maps) | Prior forward gain (×1e4) | 90% CI (×1e4) | Elo sanity r |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for c in comp_results:
        fg = c["forward"]
        g = fg["gain"] * 1e4 if fg["gain"] is not None else None
        gci = (fg["gain_ci"][0] * 1e4 if fg["gain_ci"][0] is not None else None, fg["gain_ci"][1] * 1e4 if fg["gain_ci"][1] is not None else None)
        lines.append(
            f"| {warcheck.LABELS[c['metric']]} | {_fmt_f(c['beta'], 3)} | {c['units']} | {_fmt_f(c['r'], 3)} | {_fmt_ci(c['r_ci'], 3)} | "
            f"{_fmt_k(c['k_rounds'])} | {_fmt_k(c['k_maps'])} | {_fmt_f(g, 2, True)} | {_fmt_ci(gci, 2, True)} | {_fmt_f(c['sanity_r'], 3)} |"
        )

    lines.extend(["", "## Stage 1: Team factors (`wpa_opp`, top & bottom stints with 300+ rounds)", "",
                  "| Team stint | Maps | Rounds | τ / 100 rds (90% CI) | Maps over exp. (τ / r_win) | Raw resid RW | Logistic MoE | Elo − WAR Elo |",
                  "| --- | --- | --- | --- | --- | --- | --- | --- |"])
    qual = tf_stint.filter(pl.col("rounds") >= min_rounds).sort("tau_per100", descending=True)
    shown = pl.concat([qual.head(12), qual.tail(10)]).unique("unit_id", maintain_order=True).sort("tau_per100", descending=True)
    for r in shown.iter_rows(named=True):
        ci = f"({_fmt_f(r['tau_per100_p5'], 2, True)}, {_fmt_f(r['tau_per100_p95'], 2, True)})"
        lines.append(
            f"| {r['label']} | {r['maps']} | {r['rounds']:,} | {_fmt_f(r['tau_per100'], 2, True)} {ci} | "
            f"{_fmt_f(r['tau_waa'], 2, True)} | {_fmt_f(r['raw_resid_rw'], 1, True)} | {_fmt_f(r['moe_sum'], 1, True)} | {_fmt_f(r['elo_excess'], 1, True)} |"
        )

    lines.extend(["", "## Stage 1 sense checks", "", "| Team / stint | Maps | Rounds | τ / 100 rds (90% CI) | Maps over exp. |", "| --- | --- | --- | --- | --- |"])
    sense = tf_stint.filter(
        pl.col("lp_team").is_in(["Team Vitality", "FaZe Clan", "Team Falcons", "G2 Esports", "FURIA", "MOUZ", "Team Liquid", "Team Spirit"])
    ).sort(["lp_team", "rounds"], descending=[False, True])
    for r in sense.iter_rows(named=True):
        ci = f"({_fmt_f(r['tau_per100_p5'], 2, True)}, {_fmt_f(r['tau_per100_p95'], 2, True)})"
        lines.append(f"| {r['label']} | {r['maps']} | {r['rounds']:,} | {_fmt_f(r['tau_per100'], 2, True)} {ci} | {_fmt_f(r['tau_waa'], 2, True)} |")

    t_sh = primary["team_split_half"]
    lines.extend([
        "",
        f"Plain `lp_team` split-half (`{PRIMARY_METRIC}`): r = {_fmt_f(t_sh['r'], 3)} 90% CI {_fmt_ci(t_sh['r_ci'], 3)}, k = {_fmt_k(t_sh['k_rounds'])} rounds ({_fmt_k(t_sh['k_maps'])} maps, {t_sh['units']} teams).",
        "",
        "| Top plain teams (300+ rds) | Maps | Rounds | τ / 100 rds (90% CI) | Maps over exp. |",
        "| --- | --- | --- | --- | --- |",
    ])
    t_qual = tf_team.filter(pl.col("rounds") >= min_rounds).sort("tau_per100", descending=True)
    for r in pl.concat([t_qual.head(6), t_qual.tail(4)]).unique("unit_id", maintain_order=True).sort("tau_per100", descending=True).iter_rows(named=True):
        ci = f"({_fmt_f(r['tau_per100_p5'], 2, True)}, {_fmt_f(r['tau_per100_p95'], 2, True)})"
        lines.append(f"| {r['lp_team']} | {r['maps']} | {r['rounds']:,} | {_fmt_f(r['tau_per100'], 2, True)} {ci} | {_fmt_f(r['tau_waa'], 2, True)} |")

    g = apm_info["gate"]
    sh2 = apm_info["split_half"]
    grid_rows = apm_info["grid"]
    g_alphas = sorted({r["alpha"] for r in grid_rows})
    g_ratios = sorted({r["ratio"] for r in grid_rows})
    g_lookup = {(r["alpha"], r["ratio"]): r["gain_over_zero"] * 1e4 for r in grid_rows}
    lines.extend([
        "",
        "## Stage 2: Adjusted plus-minus attribution",
        "",
        f"LOEO-selected hyperparameters: `alpha` = {apm_info['alpha']:,.0f} rounds, calling/playing variance ratio = {apm_info['ratio']:g}.",
        f"Split-half `r` of player `θ`: players with 2+ lineups: {_fmt_f(sh2['r_multi'], 3)} (n = {sh2['n_multi']}); all 300+ round players: {_fmt_f(sh2['r_all'], 3)} (n = {sh2['n_all']}).",
        "",
        "| `α_play` vs `ratio` | " + " | ".join(f"{r:g}" for r in g_ratios) + " |",
        "| --- | " + " | ".join("---" for _ in g_ratios) + " |",
        *(
            f"| {a:,.0f} | " + " | ".join(_fmt_f(g_lookup.get((a, r)), 3, True) for r in g_ratios) + " |"
            for a in g_alphas
        ),
        "",
        "| Out-of-fold evaluation subset | Maps | Series | Base MSE (×1e4) | APM MSE (×1e4) | Gain (×1e4) | 90% CI (×1e4) |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ])
    for key, label in (
        ("prev_vs_stint", "Differs from team's previous lineup vs Stage 1 (stint)"),
        ("prev_vs_team", "Differs from team's previous lineup vs Stage 1 (team)"),
        ("transfer_vs_stint", "Any player majority prior rounds on other team vs Stage 1 (stint)"),
        ("transfer_vs_team", "Any player majority prior rounds on other team vs Stage 1 (team)"),
        ("all_vs_stint", "All covered maps vs Stage 1 (stint)"),
    ):
        s = g[key]
        mb = s["mse_base"] * 1e4 if s["mse_base"] is not None else None
        ma = s["mse_apm"] * 1e4 if s["mse_apm"] is not None else None
        gn = s["gain"] * 1e4 if s["gain"] is not None else None
        gci = (s["ci"][0] * 1e4 if s["ci"][0] is not None else None, s["ci"][1] * 1e4 if s["ci"][1] is not None else None)
        lines.append(f"| {label} | {s['maps']} | {s['series']} | {_fmt_f(mb, 3)} | {_fmt_f(ma, 3)} | {_fmt_f(gn, 3, True)} | {_fmt_ci(gci, 3, True)} |")

    lines.extend(["", "### IGL calling terms (`θ_call` per 100 rounds, 90% series-bootstrap CI)", "",
                  "| IGL | Team | Lineups | IGL maps | Non-IGL maps | θ_call / 100 (90% CI) | θ_play / 100 |",
                  "| --- | --- | --- | --- | --- | --- | --- |"])
    igls = apm_df.filter(pl.col("is_igl_caller") & (pl.col("maps_as_igl") >= 5)).sort("theta_call_per100", descending=True)
    for r in igls.iter_rows(named=True):
        ci = f"({_fmt_f(r['theta_call_p5_per100'], 2, True)}, {_fmt_f(r['theta_call_p95_per100'], 2, True)})"
        lines.append(
            f"| {r['lp_player'] or r['steamid']} | {r['primary_team']} | {r['lineups']} | {r['maps_as_igl']} | {r['maps_non_igl']} | "
            f"{_fmt_f(r['theta_call_per100'], 2, True)} {ci} | {_fmt_f(r['theta_play_per100'], 2, True)} |"
        )

    lines.extend(["", "### Identification report (players sorted by distance from 1/5 of team τ)", "",
                  "| Player | Team | Teams | Lineups | Maps (IGL / non) | θ_play / 100 | 1/5 team τ | Diff | Status |",
                  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"])
    qual_p = apm_df.filter(pl.col("rounds") >= min_rounds).with_columns(pl.col("diff_from_fifth_per100").abs().alias("_abs_d")).sort("_abs_d", descending=True)
    sample_p = pl.concat([qual_p.head(15), qual_p.filter(~pl.col("identified")).head(5)]).unique("steamid", maintain_order=True)
    for r in sample_p.iter_rows(named=True):
        status = "identified (2+ lineups)" if r["identified"] else "even-split only (1 lineup)"
        lines.append(
            f"| {r['lp_player'] or r['steamid']} | {r['primary_team']} | {r['teams']} | {r['lineups']} | "
            f"{r['maps_as_igl']} / {r['maps_non_igl']} | {_fmt_f(r['theta_play_per100'], 2, True)} | "
            f"{_fmt_f(r['team_tau_fifth_per100'], 2, True)} | {_fmt_f(r['diff_from_fifth_per100'], 2, True)} | {status} |"
        )
    return lines


def export_teams_public(tf_stint: pl.DataFrame, min_rounds: int, res_stats: dict, primary: dict, out_dir: Path = PUBLIC_WAR) -> int:
    qual = tf_stint.filter(pl.col("rounds") >= min_rounds).sort("tau_per100", descending=True)
    records = [
        {
            "stint_id": r["unit_id"],
            "label": r["label"],
            "lp_team": r["lp_team"],
            "liquipedia_url": f"https://liquipedia.net/counterstrike/{r['lp_team'].replace(' ', '_')}",
            "igl_player": r["igl_player"],
            "maps": int(r["maps"]),
            "rounds": int(r["rounds"]),
            "tau_per100": round(float(r["tau_per100"]), 3),
            "tau_per100_p5": round(float(r["tau_per100_p5"]), 3),
            "tau_per100_p95": round(float(r["tau_per100_p95"]), 3),
            "tau_waa": round(float(r["tau_waa"]), 3),
            "tau_waa_p5": round(float(r["tau_waa_p5"]), 3),
            "tau_waa_p95": round(float(r["tau_waa_p95"]), 3),
            "moe_sum": round(float(r["moe_sum"]), 3),
            "elo_mean": round(float(r["elo_mean"]), 1) if r["elo_mean"] is not None else None,
            "elo_excess": round(float(r["elo_excess"]), 1) if r["elo_excess"] is not None else None,
        }
        for r in qual.iter_rows(named=True)
    ]
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "metric": PRIMARY_METRIC,
        "min_rounds": min_rounds,
        "coverage": {
            "maps_total": res_stats["maps_total"],
            "maps_all_covered": res_stats["maps_all_covered"],
            "split_half_r": primary["r"],
            "split_half_r_ci": list(primary["r_ci"]),
            "k_rounds": primary["k_rounds"],
            "k_maps": primary["k_maps"],
        },
        "source": SOURCE,
        "teams": records,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "teams.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {len(records)} team stints to {out_dir / 'teams.json'}")
    return 0


def build(min_rounds: int = 300, resamples: int = DEFAULT_RESAMPLES, publish: bool = False) -> int:
    adjusted, _ = load_adjusted()
    refs = catalog()
    scores = map_scores(refs)
    pm = warcheck.player_maps(adjusted, player_rounds(refs))
    rel = warcheck.split_half(pm, min_rounds)
    ks = {m: r["k"] for m, r in rel.items() if r["k"] is not None}
    igl_table = load_igl_table()

    maps_loeo, team_maps, res_stats = compute_residuals(refs, pm, scores, ks, mode="loeo", metrics=COMPARATORS, igl_table=igl_table)
    if maps_loeo.is_empty():
        print("No valid 5v5 maps with scores; cannot build team factor.")
        return 1
    maps_prior, _, _ = compute_residuals(refs, pm, scores, ks, mode="prior", metrics=COMPARATORS, igl_table=igl_table)
    r_win = estimate_rounds_per_win(adjusted, map_outcomes(refs))

    comp_results = []
    primary_tf_stint = primary_tf_team = None
    for m in COMPARATORS:
        rcol = f"resid_{m}"
        sh = split_half_team_factor(maps_loeo, unit="stint", resid_col=rcol, min_rounds=min_rounds, resamples=resamples)
        tf_s = fit_team_factor(maps_loeo, unit="stint", resid_col=rcol, alpha=sh["k_rounds"], r_win=r_win, resamples=resamples)
        san, tf_s = sanity_check_elo(maps_loeo, tf_s, unit="stint", metric=m, min_rounds=min_rounds)

        sh_prior = split_half_team_factor(maps_prior, unit="stint", resid_col=rcol, min_rounds=min_rounds, resamples=0)
        fg = forward_team_factor(maps_prior, unit="stint", resid_col=rcol, k_rounds=sh_prior["k_rounds"], resamples=resamples)

        entry = {"metric": m, "beta": res_stats["betas"][m], **sh, "forward": fg, "sanity_r": san["r"]}
        if m == PRIMARY_METRIC:
            sh_t = split_half_team_factor(maps_loeo, unit="team", resid_col=rcol, min_rounds=min_rounds, resamples=resamples)
            tf_t = fit_team_factor(maps_loeo, unit="team", resid_col=rcol, alpha=sh_t["k_rounds"], r_win=r_win, resamples=resamples)
            _, tf_t = sanity_check_elo(maps_loeo, tf_t, unit="team", metric=m, min_rounds=min_rounds)
            entry["team_split_half"] = sh_t
            primary_tf_stint, primary_tf_team = tf_s, tf_t
        comp_results.append(entry)

    assert primary_tf_stint is not None and primary_tf_team is not None
    primary = next(c for c in comp_results if c["metric"] == PRIMARY_METRIC)
    TEAM_MAP_RESIDUALS.parent.mkdir(parents=True, exist_ok=True)
    team_maps.write_parquet(TEAM_MAP_RESIDUALS)
    tf_out = pl.concat([
        primary_tf_stint.with_columns(pl.lit("stint").alias("unit_type")),
        primary_tf_team.with_columns(pl.lit("team").alias("unit_type")),
    ], how="diagonal_relaxed")
    tf_out.write_parquet(TEAM_FACTORS)

    best_alpha, best_ratio, grid = tune_apm(maps_loeo, resid_col="residual")
    theta_p, theta_c, p_ids, i_ids = fit_apm(maps_loeo, resid_col="residual", alpha=best_alpha, calling_ratio=best_ratio)
    p_se, c_se, c_p5, c_p95, _, _ = bootstrap_apm(maps_loeo, resid_col="residual", alpha=best_alpha, calling_ratio=best_ratio, resamples=resamples)
    apm_df = build_apm_table(maps_loeo, adjusted, primary_tf_stint, theta_p, theta_c, p_se, c_se, c_p5, c_p95, p_ids, i_ids)
    lineup_counts = dict(apm_df.select("steamid", "lineups").iter_rows())
    sh2 = split_half_apm(maps_loeo, lineup_counts, resid_col="residual", alpha=best_alpha, calling_ratio=best_ratio, min_rounds=min_rounds)
    gate2 = apm_oof_gate(
        maps_loeo, maps_loeo, "residual",
        k_stint=primary["k_rounds"], k_team=primary["team_split_half"]["k_rounds"],
        alpha_apm=best_alpha, ratio_apm=best_ratio, resamples=resamples,
    )
    apm_df.write_parquet(PLAYER_APM)

    lines = report_lines(
        res_stats, comp_results, primary_tf_stint, primary_tf_team,
        {"alpha": best_alpha, "ratio": best_ratio, "grid": grid, "split_half": sh2, "gate": gate2},
        apm_df, min_rounds, r_win,
    )
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "team-factor.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {TEAM_MAP_RESIDUALS}, {TEAM_FACTORS}, {PLAYER_APM}")

    if publish:
        s1_pass = primary["r_ci"][0] is not None and primary["r_ci"][0] > 0.0
        if not s1_pass:
            print("Stage 1 gate not passed (split-half r 90% CI includes 0); skipping public teams.json export.")
            return 1
        return export_teams_public(primary_tf_stint, min_rounds, res_stats, primary)
    return 0
