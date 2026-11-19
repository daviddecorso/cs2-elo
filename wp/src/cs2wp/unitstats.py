"""Reliability tests for one-sided per-unit means (a team's own rounds, a player's own clutches), where the zero-sum
pair designs in `duelstats` and `teamfactor` don't apply. Every interval resamples whole series."""

import numpy as np
import polars as pl

from . import duelstats as ds
from .warcheck import _alternating


def _index(rows: pl.DataFrame, unit: str, period: str):
    units, u = np.unique(rows[unit].cast(pl.String).to_numpy(), return_inverse=True)
    labels, p = np.unique(rows[period].cast(pl.String).to_numpy(), return_inverse=True)
    _, s = np.unique(rows["series"].to_numpy(), return_inverse=True)
    return units, labels, u, p, s


def _cell_means(idx: np.ndarray, vals: np.ndarray, w: np.ndarray, size: int) -> tuple[np.ndarray, np.ndarray]:
    sums = np.bincount(idx, weights=w * vals, minlength=size)
    cnt = np.bincount(idx, weights=w, minlength=size)
    with np.errstate(invalid="ignore", divide="ignore"):
        return sums / cnt, cnt


def _pooled_corr(means: np.ndarray, ok: np.ndarray) -> float | None:
    """Correlation of each unit's mean in period i with period i + 1, pooled over consecutive pairs; each pair is
    centred on its own means so a league-wide shift between periods doesn't count as persistence."""
    a, b = [], []
    for i in range(means.shape[1] - 1):
        m = ok[:, i] & np.isfinite(means[:, i]) & np.isfinite(means[:, i + 1])
        if m.sum() < 2:
            continue
        a.append(means[m, i] - means[m, i].mean())
        b.append(means[m, i + 1] - means[m, i + 1].mean())
    if not a:
        return None
    return ds._corr(np.concatenate(a), np.concatenate(b))


def persistence(rows: pl.DataFrame, unit: str, value: str, period: str, min_n: float, resamples: int,
                seed: int = 0) -> dict:
    """Does a unit's mean `value` in one `period` carry to the next? Units qualify for a pair with `min_n` rows in
    both periods; 90% interval resampling series, centred in Fisher z."""
    rows = rows.filter(pl.col(value).is_not_null())
    if rows.is_empty():
        return {"r": None, "r_ci": (None, None), "pairs": 0, "periods": []}
    units, labels, u, p, s = _index(rows, unit, period)
    n_u, n_p = len(units), len(labels)
    idx = u * n_p + p
    vals = rows[value].to_numpy().astype(np.float64)
    means, cnt = _cell_means(idx, vals, np.ones(len(vals)), n_u * n_p)
    means, cnt = means.reshape(n_u, n_p), cnt.reshape(n_u, n_p)
    ok = np.zeros((n_u, max(n_p - 1, 0)), dtype=bool)
    for i in range(n_p - 1):
        ok[:, i] = (cnt[:, i] >= min_n) & (cnt[:, i + 1] >= min_n)
    obs = _pooled_corr(means, ok) if n_p >= 2 else None
    boots = []
    if obs is not None:
        for m in ds._mults(int(s.max()) + 1, resamples, seed):
            bm, _ = _cell_means(idx, vals, m[s], n_u * n_p)
            boots.append(_pooled_corr(bm.reshape(n_u, n_p), ok))
    return {"r": obs, "r_ci": ds._z_ci(obs, boots), "pairs": int(ok.sum()), "periods": labels.tolist()}


def split_half(rows: pl.DataFrame, unit: str, value: str, min_n: float, resamples: int, seed: int = 0) -> dict:
    """Persistence between alternating series of each unit (needs `date` and `series`)."""
    halves = _alternating(rows.filter(pl.col(value).is_not_null()), [unit])
    return persistence(halves.with_columns(pl.col("half").cast(pl.String)), unit, value, "half", min_n, resamples, seed)


def estimates(rows: pl.DataFrame, unit: str, value: str, resamples: int, seed: int = 0) -> pl.DataFrame:
    """Per unit: rows, mean `value` and its 90% interval resampling series."""
    rows = rows.filter(pl.col(value).is_not_null())
    units, _, u, _, s = _index(rows.with_columns(pl.lit("all").alias("_p")), unit, "_p")
    vals = rows[value].to_numpy().astype(np.float64)
    mean, cnt = _cell_means(u, vals, np.ones(len(vals)), len(units))
    boot = np.stack([_cell_means(u, vals, m[s], len(units))[0] for m in ds._mults(int(s.max()) + 1, resamples, seed)])
    with np.errstate(invalid="ignore"):
        lo, hi = np.nanquantile(boot, [0.05, 0.95], axis=0)
    return pl.DataFrame({unit: units.astype(str), "n": cnt.astype(np.int64), "mean": mean, "p5": lo, "p95": hi})
