"""The steps behind each CLI command."""

import json
from datetime import date

import numpy as np
import polars as pl

from . import credit as cr
from . import evaluate as ev
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
# Each logged in docs/wp-experiments.md; a variant replaces `full` only if it lowers test log loss.
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


def build_states(only: str | None = None) -> int:
    refs = catalog()
    if only:
        refs = [r for r in refs if r.key == only]
    plants = map_plants(catalog())
    sites: dict[str, SiteDistance] = {}
    coverage = []
    for ref in refs:
        if ref.map not in sites:
            sites[ref.map] = SiteDistance(ref.map, plants[ref.map])
        sd = sites[ref.map]
        before = dict(sd.stats)
        grid, events, roster = build(ref, sd)
        out = _state_dir(ref)
        out.mkdir(parents=True, exist_ok=True)
        grid.write_parquet(out / "grid.parquet")
        events.write_parquet(out / "events.parquet")
        roster.write_parquet(out / "roster.parquet")
        hit = {k: sd.stats[k] - before[k] for k in sd.stats}
        total = sum(hit.values()) or 1
        coverage.append({"key": ref.key, "map": ref.map, "month": ref.date[:7],
                         "on_mesh": hit["area"] / total, "snapped": hit["snapped"] / total, "missed": hit["missed"] / total})
        print(f"{ref.key} {ref.map} {ref.date}: {grid.height} grid states, {events.height} events, "
              f"{100 * (1 - hit['missed'] / total):.1f}% positions on the nav mesh")
    STATES.mkdir(parents=True, exist_ok=True)
    (STATES / "coverage.json").write_text(json.dumps({"nav_release": NAV_RELEASE, "maps": coverage}, indent=2))
    return 0


def _load(refs: list[MapRef], name: str) -> pl.DataFrame:
    frames = [pl.read_parquet(_state_dir(r) / f"{name}.parquet") for r in refs if (_state_dir(r) / f"{name}.parquet").exists()]
    frames = [f for f in frames if not f.is_empty()]
    return pl.concat(frames, how="diagonal_relaxed") if frames else pl.DataFrame()


def _xy(df: pl.DataFrame, features: list[str], maps: list[str]):
    import pandas as pd

    x = df.select(features).to_pandas()
    x["map"] = pd.Categorical(x["map"], categories=maps)
    x["bomb_site"] = pd.Categorical(x["bomb_site"], categories=["none", "A", "B"])
    y = df["ct_win"].cast(pl.Int8).to_numpy()
    # Rounds per state, constant so the total weight equals the round count without reweighting by round length:
    # T-won rounds run longer, so 1/states-in-round leaned the model toward CT.
    if "key" in df.columns and "round_num" in df.columns and not df.is_empty():
        rounds = df.select(pl.struct("key", "round_num").n_unique()).item()
        w = np.full(df.height, rounds / df.height, dtype=float)
    else:
        w = np.ones(df.height, dtype=float)
    return x, y, w


def _fit_xgb(
    x,
    y,
    params: dict,
    sample_weight=None,
    n_estimators: int = 100,
    eval_set=None,
    early_stopping_rounds: int | None = None,
    monotone_constraints: tuple[int, ...] | None = None,
):
    from xgboost import XGBClassifier

    kw = dict(
        n_estimators=n_estimators,
        tree_method="hist",
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


def train(test_from: str, out: str, ablations: bool = False) -> int:
    fit_refs, val_refs, train_refs, test_refs = split(catalog(), test_from)
    if not train_refs or not test_refs:
        print(f"Need maps on both sides of {test_from}: {len(train_refs)} train, {len(test_refs)} test.")
        return 1
    fit, val, train_df, test = (_load(x, "grid") for x in (fit_refs, val_refs, train_refs, test_refs))
    maps = sorted(train_df["map"].unique().to_list())
    unseen = sorted(set(test["map"].unique().to_list()) - set(maps))
    train_rounds = dict(train_df.group_by("map").agg(pl.struct("key", "round_num").n_unique().alias("n")).iter_rows())
    low_exposure = sorted(m for m in test["map"].unique().to_list() if train_rounds.get(m, 0) < 500)

    reports = []
    rate = train_df.group_by("map").agg(pl.col("ct_win").cast(pl.Float64).mean().alias("p"))
    p = test.join(rate, on="map", how="left")["p"].fill_null(float(train_df["ct_win"].cast(pl.Float64).mean())).to_numpy()
    reports.append(_report("map_average", test, p))
    reports.append(_report("logistic", test, _fit_logistic(train_df, maps)(test)))

    models_dir = MODELS / out
    models_dir.mkdir(parents=True, exist_ok=True)

    full_p = None
    variants = {**FEATURES, **(ABLATIONS if ablations else {})}
    for name, features in variants.items():
        xf, yf, wf = _xy(fit, features, maps)
        xv, yv, _ = _xy(val, features, maps)
        xt, yt, wt = _xy(train_df, features, maps)
        xs, _, _ = _xy(test, features, maps)

        # `replication` keeps the paper's recipe; everything else gets the regularized one.
        is_rep = name == "replication"
        grid = GRID if is_rep else GRID_FULL
        sw_fit = None if is_rep else wf
        sw_train = None if is_rep else wt
        es_rounds = None if is_rep else 50
        eval_s = None if is_rep else [(xv, yv)]
        n_est_search = 100 if is_rep else 2000
        mc = None if is_rep else _monotone_constraints(features)

        tried = []
        for p_grid in grid:
            m = _fit_xgb(
                xf,
                yf,
                p_grid,
                sample_weight=sw_fit,
                n_estimators=n_est_search,
                eval_set=eval_s,
                early_stopping_rounds=es_rounds,
                monotone_constraints=mc,
            )
            v_loss = ev.scores(yv, m.predict_proba(xv)[:, 1])["log_loss"]
            score_item = {**p_grid, "val_log_loss": v_loss}
            if getattr(m, "best_iteration", None) is not None:
                score_item["best_iteration"] = int(m.best_iteration)
            tried.append(score_item)

        best = min(tried, key=lambda t: t["val_log_loss"])
        params = {k: v for k, v in best.items() if k not in ("val_log_loss", "best_iteration")}
        n_est_final = (int(best["best_iteration"]) + 1) if "best_iteration" in best else 100

        model = _fit_xgb(
            xt,
            yt,
            params,
            sample_weight=sw_train,
            n_estimators=n_est_final,
            monotone_constraints=mc,
        )
        model.save_model(models_dir / f"{name}.json")

        p_test = model.predict_proba(xs)[:, 1]
        if name == "full":
            full_p = p_test

        r = _report(f"xgboost_{name}", test, p_test)
        gain = model.get_booster().get_score(importance_type="gain")
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


def _predict(model, features: list[str], maps: list[str], events: pl.DataFrame, prefix: str) -> np.ndarray:
    cols = {f"{prefix}_{c}": c for c in features if f"{prefix}_{c}" in events.columns}
    frame = events.select(*(pl.col(k).alias(v) for k, v in cols.items()), *(c for c in features if c not in cols.values()))
    x, _, _ = _xy(frame.with_columns(pl.lit(False).alias("ct_win")), features, maps)
    return model.predict_proba(x)[:, 1]


def credit(model_dir: str) -> int:
    from xgboost import XGBClassifier

    root = MODELS / model_dir
    meta = json.loads((root / "report.json").read_text())
    model = XGBClassifier()
    model.load_model(root / "full.json")
    features, maps, test_from = FEATURES["full"], meta["maps"], meta["test_from"]

    valued = {}
    for ref in catalog():
        events = pl.read_parquet(_state_dir(ref) / "events.parquet") if (_state_dir(ref) / "events.parquet").exists() else None
        if events is None or events.is_empty():
            continue
        valued[ref.key] = cr.with_values(events, _predict(model, features, maps, events, "pre"),
                                         _predict(model, features, maps, events, "post"))
    train_events = pl.concat([v for k, v in valued.items() if v["date"][0] < test_from], how="diagonal_relaxed")
    tables = cr.neutral_tables(train_events)
    CREDITS.mkdir(parents=True, exist_ok=True)
    for name, t in tables.items():
        t.write_parquet(CREDITS / f"neutral-{name}.parquet")

    for key, events in valued.items():
        cr.attribute(cr.neutral_values(events, tables)).write_parquet(CREDITS / f"{key.replace('/', '-')}.parquet")
    print(f"credited {len(valued)} maps; neutral buckets fit on {train_events.height} training events")
    return 0


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
