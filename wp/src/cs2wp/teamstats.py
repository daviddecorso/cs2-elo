"""Team round-level stats (Phase 7, order 2): time-and-position value, round wins over an economy and a player-WAR
expectation, round conversion beyond the round's gun duels, and opponent-adjusted T and CT ratings.

No expectation here includes team Elo: Elo absorbs whatever these stats measure, so each would drift to zero.
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl
from scipy.optimize import minimize
from scipy.sparse import csr_matrix
from scipy.special import expit

from . import duelstats as ds
from . import teamfactor as tf
from . import warcheck
from .data import catalog
from .duels import event_folds
from .evaluate import _buy
from .paths import (DUELS, PUBLIC_WAR, REPORTS, RESOURCE_ROUNDS, TEAM_MAP_RESIDUALS, TEAM_ROUNDS, TEAM_SIDE_RATINGS,
                    TEAM_STAT_MAPS, TEAM_STATS, WAR_REPORTS)
from .publish import SOURCE
from .states import CT, T

ROUND_STATS = ("tpv", "rwoe_econ", "conv")
STATS = (*ROUND_STATS, "rwoe_war")
WEIGHT = {"tpv": "n_tpv", "rwoe_econ": "n_econ", "conv": "n_conv", "rwoe_war": "rounds"}
LABELS = {"tpv": "Time-and-position value", "rwoe_econ": "Round wins over expected (economy)",
          "conv": "Round conversion over duels", "rwoe_war": "Round wins over expected (player WAR)"}
# Spec gate beyond split-half: these must persist from one quarter to the next; the others are descriptive.
PERSISTENCE_GATED = ("conv", "rwoe_war")
SIDE_LABELS = {"ct_def": "Adjusted CT (defense)", "t_off": "Adjusted T (offense)"}

ECON = ["map", "ct_equip", "t_equip", "pistol", "overtime"]
DUEL = [*ECON, "ct_kills", "t_kills", "opening_ct"]
MONOTONE = {"ct_equip": 1, "t_equip": -1, "ct_kills": 1, "t_kills": -1, "opening_ct": 1}
PARAMS = dict(max_depth=4, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, min_child_weight=50)
MAX_TREES = 2000
PISTOL_ROUNDS = (1, 13)
REGULATION = 24
CAL_MAX_GAP = 0.03
CAL_MIN_ROUNDS = 200

ALPHA_GRID = (25.0, 50.0, 100.0, 200.0, 400.0, 800.0, 1600.0)
RAW_K_GRID = (50.0, 100.0, 200.0, 400.0, 800.0, 1600.0, 3200.0)
MIN_PRIOR_ROUNDS = 2000
SIDE_RESAMPLES = 100


def team_rounds(refs, residuals: pl.DataFrame, resources: pl.DataFrame, duels: pl.DataFrame,
                drift: pl.DataFrame) -> pl.DataFrame:
    """One row per round on maps with both teams' stints and Elo: teams, result, both buys, gun kills per side,
    the opening duel's winning side and the WP model's uncredited drift (CT win probability)."""
    meta = residuals.select("key", "series", "event", "date").unique("key")
    keys = set(meta["key"].to_list())
    frames = []
    for ref in refs:
        path = ref.dir / "rounds.parquet"
        if ref.key not in keys or not path.exists():
            continue
        frames.append(pl.read_parquet(path, columns=["round_num", "ct_lp_team", "t_lp_team", "winner_side"])
                      .with_columns(pl.lit(ref.key).alias("key"), pl.lit(ref.map).alias("map")))
    rounds = (pl.concat(frames).filter(pl.col("winner_side").is_in(["ct", "t"]))
              .with_columns(pl.col("round_num").cast(pl.Int64), (pl.col("winner_side") == "ct").alias("ct_win"))
              .drop("winner_side").join(meta, on="key"))

    equip = resources.group_by("key", "round_num", "side").agg(pl.col("team_equip").first())
    ct = equip.filter(pl.col("side") == CT).select("key", "round_num", pl.col("team_equip").alias("ct_equip"))
    t = equip.filter(pl.col("side") == T).select("key", "round_num", pl.col("team_equip").alias("t_equip"))
    a_ct = pl.col("attacker_side") == CT
    kills = (duels.with_columns(pl.col("round_num").cast(pl.Int64)).group_by("key", "round_num")
             .agg(a_ct.sum().cast(pl.Float64).alias("ct_kills"), (~a_ct).sum().cast(pl.Float64).alias("t_kills"),
                  a_ct.filter(pl.col("opening")).first().cast(pl.Float64).alias("opening_ct")))
    return (rounds.join(ct, on=["key", "round_num"], how="left").join(t, on=["key", "round_num"], how="left")
            .join(kills, on=["key", "round_num"], how="left")
            .join(drift.select("key", pl.col("round_num").cast(pl.Int64), "drift"), on=["key", "round_num"], how="left")
            .with_columns(pl.col("ct_kills", "t_kills").fill_null(0.0),
                          pl.col("round_num").is_in(PISTOL_ROUNDS).alias("pistol"),
                          (pl.col("round_num") > REGULATION).alias("overtime"))
            .sort("date", "key", "round_num"))


def _design(df: pl.DataFrame, cols: list[str], maps: list[str]):
    import pandas as pd

    x = df.select(pl.col(c) if c == "map" else pl.col(c).cast(pl.Float32) for c in cols).to_pandas()
    if "map" in cols:
        x["map"] = pd.Categorical(x["map"], categories=maps)
    return x


def cross_fit(df: pl.DataFrame, cols: list[str], device: str = "cpu", target: str = "ct_win",
              monotone: dict[str, int] = MONOTONE) -> tuple[np.ndarray, int]:
    """Out-of-fold P(`target`), whole events per fold. The tree count is early-stopped once on fold 0."""
    from .pipeline import _fit_xgb

    maps = sorted(df["map"].unique().to_list())
    folds = event_folds(df)
    y = df[target].cast(pl.Int8).to_numpy()
    mono = tuple(monotone.get(c, 0) for c in cols)

    def fit(mask, n, val=None):
        kw = dict(eval_set=[(_design(df.filter(pl.Series(val)), cols, maps), y[val])], early_stopping_rounds=50) if val is not None else {}
        return _fit_xgb(_design(df.filter(pl.Series(mask)), cols, maps), y[mask], PARAMS, n_estimators=n,
                        monotone_constraints=mono, device=device, **kw)

    n = fit(folds != 0, MAX_TREES, folds == 0).best_iteration + 1
    p = np.empty(df.height)
    for f in range(folds.max() + 1):
        test = folds == f
        p[test] = fit(~test, n).predict_proba(_design(df.filter(pl.Series(test)), cols, maps))[:, 1]
    return p, n


def _log_loss(y: np.ndarray, p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def calibration_by_buy(r: pl.DataFrame, col: str) -> pl.DataFrame:
    return (r.with_columns(pl.when(pl.col("pistol")).then(pl.lit("pistol"))
                           .otherwise(pl.concat_str(_buy("ct_equip"), pl.lit("/"), _buy("t_equip"))).alias("buy"))
            .group_by("buy").agg(pl.len().alias("rounds"), pl.col(col).mean().alias("pred"),
                                 pl.col("ct_win").cast(pl.Float64).mean().alias("obs"))
            .with_columns((pl.col("pred") - pl.col("obs")).alias("gap"))
            .with_columns(((pl.col("rounds") >= CAL_MIN_ROUNDS) & (pl.col("gap").abs() > CAL_MAX_GAP)).alias("flagged"))
            .sort("buy"))


def expectations(rounds: pl.DataFrame, device: str = "cpu") -> tuple[pl.DataFrame, dict]:
    """Adds `p_econ` (map, both buys, pistol, overtime) and `p_duel` (the same plus the round's gun kills per side and
    the opening duel's winner), both cross-fit by event, on rounds with both buys."""
    r = rounds.filter(pl.col("ct_equip").is_not_null() & pl.col("t_equip").is_not_null())
    y = r["ct_win"].cast(pl.Float64).to_numpy()
    p_econ, n_econ = cross_fit(r, ECON, device)
    p_duel, n_duel = cross_fit(r, DUEL, device)
    base = np.full(len(y), y.mean())
    r = r.with_columns(pl.Series("p_econ", p_econ), pl.Series("p_duel", p_duel))
    info = {"rounds": r.height, "ct_rate": float(y.mean()), "trees": {"econ": n_econ, "duel": n_duel},
            "log_loss": {"base": float(_log_loss(y, base).mean()), "econ": float(_log_loss(y, p_econ).mean()),
                         "duel": float(_log_loss(y, p_duel).mean())},
            "calibration": {"econ": calibration_by_buy(r, "p_econ"), "duel": calibration_by_buy(r, "p_duel")}}
    return rounds.join(r.select("key", "round_num", "p_econ", "p_duel"), on=["key", "round_num"], how="left"), info


def per_team(rounds: pl.DataFrame, residuals: pl.DataFrame) -> pl.DataFrame:
    """Per (key, lp_team): each round stat summed from the team's view, and the rounds it covers.

    `tpv` is the drift centered per map, so the side offset (drift runs toward T) cancels and the two teams' values
    stay opposite. `rwoe_war` is `resid_wpa_opp` from `cs2wp team-factor`."""
    r = rounds.with_columns(
        (pl.col("drift") - pl.col("drift").mean().over("map")).alias("tpv"),
        (pl.col("ct_win").cast(pl.Float64) - pl.col("p_econ")).alias("rwoe_econ"),
        (pl.col("ct_win").cast(pl.Float64) - pl.col("p_duel")).alias("conv"))
    long = pl.concat([
        r.select("key", pl.col("ct_lp_team").alias("lp_team"), *ROUND_STATS),
        r.select("key", pl.col("t_lp_team").alias("lp_team"), *(-pl.col(s) for s in ROUND_STATS)),
    ])
    per = long.group_by("key", "lp_team").agg(
        *(pl.col(s).sum() for s in ROUND_STATS),
        *(pl.col(s).is_not_null().sum().cast(pl.Float64).alias(WEIGHT[s]) for s in ROUND_STATS))
    war = residuals.select("key", "lp_team", pl.col("resid_wpa_opp").alias("rwoe_war"))
    return per.join(war, on=["key", "lp_team"], how="left")


def stat_maps(per: pl.DataFrame, residuals: pl.DataFrame) -> pl.DataFrame:
    covered = residuals.group_by("key").agg(pl.col("all_covered").all().alias("war_covered"))
    weights = [WEIGHT[s] for s in ROUND_STATS]
    return (ds.pair_maps(per.with_columns(pl.col("rwoe_war").fill_null(0.0)), residuals, weights=weights, stats=list(STATS))
            .join(covered, on="key", how="left"))


def long_maps(maps: pl.DataFrame) -> pl.DataFrame:
    keep = ["key", "series", "event", "date", "rounds", *(WEIGHT[s] for s in ROUND_STATS), "war_covered"]
    return pl.concat([
        maps.select(*keep, pl.col("team_a").alias("lp_team"), pl.col("team_b").alias("opponent"),
                    pl.col("stint_a").alias("stint_id"), *STATS),
        maps.select(*keep, pl.col("team_b").alias("lp_team"), pl.col("team_a").alias("opponent"),
                    pl.col("stint_b").alias("stint_id"), *(-pl.col(s) for s in STATS)),
    ]).sort("date", "key", "lp_team")


def round_stat_results(maps: pl.DataFrame, min_rounds: int, resamples: int) -> tuple[dict, pl.DataFrame]:
    """`duelstats.team_results` for each stat (the WAR version on maps where all ten players have priors), plus
    quarter-to-quarter persistence."""
    war_maps = maps.filter(pl.col("war_covered"))
    res, est = ds.team_results(maps, min_rounds, resamples, stats=ROUND_STATS, weight=WEIGHT.get)
    war_res, war_est = ds.team_results(war_maps, min_rounds, resamples, stats=("rwoe_war",), weight=WEIGHT.get)
    for unit in ds.UNITS:
        res[unit].update(war_res[unit])
        for stat in STATS:
            m = war_maps if stat == "rwoe_war" else maps
            wcol = WEIGHT[stat]
            min_w = min_rounds / 2 * m[wcol].sum() / m["rounds"].sum()
            res[unit][stat]["persist"] = tf.window_persistence(m, unit=unit, resid_col=stat, min_window=min_w,
                                                               resamples=resamples, weight_col=wcol)
    return res, pl.concat([est, war_est], how="vertical_relaxed")


# Adjusted T and CT ratings: logit P(CT wins) = logit(p_econ) + d[CT unit] − o[T unit].

def _side_units(rounds: pl.DataFrame, residuals: pl.DataFrame, unit: str) -> pl.DataFrame:
    if unit == "team":
        return rounds.with_columns(pl.col("ct_lp_team").alias("ct_unit"), pl.col("t_lp_team").alias("t_unit"))
    stints = residuals.select("key", "lp_team", "stint_id")
    return (rounds.join(stints.rename({"lp_team": "ct_lp_team", "stint_id": "ct_unit"}), on=["key", "ct_lp_team"])
            .join(stints.rename({"lp_team": "t_lp_team", "stint_id": "t_unit"}), on=["key", "t_lp_team"]))


def side_design(ct_idx: np.ndarray, t_idx: np.ndarray, n_units: int) -> csr_matrix:
    """Columns 0..n−1 are CT defense (+1 on the CT unit), n..2n−1 T offense (−1 on the T unit)."""
    n = len(ct_idx)
    rows = np.r_[np.arange(n), np.arange(n)]
    cols = np.r_[ct_idx, n_units + t_idx]
    vals = np.r_[np.ones(n), -np.ones(n)]
    return csr_matrix((vals, (rows, cols)), shape=(n, 2 * n_units))


def fit_logit_ridge(X: csr_matrix, y: np.ndarray, offset: np.ndarray, alpha: float, w: np.ndarray | None = None,
                    start: np.ndarray | None = None) -> np.ndarray:
    """L2-penalized logistic regression with a fixed offset and no intercept (the offset carries the base rate)."""
    w = np.ones(len(y)) if w is None else w
    Xt = X.T.tocsr()

    def f(b: np.ndarray) -> tuple[float, np.ndarray]:
        z = offset + X @ b
        loss = float(np.sum(w * (np.logaddexp(0.0, z) - y * z)) + 0.5 * alpha * b @ b)
        return loss, Xt @ (w * (expit(z) - y)) + alpha * b

    b0 = np.zeros(X.shape[1]) if start is None else start
    return minimize(f, b0, jac=True, method="L-BFGS-B", options={"maxiter": 500}).x


def raw_ratings(ct_idx: np.ndarray, t_idx: np.ndarray, y: np.ndarray, n_units: int, k: float,
                w: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Shrunk raw win rates above the league's: CT rounds won and T rounds won, with no economy or opponent terms."""
    w = np.ones(len(y)) if w is None else w
    league = np.sum(w * y) / np.sum(w)
    d = np.bincount(ct_idx, w * (y - league), n_units) / (np.bincount(ct_idx, w, n_units) + k)
    o = np.bincount(t_idx, w * ((1 - y) - (1 - league)), n_units) / (np.bincount(t_idx, w, n_units) + k)
    return d, o


def _side_arrays(r: pl.DataFrame) -> tuple[list[str], np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    units = sorted(set(r["ct_unit"].to_list()) | set(r["t_unit"].to_list()))
    uidx = {u: i for i, u in enumerate(units)}
    ct_idx = np.array([uidx[u] for u in r["ct_unit"].to_list()], dtype=np.int64)
    t_idx = np.array([uidx[u] for u in r["t_unit"].to_list()], dtype=np.int64)
    p = np.clip(r["p_econ"].to_numpy(), 1e-6, 1 - 1e-6)
    return units, ct_idx, t_idx, r["ct_win"].cast(pl.Float64).to_numpy(), np.log(p / (1 - p))


def side_gate(r: pl.DataFrame, min_prior_rounds: int = MIN_PRIOR_ROUNDS) -> dict:
    """Walk-forward by event. Alpha and the raw shrinkage `k` are tuned on the first half of evaluable events; the
    second half scores offset + raw win rates against offset + adjusted ratings, per round, with a 90% interval
    from resampling events."""
    units, ct_idx, t_idx, y, off = _side_arrays(r)
    n_u = len(units)
    X = side_design(ct_idx, t_idx, n_u)
    dates, events = r["date"].to_numpy(), r["event"].to_numpy()
    starts = r.group_by("event").agg(pl.col("date").min().alias("start")).sort("start", "event")
    evaluable = [(e, s) for e, s in starts.iter_rows() if np.sum(dates < s) >= min_prior_rounds]
    if len(evaluable) < 6:
        return {"events": len(evaluable), "passed": False}
    tune, test = evaluable[:len(evaluable) // 2], evaluable[len(evaluable) // 2:]
    pbar = float(y.mean())
    scale = pbar * (1 - pbar)

    def losses(event: str, start: str, alphas, ks) -> tuple[dict, dict, np.ndarray]:
        tr, te = dates < start, events == event
        adj, b = {}, None
        Xtr = X[tr]
        for a in alphas:
            b = fit_logit_ridge(Xtr, y[tr], off[tr], a, start=b)
            adj[a] = _log_loss(y[te], expit(off[te] + X[te] @ b))
        raw = {}
        for k in ks:
            d, o = raw_ratings(ct_idx[tr], t_idx[tr], y[tr], n_u, k)
            raw[k] = _log_loss(y[te], expit(off[te] + (d[ct_idx[te]] - o[t_idx[te]]) / scale))
        return adj, raw, _log_loss(y[te], expit(off[te]))

    tuned_adj = {a: 0.0 for a in ALPHA_GRID}
    tuned_raw = {k: 0.0 for k in RAW_K_GRID}
    for e, s in tune:
        adj, raw, _ = losses(e, s, sorted(ALPHA_GRID, reverse=True), RAW_K_GRID)
        for a in ALPHA_GRID:
            tuned_adj[a] += float(adj[a].sum())
        for k in RAW_K_GRID:
            tuned_raw[k] += float(raw[k].sum())
    alpha = min(tuned_adj, key=tuned_adj.get)
    k = min(tuned_raw, key=tuned_raw.get)

    adj_l, raw_l, off_l, ev = [], [], [], []
    for e, s in test:
        adj, raw, base = losses(e, s, [alpha], [k])
        adj_l.append(adj[alpha]); raw_l.append(raw[k]); off_l.append(base); ev.append(np.full(len(base), e))
    adj_l, raw_l, off_l, ev = map(np.concatenate, (adj_l, raw_l, off_l, ev))
    gain = raw_l - adj_l
    lo, hi = warcheck.paired_ci(gain, ev)
    vs_off = off_l - adj_l
    lo_o, hi_o = warcheck.paired_ci(vs_off, ev)
    return {"events": len(test), "tune_events": len(tune), "rounds": len(gain), "alpha": alpha, "raw_k": k,
            "offset": float(off_l.mean()), "raw": float(raw_l.mean()), "adjusted": float(adj_l.mean()),
            "gain": float(gain.mean()), "gain_ci": (lo, hi), "gain_vs_offset": float(vs_off.mean()),
            "gain_vs_offset_ci": (lo_o, hi_o), "passed": lo > 0}


def side_ratings(r: pl.DataFrame, alpha: float, resamples: int, seed: int = 0) -> pl.DataFrame:
    """Full-data ratings per unit with series-bootstrap p5 / p95, in win-rate points per 100 rounds at the league's
    CT rate."""
    units, ct_idx, t_idx, y, off = _side_arrays(r)
    n_u = len(units)
    X = side_design(ct_idx, t_idx, n_u)
    b = fit_logit_ridge(X, y, off, alpha)
    _, s_ids = np.unique(r["series"].to_numpy(), return_inverse=True)
    n_s = int(s_ids.max()) + 1
    rng = np.random.default_rng(seed)
    boots = np.array([fit_logit_ridge(X, y, off, alpha, w=m[s_ids], start=b)
                      for m in rng.multinomial(n_s, np.full(n_s, 1.0 / n_s), size=resamples).astype(np.float64)])
    pbar = float(y.mean())
    per100 = 100 * pbar * (1 - pbar)
    p5, p95 = np.quantile(boots, [0.05, 0.95], axis=0) if resamples else (b, b)
    out = []
    for name, sl, idx in (("ct_def", slice(0, n_u), ct_idx), ("t_off", slice(n_u, 2 * n_u), t_idx)):
        out.append(pl.DataFrame({"unit_id": units, "side": name, "rating": b[sl], "per100": per100 * b[sl],
                                 "per100_p5": per100 * p5[sl], "per100_p95": per100 * p95[sl],
                                 "rounds": np.bincount(idx, minlength=n_u)}))
    return pl.concat(out)


def side_split_half(r: pl.DataFrame, alpha: float, min_rounds: float, resamples: int, seed: int = 0) -> dict:
    """Alternating-series split-half r of `d` and `o` per unit, fit with the gate's alpha."""
    long = pl.concat([r.select("key", "series", "date", pl.col(c).alias("unit")) for c in ("ct_unit", "t_unit")]).unique()
    half = {(k, u): h for k, u, h in warcheck._alternating(long, ["unit"]).select("key", "unit", "half").iter_rows()}
    units, ct_idx, t_idx, y, off = _side_arrays(r)
    keys = r["key"].to_list()
    hc = np.array([half[(k, u)] for k, u in zip(keys, r["ct_unit"].to_list())], dtype=np.int64)
    ht = np.array([half[(k, u)] for k, u in zip(keys, r["t_unit"].to_list())], dtype=np.int64)
    n_u = len(units)
    X = side_design(2 * ct_idx + hc, 2 * t_idx + ht, 2 * n_u)
    n_ct = np.bincount(2 * ct_idx + hc, minlength=2 * n_u)
    n_t = np.bincount(2 * t_idx + ht, minlength=2 * n_u)
    _, s_ids = np.unique(r["series"].to_numpy(), return_inverse=True)
    n_s = int(s_ids.max()) + 1

    def corrs(b: np.ndarray) -> dict:
        out = {}
        for name, coef, n in (("ct_def", b[:2 * n_u], n_ct), ("t_off", b[2 * n_u:], n_t)):
            ok = (n[0::2] >= min_rounds) & (n[1::2] >= min_rounds)
            out[name] = (ds._corr(coef[0::2][ok], coef[1::2][ok]), int(ok.sum()))
        return out

    b = fit_logit_ridge(X, y, off, alpha)
    obs = corrs(b)
    rng = np.random.default_rng(seed)
    boots = [corrs(fit_logit_ridge(X, y, off, alpha, w=m[s_ids], start=b))
             for m in rng.multinomial(n_s, np.full(n_s, 1.0 / n_s), size=resamples).astype(np.float64)]
    return {name: {"r": obs[name][0], "units": obs[name][1], "r_ci": ds._z_ci(obs[name][0], [x[name][0] for x in boots])}
            for name in obs}


def _unit_elo(residuals: pl.DataFrame, unit: str) -> pl.DataFrame:
    col = "stint_id" if unit == "stint" else "lp_team"
    meta = [pl.col("stint_label").first().alias("label"), pl.col("igl_player").first()] if unit == "stint" else \
        [pl.col("lp_team").first().alias("label"), pl.lit(None, pl.String).alias("igl_player")]
    return residuals.group_by(pl.col(col).alias("unit_id")).agg(
        pl.col("lp_team").first(), *meta, pl.len().alias("maps"),
        ((pl.col("elo") * pl.col("rounds")).sum() / pl.col("rounds").sum()).alias("elo_mean"))


def side_results(rounds: pl.DataFrame, residuals: pl.DataFrame, min_rounds: int, resamples: int) -> tuple[dict, pl.DataFrame]:
    r0 = rounds.filter(pl.col("p_econ").is_not_null())
    res, tables = {}, []
    for unit in ds.UNITS:
        r = _side_units(r0, residuals, unit)
        gate = side_gate(r)
        alpha = gate.get("alpha", ALPHA_GRID[len(ALPHA_GRID) // 2])
        n = min(resamples, SIDE_RESAMPLES)
        sh = side_split_half(r, alpha, min_rounds / 4, n)
        est = side_ratings(r, alpha, n).join(_unit_elo(residuals, unit), on="unit_id", how="left") \
            .with_columns(pl.lit(unit).alias("unit_type"))
        elig = est.filter(pl.col("rounds") >= min_rounds / 2)
        r_elo = {s: ds._corr(elig.filter(pl.col("side") == s)["per100"].to_numpy(),
                             elig.filter(pl.col("side") == s)["elo_mean"].to_numpy()) for s in SIDE_LABELS}
        res[unit] = {"gate": gate, "split": sh, "r_elo": r_elo}
        tables.append(est)
    return res, pl.concat(tables, how="diagonal_relaxed")


def gates(res: dict, side: dict) -> dict:
    """Published round stats pass split-half (stints), and the persistence-gated ones persist across quarters.
    Side ratings publish only when they beat raw win rates walk-forward."""
    stint = res["stint"]
    split = {s: ds._passes(stint[s]["split"]["r_ci"]) for s in STATS}
    persist = {s: ds._passes(stint[s]["persist"]["r_ci"]) for s in STATS}
    published = [s for s in STATS if split[s] and (s not in PERSISTENCE_GATED or persist[s])]
    side_ok = side["stint"]["gate"].get("passed", False)
    return {"split": split, "persist": persist, "published": published, "side": side_ok}


def _f(v, d=3, signed=False):
    return tf._fmt_f(v, d, signed)


def _ci(ci, d=3, signed=False):
    return tf._fmt_ci(ci, d, signed)


def _verdict(ok: bool) -> str:
    return "**PASS**" if ok else "**FAIL**"


def report_lines(rounds: pl.DataFrame, info: dict, maps: pl.DataFrame, res: dict, side: dict, est: pl.DataFrame,
                 side_est: pl.DataFrame, g: dict, min_rounds: int) -> list[str]:
    ll = info["log_loss"]
    lines = [
        "# Team round stats", "",
        f"{rounds.height:,} rounds on {rounds['key'].n_unique():,} maps; {maps.height:,} maps have both teams' stints and "
        f"Elo ({int(maps['war_covered'].sum()):,} with all ten players' WAR priors). Every interval is 90%, resampling "
        "whole series unless marked. No expectation includes team Elo.", "",
        "## Gates", "",
        *(f"- {LABELS[s]}: split-half {_verdict(g['split'][s])}, quarter persistence {_verdict(g['persist'][s])}"
          f"{' (required)' if s in PERSISTENCE_GATED else ' (reported)'}." for s in STATS),
        f"- Adjusted T and CT ratings beat raw win rates walk-forward: {_verdict(g['side'])}.",
        f"- Published: {', '.join(g['published'] + (['ct_def', 't_off'] if g['side'] else [])) or 'none'}.", "",
        "## Round expectations (cross-fit by event, no Elo)", "",
        f"{info['rounds']:,} rounds with both buys; CT round rate {info['ct_rate']:.3f}.", "",
        "| Model | Inputs | Trees | Log loss |", "| --- | --- | --- | --- |",
        f"| Base rate | — | — | {ll['base']:.4f} |",
        f"| Economy `p_econ` | {', '.join(ECON)} | {info['trees']['econ']} | {ll['econ']:.4f} |",
        f"| Duels `p_duel` | economy + {', '.join(DUEL[len(ECON):])} | {info['trees']['duel']} | {ll['duel']:.4f} |",
        "", f"Calibration by buy (CT/T; flagged when |gap| > {CAL_MAX_GAP} on {CAL_MIN_ROUNDS}+ rounds):", "",
        "| Buy | Rounds | Econ pred | Duel pred | Observed | Econ gap | Duel gap |", "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    duel_cal = {row["buy"]: row for row in info["calibration"]["duel"].iter_rows(named=True)}
    for row in info["calibration"]["econ"].iter_rows(named=True):
        dc = duel_cal.get(row["buy"], {})
        lines.append(f"| {row['buy']} | {row['rounds']:,} | {row['pred']:.3f} | {_f(dc.get('pred'))} | {row['obs']:.3f} | "
                     f"{row['gap']:+.3f}{' FLAG' if row['flagged'] else ''} | {_f(dc.get('gap'), 3, True)}"
                     f"{' FLAG' if dc.get('flagged') else ''} |")

    for unit, name in ds.UNITS.items():
        lines += ["", f"## Team stats by {name} ({min_rounds}+ rounds)", "",
                  "All stats are per 100 rounds. Persistence pools consecutive calendar quarters where the unit has half "
                  "the minimum in both. Forward gain is the walk-forward weighted MSE gain as a % of predicting zero; the "
                  "Elo test is leave-one-event-out log loss of the map result, Elo against Elo plus the walk-forward stat.",
                  "", "| Stat | Units | Split-half r | 90% CI | k (rounds) | Persistence r | 90% CI | Pairs | Forward gain % "
                  "| r with Elo | Elo + stat gain | 90% CI |", "|" + " --- |" * 12]
        for stat in STATS:
            t = res[unit][stat]
            sh, fw, el, pr = t["split"], t["forward"], t["elo"], t["persist"]
            pct = None if fw.get("gain") is None or not fw["mse_zero"] else 100 * fw["gain"] / fw["mse_zero"]
            lines.append(f"| {LABELS[stat]} | {sh['units']} | {_f(sh['r'])} | {_ci(sh['r_ci'])} | {tf._fmt_k(sh['k_rounds'])} | "
                         f"{_f(pr['r'])} | {_ci(pr['r_ci'])} | {pr['pairs']} | {_f(pct, 2, True)} | {_f(t['r_elo'], 2)} | "
                         f"{_f(el and el['gain'], 4, True)} | {_ci(el['gain_ci'] if el else (None, None), 4, True)} |")

    lines += ["", "## Adjusted T and CT ratings", "",
              "`logit P(CT wins) = logit(p_econ) + d[CT unit] − o[T unit]`, logistic ridge. The economy offset controls "
              "for map, side and both buys; the pairing controls for the opponent. The raw comparator is each unit's "
              "shrunk CT and T round win rate above the league's on the same offset. Walk-forward by event: alpha and "
              "the raw `k` are tuned on the first half of events, the gain is scored on the second half, resampling "
              "events.", "",
              "| Unit | Test events | Rounds | Alpha | Raw k | Offset only | Raw | Adjusted | Gain vs raw | 90% CI | "
              "Gain vs offset | 90% CI | CT split-half r (90% CI) | T split-half r (90% CI) | CT r Elo | T r Elo |",
              "|" + " --- |" * 16]
    for unit, name in ds.UNITS.items():
        s = side[unit]
        gt, sh = s["gate"], s["split"]
        if "gain" not in gt:
            lines.append(f"| {name} | {gt['events']} | not enough events |" + " |" * 13)
            continue
        lines.append(
            f"| {name} | {gt['events']} | {gt['rounds']:,} | {gt['alpha']:g} | {gt['raw_k']:g} | {gt['offset']:.4f} | "
            f"{gt['raw']:.4f} | {gt['adjusted']:.4f} | {gt['gain']:+.5f} | {_ci(gt['gain_ci'], 5, True)} | "
            f"{gt['gain_vs_offset']:+.5f} | {_ci(gt['gain_vs_offset_ci'], 5, True)} | "
            f"{_f(sh['ct_def']['r'])} {_ci(sh['ct_def']['r_ci'])} | {_f(sh['t_off']['r'])} {_ci(sh['t_off']['r_ci'])} | "
            f"{_f(s['r_elo']['ct_def'], 2)} | {_f(s['r_elo']['t_off'], 2)} |")

    stint = est.filter((pl.col("unit_type") == "stint") & (pl.col("rounds") >= min_rounds))
    for stat in STATS:
        q = stint.filter(pl.col("stat") == stat).sort("per100", descending=True)
        if q.is_empty():
            continue
        lines += ["", f"### {LABELS[stat]}: top and bottom {ds.TOP} stints", "",
                  "| Stint | Maps | Rounds | Per 100 rounds (90% CI) |", "| --- | --- | --- | --- |"]
        for r in pl.concat([q.head(ds.TOP), q.tail(ds.TOP)]).unique("unit_id", maintain_order=True).iter_rows(named=True):
            lines.append(f"| {r['label']} | {r['maps']} | {r['weight']:,.0f} | {_f(r['per100'], 2, True)} "
                         f"({_f(r['per100_p5'], 2, True)}, {_f(r['per100_p95'], 2, True)}) |")
    st = side_est.filter((pl.col("unit_type") == "stint") & (pl.col("rounds") >= min_rounds / 2))
    for s, label in SIDE_LABELS.items():
        q = st.filter(pl.col("side") == s).sort("per100", descending=True)
        lines += ["", f"### {label}: top and bottom {ds.TOP} stints (win-rate points per 100 rounds)", "",
                  "| Stint | Side rounds | Per 100 (90% CI) |", "| --- | --- | --- |"]
        for r in pl.concat([q.head(ds.TOP), q.tail(ds.TOP)]).unique("unit_id", maintain_order=True).iter_rows(named=True):
            lines.append(f"| {r['label']} | {r['rounds']:,} | {_f(r['per100'], 2, True)} "
                         f"({_f(r['per100_p5'], 2, True)}, {_f(r['per100_p95'], 2, True)}) |")
    return lines


def _rate(r: dict) -> dict:
    return {"per100": round(float(r["per100"]), 3), "p5": round(float(r["per100_p5"]), 3),
            "p95": round(float(r["per100_p95"]), 3)}


def export_public(est: pl.DataFrame, side_est: pl.DataFrame, res: dict, side: dict, g: dict, min_rounds: int,
                  out_dir: Path = PUBLIC_WAR) -> int:
    """`team-stats.json`: stint estimates per 100 rounds for the stats that passed, each marked descriptive unless it
    adds to Elo."""
    if not g["published"] and not g["side"]:
        print("No team round stat passed its gate; skipping team-stats.json.")
        return 1
    stint = est.filter((pl.col("unit_type") == "stint") & (pl.col("rounds") >= min_rounds))
    meta, records = {}, {}

    def record(r: dict) -> dict:
        return records.setdefault(r["unit_id"], {
            "stint_id": r["unit_id"], "label": r["label"], "lp_team": r["lp_team"],
            "liquipedia_url": f"https://liquipedia.net/counterstrike/{r['lp_team'].replace(' ', '_')}",
            "igl_player": r["igl_player"], "maps": int(r["maps"]), "rounds": int(r["rounds"])})

    for stat in g["published"]:
        t = res["stint"][stat]
        el = t["elo"]
        meta[stat] = {"label": LABELS[stat], "split_half_r": t["split"]["r"], "split_half_r_ci": list(t["split"]["r_ci"]),
                      "persistence_r": t["persist"]["r"], "persistence_r_ci": list(t["persist"]["r_ci"]),
                      "descriptive": not (el is not None and ds._passes(el["gain_ci"]))}
        for r in stint.filter(pl.col("stat") == stat).iter_rows(named=True):
            record(r)[stat] = _rate(r)
    if g["side"]:
        gt, sh = side["stint"]["gate"], side["stint"]["split"]
        for s, label in SIDE_LABELS.items():
            meta[s] = {"label": label, "split_half_r": sh[s]["r"], "split_half_r_ci": list(sh[s]["r_ci"]),
                       "gain_vs_raw": gt["gain"], "gain_vs_raw_ci": list(gt["gain_ci"]), "descriptive": True}
        rows = side_est.filter(pl.col("unit_type") == "stint")
        totals = rows.group_by("unit_id").agg(pl.col("rounds").sum(), pl.col("label", "lp_team", "igl_player", "maps").first())
        for r in totals.filter(pl.col("rounds") >= min_rounds).iter_rows(named=True):
            record(r)
        for r in rows.filter(pl.col("unit_id").is_in(list(records))).iter_rows(named=True):
            records[r["unit_id"]][r["side"]] = _rate(r)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "min_rounds": min_rounds,
        "stats": meta,
        "source": SOURCE,
        "teams": sorted(records.values(), key=lambda r: -r["rounds"]),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "team-stats.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {len(records)} stints to {out_dir / 'team-stats.json'}")
    return 0


def build(min_rounds: int = ds.MIN_TEAM_ROUNDS, resamples: int = tf.DEFAULT_RESAMPLES, publish: bool = False,
          device: str = "cpu") -> int:
    conservation = REPORTS / "conservation.parquet"
    for path, cmd in ((TEAM_MAP_RESIDUALS, "cs2wp team-factor"), (RESOURCE_ROUNDS, "cs2wp usage"),
                      (DUELS, "cs2wp duels"), (conservation, "cs2wp credit")):
        if not path.exists():
            raise FileNotFoundError(f"{path} not found; run `{cmd}` first")
    residuals = pl.read_parquet(TEAM_MAP_RESIDUALS)
    rounds = team_rounds(catalog(), residuals,
                         pl.read_parquet(RESOURCE_ROUNDS, columns=["key", "round_num", "side", "team_equip"]),
                         pl.read_parquet(DUELS, columns=["key", "round_num", "attacker_side", "opening"]),
                         pl.read_parquet(conservation, columns=["key", "round_num", "drift"]))
    rounds, info = expectations(rounds, device)
    TEAM_ROUNDS.parent.mkdir(parents=True, exist_ok=True)
    rounds.write_parquet(TEAM_ROUNDS)

    maps = stat_maps(per_team(rounds, residuals), residuals)
    res, est = round_stat_results(maps, min_rounds, resamples)
    side, side_est = side_results(rounds, residuals, min_rounds, resamples)
    g = gates(res, side)

    long_maps(maps).write_parquet(TEAM_STAT_MAPS)
    est.write_parquet(TEAM_STATS)
    side_est.write_parquet(TEAM_SIDE_RATINGS)
    lines = report_lines(rounds, info, maps, res, side, est, side_est, g, min_rounds)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "team-stats.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {TEAM_ROUNDS}, {TEAM_STAT_MAPS}, {TEAM_STATS}, {TEAM_SIDE_RATINGS}")
    return export_public(est, side_est, res, side, g, min_rounds) if publish else 0
