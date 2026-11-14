"""Duel execution and duel quality (Phase 7): duel wins above the expected-duel model, and how much better the
duels a team takes are than its buy and side predict."""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl
from scipy.linalg import solve
from scipy.sparse import csr_matrix, identity

from . import teamfactor as tf
from . import warcheck
from .duels import NESTED
from .paths import (DUEL_PLAYERS, DUEL_TEAM_MAPS, DUEL_TEAMS, DUELS, PUBLIC_WAR, ROLE_ROUNDS, TEAM_MAP_RESIDUALS,
                    WAR_REPORTS)
from .publish import SOURCE
from .states import CT, T

PARTS = ("q_pos", "q_flash", "q_hp")
QUALITY = ("quality", *PARTS)
STATS = ("exec", *QUALITY)
OPEN = tuple(f"{s}_open" for s in STATS)
LABELS = {"exec": "Execution", "quality": "Quality", "q_pos": "Quality: positioning", "q_flash": "Quality: flashes",
          "q_hp": "Quality: HP", "quality_headline": "Quality (passing parts only)"}
UNITS = {"stint": "IGL stint", "team": "Team (`lp_team`)"}
MIN_PLAYER_DUELS = 300
MIN_TEAM_ROUNDS = 300
# The duel-level ridge refits a dense players × players system per resample.
EXPERIMENT_RESAMPLES = 200
TOP = 10
CHUNK = 100


def label(stat: str) -> str:
    base = stat.removesuffix("_open")
    return LABELS[base] + (" (opening duels)" if stat.endswith("_open") else "")


def weight_of(stat: str) -> str:
    return "duels_open" if stat.endswith("_open") else "duels"


def _corr(a: np.ndarray, b: np.ndarray) -> float | None:
    if len(a) < 3 or np.std(a) < 1e-12 or np.std(b) < 1e-12:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def _mults(n: int, resamples: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.multinomial(n, np.full(n, 1.0 / n), size=resamples).astype(np.float64)


def _z_ci(obs: float | None, boot: list[float]) -> tuple[float | None, float | None]:
    """90% interval in Fisher z, centered on `obs`: resampling series drops about 37% of them and attenuates raw r."""
    boot = [b for b in boot if b is not None]
    if obs is None or len(boot) < 10:
        return (None, None)
    zb = np.arctanh(np.clip(boot, -0.9999, 0.9999))
    zc = zb - zb.mean() + math.atanh(max(-0.9999, min(0.9999, obs)))
    return float(np.tanh(np.quantile(zc, 0.05))), float(np.tanh(np.quantile(zc, 0.95)))


def _passes(ci: tuple) -> bool:
    return ci[0] is not None and ci[0] > 0


def duel_values(d: pl.DataFrame) -> pl.DataFrame:
    """Each duel from both players' views. Quality and its parts are centered per map × side.

    Every stat is antisymmetric: a duel's two rows sum to zero. `quality_raw` is quality before centering.
    """
    missing = [c for c in ("p", *NESTED, "opening") if c not in d.columns]
    if missing:
        raise ValueError(f"{DUELS} has no {', '.join(missing)}; rerun `cs2wp duels`")
    a_side = pl.col("attacker_side").cast(pl.Int32)
    v_side = pl.when(a_side == CT).then(T).otherwise(CT).cast(pl.Int32)
    keep = ["key", "date", "map", "event", "round_num", "kill", "opening"]

    def view(who: str, opp: str, side: pl.Expr, win: int) -> pl.DataFrame:
        p = (lambda c: pl.col(c)) if win else (lambda c: 1 - pl.col(c))
        return d.select(*keep, pl.col(who).alias("steamid"), pl.col(opp).alias("opponent"), side.alias("side"),
                        pl.lit(float(win)).alias("win"), p("p").alias("expected"),
                        (pl.lit(float(win)) - p("p")).alias("exec"), (p("p") - p("p_base")).alias("quality"),
                        (p("p_pos") - p("p_base")).alias("q_pos"), (p("p_flash") - p("p_pos")).alias("q_flash"),
                        (p("p") - p("p_flash")).alias("q_hp"))

    v = pl.concat([view("attacker", "victim", a_side, 1), view("victim", "attacker", v_side, 0)])
    return v.with_columns(pl.col("quality").alias("quality_raw"),
                          *(pl.col(c) - pl.col(c).mean().over("map", "side") for c in QUALITY))


def player_maps(values: pl.DataFrame, role_rounds: pl.DataFrame) -> pl.DataFrame:
    """Per (key, steamid): rounds, duels, wins, expected wins, and execution and quality sums."""
    rr = role_rounds.group_by("key", "steamid").agg(pl.col("rounds").sum().cast(pl.Float64),
                                                    pl.col("date", "event", "lp_team", "lp_player").first())
    sums = ["wins", "expected", "exec", "quality"]
    pv = values.group_by("key", "steamid").agg(pl.len().cast(pl.Float64).alias("duels"),
                                               pl.col("win").sum().alias("wins"), pl.col("expected", "exec", "quality").sum())
    return (rr.join(pv, on=["key", "steamid"], how="left")
            .with_columns(pl.col("duels", *sums).fill_null(0.0), pl.col("key").str.split("/").list.first().alias("series"))
            .sort("date", "key", "steamid"))


def player_split_half(halves: pl.DataFrame, col: str, weight: str, resamples: int, seed: int = 0) -> dict:
    """`warcheck._paired_halves` on `col / weight`, plus a 90% interval for r from resampling series."""
    point = warcheck._paired_halves(halves, ["steamid"], col, weight=weight)
    if point["r"] is None or resamples <= 0:
        return {**point, "r_ci": (None, None)}
    g = halves.group_by("steamid", "half", "series").agg(pl.col(col).sum().alias("num"), pl.col(weight).sum().alias("den"))
    _, s = np.unique(g["series"].to_numpy(), return_inverse=True)
    _, u = np.unique(g["steamid"].to_numpy(), return_inverse=True)
    cells = csr_matrix((np.ones(g.height), (2 * u + g["half"].to_numpy(), np.arange(g.height))),
                       shape=(2 * (u.max() + 1), g.height))
    num, den = g["num"].to_numpy(), g["den"].to_numpy()
    mults = _mults(int(s.max()) + 1, resamples, seed)
    boot = []
    for i in range(0, resamples, CHUNK):
        m = mults[i:i + CHUNK][:, s]
        nb, db = np.asarray(cells @ (m * num).T).T, np.asarray(cells @ (m * den).T).T
        for n_, d_ in zip(nb, db):
            ok = (d_[0::2] > 0) & (d_[1::2] > 0)
            if ok.sum() >= 10:
                boot.append(_corr(n_[0::2][ok] / d_[0::2][ok], n_[1::2][ok] / d_[1::2][ok]))
    return {**point, "r_ci": _z_ci(point["r"], boot)}


def opponent_adjustment(values: pl.DataFrame, halves_all: pl.DataFrame, eligible: np.ndarray, k_duels: float | None,
                        resamples: int, seed: int = 0) -> dict | None:
    """Experiment: ridge `win − p = θ_x − θ_y` over duels with alpha `k_duels`, fit per alternating-series half.

    The comparator is the same ridge without opponents, `sum / (duels + alpha)`, so the gain measures the opponent
    terms and not shrinkage (which alone raises r by pulling small samples to zero). Gain is θ's split-half r minus
    the comparator's on the same players, with a 90% interval from resampling series. `theta` is the full-data fit,
    per 100 duels.
    """
    if k_duels is None or not math.isfinite(k_duels):
        return None
    rows = values.filter(pl.col("win") == 1).select(pl.col("key").str.split("/").list.first().alias("series"),
                                                    "steamid", "opponent", "exec")
    lookup = halves_all.select("steamid", "series", "half").unique()
    rows = (rows.join(lookup, on=["steamid", "series"])
            .join(lookup.rename({"steamid": "opponent", "half": "half_o"}), on=["opponent", "series"]))
    ids = np.unique(np.r_[rows["steamid"].to_numpy(), rows["opponent"].to_numpy()])
    ia, ib = np.searchsorted(ids, rows["steamid"].to_numpy()), np.searchsorted(ids, rows["opponent"].to_numpy())
    X = tf._pair_matrix(2 * ia + rows["half"].to_numpy(), 2 * ib + rows["half_o"].to_numpy(), 2 * len(ids))
    y = rows["exec"].to_numpy()
    keep = np.isin(ids, eligible)
    eye = k_duels * identity(2 * len(ids), format="csr")
    absX = abs(X)

    def fit(w: np.ndarray) -> tuple[float | None, float | None, float | None, int]:
        G = (X.T @ X.multiply(w[:, None]).tocsr() + eye).toarray()
        b = X.T @ (w * y)
        theta = solve(G, b, assume_a="pos")
        den = absX.T @ w
        ok = keep & (den[0::2] > 0) & (den[1::2] > 0)
        raw = _corr(b[0::2][ok] / den[0::2][ok], b[1::2][ok] / den[1::2][ok])
        shrunk = _corr(b[0::2][ok] / (den[0::2][ok] + k_duels), b[1::2][ok] / (den[1::2][ok] + k_duels))
        return raw, shrunk, _corr(theta[0::2][ok], theta[1::2][ok]), int(ok.sum())

    raw, shrunk, adj, n = fit(np.ones(len(y)))
    _, s = np.unique(rows["series"].to_numpy(), return_inverse=True)
    gains = []
    for m in _mults(int(s.max()) + 1, resamples, seed):
        _, sb, ab, _ = fit(m[s])
        if sb is not None and ab is not None:
            gains.append(ab - sb)
    gain = adj - shrunk if shrunk is not None and adj is not None else None
    ci = (None, None)
    if gain is not None and len(gains) >= 10:
        g = np.array(gains) - np.mean(gains) + gain
        ci = (float(np.quantile(g, 0.05)), float(np.quantile(g, 0.95)))

    Xf = tf._pair_matrix(ia, ib, len(ids))
    theta = solve((Xf.T @ Xf + k_duels * identity(len(ids), format="csr")).toarray(), Xf.T @ y, assume_a="pos")
    return {"alpha": k_duels, "players": n, "r_raw": raw, "r_shrunk": shrunk, "r_adj": adj, "gain": gain, "gain_ci": ci,
            "resamples": resamples, "kept": _passes(ci),
            "theta": pl.DataFrame({"steamid": pl.Series(ids, dtype=pl.UInt64), "exec_adj_per100": 100.0 * theta})}


def player_table(pm: pl.DataFrame, k_duels: float | None, adjusted: pl.DataFrame | None) -> pl.DataFrame:
    """Per player: execution per 100 duels and rounds, and split-half reliability `n / (n + k)` in duels."""
    k = k_duels if k_duels is not None and math.isfinite(k_duels) else math.inf
    latest = pm.sort("date", "key").group_by("steamid").agg(pl.col("lp_player", "lp_team").last())
    out = (pm.group_by("steamid").agg(pl.col("duels", "rounds", "wins", "expected", "exec").sum(), pl.len().alias("maps"))
           .join(latest, on="steamid", how="left")
           .with_columns((100 * pl.col("exec") / pl.col("duels")).alias("exec_per100"),
                         (100 * pl.col("exec") / pl.col("rounds")).alias("exec_per100_rounds"),
                         (pl.col("duels") / (pl.col("duels") + k)).alias("reliability"))
           .with_columns((pl.col("reliability") * pl.col("exec_per100")).alias("exec_shrunk_per100")))
    if adjusted is not None:
        out = out.join(adjusted, on="steamid", how="left")
    return out.sort("duels", descending=True)


def team_maps(values: pl.DataFrame, role_rounds: pl.DataFrame, residuals: pl.DataFrame) -> pl.DataFrame:
    """One row per map in the `team_a` / `team_b` shape `teamfactor` fits, with stints, rounds and Elo from
    `team-map-residuals.parquet`. Each stat is team_a's sum over its players' duel views (team_b's is the negative);
    `duels` and `duels_open` are the weights."""
    teams = role_rounds.select("key", "steamid", "lp_team").unique(["key", "steamid"])
    per = values.join(teams, on=["key", "steamid"]).group_by("key", "lp_team").agg(
        pl.len().cast(pl.Float64).alias("duels"), pl.col("opening").sum().cast(pl.Float64).alias("duels_open"),
        *(pl.col(s).sum() for s in STATS), *(pl.col(s).filter(pl.col("opening")).sum().alias(f"{s}_open") for s in STATS))

    def side(s: str) -> list[pl.Expr]:
        return [pl.col("lp_team").alias(f"team_{s}"), pl.col("stint_id").alias(f"stint_{s}"),
                pl.col("stint_label").alias(f"stint_label_{s}"), pl.col("igl_player").alias(f"igl_name_{s}"),
                pl.col("elo").alias(f"elo_{s}")]

    a = residuals.filter(pl.col("lp_team") < pl.col("opponent")).select(
        "key", "series", "event", "date", "rounds", pl.col("won").alias("y"), *side("a"),
        pl.col("opponent").alias("team_b"))
    b = residuals.select("key", *side("b"))
    cols = ["duels", "duels_open", *STATS, *OPEN]
    pa = per.rename({"lp_team": "team_a", **{c: f"{c}__a" for c in cols}})
    pb = per.rename({"lp_team": "team_b", **{c: f"{c}__b" for c in cols}})
    maps = a.join(b, on=["key", "team_b"]).join(pa, on=["key", "team_a"]).join(pb, on=["key", "team_b"])
    return (maps.with_columns(*(((pl.col(f"{c}__a") + pl.col(f"{c}__b")) / 2).alias(c) for c in ("duels", "duels_open")),
                              *(((pl.col(f"{c}__a") - pl.col(f"{c}__b")) / 2).alias(c) for c in (*STATS, *OPEN)),
                              ((pl.col("elo_a") - pl.col("elo_b")) * math.log(10) / 400).alias("elo_logit"))
            .drop(*(f"{c}__{s}" for c in cols for s in "ab"))
            .filter((pl.col("duels") > 0) & (pl.col("duels_open") > 0))
            .sort("date", "key"))


def long_team_maps(maps: pl.DataFrame) -> pl.DataFrame:
    """Two rows per map, one per team, each with its own stat sums."""
    keep = ["key", "series", "event", "date", "rounds", "duels", "duels_open"]
    stats = [*STATS, *OPEN]
    return pl.concat([
        maps.select(*keep, pl.col("team_a").alias("lp_team"), pl.col("team_b").alias("opponent"),
                    pl.col("stint_a").alias("stint_id"), *stats),
        maps.select(*keep, pl.col("team_b").alias("lp_team"), pl.col("team_a").alias("opponent"),
                    pl.col("stint_b").alias("stint_id"), *(-pl.col(c) for c in stats)),
    ]).sort("date", "key", "lp_team")


def _half_design(maps: pl.DataFrame, unit: str, weight_col: str, min_w: float):
    """The alternating-series half design `teamfactor.split_half_team_factor` builds, for two targets at once."""
    col_a, col_b = tf._unit_cols(unit)
    long = pl.concat([maps.select("key", "series", "date", pl.col(c).alias("unit"), pl.col(weight_col).alias("w"))
                      for c in (col_a, col_b)])
    totals = long.group_by("unit").agg(pl.col("w").sum())
    units = sorted(totals["unit"].to_list())
    uidx = {u: i for i, u in enumerate(units)}
    elig = np.array(sorted(uidx[u] for u in totals.filter(pl.col("w") >= min_w)["unit"].to_list()), dtype=np.int64)
    half = {(r["key"], r["unit"]): r["half"] for r in
            warcheck._alternating(long, ["unit"]).select("key", "unit", "half").iter_rows(named=True)}
    keys = maps["key"].to_list()
    ha = np.array([2 * uidx[u] + half[(k, u)] for k, u in zip(keys, maps[col_a].to_list())], dtype=np.int64)
    hb = np.array([2 * uidx[u] + half[(k, u)] for k, u in zip(keys, maps[col_b].to_list())], dtype=np.int64)
    return tf._pair_matrix(ha, hb, 2 * len(units)), maps[weight_col].to_numpy().astype(np.float64), elig


def independence(maps: pl.DataFrame, unit: str, q_col: str, e_col: str, min_w: float, resamples: int,
                 seed: int = 0) -> dict:
    """Is quality more than execution? Per unit and alternating-series half, ridge estimates of both (alpha 1, as in
    the split-half). `cross`: quality in one half against execution in the other, which shares no maps.
    `resid`: quality's split-half r after regressing out same-half execution. `same`: same-half r of the two."""
    empty = {"units": 0, **{f"{m}{s}": v for m in ("cross", "resid", "same") for s, v in (("", None), ("_ci", (None, None)))}}
    weight_col = weight_of(q_col)
    X, w, elig = _half_design(maps, unit, weight_col, min_w)
    if len(elig) < tf.MIN_HALF_TEAMS:
        return empty
    yq, ye = maps[q_col].to_numpy() / w, maps[e_col].to_numpy() / w
    _, s_ids = np.unique(maps["series"].to_numpy(), return_inverse=True)
    Gs, bq, rds = tf._group_grams(X, yq, w, s_ids)
    S = csr_matrix((np.ones(len(s_ids)), (s_ids, np.arange(len(s_ids)))), shape=(int(s_ids.max()) + 1, len(s_ids)))
    be = np.asarray((S @ X.multiply((w * ye)[:, None]).tocsr()).todense())
    eye = np.eye(X.shape[1])

    def stats(G, bq_, be_, rds_):
        cq, ce = np.linalg.solve(G + eye, np.c_[bq_, be_]).T
        ok = (rds_[2 * elig] > 0) & (rds_[2 * elig + 1] > 0)
        if ok.sum() < 5:
            return None
        i0, i1 = 2 * elig[ok], 2 * elig[ok] + 1
        q0, q1, e0, e1 = cq[i0], cq[i1], ce[i0], ce[i1]
        c1, c2, s1, s2 = _corr(q0, e1), _corr(q1, e0), _corr(q0, e0), _corr(q1, e1)
        cross = None if c1 is None or c2 is None else (c1 + c2) / 2
        same = None if s1 is None or s2 is None else (s1 + s2) / 2
        res = lambda q, e: q - np.polyval(np.polyfit(e, q, 1), e) if np.std(e) > 1e-12 else q - q.mean()
        return {"cross": cross, "same": same, "resid": _corr(res(q0, e0), res(q1, e1)), "units": int(ok.sum())}

    obs = stats(Gs.sum(axis=0), bq.sum(axis=0), be.sum(axis=0), rds.sum(axis=0))
    if obs is None:
        return empty
    boots = [stats(np.tensordot(m, Gs, axes=(0, 0)), m @ bq, m @ be, m @ rds)
             for m in _mults(Gs.shape[0], resamples, seed)]
    boots = [b for b in boots if b is not None]
    return {**obs, **{f"{k}_ci": _z_ci(obs[k], [b[k] for b in boots]) for k in ("cross", "resid", "same")}}


def beyond_elo(maps: pl.DataFrame, forward: dict) -> dict | None:
    """Leave-one-event-out log loss of the map result from Elo alone and from Elo plus the walk-forward stat difference,
    with the gain's 90% interval from resampling events."""
    if forward.get("pred") is None or not np.any(forward["pred"]):
        return None
    rows = maps.with_columns(pl.Series("prior", forward["pred"])).filter(pl.Series(forward["evaluated"]))
    if rows["event"].n_unique() < 3:
        return None
    base = warcheck.cv_losses(rows, ["elo_logit"])
    both = warcheck.cv_losses(rows, ["elo_logit", "prior"])
    lo, hi = warcheck.paired_ci(base - both, rows["event"].to_numpy())
    return {"maps": rows.height, "events": int(rows["event"].n_unique()), "elo": float(base.mean()),
            "with": float(both.mean()), "gain": float((base - both).mean()), "gain_ci": (lo, hi)}


def _unit_weights(maps: pl.DataFrame, unit: str, weight_col: str) -> pl.DataFrame:
    col_a, col_b = tf._unit_cols(unit)
    return (pl.concat([maps.select(pl.col(c).alias("unit_id"), pl.col(weight_col).alias("weight")) for c in (col_a, col_b)])
            .group_by("unit_id").agg(pl.col("weight").sum()))


def _estimates(maps: pl.DataFrame, unit: str, stat: str, alpha: float | None, resamples: int) -> pl.DataFrame:
    """Ridge estimate per unit, per 100 duels and per 100 rounds, with series-bootstrap p5 / p95."""
    wcol = weight_of(stat)
    est = tf.fit_team_factor(maps, unit=unit, resid_col=stat, alpha=alpha, resamples=resamples, weight_col=wcol)
    per_round = pl.col("weight") / pl.col("rounds")
    return (est.join(_unit_weights(maps, unit, wcol), on="unit_id", how="left")
            .select(pl.lit(unit).alias("unit_type"), pl.lit(stat).alias("stat"), "unit_id", "label", "lp_team",
                    "igl_player", "maps", "rounds", "weight", "elo_mean",
                    pl.col("tau_per100").alias("per100"), pl.col("tau_per100_p5").alias("per100_p5"),
                    pl.col("tau_per100_p95").alias("per100_p95"),
                    (pl.col("tau_per100") * per_round).alias("per100_rounds"),
                    (pl.col("tau_per100_p5") * per_round).alias("per100_rounds_p5"),
                    (pl.col("tau_per100_p95") * per_round).alias("per100_rounds_p95")))


def team_results(maps: pl.DataFrame, min_rounds: int, resamples: int) -> tuple[dict, pl.DataFrame]:
    """Per unit and stat: split-half, ridge estimates, walk-forward, correlation with Elo and the Elo log-loss test."""
    results: dict = {}
    tables = []
    for unit in UNITS:
        results[unit] = {}
        for stat in (*STATS, *OPEN):
            wcol = weight_of(stat)
            min_w = min_rounds * maps[wcol].sum() / maps["rounds"].sum()
            sh = tf.split_half_team_factor(maps, unit=unit, resid_col=stat, min_rounds=min_w, resamples=resamples,
                                           weight_col=wcol)
            est = _estimates(maps, unit, stat, sh["k_rounds"], resamples)
            fw = tf.forward_team_factor(maps, unit=unit, resid_col=stat, k_rounds=sh["k_rounds"], resamples=resamples,
                                        weight_col=wcol)
            elig = est.filter((pl.col("rounds") >= min_rounds) & pl.col("elo_mean").is_not_null())
            results[unit][stat] = {"split": sh, "forward": fw, "min_w": min_w,
                                   "r_elo": _corr(elig["per100"].to_numpy(), elig["elo_mean"].to_numpy()),
                                   "elo": beyond_elo(maps, fw)}
            tables.append(est)
    return results, pl.concat(tables)


def part_shares(maps: pl.DataFrame, unit: str, variant: str, k: float | None, min_rounds: int) -> dict[str, float] | None:
    """Share of quality's between-unit variance from each part, cov(part, quality) / var(quality), all fit with
    quality's alpha so the parts' estimates sum to quality's and the shares sum to 1."""
    if k is None or not math.isfinite(k):
        return None
    sfx = "_open" if variant == "open" else ""
    est = {s: tf.fit_team_factor(maps, unit=unit, resid_col=f"{s}{sfx}", alpha=k, resamples=0, weight_col=weight_of(f"{s}{sfx}"))
           .filter(pl.col("rounds") >= min_rounds).sort("unit_id")["tau_per100"].to_numpy() for s in QUALITY}
    var = np.var(est["quality"])
    if var <= 0:
        return None
    return {p: float(np.cov(est[p], est["quality"], bias=True)[0, 1] / var) for p in PARTS}


def gates(player: dict, teams: dict, indep: dict) -> dict:
    stint = teams["stint"]
    stable = {v: _passes(stint[f"quality{sfx}"]["split"]["r_ci"]) for v, sfx in (("full", ""), ("open", "_open"))}
    independent = {v: _passes(indep["stint"][v]["resid_ci"]) for v in ("full", "open")}
    ok = {v: stable[v] and independent[v] for v in ("full", "open")}
    definition = "full" if ok["full"] else ("open" if ok["open"] else None)
    sfx = "_open" if definition == "open" else ""
    parts = [p for p in PARTS if _passes(stint[f"{p}{sfx}"]["split"]["r_ci"])] if definition else []
    published = ([] if not _passes(stint["exec"]["split"]["r_ci"]) else ["exec"])
    if definition:
        published += [f"quality{sfx}", *(f"{p}{sfx}" for p in parts)]
    return {"player_exec": _passes(player["exec_duel"]["r_ci"]), "stable": stable, "independent": independent,
            "definition": definition, "parts": parts, "published": published}


def _f(v, d=3, signed=False):
    return tf._fmt_f(v, d, signed)


def _ci(ci, d=3, signed=False):
    return tf._fmt_ci(ci, d, signed)


def _verdict(ok: bool) -> str:
    return "**PASS**" if ok else "**FAIL**"


PLAYER_METRICS = {"exec_duel": ("Execution per duel", "exec", "duels"), "exec_round": ("Execution per round", "exec", "rounds"),
                  "win_rate": ("Duel win rate", "wins", "duels"), "expected_rate": ("Expected win rate", "expected", "duels")}


def report_lines(d: pl.DataFrame, values: pl.DataFrame, maps: pl.DataFrame, player: dict, experiment: dict | None,
                 teams: dict, indep: dict, shares: dict, est: pl.DataFrame, g: dict, min_duels: int,
                 min_rounds: int) -> list[str]:
    lines = [
        "# Duel execution and quality", "",
        f"{d.height:,} duels on {d['key'].n_unique():,} maps; {maps.height:,} maps have both teams' stints and Elo. "
        "Execution is `win − p`; quality is `p − p_base`, centered per map × side, split into positioning "
        "(`p_pos − p_base`), flashes (`p_flash − p_pos`) and HP (`p − p_flash`). Opening variants use only each round's "
        "first duel. Every interval is 90%, resampling whole series unless marked.", "",
        "## Gates", "",
        f"- Player execution (per duel, split-half r lower CI > 0): {_verdict(g['player_exec'])}.",
        f"- Quality stability (stint split-half r lower CI > 0): full {_verdict(g['stable']['full'])}, "
        f"opening {_verdict(g['stable']['open'])}.",
        f"- Quality independence (stint residualised r lower CI > 0): full {_verdict(g['independent']['full'])}, "
        f"opening {_verdict(g['independent']['open'])}.",
        f"- Published quality definition: {({'full': 'all duels', 'open': 'opening duels'}).get(g['definition'], 'none')}. "
        f"Parts in the headline: {', '.join(g['parts']) or 'none'}. Published stats: {', '.join(g['published']) or 'none'}.",
        "",
        f"## Player execution ({player['exec_duel']['players']} players with {min_duels}+ duels, alternating series)", "",
        "`k` is in the rate's denominator: duels, or rounds for the per-round row.", "",
        "| Metric | Players | Half (median) | Split-half r | 90% CI | k |", "| --- | --- | --- | --- | --- | --- |",
    ]
    for key, (name, _, _) in PLAYER_METRICS.items():
        r = player[key]
        lines.append(f"| {name} | {r['players']} | {_f(r['half_rounds'], 0)} | {_f(r['r'])} | {_ci(r['r_ci'])} | "
                     f"{tf._fmt_k(r['k'])} |")
    lines += ["", "### Opponent adjustment (experiment)", ""]
    if experiment is None:
        lines.append("Not run: execution has no finite `k` to use as the ridge alpha.")
    else:
        lines.append(
            f"Ridge over duels, `win − p = θ_x − θ_y`, alpha = {experiment['alpha']:,.0f} duels (the raw per-duel `k`). "
            f"On {experiment['players']} players, split-half r: raw rate {_f(experiment['r_raw'])}, the same ridge without "
            f"opponents {_f(experiment['r_shrunk'])}, with opponents {_f(experiment['r_adj'])}. Gain over the ridge "
            f"without opponents {_f(experiment['gain'], 3, True)}, 90% CI {_ci(experiment['gain_ci'], 3, True)} "
            f"({experiment['resamples']} series resamples): **{'keep' if experiment['kept'] else 'reject'}**.")

    for unit, name in UNITS.items():
        lines += ["", f"## Team stats by {name} ({min_rounds}+ rounds)", "",
                  "`k` is in the stat's weight (duels, or opening duels); maps is `k` over the mean weight per map. "
                  "Forward gain is the walk-forward weighted MSE gain as a % of the MSE of predicting zero. The Elo "
                  "test is leave-one-event-out log loss of the map result, Elo against Elo plus the walk-forward stat "
                  "difference, with events resampled; n/a when `k` is infinite.", "",
                  "| Stat | Units | Split-half r | 90% CI | k | k (maps) | Forward gain % | 90% CI | r with Elo | "
                  "Elo + stat gain | 90% CI | Label |", "|" + " --- |" * 12]
        for stat in (*STATS, *OPEN):
            t = teams[unit][stat]
            sh, fw, el = t["split"], t["forward"], t["elo"]
            pct = lambda v: None if v is None or not fw["mse_zero"] else 100 * v / fw["mse_zero"]
            predictive = el is not None and _passes(el["gain_ci"])
            lines.append(
                f"| {label(stat)} | {sh['units']} | {_f(sh['r'])} | {_ci(sh['r_ci'])} | {tf._fmt_k(sh['k_rounds'])} | "
                f"{tf._fmt_k(sh['k_maps'])} | {_f(pct(fw['gain']), 2, True)} | "
                f"{_ci(tuple(pct(c) for c in fw['gain_ci']), 2, True)} | {_f(t['r_elo'], 2)} | "
                f"{_f(el and el['gain'], 4, True)} | {_ci(el['gain_ci'] if el else (None, None), 4, True)} | "
                f"{'predictive' if predictive else 'descriptive'} |")

    lines += ["", "## Independence of quality from execution", "",
              "Half estimates use alpha 1, as the split-half does. Same-half r is how much the two move together on the "
              "same maps; cross-half r pairs quality in one half with execution in the other, so they share no maps. "
              "Residualised r is quality's split-half r after regressing out same-half execution.", "",
              "| Unit | Duels | Units | Same-half r | 90% CI | Cross-half r | 90% CI | Residualised r | 90% CI |",
              "|" + " --- |" * 9]
    for unit, name in UNITS.items():
        for v, vname in (("full", "All"), ("open", "Opening")):
            r = indep[unit][v]
            lines.append(f"| {name} | {vname} | {r['units']} | {_f(r['same'])} | {_ci(r['same_ci'])} | {_f(r['cross'])} | "
                         f"{_ci(r['cross_ci'])} | {_f(r['resid'])} | {_ci(r['resid_ci'])} |")

    lines += ["", "## Part shares of quality variance (stints)", "",
              "cov(part, quality) / var(quality) across stint estimates, all fit with quality's alpha so the shares sum "
              "to 1.", "", "| Duels | " + " | ".join(LABELS[p] for p in PARTS) + " |", "|" + " --- |" * 4]
    for v, vname in (("full", "All"), ("open", "Opening")):
        s = shares.get(v)
        lines.append(f"| {vname} | " + " | ".join(_f(s and s[p], 2) for p in PARTS) + " |")

    by_map = (values.group_by("map", "side").agg(pl.len().alias("n"), pl.col("quality_raw").mean())
              .pivot(on="side", index="map", values="quality_raw").sort("map"))
    lines += ["", "## Quality by map and side, before centering (mean per duel view)", "",
              "| Map | CT | T |", "| --- | --- | --- |"]
    for r in by_map.iter_rows(named=True):
        lines.append(f"| {r['map']} | {_f(r.get(str(CT)), 4, True)} | {_f(r.get(str(T)), 4, True)} |")

    stint = est.filter((pl.col("unit_type") == "stint") & (pl.col("rounds") >= min_rounds))
    for stat in (*STATS, "exec_open", "quality_open"):
        q = stint.filter(pl.col("stat") == stat).sort("per100", descending=True)
        if q.is_empty():
            continue
        lines += ["", f"### {label(stat)}: top and bottom {TOP} stints", "",
                  "| Stint | Maps | Duels | Per 100 duels (90% CI) | Per 100 rounds |", "| --- | --- | --- | --- | --- |"]
        for r in pl.concat([q.head(TOP), q.tail(TOP)]).unique("unit_id", maintain_order=True).iter_rows(named=True):
            lines.append(f"| {r['label']} | {r['maps']} | {r['weight']:,.0f} | {_f(r['per100'], 2, True)} "
                         f"({_f(r['per100_p5'], 2, True)}, {_f(r['per100_p95'], 2, True)}) | {_f(r['per100_rounds'], 2, True)} |")
    return lines


def export_public(est: pl.DataFrame, teams: dict, g: dict, min_rounds: int, out_dir: Path = PUBLIC_WAR) -> int:
    """`team-duels.json`: stint estimates for the stats that passed split-half, each marked descriptive unless it
    adds to Elo. Quality is the sum of the passing parts when a part was dropped."""
    if not g["published"]:
        print("No duel stat passed its gate; skipping team-duels.json.")
        return 1
    stint = est.filter((pl.col("unit_type") == "stint") & (pl.col("rounds") >= min_rounds))
    stats = set(stint["stat"].unique().to_list())
    meta, records = {}, {}
    for stat in g["published"]:
        t = teams["stint"][stat]
        el = t["elo"]
        meta[stat] = {"label": label(stat), "weight": weight_of(stat), "split_half_r": t["split"]["r"],
                      "split_half_r_ci": list(t["split"]["r_ci"]), "k": t["split"]["k_rounds"],
                      "descriptive": not (el is not None and _passes(el["gain_ci"]))}
        headline = stat.replace("quality", "quality_headline")
        source = headline if stat.startswith("quality") and headline in stats else stat
        for r in stint.filter(pl.col("stat") == source).iter_rows(named=True):
            rec = records.setdefault(r["unit_id"], {
                "stint_id": r["unit_id"], "label": r["label"], "lp_team": r["lp_team"],
                "liquipedia_url": f"https://liquipedia.net/counterstrike/{r['lp_team'].replace(' ', '_')}",
                "igl_player": r["igl_player"], "maps": int(r["maps"]), "rounds": int(r["rounds"])})
            rec[f"{weight_of(stat)}"] = round(float(r["weight"]))
            rec[stat.removesuffix("_open")] = {k: round(float(r[c]), 3) for k, c in (
                ("per100", "per100"), ("p5", "per100_p5"), ("p95", "per100_p95"), ("per100_rounds", "per100_rounds"),
                ("per100_rounds_p5", "per100_rounds_p5"), ("per100_rounds_p95", "per100_rounds_p95"))}
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "min_rounds": min_rounds,
        "quality_definition": {"full": "all duels", "open": "opening duels"}.get(g["definition"]),
        "quality_parts": [p for p in g["parts"]],
        "stats": {s.removesuffix("_open"): m for s, m in meta.items()},
        "source": SOURCE,
        "teams": sorted(records.values(), key=lambda r: -r["rounds"]),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "team-duels.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {len(records)} stints to {out_dir / 'team-duels.json'}")
    return 0


def build(min_duels: int = MIN_PLAYER_DUELS, min_rounds: int = MIN_TEAM_ROUNDS, resamples: int = tf.DEFAULT_RESAMPLES,
          publish: bool = False) -> int:
    for path, cmd in ((DUELS, "cs2wp duels"), (ROLE_ROUNDS, "cs2wp baselines"), (TEAM_MAP_RESIDUALS, "cs2wp team-factor")):
        if not path.exists():
            raise FileNotFoundError(f"{path} not found; run `{cmd}` first")
    d = pl.read_parquet(DUELS)
    rr = pl.read_parquet(ROLE_ROUNDS).select("key", "steamid", "side", "rounds", "date", "event", "lp_team", "lp_player")
    values = duel_values(d)

    pm = player_maps(values, rr)
    halves_all = warcheck._alternating(pm.filter(pl.col("duels") > 0), ["steamid"])
    eligible = pm.group_by("steamid").agg(pl.col("duels").sum()).filter(pl.col("duels") >= min_duels)["steamid"]
    halves = halves_all.filter(pl.col("steamid").is_in(eligible.implode()))
    player = {k: player_split_half(halves, col, w, resamples) for k, (_, col, w) in PLAYER_METRICS.items()}
    experiment = opponent_adjustment(values, halves_all, eligible.to_numpy(), player["exec_duel"]["k"],
                                     min(resamples, EXPERIMENT_RESAMPLES))

    maps = team_maps(values, rr, pl.read_parquet(TEAM_MAP_RESIDUALS))
    teams, est = team_results(maps, min_rounds, resamples)
    indep = {unit: {v: independence(maps, unit, f"quality{sfx}", f"exec{sfx}", teams[unit][f"quality{sfx}"]["min_w"],
                                    resamples)
                    for v, sfx in (("full", ""), ("open", "_open"))} for unit in UNITS}
    shares = {v: part_shares(maps, "stint", v, teams["stint"][f"quality{sfx}"]["split"]["k_rounds"], min_rounds)
              for v, sfx in (("full", ""), ("open", "_open"))}
    g = gates(player, teams, indep)

    if g["definition"] and g["parts"] and len(g["parts"]) < len(PARTS):
        sfx = "_open" if g["definition"] == "open" else ""
        col = f"quality_headline{sfx}"
        maps = maps.with_columns(pl.sum_horizontal(*(f"{p}{sfx}" for p in g["parts"])).alias(col))
        est = pl.concat([est, _estimates(maps, "stint", col, teams["stint"][f"quality{sfx}"]["split"]["k_rounds"],
                                         resamples)])

    adjusted = experiment["theta"] if experiment else None
    players = player_table(pm, player["exec_duel"]["k"], adjusted)
    DUEL_TEAMS.parent.mkdir(parents=True, exist_ok=True)
    long_team_maps(maps).write_parquet(DUEL_TEAM_MAPS)
    est.write_parquet(DUEL_TEAMS)
    players.write_parquet(DUEL_PLAYERS)

    lines = report_lines(d, values, maps, player, experiment, teams, indep, shares, est, g, min_duels, min_rounds)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "duel-stats.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {DUEL_TEAM_MAPS}, {DUEL_TEAMS}, {DUEL_PLAYERS}")
    return export_public(est, teams, g, min_rounds) if publish else 0
