"""Scores, calibration curves and per-bucket calibration for round win probability."""

import numpy as np
import polars as pl
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

# A calibration bin needs this many states before its gap counts against the gate.
MIN_BIN_STATES = 1000
# The paper's bins.
BINS = 100


def scores(y: np.ndarray, p: np.ndarray) -> dict[str, float]:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return {
        "n": int(len(y)),
        "log_loss": float(log_loss(y, p, labels=[0, 1])),
        "brier": float(brier_score_loss(y, p)),
        "auc": float(roc_auc_score(y, p)) if len(np.unique(y)) == 2 else float("nan"),
    }


def round_bootstrap(df: pl.DataFrame, p: np.ndarray, n: int = 200, seed: int = 0) -> dict[str, list[float]]:
    """95% intervals for log loss and Brier, resampling whole rounds because states within a round are correlated."""
    y = df["ct_win"].cast(pl.Float64).to_numpy()
    pc = np.clip(p, 1e-6, 1 - 1e-6)
    per = pl.DataFrame({
        "r": (df["key"] + "#" + df["round_num"].cast(pl.Utf8)),
        "ll": -(y * np.log(pc) + (1 - y) * np.log(1 - pc)),
        "br": (pc - y) ** 2,
    }).group_by("r").agg(pl.col("ll").sum(), pl.col("br").sum(), pl.len().alias("n"))
    ll, br, cnt = per["ll"].to_numpy(), per["br"].to_numpy(), per["n"].to_numpy().astype(float)
    rng = np.random.default_rng(seed)
    w = rng.multinomial(len(cnt), np.full(len(cnt), 1 / len(cnt)), size=n).astype(float)
    lls, brs = (w @ ll) / (w @ cnt), (w @ br) / (w @ cnt)
    return {"log_loss": [float(np.quantile(lls, 0.025)), float(np.quantile(lls, 0.975))],
            "brier": [float(np.quantile(brs, 0.025)), float(np.quantile(brs, 0.975))]}


def calibration(y: np.ndarray, p: np.ndarray, bins: int = BINS) -> dict:
    """Equal-width bins: predicted vs observed, the largest gap over bins with enough states, and the logistic slope."""
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    curve = []
    for b in range(bins):
        m = idx == b
        if m.any():
            curve.append({"bin": b, "n": int(m.sum()), "pred": float(p[m].mean()), "obs": float(y[m].mean())})
    big = [c for c in curve if c["n"] >= MIN_BIN_STATES]
    pc = np.clip(p, 1e-6, 1 - 1e-6)
    logit = np.log(pc / (1 - pc)).reshape(-1, 1)
    fit = LogisticRegression(C=1e6).fit(logit, y) if len(np.unique(y)) == 2 else None
    return {
        "curve": curve,
        "max_gap": max((abs(c["pred"] - c["obs"]) for c in big), default=float("nan")),
        "ece": float(sum(c["n"] * abs(c["pred"] - c["obs"]) for c in curve) / max(len(y), 1)),
        "slope": float(fit.coef_[0][0]) if fit is not None else float("nan"),
        "intercept": float(fit.intercept_[0]) if fit is not None else float("nan"),
    }


def by_bucket(df: pl.DataFrame, p: np.ndarray, min_rounds: int = 50, max_gap: float = 0.05) -> pl.DataFrame:
    """Calibration per (CT alive, T alive, bomb planted), the man-count states where swings are largest."""
    d = df.select("key", "round_num", "ct_alive", "t_alive", "bomb_planted", "ct_win").with_columns(pl.Series("p", p))
    out = (
        d.group_by("ct_alive", "t_alive", "bomb_planted")
        .agg(
            pl.len().alias("states"),
            pl.struct("key", "round_num").n_unique().alias("rounds"),
            pl.col("p").mean().alias("pred"),
            pl.col("ct_win").cast(pl.Float64).mean().alias("obs"),
        )
        .with_columns((pl.col("pred") - pl.col("obs")).abs().alias("gap"))
        .with_columns(((pl.col("rounds") < min_rounds) | (pl.col("gap") > max_gap)).alias("flagged"))
        .sort("ct_alive", "t_alive", "bomb_planted")
    )
    return out


def by_map(df: pl.DataFrame, p: np.ndarray) -> list[dict]:
    d = df.select("map", "ct_win").with_columns(pl.Series("p", p))
    out = []
    for (m,), g in d.group_by("map"):
        out.append({"map": m, **scores(g["ct_win"].cast(pl.Int8).to_numpy(), g["p"].to_numpy())})
    return sorted(out, key=lambda r: r["map"])
