"""The steps behind each CLI command."""

import gc
import hashlib
import json
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
from datetime import date
from functools import lru_cache
from pathlib import Path

import numpy as np
import polars as pl

from . import credit as cr
from . import evaluate as ev
from .book import design
from .data import MapRef, catalog
from .hltv import ratings_for
from .nav import NAV_RELEASE, SiteDistance
from .paths import CREDITS, MODELS, REPORTS, STATES
from .ratings import map_stats, rating2
from .states import build, map_plants

PAPER = ["map", "seconds", "bomb_planted", "bomb_site", "t_equip", "ct_equip", "t_alive", "ct_alive",
         "t_hp", "ct_hp", "t_graph_a", "t_graph_b", "ct_graph_a", "ct_graph_b"]
CS2 = ["ct_kits", "t_util", "ct_util", "elo_diff_ct"]
FEATURES = {"replication": PAPER, "full": PAPER + CS2}
EUCLID = [c.replace("graph", "euclid") for c in PAPER] + CS2
# Each logged in docs/wp-experiments.md; the promotion rule is the protocol there.
ABLATIONS = {
    "full_euclid": EUCLID,
    "full_no_elo": [c for c in PAPER + CS2 if c != "elo_diff_ct"],
    "full_no_kits": [c for c in PAPER + CS2 if c != "ct_kits"],
    "full_no_util": [c for c in PAPER + CS2 if c not in ("ct_util", "t_util")],
    "full_plant_clock": PAPER + CS2 + ["since_plant"],
    "full_defusing": PAPER + CS2 + ["ct_defusing"],
    "full_util_types": [c for c in PAPER + CS2 if c not in ("ct_util", "t_util")]
    + [f"{s}_{u}" for s in ("ct", "t") for u in ("smokes", "flashes", "hes", "fires")],
}
GRID = [{"max_depth": d, "min_child_weight": w} for d in (6, 8, 10, 12) for w in (1, 3, 5, 7)]
GRID_FULL = [
    {"max_depth": d, "min_child_weight": w, "learning_rate": 0.05, "subsample": 0.5, "colsample_bytree": 0.8}
    for d in (3, 4, 5, 6)
    for w in (1, 5, 20, 50)
]
PAPER_LOG_LOSS = 0.535
PAPER_BIN_GAP = 0.03


def _monotone_constraints(features: list[str]) -> tuple[int, ...]:
    pos = {"ct_alive", "ct_hp", "ct_kits"}
    neg = {"t_alive", "t_hp"}
    return tuple(1 if f in pos else (-1 if f in neg else 0) for f in features)


def _state_dir(ref: MapRef):
    return STATES / ref.slug


STATE_SOURCES = (Path(__file__).with_name("states.py"), Path(__file__).with_name("nav.py"))


def _site_key(sd: SiteDistance) -> dict:
    # Centroids are means over every plant on the map, so they drift as maps are added; rounding to 1 unit keeps
    # a new event from invalidating every earlier map, at the cost of euclid_* distances up to 1 unit stale.
    return {s: [sorted(sd.site_areas[s]), [round(c) for c in sd.site_centroid[s]]] for s in sorted(sd.site_areas)}


def _state_key(ref: MapRef, sd: SiteDistance, code: str) -> str:
    tables = sorted((p.name, p.stat().st_size, p.stat().st_mtime_ns) for p in ref.dir.glob("*.parquet"))
    payload = {"ref": asdict(ref), "nav": NAV_RELEASE, "sites": _site_key(sd), "code": code, "tables": tables}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


_WORKER_PLANTS: dict[str, pl.DataFrame] = {}
_WORKER_SITES: dict[str, SiteDistance] = {}


def _init_state_worker(plants: dict[str, pl.DataFrame]) -> None:
    global _WORKER_PLANTS, _WORKER_SITES
    _WORKER_PLANTS = plants
    _WORKER_SITES = {}


def _build_one(ref: MapRef, key: str, sd: SiteDistance) -> tuple[str, str, str, int, int, dict, float]:
    out = _state_dir(ref)
    before = dict(sd.stats)
    grid, events, roster = build(ref, sd)
    out.mkdir(parents=True, exist_ok=True)
    grid.write_parquet(out / "grid.parquet")
    events.write_parquet(out / "events.parquet")
    roster.write_parquet(out / "roster.parquet")
    hit = {k: sd.stats[k] - before[k] for k in sd.stats}
    total = sum(hit.values()) or 1
    cov = {"key": ref.key, "map": ref.map, "month": ref.date[:7],
           "on_mesh": hit["area"] / total, "snapped": hit["snapped"] / total, "missed": hit["missed"] / total}
    (out / "meta.json").write_text(json.dumps({"key": key, "coverage": cov}))
    miss_pct = 100 * (1 - hit["missed"] / total)
    return ref.key, ref.map, ref.date, grid.height, events.height, cov, miss_pct


def _build_worker_task(item: tuple[MapRef, str]) -> tuple[str, str, str, int, int, dict, float]:
    ref, key = item
    sd = _WORKER_SITES.get(ref.map)
    if sd is None:
        sd = SiteDistance(ref.map, _WORKER_PLANTS[ref.map])
        _WORKER_SITES[ref.map] = sd
    return _build_one(ref, key, sd)


def build_states(only: str | None = None, force: bool = False, workers: int | None = None) -> int:
    """Rebuilds a map only when its tables, Elo, site areas, nav release or the state code changed."""
    all_refs = catalog()
    refs = [r for r in all_refs if r.key == only] if only else all_refs
    target_maps = {r.map for r in refs}
    plants = map_plants([r for r in all_refs if r.map in target_maps])
    code = hashlib.sha256(b"".join(p.read_bytes() for p in STATE_SOURCES)).hexdigest()
    sites: dict[str, SiteDistance | None] = {}
    cov_by_key: dict[str, dict] = {}
    skipped: list[dict] = []
    todo: list[tuple[MapRef, str]] = []
    cached = 0
    for ref in refs:
        if ref.map not in sites:
            try:
                sites[ref.map] = SiteDistance(ref.map, plants[ref.map])
            except FileNotFoundError as e:
                print(f"warning: skipping {ref.map}: {e}")
                sites[ref.map] = None
        sd = sites[ref.map]
        if sd is None:
            skipped.append({"key": ref.key, "map": ref.map, "reason": "no nav mesh"})
            continue
        out = _state_dir(ref)
        key = _state_key(ref, sd, code)
        meta_path = out / "meta.json"
        if not force and meta_path.exists():
            meta = json.loads(meta_path.read_text())
            if meta["key"] == key:
                cov_by_key[ref.key] = meta["coverage"]
                cached += 1
                continue
        todo.append((ref, key))

    n_workers = workers if workers is not None else (1 if only or len(todo) <= 1 else min(os.cpu_count() or 1, 6))
    built = 0
    if todo:
        if n_workers <= 1 or len(todo) <= 1:
            for ref, key in todo:
                rkey, rmap, rdate, gh, eh, cov, miss_pct = _build_one(ref, key, sites[ref.map])
                cov_by_key[rkey] = cov
                built += 1
                print(f"{rkey} {rmap} {rdate}: {gh} grid states, {eh} events, {miss_pct:.1f}% positions on the nav mesh",
                      flush=True)
        else:
            needed_plants = {m: plants[m] for m in {r.map for r, _ in todo}}
            with ProcessPoolExecutor(max_workers=n_workers, initializer=_init_state_worker, initargs=(needed_plants,)) as ex:
                for rkey, rmap, rdate, gh, eh, cov, miss_pct in ex.map(_build_worker_task, todo, chunksize=4):
                    cov_by_key[rkey] = cov
                    built += 1
                    print(f"{rkey} {rmap} {rdate}: {gh} grid states, {eh} events, {miss_pct:.1f}% positions on the nav mesh",
                          flush=True)

    coverage = [cov_by_key[r.key] for r in refs if r.key in cov_by_key]
    print(f"{built} built, {cached} unchanged, {len(skipped)} skipped")
    STATES.mkdir(parents=True, exist_ok=True)
    (STATES / "coverage.json").write_text(
        json.dumps({"nav_release": NAV_RELEASE, "maps": coverage, "skipped": skipped}, indent=2))
    return 0


def _load(refs: list[MapRef], name: str, columns: list[str] | None = None) -> pl.DataFrame:
    frames = [
        pl.read_parquet(_state_dir(r) / f"{name}.parquet", columns=columns)
        for r in refs
        if (_state_dir(r) / f"{name}.parquet").exists()
    ]
    frames = [f for f in frames if not f.is_empty()]
    return pl.concat(frames, how="diagonal_relaxed") if frames else pl.DataFrame()


def _round_weights(df: pl.DataFrame) -> np.ndarray:
    # Rounds per state, constant so the total weight equals the round count without reweighting by round length:
    # T-won rounds run longer, so 1/states-in-round leaned the model toward CT.
    if "key" in df.columns and "round_num" in df.columns and not df.is_empty():
        rounds = df.select(pl.struct("key", "round_num").n_unique()).item()
        return np.full(df.height, rounds / df.height, dtype=np.float32)
    return np.ones(df.height, dtype=np.float32)


def _xy(df: pl.DataFrame, features: list[str], maps: list[str]):
    x = design(df, features, maps)
    y = df["ct_win"].cast(pl.Int8).to_numpy()
    return x, y, _round_weights(df)


@lru_cache(maxsize=4)
def resolve_device(device: str = "auto") -> str:
    if device == "cpu":
        return "cpu"
    import xgboost as xgb

    has_cuda = bool(xgb.build_info().get("USE_CUDA"))
    if device == "cuda":
        if not has_cuda:
            raise SystemExit("XGBoost was built without CUDA support; install CUDA-enabled xgboost or pass --device cpu")
        return "cuda"
    if device != "auto":
        raise ValueError(f"unknown device: {device}")
    if not has_cuda:
        return "cpu"
    try:
        x = np.array([[0.0], [1.0]], dtype=np.float32)
        y = np.array([0, 1], np.int8)
        dm = xgb.QuantileDMatrix(x, y)
        xgb.train({"tree_method": "hist", "device": "cuda", "objective": "binary:logistic", "max_depth": 1}, dm,
                  num_boost_round=1)
        return "cuda"
    except Exception:
        return "cpu"


def _make_qdm(df: pl.DataFrame, features: list[str], maps: list[str], y: np.ndarray,
              weight: np.ndarray | None = None, ref=None):
    import xgboost as xgb

    x = design(df, features, maps)
    qdm = xgb.QuantileDMatrix(x, y, weight=weight, ref=ref, enable_categorical=True)
    del x
    return qdm


def _train_booster(
    dtrain,
    params: dict,
    n_estimators: int = 100,
    evals=None,
    early_stopping_rounds: int | None = None,
    monotone_constraints: tuple[int, ...] | None = None,
    device: str = "auto",
):
    import xgboost as xgb

    xgb_params = {
        "tree_method": "hist",
        "device": resolve_device(device),
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "nthread": 0,
        **params,
    }
    if monotone_constraints is not None:
        xgb_params["monotone_constraints"] = monotone_constraints
    kw: dict = {"num_boost_round": n_estimators, "verbose_eval": False}
    if evals is not None:
        kw["evals"] = evals
    if early_stopping_rounds is not None:
        kw["early_stopping_rounds"] = early_stopping_rounds
    return xgb.train(xgb_params, dtrain, **kw)


def _predict_booster(bst, dmatrix) -> np.ndarray:
    best_it = getattr(bst, "best_iteration", None)
    if best_it is not None and best_it >= 0:
        return bst.predict(dmatrix, iteration_range=(0, int(best_it) + 1))
    return bst.predict(dmatrix)


def _predict_frame(bst, df: pl.DataFrame, features: list[str], maps: list[str]) -> np.ndarray:
    import xgboost as xgb

    x = design(df, features, maps)
    dm = xgb.DMatrix(x, enable_categorical=True)
    del x
    return _predict_booster(bst, dm)


def _fit_xgb(
    x,
    y,
    params: dict,
    sample_weight=None,
    n_estimators: int = 100,
    eval_set=None,
    early_stopping_rounds: int | None = None,
    monotone_constraints: tuple[int, ...] | None = None,
    device: str = "cpu",
):
    from xgboost import XGBClassifier

    kw = dict(
        n_estimators=n_estimators,
        tree_method="hist",
        device=resolve_device(device),
        enable_categorical=True,
        eval_metric="logloss",
        n_jobs=-1,
        **params,
    )
    if early_stopping_rounds is not None:
        kw["early_stopping_rounds"] = early_stopping_rounds
    if monotone_constraints is not None:
        kw["monotone_constraints"] = monotone_constraints
    model = XGBClassifier(**kw)
    fit_kw = {}
    if sample_weight is not None:
        fit_kw["sample_weight"] = sample_weight
    if eval_set is not None:
        fit_kw["eval_set"] = eval_set
        fit_kw["verbose"] = False
    return model.fit(x, y, **fit_kw)


def _fit_logistic(train: pl.DataFrame, maps: list[str]):
    """The paper's logistic regression: no penalty, one-hot map and site, missing distances at the training median."""
    from sklearn.linear_model import LogisticRegression

    num = [c for c in PAPER if c not in ("map", "bomb_site")]
    medians = {c: float(train[c].median()) for c in num}

    def design(df: pl.DataFrame) -> np.ndarray:
        cols = [df[c].fill_nan(None).fill_null(medians[c]).to_numpy() for c in num]
        cols += [(df["map"] == m).to_numpy().astype(float) for m in maps[1:]]
        cols += [(df["bomb_site"] == s).to_numpy().astype(float) for s in ("A", "B")]
        x = np.column_stack(cols).astype(float)
        return x

    x = design(train)
    mu, sd = x.mean(axis=0), x.std(axis=0) + 1e-9
    model = LogisticRegression(solver="saga", penalty=None, max_iter=200).fit((x - mu) / sd, train["ct_win"].to_numpy())
    return lambda df: model.predict_proba((design(df) - mu) / sd)[:, 1]


def _report(name: str, df: pl.DataFrame, p: np.ndarray) -> dict:
    y = df["ct_win"].cast(pl.Int8).to_numpy()
    return {"model": name, **ev.scores(y, p), "ci": ev.round_bootstrap(df, p), "calibration": ev.calibration(y, p),
            "buckets": ev.by_bucket(df, p).to_dicts(), "by_map": ev.by_map(df, p)}


def split(refs: list[MapRef], test_from: str) -> tuple[list[MapRef], list[MapRef], list[MapRef], list[MapRef]]:
    """(fit, validation, train, test) by date. Validation is the latest third of training maps, so tuning never sees
    a later match, and whole maps stay on one side because adjacent states are nearly copies of each other."""
    train_refs = sorted((r for r in refs if r.date < test_from), key=lambda r: (r.date, r.key))
    test_refs = [r for r in refs if r.date >= test_from]
    cut = max(1, (2 * len(train_refs)) // 3)
    return train_refs[:cut], train_refs[cut:] or train_refs[-1:], train_refs, test_refs


def _gate(df: pl.DataFrame, p: np.ndarray) -> dict:
    """The paper's 0.03 bin gap is the floor; the limit rises to what round-level noise alone produces on this test set."""
    y = df["ct_win"].cast(pl.Int8).to_numpy()
    log_loss, cal = ev.scores(y, p)["log_loss"], ev.calibration(y, p)
    limit = max(PAPER_BIN_GAP, ev.bin_gap_noise(df, p))
    return {
        "log_loss": log_loss, "paper": PAPER_LOG_LOSS, "max_bin_gap": cal["max_gap"], "bin_gap_limit": limit,
        "slope": cal["slope"],
        "passed": bool(log_loss <= PAPER_LOG_LOSS and cal["max_gap"] <= limit and 0.95 <= cal["slope"] <= 1.05),
    }


def _gate_line(g: dict) -> str:
    return (f"{g['log_loss']:.4f} vs {g['paper']}, max bin gap {g['max_bin_gap']:.3f} vs {g['bin_gap_limit']:.3f}, "
            f"slope {g['slope']:.3f} -> {'PASS' if g['passed'] else 'FAIL'}")


def train(test_from: str, out: str, ablations: bool = False, device: str = "auto") -> int:
    fit_refs, val_refs, train_refs, test_refs = split(catalog(), test_from)
    if not train_refs or not test_refs:
        print(f"Need maps on both sides of {test_from}: {len(train_refs)} train, {len(test_refs)} test.")
        return 1
    variants = {**FEATURES, **(ABLATIONS if ablations else {})}
    base_cols = ["key", "round_num", "date", "map", "ct_win", "ct_alive", "t_alive", "bomb_planted", "bomb_site",
                 "ct_equip", "t_equip", "elo_diff_ct"]
    needed_cols = list(dict.fromkeys(base_cols + PAPER + [c for fs in variants.values() for c in fs]))
    train_df = _load(train_refs, "grid", columns=needed_cols)
    test = _load(test_refs, "grid", columns=needed_cols)
    fit_keys = [r.key for r in fit_refs]
    val_keys = [r.key for r in val_refs]
    maps = sorted(train_df["map"].unique().to_list())
    unseen = sorted(set(test["map"].unique().to_list()) - set(maps))
    train_rounds = dict(train_df.group_by("map").agg(pl.struct("key", "round_num").n_unique().alias("n")).iter_rows())
    low_exposure = sorted(m for m in test["map"].unique().to_list() if train_rounds.get(m, 0) < 500)

    reports = []
    rate = train_df.group_by("map").agg(pl.col("ct_win").cast(pl.Float64).mean().alias("p"))
    p = test.join(rate, on="map", how="left")["p"].fill_null(float(train_df["ct_win"].cast(pl.Float64).mean())).to_numpy()
    reports.append(_report("map_average", test, p))
    reports.append(_report("logistic", test, _fit_logistic(train_df, maps)(test)))
    gc.collect()

    models_dir = MODELS / out
    models_dir.mkdir(parents=True, exist_ok=True)
    resolved = resolve_device(device)

    full_p = None
    for name, features in variants.items():
        # `replication` keeps the paper's recipe; everything else gets the regularized one.
        is_rep = name == "replication"
        grid = GRID if is_rep else GRID_FULL
        es_rounds = None if is_rep else 50
        n_est_search = 100 if is_rep else 2000
        mc = None if is_rep else _monotone_constraints(features)

        fit = train_df.filter(pl.col("key").is_in(fit_keys))
        val = train_df.filter(pl.col("key").is_in(val_keys))
        yf = fit["ct_win"].cast(pl.Int8).to_numpy()
        yv = val["ct_win"].cast(pl.Int8).to_numpy()
        wf = None if is_rep else _round_weights(fit)
        qdm_fit = _make_qdm(fit, features, maps, yf, weight=wf)
        qdm_val = _make_qdm(val, features, maps, yv, ref=qdm_fit)
        del fit, val, yf, wf
        gc.collect()

        tried = []
        for p_grid in grid:
            bst = _train_booster(
                qdm_fit,
                p_grid,
                n_estimators=n_est_search,
                evals=None if is_rep else [(qdm_val, "val")],
                early_stopping_rounds=es_rounds,
                monotone_constraints=mc,
                device=resolved,
            )
            v_loss = ev.scores(yv, _predict_booster(bst, qdm_val))["log_loss"]
            score_item = {**p_grid, "val_log_loss": v_loss}
            best_it = getattr(bst, "best_iteration", None)
            if best_it is not None:
                score_item["best_iteration"] = int(best_it)
            tried.append(score_item)
            del bst
        del qdm_fit, qdm_val, yv
        gc.collect()

        best = min(tried, key=lambda t: t["val_log_loss"])
        params = {k: v for k, v in best.items() if k not in ("val_log_loss", "best_iteration")}
        n_est_final = (int(best["best_iteration"]) + 1) if "best_iteration" in best else 100

        yt = train_df["ct_win"].cast(pl.Int8).to_numpy()
        wt = None if is_rep else _round_weights(train_df)
        qdm_train = _make_qdm(train_df, features, maps, yt, weight=wt)
        del yt, wt
        gc.collect()

        model = _train_booster(
            qdm_train,
            params,
            n_estimators=n_est_final,
            monotone_constraints=mc,
            device=resolved,
        )
        del qdm_train
        gc.collect()
        model.save_model(models_dir / f"{name}.json")

        p_test = _predict_frame(model, test, features, maps)
        if name == "full":
            full_p = p_test

        r = _report(f"xgboost_{name}", test, p_test)
        gain = model.get_score(importance_type="gain")
        del model
        gc.collect()
        total = sum(gain.values()) or 1
        r_params = dict(params)
        if "best_iteration" in best:
            r_params["best_iteration"] = best["best_iteration"]
            r_params["n_estimators"] = n_est_final
        r.update({"params": r_params, "grid": tried, "features": features,
                  "importance": {f: round(100 * gain.get(f, 0) / total, 1) for f in features}})
        reports.append(r)

    gate = _gate(test, full_p)
    secondary_gate = None
    if low_exposure:
        mask = ~test["map"].is_in(low_exposure)
        if mask.any():
            secondary_gate = {**_gate(test.filter(mask), full_p[mask.to_numpy()]), "excluded_maps": low_exposure}
    meta = {
        "built": date.today().isoformat(), "test_from": test_from, "nav_release": NAV_RELEASE, "maps": maps,
        "unseen_test_maps": unseen,
        "low_exposure_test_maps": low_exposure,
        "split": {"fit": [fit_refs[0].date, fit_refs[-1].date] if fit_refs else None,
                  "validation": [val_refs[0].date, val_refs[-1].date], "test": [test_refs[0].date, test_refs[-1].date]},
        "maps_count": {"train": len(train_refs), "test": len(test_refs)},
        "states": {"train": train_df.height, "test": test.height},
        "gate": gate, "secondary_gate": secondary_gate, "reports": reports,
    }
    (models_dir / "report.json").write_text(json.dumps(meta, indent=2, default=float))
    print(f"train {len(train_refs)} maps ({train_df.height} states) to {train_refs[-1].date}; "
          f"test {len(test_refs)} maps ({test.height} states) from {test_refs[0].date}")
    for r in reports:
        print(f"  {r['model']:<22} log loss {r['log_loss']:.4f} [{r['ci']['log_loss'][0]:.4f}, {r['ci']['log_loss'][1]:.4f}]"
              f"  brier {r['brier']:.4f}  auc {r['auc']:.4f}  slope {r['calibration']['slope']:.3f}")
    print(f"Gate: {_gate_line(gate)}")
    if secondary_gate:
        print(f"Gate (excluding {', '.join(low_exposure)}): {_gate_line(secondary_gate)}")
    if unseen:
        print(f"  maps in test but not train: {', '.join(unseen)}")
    if low_exposure:
        print(f"  test maps with <500 train rounds: {', '.join(low_exposure)}")
    return 0 if gate["passed"] else 2


def _round_team_elo(ref: MapRef) -> pl.DataFrame | None:
    """Per round, the pre-map Elo of the CT and T teams (null where a team has no rating)."""
    path = ref.dir / "rounds.parquet"
    if not path.exists():
        return None
    elo = {team: float(r) for team, r in ref.elo}
    rounds = pl.read_parquet(path, columns=["round_num", "ct_lp_team", "t_lp_team"])
    return rounds.select(
        "round_num",
        pl.col("ct_lp_team").replace_strict(elo, default=None, return_dtype=pl.Float64).alias("ct_elo"),
        pl.col("t_lp_team").replace_strict(elo, default=None, return_dtype=pl.Float64).alias("t_elo"),
    )


def _unprefixed(events: pl.DataFrame, features: list[str], prefix: str) -> pl.DataFrame:
    cols = {f"{prefix}_{c}": c for c in features if f"{prefix}_{c}" in events.columns}
    return events.select(*(pl.col(k).alias(v) for k, v in cols.items()), *(c for c in features if c not in cols.values()))


def _frozen(path: Path) -> bool:
    """Credits written by an out-of-sample run carry `model_version` and stay as they are until a full re-credit."""
    return path.exists() and "model_version" in pl.read_parquet_schema(path)


NEUTRAL = ("coarse", "fine", "base")


def credit(model_dir: str, recredit: bool = False) -> int:
    """Values every map with its own month's out-of-sample model (book.py). Maps already credited are frozen unless
    `recredit`; the neutral tables are refit, from maps before test_from, only on a full re-credit."""
    from .book import ModelBook
    from .features import with_derived

    book = ModelBook(model_dir)
    test_from = book.index["test_from"]
    refs = catalog()
    league_elo = float(np.mean([r for ref in refs if ref.date < test_from for _, r in ref.elo]))
    CREDITS.mkdir(parents=True, exist_ok=True)
    tables_exist = all((CREDITS / f"neutral-{n}.parquet").exists() for n in NEUTRAL)
    if not recredit and not tables_exist:
        print("No neutral tables yet; run `cs2wp credit --recredit` once.")
        return 1

    valued, skipped, frozen = {}, [], 0
    for ref in refs:
        out = CREDITS / f"{ref.slug}.parquet"
        if not recredit and _frozen(out):
            frozen += 1
            continue
        epath = _state_dir(ref) / "events.parquet"
        events = pl.read_parquet(epath) if epath.exists() else None
        if events is None or events.is_empty():
            continue
        e = book.entry(ref.date[:7])
        if e is None:
            skipped.append(ref.key)
            continue
        events = with_derived(with_derived(events, "pre_"), "post_")
        shift = book.shift(ref.date, refs)
        def p(ev: pl.DataFrame, prefix: str, e=e, shift=shift) -> np.ndarray:
            return book.predict(e, _unprefixed(ev, e["features"], prefix), shift)

        own_average = {}
        teams = _round_team_elo(ref)
        if teams is not None:
            joined = events.join(teams, on="round_num", how="left")
            for side, diff in (("ct", league_elo - pl.col("t_elo")), ("t", pl.col("ct_elo") - league_elo)):
                shifted = joined.with_columns(diff.alias("elo_diff_ct"))
                own_average[side] = (p(shifted, "pre"), p(shifted, "post"))
        grid = with_derived(pl.read_parquet(_state_dir(ref) / "grid.parquet"))
        first = grid.sort("round_num", "tick").group_by("round_num", maintain_order=True).first()
        p0 = first.select("round_num", "ct_win").with_columns(pl.Series("p0", book.predict(e, first, shift)))
        version = e["version"] + (f"+shift{shift:+.4f}" if shift else "")
        valued[ref.key] = (ref, cr.with_values(events, p(events, "pre"), p(events, "post"), own_average), p0, version)

    if recredit:
        train_events = pl.concat([v for _, v, _, _ in valued.values() if v["date"][0] < test_from], how="diagonal_relaxed")
        tables = cr.neutral_tables(train_events)
        for name, t in tables.items():
            t.write_parquet(CREDITS / f"neutral-{name}.parquet")
        print(f"neutral buckets fit on {train_events.height} events before {test_from}")
    else:
        tables = {n: pl.read_parquet(CREDITS / f"neutral-{n}.parquet") for n in NEUTRAL}

    checks = []
    for key, (ref, events, p0, version) in valued.items():
        credits = cr.attribute(cr.neutral_values(events, tables)).with_columns(pl.lit(version).alias("model_version"))
        credits.write_parquet(CREDITS / f"{ref.slug}.parquet")
        roster = pl.read_parquet(_state_dir(ref) / "roster.parquet").with_columns(pl.col("round_num").cast(pl.Int64))
        checks.append(cr.conservation(events.with_columns(pl.col("round_num").cast(pl.Int64)), credits, roster,
                                      p0.with_columns(pl.col("round_num").cast(pl.Int64)))
                      .with_columns(pl.lit(key).alias("key"), pl.lit(ref.date).alias("date"), pl.lit(version).alias("model_version")))
    print(f"credited {len(valued)} maps, {frozen} frozen, {len(skipped)} without a model for their month")
    if skipped:
        print(f"  no model: {', '.join(skipped[:10])}{' …' if len(skipped) > 10 else ''} "
              f"(run `cs2wp monthly --model {model_dir}`)")
    if checks:
        conservation_report(pl.concat(checks, how="diagonal_relaxed"))
        team_drift(refs)
    return 0


def team_drift(refs: list[MapRef]) -> pl.DataFrame:
    """Per team per map, "time-and-position value": the win probability that moved toward the team between events,
    which WPA credits to no player (credit.conservation's `drift`). Zero-sum between the two teams in each round.
    Written to REPORTS/team_drift.parquet with a per-side split."""
    path = REPORTS / "conservation.parquet"
    if not path.exists():
        return pl.DataFrame()
    drift = pl.read_parquet(path).select("key", "round_num", "drift")
    by_key = {r.key: r for r in refs}
    frames = []
    for key in drift["key"].unique().to_list():
        ref = by_key.get(key)
        if ref is None or not (ref.dir / "rounds.parquet").exists():
            continue
        frames.append(pl.read_parquet(ref.dir / "rounds.parquet", columns=["round_num", "ct_lp_team", "t_lp_team"])
                      .with_columns(pl.col("round_num").cast(pl.Int64), pl.lit(key).alias("key"),
                                    pl.lit(ref.date).alias("date"), pl.lit(ref.map).alias("map")))
    teams = pl.concat(frames).join(drift, on=["key", "round_num"], how="inner")
    long = pl.concat([
        teams.select("key", "date", "map", pl.col("ct_lp_team").alias("lp_team"), pl.lit("ct").alias("side"),
                     pl.col("drift").alias("value")),
        teams.select("key", "date", "map", pl.col("t_lp_team").alias("lp_team"), pl.lit("t").alias("side"),
                     (-pl.col("drift")).alias("value")),
    ]).filter(pl.col("lp_team").is_not_null())
    out = (
        long.group_by("key", "date", "map", "lp_team")
        .agg(pl.len().alias("rounds"), pl.col("value").sum().alias("time_position"),
             pl.col("value").filter(pl.col("side") == "ct").sum().alias("time_position_ct"),
             pl.col("value").filter(pl.col("side") == "t").sum().alias("time_position_t"))
        .with_columns((pl.col("time_position") / pl.col("rounds")).alias("time_position_per_round"))
        .sort("date", "key", "lp_team")
    )
    REPORTS.mkdir(parents=True, exist_ok=True)
    out.write_parquet(REPORTS / "team_drift.parquet")
    print(f"time-and-position value for {out.height} team-maps in {REPORTS / 'team_drift.parquet'}")
    return out


def conservation_report(new: pl.DataFrame) -> dict:
    """Merges this run's per-round checks into REPORTS/conservation.parquet and summarizes every credited round."""
    REPORTS.mkdir(parents=True, exist_ok=True)
    path = REPORTS / "conservation.parquet"
    rows = new
    if path.exists():
        rows = pl.concat([pl.read_parquet(path).filter(~pl.col("key").is_in(new["key"].unique())), new],
                         how="diagonal_relaxed")
    rows.write_parquet(path)
    n = rows.height
    def abs_sum(c: str) -> float:
        return float(rows[c].abs().sum())

    reasons = (rows.select(pl.col("reasons").explode()).drop_nulls().group_by("reasons").len()
               .sort("len", descending=True).to_dicts())
    report = {
        "rounds": n, "passed": int(rows["passed"].sum()),
        "identity_max_error": float(rows["identity_error"].abs().max()),
        "share_of_abs_target": {c: abs_sum(c) / max(abs_sum("target"), 1e-12) for c in ("events", "drift", "end")},
        "mean_abs": {c: float(rows[c].abs().mean()) for c in ("target", "events", "drift", "end", "leak_ct", "leak_t")},
        "fail_reasons": {r["reasons"]: r["len"] for r in reasons},
        "worst": rows.sort((pl.col("credit_ct") - pl.col("target")).abs(), descending=True).head(10)
        .select("key", "round_num", "target", "credit_ct", "events", "drift", "end", "leak_ct", "reasons").to_dicts(),
    }
    (REPORTS / "conservation.json").write_text(json.dumps(report, indent=2, default=float))
    print(f"conservation: {report['passed']}/{n} rounds conserve exactly; identity error ≤ {report['identity_max_error']:.1e}")
    for reason, count in report["fail_reasons"].items():
        print(f"  {count:>7} rounds: {reason}")
    print("  mean |·| per round: " + ", ".join(f"{k} {v:.3f}" for k, v in report["mean_abs"].items()))
    return report


def player_rounds(refs: list[MapRef]) -> pl.DataFrame:
    """Per player per map: rounds, summed credit (three versions), box-score counts and HLTV numbers."""
    rows = []
    for ref in refs:
        cpath = CREDITS / f"{ref.slug}.parquet"
        rpath = _state_dir(ref) / "roster.parquet"
        if not cpath.exists() or not rpath.exists():
            continue
        roster = pl.read_parquet(rpath)
        credits = pl.read_parquet(cpath).group_by("steamid").agg(
            pl.col("wpa").sum(), pl.col("nwpa_event").sum(), pl.col("nwpa_mancount").sum()
        )
        stats = map_stats(ref, roster).join(credits, on="steamid", how="left").fill_null(0)
        players = ref.table("players").select("steamid", "name", "lp_player", "lp_team")
        occurrence = sum(1 for o in refs if o.hltv_match_id == ref.hltv_match_id and o.map == ref.map
                         and o.map_number < ref.map_number)
        hltv = ratings_for(ref.hltv_match_id, ref.map, occurrence, players)
        stats = stats.join(players, on="steamid", how="left").join(hltv, on="steamid", how="left")
        rows.append(stats.with_columns(pl.lit(ref.map).alias("map")))
    return pl.concat(rows, how="diagonal_relaxed") if rows else pl.DataFrame()


def _summed(df: pl.DataFrame, by: list[str]) -> pl.DataFrame:
    counts = ("rounds", "kills", "deaths", "assists", "damage", "kast_rounds", "wpa", "nwpa_event", "nwpa_mancount")
    agg = df.group_by(by).agg(
        *(pl.col(c).sum() for c in counts),
        (pl.col("rating3") * pl.col("rounds")).sum().alias("_r3"),
        (pl.col("swing") * pl.col("rounds")).sum().alias("_sw"),
        pl.col("rounds").filter(pl.col("rating3").is_not_null()).sum().alias("_hr"),
        pl.col("lp_player").drop_nulls().first(), pl.col("name").drop_nulls().first(),
    )
    agg = rating2(agg).with_columns(
        *(pl.col(c) / pl.col("rounds") for c in ("wpa", "nwpa_event", "nwpa_mancount")),
        pl.when(pl.col("_hr") > 0).then(pl.col("_r3") / pl.col("_hr")).alias("rating3"),
        pl.when(pl.col("_hr") > 0).then(pl.col("_sw") / pl.col("_hr")).alias("swing"),
    )
    return agg.drop("_r3", "_sw", "_hr")


METRICS = ("wpa", "nwpa_event", "nwpa_mancount", "rating2_approx", "rating3", "swing", "kd", "adr")


def validate(test_from: str, min_month_rounds: int = 100, min_rounds: int = 300) -> int:
    refs = [r for r in catalog() if r.date >= test_from]
    per_map = player_rounds(refs)
    if per_map.is_empty():
        print("No credited maps in the window; run `cs2wp credit` first.")
        return 1
    per_map = per_map.with_columns(pl.col("date").str.slice(0, 7).alias("month"))
    monthly = _summed(per_map, ["steamid", "month"]).filter(pl.col("rounds") >= min_month_rounds)
    months = sorted(monthly["month"].unique().to_list())
    pairs = []
    for a, b in zip(months, months[1:]):
        x = monthly.filter(pl.col("month") == a)
        y = monthly.filter(pl.col("month") == b)
        pairs.append(x.join(y, on="steamid", suffix="_next"))
    paired = pl.concat(pairs) if pairs else pl.DataFrame()
    stability = {}
    for m in METRICS:
        if paired.is_empty():
            break
        d = paired.select(m, f"{m}_next").drop_nulls().drop_nans()
        stability[m] = {"r": float(np.corrcoef(d[m], d[f"{m}_next"])[0, 1]) if d.height > 2 else None, "pairs": d.height}

    overall = _summed(per_map, ["steamid"]).filter(pl.col("rounds") >= min_rounds)
    with_kd = {}
    for m in METRICS:
        if m == "kd":
            continue
        d = overall.select(m, "kd").drop_nulls().drop_nans()
        with_kd[m] = {"r": float(np.corrcoef(d[m], d["kd"])[0, 1]) if d.height > 2 else None, "players": d.height}

    boot = bootstrap(refs, overall["steamid"].to_list())
    players = overall.join(boot, on="steamid", how="left").sort("wpa", descending=True)
    REPORTS.mkdir(parents=True, exist_ok=True)
    players.write_parquet(REPORTS / "player_wpa.parquet")
    report = {"window_from": test_from, "maps": len(refs), "players": overall.height,
              "month_to_month": stability, "with_kd": with_kd,
              "paper": {"month_to_month": {"wpa": 0.40, "rating2": 0.29}, "with_kd": {"wpa": 0.73, "rating2": 0.93}}}
    (REPORTS / "validation.json").write_text(json.dumps(report, indent=2))
    print(f"{len(refs)} maps from {test_from}, {overall.height} players with {min_rounds}+ rounds")
    print(f"  {'metric':<16} month-to-month r (pairs)   r with K/D (players)")
    for m in METRICS:
        s, k = stability.get(m, {}), with_kd.get(m, {"r": 1.0, "players": overall.height})
        fmt = lambda v: f"{v:.3f}" if v is not None else "  n/a"
        print(f"  {m:<16} {fmt(s.get('r'))} ({s.get('pairs', 0)})           {fmt(k['r'])} ({k['players']})")
    return 0


def bootstrap(refs: list[MapRef], steamids: list[int], n: int = 100, seed: int = 0) -> pl.DataFrame:
    """The paper's density estimate: resample each player's rounds with replacement, 100 times."""
    rounds = []
    for ref in refs:
        cpath, rpath = CREDITS / f"{ref.slug}.parquet", _state_dir(ref) / "roster.parquet"
        if not cpath.exists() or not rpath.exists():
            continue
        played = pl.read_parquet(rpath).select("steamid", "round_num").with_columns(pl.lit(ref.key).alias("key"))
        c = pl.read_parquet(cpath).group_by("steamid", "round_num").agg(
            pl.col("wpa").sum(), pl.col("nwpa_event").sum(), pl.col("nwpa_mancount").sum()
        )
        rounds.append(played.join(c, on=["steamid", "round_num"], how="left").fill_null(0))
    if not rounds:
        return pl.DataFrame()
    allr = pl.concat(rounds).filter(pl.col("steamid").is_in(steamids))
    rng = np.random.default_rng(seed)
    out = []
    for (sid,), g in allr.group_by("steamid"):
        row = {"steamid": sid}
        for col in ("wpa", "nwpa_event", "nwpa_mancount"):
            v = g[col].to_numpy()
            means = rng.choice(v, size=(n, len(v)), replace=True).mean(axis=1)
            row.update({f"{col}_p5": float(np.quantile(means, 0.05)), f"{col}_p50": float(np.quantile(means, 0.5)),
                        f"{col}_p95": float(np.quantile(means, 0.95))})
        out.append(row)
    return pl.DataFrame(out).with_columns(pl.col("steamid").cast(pl.UInt64))
