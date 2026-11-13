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
    w = _round_weights(len(cnt), n, seed)
    lls, brs = (w @ ll) / (w @ cnt), (w @ br) / (w @ cnt)
    return {"log_loss": _ci(lls), "brier": _ci(brs)}


def _round_weights(rounds: int, n: int, seed: int) -> np.ndarray:
    """n resamples of `rounds` rounds with replacement, as a count per round."""
    rng = np.random.default_rng(seed)
    return rng.multinomial(rounds, np.full(rounds, 1 / rounds), size=n).astype(float)


def _ci(x: np.ndarray) -> list[float]:
    return [float(np.quantile(x, 0.025)), float(np.quantile(x, 0.975))]


def _round_ll(y: np.ndarray, p: np.ndarray) -> np.ndarray:
    pc = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(pc) + (1 - y) * np.log(1 - pc))


class _Cells:
    """State sums per (round, group), so a group's mean prediction and outcome can be reweighted by resampled rounds."""

    def __init__(self, rid: np.ndarray, group: np.ndarray, groups: int, y: np.ndarray, **preds: np.ndarray):
        keep = group >= 0
        f = (pl.DataFrame({"r": rid[keep], "g": group[keep], "y": y[keep], **{k: v[keep] for k, v in preds.items()}})
             .group_by("r", "g").agg(pl.len().alias("n"), pl.all().sum()))
        self.r, self.g, self.groups = f["r"].to_numpy(), f["g"].to_numpy(), groups
        self.sums = {c: f[c].to_numpy().astype(float) for c in ["n", "y", *preds]}
        self.rounds = np.bincount(self.g, minlength=groups)

    def gaps(self, w: np.ndarray, pred: str) -> tuple[np.ndarray, np.ndarray]:
        """Signed gap (mean pred − mean outcome) per group and the weighted state count."""
        wr = w[self.r]
        tot = np.bincount(self.g, wr * self.sums["n"], self.groups)
        diff = np.bincount(self.g, wr * (self.sums[pred] - self.sums["y"]), self.groups)
        return diff / np.maximum(tot, 1e-9), tot


def paired_bootstrap(rid: np.ndarray, y: np.ndarray, pa: np.ndarray, pb: np.ndarray, groups: dict[str, np.ndarray],
                     n: int = 200, seed: int = 0, bins: int = BINS) -> dict:
    """b against a on the same states, one round resample shared by both: log loss, max bin gap, and |gap| per group.

    `rid` is a dense round index (0..rounds−1) per state. Each entry of `groups` labels states 0..k−1, or −1 for states
    outside every group. Deltas are b − a, so negative means b is better.
    """
    y = y.astype(float)
    rounds = int(rid.max()) + 1
    w = _round_weights(rounds, n, seed)
    ones = np.ones(rounds)

    cnt = np.bincount(rid, minlength=rounds).astype(float)
    lla, llb = np.bincount(rid, _round_ll(y, pa), rounds), np.bincount(rid, _round_ll(y, pb), rounds)
    d_ll = (w @ (llb - lla)) / (w @ cnt)
    out = {"log_loss": {"a": float(lla.sum() / cnt.sum()), "b": float(llb.sum() / cnt.sum()),
                        "delta": float((llb - lla).sum() / cnt.sum()), "ci": _ci(d_ll)}}

    bin_a = _Cells(rid, _bin_index(pa, bins), bins, y, p=pa)
    bin_b = _Cells(rid, _bin_index(pb, bins), bins, y, p=pb)
    elig_a = bin_a.gaps(ones, "p")[1] >= MIN_BIN_STATES
    elig_b = bin_b.gaps(ones, "p")[1] >= MIN_BIN_STATES

    def max_gap(cells: _Cells, elig: np.ndarray, wi: np.ndarray) -> float:
        return float(np.abs(cells.gaps(wi, "p")[0])[elig].max()) if elig.any() else float("nan")

    ga, gb = max_gap(bin_a, elig_a, ones), max_gap(bin_b, elig_b, ones)
    d_gap = np.array([max_gap(bin_b, elig_b, wi) - max_gap(bin_a, elig_a, wi) for wi in w])
    out["max_bin_gap"] = {"a": ga, "b": gb, "delta": gb - ga, "ci": _ci(d_gap)}

    out["groups"] = {}
    for name, label in groups.items():
        k = int(label.max()) + 1 if label.size and label.max() >= 0 else 0
        if k == 0:
            out["groups"][name] = []
            continue
        cells = _Cells(rid, label, k, y, pa=pa, pb=pb)
        a0, b0 = cells.gaps(ones, "pa")[0], cells.gaps(ones, "pb")[0]
        boot = np.array([np.abs(cells.gaps(wi, "pb")[0]) - np.abs(cells.gaps(wi, "pa")[0]) for wi in w])
        lo, hi = np.quantile(boot, 0.025, axis=0), np.quantile(boot, 0.975, axis=0)
        out["groups"][name] = [
            {"group": g, "rounds": int(cells.rounds[g]), "a": float(a0[g]), "b": float(b0[g]),
             "delta": float(abs(b0[g]) - abs(a0[g])), "ci": [float(lo[g]), float(hi[g])]}
            for g in range(k) if cells.rounds[g]]
    return out


def _bin_index(p: np.ndarray, bins: int) -> np.ndarray:
    return np.clip(np.digitize(p, np.linspace(0, 1, bins + 1)) - 1, 0, bins - 1)


def bin_gap_noise(df: pl.DataFrame, p: np.ndarray, n: int = 200, seed: int = 0, bins: int = BINS) -> float:
    """p95 of the max bin gap a perfectly calibrated model would show on this test set.

    States in a round share one outcome, so a bin's gap has round-level sampling noise far above what its state count
    suggests. Resampling whole rounds and centring each bin's gap on the observed one gives that noise's distribution.
    """
    idx = _bin_index(p, bins)
    g = (
        pl.DataFrame({
            "r": df.select(pl.struct("key", "round_num").rank("dense")).to_series().to_numpy() - 1,
            "b": idx, "p": p, "y": df["ct_win"].cast(pl.Float64).to_numpy(),
        })
        .group_by("r", "b").agg(pl.len().alias("n"), pl.col("p").sum(), pl.col("y").sum())
    )
    r, b = g["r"].to_numpy(), g["b"].to_numpy()
    cnt, ps, ys = (g[c].to_numpy().astype(float) for c in ("n", "p", "y"))

    def gaps(w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        wr = w[r]
        tot = np.bincount(b, wr * cnt, bins)
        return (np.bincount(b, wr * ps, bins) - np.bincount(b, wr * ys, bins)) / np.maximum(tot, 1e-9), tot

    rounds = int(r.max()) + 1
    g0, n0 = gaps(np.ones(rounds))
    eligible = n0 >= MIN_BIN_STATES
    if not eligible.any():
        return float("nan")
    rng = np.random.default_rng(seed)
    null_max = [np.abs(gaps(rng.poisson(1.0, rounds).astype(float))[0] - g0)[eligible].max() for _ in range(n)]
    return float(np.quantile(null_max, 0.95))


def calibration(y: np.ndarray, p: np.ndarray, bins: int = BINS) -> dict:
    """Equal-width bins: predicted vs observed, the largest gap over bins with enough states, and the logistic slope."""
    idx = _bin_index(p, bins)
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


def intercept_shift(logit: np.ndarray, y: np.ndarray) -> float:
    """The shift b that makes mean(sigmoid(logit + b)) match the observed rate, by Newton's method."""
    b = 0.0
    for _ in range(50):
        q = 1 / (1 + np.exp(-(logit + b)))
        step = (y - q).sum() / max((q * (1 - q)).sum(), 1e-9)
        b += step
        if abs(step) < 1e-8:
            break
    return float(b)


# Team equipment value at the end of buy time, in dollars.
ECO_BELOW, FORCE_BELOW = 5_000, 20_000
# MR12 regulation; overtime halves start with fixed money, so they have no pistol round.
PISTOL_ROUNDS = (1, 13)
ELO_GAP_EDGES = [-200, -100, -50, 0, 50, 100, 200]
READOUT_MIN_ROUNDS = 50
READOUT_MAX_GAP = 0.05


def _buy(col: str) -> pl.Expr:
    return (pl.when(pl.col(col) < ECO_BELOW).then(pl.lit("eco"))
            .when(pl.col(col) < FORCE_BELOW).then(pl.lit("force")).otherwise(pl.lit("full")))


def _calib_by(d: pl.DataFrame, by: str) -> list[dict]:
    """Signed gap (predicted − observed) per group; flagged when the group has enough rounds and |gap| is large."""
    out = (
        d.group_by(by)
        .agg(pl.struct("key", "round_num").n_unique().alias("rounds"), pl.len().alias("states"),
             pl.col("p").mean().alias("pred"), pl.col("ct_win").cast(pl.Float64).mean().alias("obs"))
        .with_columns((pl.col("pred") - pl.col("obs")).alias("gap"))
        .with_columns(((pl.col("rounds") >= READOUT_MIN_ROUNDS) & (pl.col("gap").abs() > READOUT_MAX_GAP)).alias("flagged"))
        .sort(by)
    )
    return out.to_dicts()


def readouts(df: pl.DataFrame, p: np.ndarray) -> dict[str, list[dict]]:
    """Calibration by map, by buy type (CT/T: eco, force, full; pistol rounds apart) and by pre-map Elo gap (CT − T)."""
    labels = ([f"<{ELO_GAP_EDGES[0]}"] + [f"{a}..{b}" for a, b in zip(ELO_GAP_EDGES, ELO_GAP_EDGES[1:])]
              + [f">{ELO_GAP_EDGES[-1]}"])
    elo = pl.col("elo_diff_ct")
    d = df.select("key", "round_num", "map", "ct_win", "ct_equip", "t_equip", "elo_diff_ct").with_columns(
        pl.Series("p", p),
        pl.when(pl.col("round_num").is_in(PISTOL_ROUNDS)).then(pl.lit("pistol"))
        .otherwise(pl.concat_str(_buy("ct_equip"), pl.lit("/"), _buy("t_equip"))).alias("buy"),
        pl.when(elo.is_null() | elo.is_nan()).then(pl.lit("no rating"))
        .otherwise(elo.cut(ELO_GAP_EDGES, labels=labels).cast(pl.Utf8)).alias("elo_gap"),
    )
    return {"map": _calib_by(d, "map"), "buy": _calib_by(d, "buy"), "elo_gap": _calib_by(d, "elo_gap")}


def readout_lines(r: dict[str, list[dict]]) -> list[str]:
    lines = []
    for name, rows in r.items():
        lines.append(f"  by {name}:")
        for row in rows:
            lines.append(f"    {str(row[name]):<14} pred {row['pred']:.3f} obs {row['obs']:.3f} gap {row['gap']:+.3f} "
                         f"({row['rounds']} rounds){' FLAG' if row['flagged'] else ''}")
    return lines
