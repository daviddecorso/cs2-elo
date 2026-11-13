"""Walk-forward evaluation and the out-of-sample models behind credit.

From test_from on, each month gets a fold: a model trained with recency weighting on everything before the month.
Earlier months get a cross-fit model trained on every other month. The fold for the current month is the live model.
"""

import gc
import json
from datetime import date, timedelta

import numpy as np
import polars as pl
import xgboost as xgb

from . import evaluate as ev
from .book import RECAL_ROUNDS, design, economy_patches, file_version, recal_on
from .data import catalog
from .features import with_derived
from .paths import MODELS, STATES
from .pipeline import (
    ABLATIONS,
    FEATURES,
    _gate,
    _gate_line,
    _make_qdm,
    _monotone_constraints,
    _predict_frame,
    _train_booster,
    resolve_device,
)

# The tree settings the 2025-only grid picked for `full` (wp-experiments.md, 2026-11-11); only the half-life is tuned.
PARAMS = {"max_depth": 4, "min_child_weight": 5, "learning_rate": 0.05, "subsample": 0.5, "colsample_bytree": 0.8}
# Deeper trees for the planted × CT alive × T alive × kits interaction; child weight rises with depth so the extra
# splits can't isolate a handful of rounds.
PARAM_SETS = {
    "d4w5": PARAMS,
    "d5w10": {**PARAMS, "max_depth": 5, "min_child_weight": 10},
    "d6w20": {**PARAMS, "max_depth": 6, "min_child_weight": 20},
}
# Days; at least mild decay on every fold so 0.0001 validation ties can't revert 2026 folds to unweighted early-2025 data.
HALF_LIVES = (365, 180, 90)
VALIDATION_DAYS = 90
# Months scored before test_from only so the recalibration has trailing history on the first test week.
WARMUP_MONTHS = 2
# Adopted 2026-11-12 under the amended protocol (wp-experiments.md).
BASE = "full_plant_clock_bomb_dist"
_BASE_FEATURES = FEATURES["full"] + ["since_plant", "ct_bomb_graph"]
VARIANTS = {
    **FEATURES,
    **ABLATIONS,
    BASE: _BASE_FEATURES,
}
# (CT alive, T alive, planted): the post-plant buckets still flagged at full scale.
BUCKETS = [(2, 1, 1), (4, 3, 1), (5, 3, 1), (5, 4, 1)]
# Bomb seconds left at or above this count as early post-plant in the bucket split.
EARLY_PLANT_LEFT = 20
# CT kit counts in the kit split; the last slice is that many or more.
KIT_SLICES = (0, 1, 2, 3)
ID = ["key", "round_num", "date", "map", "ct_win", "ct_alive", "t_alive", "bomb_planted", "since_plant", "ct_kits",
      "ct_equip", "t_equip", "elo_diff_ct"]
DERIVED = {"ct_bomb_graph"}
DERIVED_INPUTS = ["bomb_site", "ct_graph_a", "ct_graph_b"]


def _load_all(features: list[str], month_prefix: str | None = None) -> pl.DataFrame:
    keep = list(dict.fromkeys(ID + features))
    stored = [c for c in dict.fromkeys(keep + DERIVED_INPUTS) if c not in DERIVED]
    frames = []
    for ref in catalog():
        if month_prefix is not None and not ref.date.startswith(month_prefix):
            continue
        p = STATES / ref.slug / "grid.parquet"
        if p.exists():
            f = pl.read_parquet(p, columns=stored)
            if not f.is_empty():
                frames.append(f)
    if not frames:
        return pl.DataFrame()
    df = with_derived(pl.concat(frames, how="diagonal_relaxed")).select(keep)
    casts = [pl.col(c).cast(pl.Float32) for c in ("ct_equip", "t_equip", "elo_diff_ct") if c in df.columns]
    if "round_num" in df.columns:
        casts.append(pl.col("round_num").cast(pl.Int32))
    return df.with_columns(casts) if casts else df


def _weights(df: pl.DataFrame, as_of: str, half_life: int | None, after: str | None = None) -> np.ndarray:
    """Rounds per state, decayed by age; scaled so the total still equals the round count, which keeps
    min_child_weight meaning the same thing at every half-life. With `after`, states later than it decay by their
    distance past it, for cross-fitting."""
    rounds = df.select(pl.struct("key", "round_num").n_unique()).item()
    if half_life is None:
        return np.full(df.height, rounds / df.height, dtype=np.float32)
    d = df["date"].str.to_date()
    age = (date.fromisoformat(as_of) - d).dt.total_days().to_numpy().astype(float)
    if after is not None:
        past = (d - date.fromisoformat(after)).dt.total_days().to_numpy().astype(float)
        age = np.where(past > 0, past, age)
    w = 0.5 ** (np.maximum(age, 0) / half_life)
    return (w * rounds / w.sum()).astype(np.float32)


def _month_start(month: str) -> str:
    return f"{month}-01"


def _next_month(month: str) -> str:
    y, m = int(month[:4]), int(month[5:7])
    return f"{y + m // 12}-{m % 12 + 1:02d}"


def _month_end(month: str) -> str:
    return (date.fromisoformat(_month_start(_next_month(month))) - timedelta(days=1)).isoformat()


def _months(df: pl.DataFrame, test_from: str) -> tuple[list[str], list[str]]:
    months = sorted(df["date"].str.slice(0, 7).unique().to_list())
    test = [m for m in months if m >= test_from[:7]]
    warm = [m for m in months if m < test_from[:7]][-WARMUP_MONTHS:]
    return warm, test


def _y(df: pl.DataFrame) -> np.ndarray:
    return df["ct_win"].cast(pl.Int8).to_numpy()


def _tune_fit(train: pl.DataFrame, as_of: str, features: list[str], maps: list[str], label: str, params: dict,
              device: str = "auto"):
    """Half-life and tree count from the last VALIDATION_DAYS before `as_of`, then a refit on all of `train`."""
    val_from = (date.fromisoformat(as_of) - timedelta(days=VALIDATION_DAYS)).isoformat()
    fit, val = train.filter(pl.col("date") < val_from), train.filter(pl.col("date") >= val_from)
    mc = _monotone_constraints(features)
    weights_by_h = {h: _weights(fit, val_from, h) for h in HALF_LIVES}
    yf, yv = _y(fit), _y(val)
    xf, xv = design(fit, features, maps), design(val, features, maps)
    del fit, val
    gc.collect()

    resolved = resolve_device(device)
    tried = []
    for h in HALF_LIVES:
        qdm_fit = xgb.QuantileDMatrix(xf, yf, weight=weights_by_h[h], enable_categorical=True)
        qdm_val = xgb.QuantileDMatrix(xv, yv, ref=qdm_fit, enable_categorical=True)
        bst = _train_booster(qdm_fit, params, n_estimators=2000, evals=[(qdm_val, "val")],
                             early_stopping_rounds=50, monotone_constraints=mc, device=resolved)
        best_it = int(bst.best_iteration)
        p_val = bst.predict(qdm_val, iteration_range=(0, best_it + 1))
        tried.append({"half_life": h, "val_log_loss": ev.scores(yv, p_val)["log_loss"], "best_iteration": best_it})
        print(f"  {label} half-life {h}: val {tried[-1]['val_log_loss']:.4f} ({best_it + 1} trees)", flush=True)
        del qdm_fit, qdm_val, bst
        gc.collect()
    del xf, xv, yf, yv, weights_by_h
    gc.collect()

    best = min(tried, key=lambda t: t["val_log_loss"])
    wt = _weights(train, as_of, best["half_life"])
    yt = _y(train)
    qdm_train = _make_qdm(train, features, maps, yt, weight=wt)
    del yt, wt
    gc.collect()
    model = _train_booster(qdm_train, params, n_estimators=best["best_iteration"] + 1,
                           monotone_constraints=mc, device=resolved)
    del qdm_train
    gc.collect()
    return model, {"half_life": best["half_life"], "trees": best["best_iteration"] + 1, "grid": tried,
                   "train_to": train["date"].max(), "train_states": train.height}


def _rounds(df: pl.DataFrame) -> int:
    return df.select(pl.struct("key", "round_num").n_unique()).item()


def _fold(df: pl.DataFrame, month: str, features: list[str], maps: list[str], params: dict, device: str = "auto"):
    train = df.filter(pl.col("date") < _month_start(month))
    test = df.filter(pl.col("date").str.starts_with(month))
    train_rounds = dict(train.group_by("map").agg(pl.struct("key", "round_num").n_unique()).iter_rows())
    model, info = _tune_fit(train, _month_start(month), features, maps, month, params, device=device)
    del train
    gc.collect()
    p = _predict_frame(model, test, features, maps) if test.height else np.array([])
    info.update({"month": month, "test_states": test.height, "test_rounds": _rounds(test) if test.height else 0,
                 "low_exposure_maps": sorted(m for m in test["map"].unique().to_list() if train_rounds.get(m, 0) < 500)})
    return model, p, info


def _save(root, name: str, kind: str, month: str, model, info: dict, features: list[str], maps: list[str]) -> dict:
    rel = f"{kind}/{month}.json"
    (root / kind).mkdir(parents=True, exist_ok=True)
    model.save_model(root / rel)
    keep = {k: info[k] for k in ("half_life", "trees", "train_to", "train_states") if k in info}
    return {"path": rel, "version": file_version(name, rel, root), "features": features, "maps": maps, **keep}


def _index(root) -> dict:
    p = root / "index.json"
    return json.loads(p.read_text()) if p.exists() else {}


def _write_index(root, index: dict) -> None:
    (root / "index.json").write_text(json.dumps(index, indent=2))


def recalibrate(pred: pl.DataFrame) -> tuple[np.ndarray, list[dict]]:
    """Weekly intercept refit on the trailing RECAL_ROUNDS out-of-sample rounds before each Monday."""
    d = pred.with_columns(pl.col("date").str.to_date().alias("d"))
    d = d.with_columns((pl.col("d") - pl.duration(days=pl.col("d").dt.weekday() - 1)).alias("week"))
    pc = np.clip(d["p"].to_numpy(), 1e-6, 1 - 1e-6)
    logit, y = np.log(pc / (1 - pc)), d["ct_win"].cast(pl.Float64).to_numpy()
    rounds = d.select("key", "round_num", "d").unique().sort("d", "key", "round_num")
    out = logit.copy()
    shifts = []
    for week in sorted(d.filter(pl.col("scored"))["week"].unique().to_list()):
        hist = rounds.filter(pl.col("d") < week).tail(RECAL_ROUNDS)
        if hist.is_empty():
            shifts.append({"week": week.isoformat(), "shift": 0.0, "rounds": 0})
            continue
        mask = d.select(pl.struct("key", "round_num").is_in(hist.select(pl.struct("key", "round_num")).to_series())).to_series().to_numpy()
        b = ev.intercept_shift(logit[mask], y[mask])
        out[(d["week"] == week).to_numpy()] += b
        shifts.append({"week": week.isoformat(), "shift": b, "rounds": hist.height})
    return 1 / (1 + np.exp(-out)), shifts


def _bucket_rows(df: pl.DataFrame, p: np.ndarray) -> list[dict]:
    b = ev.by_bucket(df, p)
    return [r for r in b.to_dicts() if (r["ct_alive"], r["t_alive"], r["bomb_planted"]) in BUCKETS]


def _bucket_clock(df: pl.DataFrame, p: np.ndarray) -> list[dict]:
    """Each flagged post-plant bucket split into early (EARLY_PLANT_LEFT+ bomb seconds left) and late."""
    d = df.select("key", "round_num", "ct_alive", "t_alive", "bomb_planted", "since_plant", "ct_win").with_columns(
        pl.Series("p", p),
        pl.when(40 - pl.col("since_plant") >= EARLY_PLANT_LEFT).then(pl.lit("early")).otherwise(pl.lit("late")).alias("phase"))
    rows = []
    for ct, t, planted in BUCKETS:
        b = d.filter((pl.col("ct_alive") == ct) & (pl.col("t_alive") == t) & (pl.col("bomb_planted") == planted))
        for (phase,), g in sorted(b.group_by("phase"), key=lambda x: x[0]):
            rows.append({"bucket": f"{ct}v{t}", "phase": phase, "rounds": _rounds(g), "pred": float(g["p"].mean()),
                         "obs": float(g["ct_win"].cast(pl.Float64).mean())})
            rows[-1]["gap"] = rows[-1]["pred"] - rows[-1]["obs"]
    return rows


def _kit_slice(kits: pl.Expr) -> pl.Expr:
    top = KIT_SLICES[-1]
    return pl.when(kits >= top).then(pl.lit(f"{top}+")).otherwise(kits.cast(pl.Int32).cast(pl.Utf8))


def _bucket_kits(df: pl.DataFrame, p: np.ndarray) -> list[dict]:
    """Each flagged post-plant bucket split by CT kits, so a level shift can't pass for a fixed kit slope."""
    d = df.select("key", "round_num", "ct_alive", "t_alive", "bomb_planted", "ct_kits", "ct_win").with_columns(
        pl.Series("p", p), _kit_slice(pl.col("ct_kits")).alias("kits"))
    rows = []
    for ct, t, planted in BUCKETS:
        b = d.filter((pl.col("ct_alive") == ct) & (pl.col("t_alive") == t) & (pl.col("bomb_planted") == planted))
        for (kits,), g in sorted(b.group_by("kits"), key=lambda x: x[0]):
            rows.append({"bucket": f"{ct}v{t}", "kits": kits, "rounds": _rounds(g), "pred": float(g["p"].mean()),
                         "obs": float(g["ct_win"].cast(pl.Float64).mean())})
            rows[-1]["gap"] = rows[-1]["pred"] - rows[-1]["obs"]
    return rows


def _pooled(df: pl.DataFrame, p: np.ndarray, full: bool = True) -> dict:
    y = _y(df)
    r = {**ev.scores(y, p), "calibration": ev.calibration(y, p), "gate": _gate(df, p), "buckets": _bucket_rows(df, p)}
    r["calibration"].pop("curve")
    if full:
        r.update({"ci": ev.round_bootstrap(df, p), "all_buckets": ev.by_bucket(df, p).to_dicts(),
                  "readouts": ev.readouts(df, p), "bucket_clock": _bucket_clock(df, p),
                  "bucket_kits": _bucket_kits(df, p)})
    return r


def _print_buckets(name: str, rows: list[dict]) -> None:
    for r in rows:
        print(f"  {name} {int(r['ct_alive'])}v{int(r['t_alive'])} post-plant: pred {r['pred']:.3f} obs {r['obs']:.3f} "
              f"({r['rounds']} rounds){' FLAG' if r['flagged'] else ''}")


def walk_forward(test_from: str, out: str, variant: str, param_set: str = "d4w5", device: str = "auto") -> int:
    resolved = resolve_device(device)
    features, params = VARIANTS[variant], PARAM_SETS[param_set]
    df = _load_all(features)
    maps = sorted(df["map"].unique().to_list())
    warm, test_months = _months(df, test_from)
    root = MODELS / out
    root.mkdir(parents=True, exist_ok=True)
    old = _index(root)
    same = old.get("variant") == variant and old.get("params", PARAMS) == params
    index = {"variant": variant, "features": features, "param_set": param_set, "params": params,
             "test_from": test_from, "folds": {}, "crossfit": old.get("crossfit", {}) if same else {}}
    preds, folds = [], []
    for month in warm + test_months:
        model, p, info = _fold(df, month, features, maps, params, device=resolved)
        index["folds"][month] = _save(root, out, "folds", month, model, info, features, maps)
        del model
        gc.collect()
        folds.append(info)
        preds.append(df.filter(pl.col("date").str.starts_with(month)).select(ID).with_columns(
            pl.Series("p", p), pl.lit(month in test_months).alias("scored"), pl.lit(month).alias("month")))
        print(f"{month}: half-life {info['half_life']}, {info['trees']} trees, {info['test_rounds']} rounds", flush=True)
    index["live"] = test_months[-1]
    _write_index(root, index)

    pred = pl.concat(preds)
    p_recal, shifts = recalibrate(pred)
    pred = pred.with_columns(pl.Series("p_recal", p_recal))
    scored = pred.filter(pl.col("scored"))
    p, pr = scored["p"].to_numpy(), scored["p_recal"].to_numpy()

    for f in folds:
        if f["month"] not in test_months:
            continue
        m = scored.filter(pl.col("month") == f["month"])
        f["gate"], f["gate_recal"] = _gate(m, m["p"].to_numpy()), _gate(m, m["p_recal"].to_numpy())
        f["intercept"] = ev.calibration(_y(m), m["p"].to_numpy())["intercept"]

    report = {
        "built": date.today().isoformat(), "variant": variant, "features": features, "param_set": param_set,
        "params": params,
        "half_lives": HALF_LIVES, "validation_days": VALIDATION_DAYS, "recal_rounds": RECAL_ROUNDS,
        "test_from": test_from, "warmup_months": warm, "test_months": test_months,
        "pooled": _pooled(scored, p), "pooled_recal": _pooled(scored, pr, full=False),
        "folds": folds, "recal_shifts": shifts,
    }
    (root / "walkforward.json").write_text(json.dumps(report, indent=2, default=float))
    # war and publish read the gate from report.json.
    (root / "report.json").write_text(json.dumps({
        "built": report["built"], "kind": "walk-forward", "variant": variant, "test_from": test_from, "maps": maps,
        "gate": report["pooled"]["gate"], "gate_recal": report["pooled_recal"]["gate"]}, indent=2, default=float))
    pred.select("key", "round_num", "date", "map", "ct_win", "p", "p_recal", "scored", "month").write_parquet(
        root / "walkforward.parquet")

    print(f"\n{variant}: {scored.height} states in {len(test_months)} months")
    print(f"Gate (walk-forward):        {_gate_line(report['pooled']['gate'])}")
    print(f"Gate (+weekly intercept):   {_gate_line(report['pooled_recal']['gate'])}")
    for f in folds:
        if "gate" not in f:
            continue
        g, gr = f["gate"], f["gate_recal"]
        print(f"  {f['month']} h={f['half_life']} ll {g['log_loss']:.4f} gap {g['max_bin_gap']:.3f}/{g['bin_gap_limit']:.3f} "
              f"(recal {gr['max_bin_gap']:.3f}) slope {g['slope']:.3f} intercept {f['intercept']:+.3f}")
    _print_buckets("raw", report["pooled"]["buckets"])
    _print_buckets("recal", report["pooled_recal"]["buckets"])
    for r in report["pooled"]["bucket_clock"]:
        print(f"  {r['bucket']} post-plant {r['phase']:<5} pred {r['pred']:.3f} obs {r['obs']:.3f} gap {r['gap']:+.3f} "
              f"({r['rounds']} rounds)")
    for r in report["pooled"]["bucket_kits"]:
        print(f"  {r['bucket']} post-plant kits {r['kits']:<2} pred {r['pred']:.3f} obs {r['obs']:.3f} "
              f"gap {r['gap']:+.3f} ({r['rounds']} rounds)")
    print("\n".join(ev.readout_lines(report["pooled"]["readouts"])))
    return 0 if report["pooled"]["gate"]["passed"] else 2


def _aligned_states(pred: pl.DataFrame) -> pl.DataFrame | None:
    """The state rows behind a walk-forward prediction frame. Folds score each month's states in load order, so rows
    match by position; None when the local states no longer line up (maps added or rebuilt since the run)."""
    states = _load_all([])
    parts = []
    for (month,), pm in pred.group_by("month", maintain_order=True):
        s = states.filter(pl.col("date").str.starts_with(month))
        if s.height != pm.height or not (s["key"].equals(pm["key"]) and s["round_num"].equals(pm["round_num"])):
            print(f"{month}: local states ({s.height} rows) don't line up with the predictions ({pm.height} rows).")
            return None
        parts.append(s)
    return pl.concat(parts)


def _comparison_groups(s: pl.DataFrame) -> tuple[dict[str, np.ndarray], dict[str, list[str]]]:
    keys = ["ct_alive", "t_alive", "bomb_planted"]
    combos = s.select(keys).unique().sort(keys)
    names = [f"{int(ct)}v{int(t)} {'post' if planted else 'pre'}" for ct, t, planted in combos.iter_rows()]
    bucket = (s.select(keys).join(combos.with_row_index("g"), on=keys, how="left", maintain_order="left")["g"]
              .cast(pl.Int64).to_numpy())

    kit_names, kit = [], np.full(s.height, -1, dtype=np.int64)
    slice_ = s.select(_kit_slice(pl.col("ct_kits")))[:, 0].to_numpy()
    for ct, t, planted in BUCKETS:
        in_bucket = ((s["ct_alive"] == ct) & (s["t_alive"] == t) & (s["bomb_planted"] == planted)).to_numpy()
        for k in KIT_SLICES:
            label = f"{k}+" if k == KIT_SLICES[-1] else str(k)
            kit[in_bucket & (slice_ == label)] = len(kit_names)
            kit_names.append(f"{ct}v{t} post kits {label}")
    return {"bucket": bucket, "kits": kit}, {"bucket": names, "kits": kit_names}


# Δ|gap| a bucket must also exceed before `compare` calls it worse or better; paired intervals on large buckets
# exclude 0 for changes of 0.0001.
MATERIAL_GAP = 0.005


def _interval(r: dict, floor: float = 0.0) -> str:
    lo, hi = r["ci"]
    mark = " worse" if lo > 0 and r["delta"] > floor else (" better" if hi < 0 and r["delta"] < -floor else "")
    return f"{r['delta']:+.4f} [{lo:+.4f}, {hi:+.4f}]{mark}"


def compare(base: str, model: str, min_rounds: int = 50, resamples: int = 200) -> int:
    """Paired round bootstrap of two walk-forward runs on the same scored states. No training."""
    # `monthly` rewrites a month by appending it, so restore month order before matching rows.
    a, b = (pl.read_parquet(MODELS / m / "walkforward.parquet").filter(pl.col("scored")).sort("month", maintain_order=True)
            for m in (base, model))
    cols = ["key", "round_num", "month"]
    if not a.select(cols).equals(b.select(cols)):
        print(f"{base} and {model} scored different states; rerun one of them on the current states.")
        return 1
    s = _aligned_states(a)
    if s is None:
        return 1
    rid = s.select(pl.struct("key", "round_num").rank("dense")).to_series().to_numpy() - 1
    groups, names = _comparison_groups(s)
    r = ev.paired_bootstrap(rid, _y(s), a["p"].to_numpy(), b["p"].to_numpy(), groups, n=resamples)
    for name, rows in r["groups"].items():
        for row in rows:
            row["group"] = names[name][row["group"]]
    r.update({"base": base, "model": model, "rounds": int(rid.max()) + 1, "states": s.height, "resamples": resamples})
    (MODELS / model / f"compare-{base}.json").write_text(json.dumps(r, indent=2, default=float))

    print(f"{model} − {base} on {r['rounds']} rounds, {r['states']} states (95% paired round-bootstrap intervals)")
    print(f"  log loss     {r['log_loss']['a']:.4f} -> {r['log_loss']['b']:.4f}  Δ {_interval(r['log_loss'])}")
    print(f"  max bin gap  {r['max_bin_gap']['a']:.4f} -> {r['max_bin_gap']['b']:.4f}  Δ {_interval(r['max_bin_gap'])}")
    print("  Δ|gap| per bucket (signed gap base -> model):")
    for row in r["groups"]["bucket"]:
        if row["rounds"] >= min_rounds:
            print(f"    {row['group']:<9} {row['a']:+.3f} -> {row['b']:+.3f}  Δ {_interval(row, MATERIAL_GAP)} "
                  f"({row['rounds']} rounds)")
    print("  Δ|gap| per kit slice:")
    for row in r["groups"]["kits"]:
        print(f"    {row['group']:<18} {row['a']:+.3f} -> {row['b']:+.3f}  Δ {_interval(row, MATERIAL_GAP)} "
              f"({row['rounds']} rounds)")
    worse = [f"{row['group']} ({row['delta']:+.4f})" for row in r["groups"]["bucket"]
             if row["rounds"] >= min_rounds and row["ci"][0] > 0 and row["delta"] > MATERIAL_GAP]
    print(f"  buckets worse by more than {MATERIAL_GAP} with an interval excluding 0: {', '.join(worse) or 'none'}")
    return 0


def cross_fit(out: str, device: str = "auto") -> int:
    """One model per month before test_from, trained on every other month with decay by distance from the held-out
    month. Half-life and tree count come from the latest fold, the one trained on the most data."""
    resolved = resolve_device(device)
    root = MODELS / out
    index = _index(root)
    if not index.get("folds"):
        print(f"No folds in {root / 'index.json'}; run `cs2wp walk-forward --model {out}` first.")
        return 1
    features, test_from = index["features"], index["test_from"]
    latest = index["folds"][max(index["folds"])]
    half_life, trees = latest["half_life"], latest["trees"]
    params = index.get("params", PARAMS)
    df = _load_all(features)
    maps = sorted(df["map"].unique().to_list())
    months = sorted(m for m in df["date"].str.slice(0, 7).unique().to_list() if m < test_from[:7])
    mc = _monotone_constraints(features)
    index["crossfit"], preds = {}, []
    for month in months:
        held = pl.col("date").str.starts_with(month)
        train, test = df.filter(~held), df.filter(held)
        train_to, train_states = train["date"].max(), train.height
        w = _weights(train, _month_start(month), half_life, after=_month_end(month))
        yt = _y(train)
        qdm_train = _make_qdm(train, features, maps, yt, weight=w)
        del train, yt, w
        gc.collect()
        model = _train_booster(qdm_train, params, n_estimators=trees, monotone_constraints=mc, device=resolved)
        del qdm_train
        gc.collect()
        info = {"half_life": half_life, "trees": trees, "train_to": train_to, "train_states": train_states}
        index["crossfit"][month] = _save(root, out, "crossfit", month, model, info, features, maps)
        p = _predict_frame(model, test, features, maps)
        del model
        gc.collect()
        preds.append(test.select(ID).with_columns(pl.Series("p", p), pl.lit(month).alias("month")))
        print(f"{month}: cross-fit on {train_states} states, scored {_rounds(test)} rounds", flush=True)
    _write_index(root, index)

    pred = pl.concat(preds)
    pooled = _pooled(pred, pred["p"].to_numpy())
    (root / "crossfit.json").write_text(json.dumps({
        "built": date.today().isoformat(), "half_life": half_life, "trees": trees, "months": months, "pooled": pooled,
    }, indent=2, default=float))
    print(f"\nCross-fit {months[0]} to {months[-1]} (not a gate: each model saw later months)")
    print(f"  {_gate_line(pooled['gate'])}")
    _print_buckets("cross-fit", pooled["buckets"])
    return 0


def monthly(out: str, today: str | None = None, force: bool = False, device: str = "auto") -> int:
    """Trains the current month's fold (the live model) and the previous month's if missing, then gates the previous
    month on all its maps. Exits 2 and records a flag when that month fails."""
    resolved = resolve_device(device)
    today = today or date.today().isoformat()
    root = MODELS / out
    index = _index(root)
    if not index.get("folds"):
        print(f"No folds in {root / 'index.json'}; run `cs2wp walk-forward --model {out}` first.")
        return 1
    features = index["features"]
    current = today[:7]
    prev = (date.fromisoformat(_month_start(current)) - timedelta(days=1)).isoformat()[:7]
    need_train = any(m not in index["folds"] or force for m in (prev, current))
    df = _load_all(features, month_prefix=None if need_train else prev)
    maps = sorted(df["map"].unique().to_list()) if need_train else index["folds"][prev]["maps"]
    for month in (prev, current):
        if month in index["folds"] and not force:
            continue
        model, _, info = _fold(df, month, features, maps, index.get("params", PARAMS), device=resolved)
        index["folds"][month] = _save(root, out, "folds", month, model, info, features, maps)
        del model
        gc.collect()
        print(f"{month}: trained on data to {info['train_to']}, half-life {info['half_life']}, {info['trees']} trees")
    index["live"] = current
    _write_index(root, index)

    from .book import ModelBook

    book = ModelBook(out)
    test = df.filter(pl.col("date").str.starts_with(prev))
    record = {"run": today, "month": prev, "live": current, "fold": index["folds"][prev]["version"]}
    patches = economy_patches()
    if recal_on(today, patches):
        record["recal"] = "weekly intercept on for maps in the current economy patch window"
    if test.is_empty():
        record.update({"passed": None, "note": "no maps in the month"})
        print(f"{prev}: no maps; nothing to gate.")
    else:
        p = book.predict(index["folds"][prev], test)
        g = _gate(test, p)
        record.update({"passed": g["passed"], "gate": g, "rounds": _rounds(test),
                       "buckets": _bucket_rows(test, p), "readouts": ev.readouts(test, p)})
        store = root / "walkforward.parquet"
        if store.exists():
            old = pl.read_parquet(store).filter(pl.col("month") != prev)
            new = test.select("key", "round_num", "date", "map", "ct_win").with_columns(
                pl.Series("p", p), pl.lit(None, pl.Float64).alias("p_recal"), pl.lit(True).alias("scored"),
                pl.lit(prev).alias("month"))
            pl.concat([old, new.select(old.columns)], how="vertical_relaxed").write_parquet(store)
        print(f"{prev} ({record['rounds']} rounds): {_gate_line(g)}")
        print("\n".join(ev.readout_lines(record["readouts"])))
        if not g["passed"]:
            print(f"FLAG: the {prev} fold failed the gate. Check patches.json for a patch in {prev} and the readouts above.")
    log = root / "monthly.json"
    history = json.loads(log.read_text()) if log.exists() else []
    log.write_text(json.dumps(history + [record], indent=2, default=float))
    return 2 if record["passed"] is False else 0
