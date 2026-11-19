"""Veto value lost (Phase 7): a walk-forward map-strength model, its gate against Elo's map probability, and the
series win probability each veto step gave up against the model's best option."""

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from itertools import product

import numpy as np
import polars as pl
from cs2demos.liquipedia import demo_map_name
from sklearn.linear_model import LogisticRegression

from . import warcheck
from .duelstats import _corr, _mults, _z_ci
from .igls import load_table
from .paths import ELO_MAPS, ELO_SERIES, IGL_TABLE, PUBLIC_WAR, REPO_ROOT, VETO_STEPS, VETO_TEAMS, VETOES, WAR_REPORTS
from .publish import SOURCE
from .teamfactor import assign_stints

MODEL_VERSION = "veto-v2"
TRAIN_YEAR = "2025"
TEST_FROM = "2026-01-01"
LN10 = math.log(10)
DAY = 86400.0
# Shrinkage `n / (n + k)` in decayed maps, and the decay's e-folding time in days (inf = no decay).
K_GRID = (2.0, 5.0, 10.0, 20.0, 40.0)
TAU_GRID = (90.0, 180.0, 365.0, math.inf)
# Prior vetoes added to a lineage's ban and pick counts.
RATE_PRIOR = 2.0
FEATURES = ("du", "pick", "ban_rate", "pick_rate")
PATTERNS = {"bbbbbbd": 1, "bbppbbd": 3, "bbppppd": 5}
MIN_HALF_SERIES = 15
MIN_QUARTER_SERIES = 5


def elo_params() -> dict:
    return json.loads((REPO_ROOT / "scripts" / "lib" / "elo" / "params.json").read_text())


def load_series() -> list[dict]:
    """Every series with its played maps, in time order, each map with its demo name and pre-series base logit."""
    scale = elo_params()["scale"]
    maps_by: dict[str, list[dict]] = {}
    with ELO_MAPS.open() as f:
        for line in f:
            r = json.loads(line)
            maps_by.setdefault(r["match2id"], []).append(r)
    series = []
    with ELO_SERIES.open() as f:
        for line in f:
            s = json.loads(line)
            ms = sorted(maps_by.get(s["match2id"], []), key=lambda m: m["index"])
            s["base"] = (s["ratings"][0] - s["ratings"][1]) * LN10 / scale
            s["offsets"] = [{demo_map_name(k): v * LN10 / scale for k, v in o.items()} for o in s["offsets"]]
            s["played"] = [{"map": demo_map_name(m["map"]), "y": int(m["rounds"][0] > m["rounds"][1]), "p_engine": m["p"]}
                           for m in ms]
            s["date"] = datetime.fromtimestamp(s["t"], timezone.utc).date().isoformat()
            series.append(s)
    series.sort(key=lambda s: (s["t"], s["match2id"]))
    return series


def load_vetoes() -> dict[str, pl.DataFrame]:
    if not VETOES.exists():
        raise FileNotFoundError(f"{VETOES} not found; run `cs2demos match-pages` first")
    v = pl.read_parquet(VETOES / "*.parquet").sort("lp_match2id", "step")
    return {k[0]: g for k, g in v.group_by("lp_match2id")}


def pattern(steps: pl.DataFrame) -> str:
    return "".join(a[0] for a in steps["action"].to_list())


@dataclass
class State:
    """Walk-forward per-lineage state: decayed map residuals, and own ban and pick counts from earlier vetoes."""

    k: float
    tau: float

    def __post_init__(self):
        self.res: dict[tuple[int, str], list[float]] = {}
        self.vetoes: dict[int, list] = {}

    def u(self, lineage: int, m: str, t: float) -> float:
        s = self.res.get((lineage, m))
        if s is None:
            return 0.0
        d = 1.0 if math.isinf(self.tau) else math.exp(-(t - s[2]) / (self.tau * DAY))
        return s[0] * d / (s[1] * d + self.k)

    def centred_u(self, lineage: int, m: str, t: float, pool) -> float:
        """`u` on `m` minus the lineage's unweighted mean `u` over `pool`, uncentred for an empty pool. The pool mean
        is "this team beats its Elo overall", which predicts its next maps with the wrong sign."""
        if not pool:
            return self.u(lineage, m, t)
        return self.u(lineage, m, t) - sum(self.u(lineage, x, t) for x in pool) / len(pool)

    def add_residual(self, lineage: int, m: str, r: float, t: float) -> None:
        s = self.res.get((lineage, m))
        if s is None:
            self.res[(lineage, m)] = [r, 1.0, t]
            return
        d = 1.0 if math.isinf(self.tau) else math.exp(-(t - s[2]) / (self.tau * DAY))
        s[0], s[1], s[2] = s[0] * d + r, s[1] * d + 1.0, t

    def rates(self, lineage: int, m: str) -> tuple[float, float]:
        """Own ban and pick rate on `m`, centred on the lineage's mean over the pool and shrunk by RATE_PRIOR vetoes."""
        v = self.vetoes.get(lineage)
        if v is None:
            return 0.0, 0.0
        n, bans, picks, pool_bans, pool_picks = v
        return ((bans.get(m, 0) - pool_bans) / (n + RATE_PRIOR), (picks.get(m, 0) - pool_picks) / (n + RATE_PRIOR))

    def add_veto(self, lineage: int, own: list[tuple[str, str]], pool_size: int) -> None:
        v = self.vetoes.setdefault(lineage, [0, {}, {}, 0.0, 0.0])
        v[0] += 1
        for action, m in own:
            counts = v[1] if action == "ban" else v[2]
            counts[m] = counts.get(m, 0) + 1
            v[3 if action == "ban" else 4] += 1.0 / pool_size


def feature_row(state: State, s: dict, m: str, pool) -> tuple[float, float, float]:
    la, lb = s["lineages"]
    ba, pa = state.rates(la, m)
    bb, pb = state.rates(lb, m)
    return state.centred_u(la, m, s["t"], pool) - state.centred_u(lb, m, s["t"], pool), ba - bb, pa - pb


def walk(series: list[dict], vetoes: dict[str, pl.DataFrame], k: float, tau: float,
         snapshot: bool = False) -> tuple[pl.DataFrame, dict[str, dict]]:
    """One row per played map with features from earlier series only. With `snapshot`, also every vetoed series'
    features for each map in its veto pool."""
    state = State(k, tau)
    rows: dict[str, list] = {c: [] for c in ("match2id", "event", "t", "index", "map", "y", "base", "engine_pre",
                                              "p_engine", "vetoed", *FEATURES)}
    snaps: dict[str, dict] = {}
    for s in series:
        veto = vetoes.get(s["match2id"])
        picker: dict[str, int] = {}
        pool = veto["map"].unique().to_list() if veto is not None else list(s["offsets"][0])
        if veto is not None:
            for r in veto.filter(pl.col("action") == "pick").iter_rows(named=True):
                picker[r["map"]] = 1 if r["opponent"] == 1 else -1
            if snapshot:
                snaps[s["match2id"]] = {m: feature_row(state, s, m, pool) for m in veto["map"].to_list()}
        for i, pm in enumerate(s["played"]):
            m = pm["map"]
            du, db, dp = feature_row(state, s, m, pool)
            pre = s["base"] + s["offsets"][0].get(m, 0.0) - s["offsets"][1].get(m, 0.0)
            for c, v in (("match2id", s["match2id"]), ("event", s["pagename"]), ("t", s["t"]), ("index", i), ("map", m),
                         ("y", pm["y"]), ("base", s["base"]), ("engine_pre", pre), ("p_engine", pm["p_engine"]),
                         ("vetoed", veto is not None), ("du", du), ("pick", float(picker.get(m, 0))),
                         ("ban_rate", db), ("pick_rate", dp)):
                rows[c].append(v)
        p_base = 1 / (1 + math.exp(-s["base"]))
        la, lb = s["lineages"]
        for pm in s["played"]:
            r = pm["y"] - p_base
            state.add_residual(la, pm["map"], r, s["t"])
            state.add_residual(lb, pm["map"], -r, s["t"])
        if veto is not None:
            pool = veto["map"].n_unique()
            for opp, lineage in ((1, la), (2, lb)):
                own = veto.filter(pl.col("opponent") == opp).select("action", "map").rows()
                state.add_veto(lineage, own, pool)
    df = pl.DataFrame(rows).with_columns(
        pl.from_epoch("t").dt.date().cast(pl.String).alias("date"))
    return df, snaps


def _sig(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-x))


def _ll(y: np.ndarray, p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def fit_coefs(df: pl.DataFrame, features: tuple[str, ...] = FEATURES) -> np.ndarray:
    """No-intercept logistic on the features with Elo's base logit as a fixed offset, by Newton's method."""
    X = df.select(features).to_numpy()
    y, off = df["y"].to_numpy().astype(float), df["base"].to_numpy()
    b = np.zeros(X.shape[1])
    for _ in range(50):
        p = _sig(off + X @ b)
        g = X.T @ (y - p)
        H = (X * (p * (1 - p))[:, None]).T @ X + 1e-6 * np.eye(X.shape[1])
        step = np.linalg.solve(H, g)
        b += step
        if np.abs(step).max() < 1e-10:
            break
    return b


def predict(df: pl.DataFrame, coefs: np.ndarray, features: tuple[str, ...] = FEATURES) -> np.ndarray:
    return _sig(df["base"].to_numpy() + df.select(features).to_numpy() @ coefs)


def tune(series: list[dict], vetoes: dict[str, pl.DataFrame]) -> dict:
    best = None
    grid = []
    for k, tau in product(K_GRID, TAU_GRID):
        df, _ = walk(series, vetoes, k, tau)
        train = df.filter(pl.col("date").str.starts_with(TRAIN_YEAR))
        coefs = fit_coefs(train)
        loss = float(_ll(train["y"].to_numpy(), predict(train, coefs)).mean())
        grid.append({"k": k, "tau": tau, "loss": loss})
        print(f"  k={k:g} tau={tau:g}d  2025 log loss {loss:.5f}  coefs {np.round(coefs, 3).tolist()}")
        if best is None or loss < best["loss"]:
            best = {"k": k, "tau": tau, "loss": loss, "coefs": coefs, "df": df}
    best["grid"] = grid
    return best


def gate(df: pl.DataFrame, coefs: np.ndarray) -> dict:
    """2026 played maps: model log loss against Elo's map probability at the series start, events resampled."""
    out = {}
    for name, sel in (("all", pl.lit(True)), ("vetoed", pl.col("vetoed"))):
        test = df.filter((pl.col("date") >= TEST_FROM) & sel)
        y = test["y"].to_numpy()
        model = _ll(y, predict(test, coefs))
        engine = _ll(y, _sig(test["engine_pre"].to_numpy()))
        in_series = _ll(y, test["p_engine"].to_numpy())
        base = _ll(y, _sig(test["base"].to_numpy()))
        lo, hi = warcheck.paired_ci(engine - model, test["event"].to_numpy())
        out[name] = {"maps": test.height, "events": test["event"].n_unique(), "model": float(model.mean()),
                     "engine": float(engine.mean()), "engine_in_series": float(in_series.mean()),
                     "base": float(base.mean()), "gain": float((engine - model).mean()), "gain_ci": (lo, hi)}
    out["passed"] = out["all"]["gain_ci"][0] > 0
    return out


def series_prob(logits: list[float], temp: float) -> float:
    """P(team A wins) when every map is played, maps independent; logits scaled by `temp` for Bo3 and Bo5."""
    n = len(logits)
    need = n // 2 + 1
    ps = [1 / (1 + math.exp(-(l * temp if n > 1 else l))) for l in logits]
    dist = [1.0]
    for p in ps:
        nxt = [0.0] * (len(dist) + 1)
        for w, q in enumerate(dist):
            nxt[w] += q * (1 - p)
            nxt[w + 1] += q * p
        dist = nxt
    return sum(dist[need:])


def solve_veto(base_logit: dict[str, float], gamma: float, steps: list[tuple[int, str]], temp: float):
    """Backward induction over the veto. `base_logit[m]` is A's map logit without the pick term; `steps` are
    (actor, action) with actor 1 = A, 2 = B, ending before the decider. Returns `value(i, remaining, picks)`, A's
    series probability with both teams playing the model's best option from step i on."""
    maps = tuple(sorted(base_logit))

    @lru_cache(maxsize=None)
    def value(i: int, remaining: frozenset, picks: frozenset) -> float:
        if i == len(steps):
            (decider,) = remaining
            logits = [base_logit[m] + (gamma if who == 1 else -gamma) for m, who in picks] + [base_logit[decider]]
            return series_prob(logits, temp)
        actor, action = steps[i]
        vals = [after(i, remaining, picks, m) for m in sorted(remaining)]
        return max(vals) if actor == 1 else min(vals)

    def after(i: int, remaining: frozenset, picks: frozenset, m: str) -> float:
        actor, action = steps[i]
        new_picks = picks | {(m, actor)} if action == "pick" else picks
        return value(i + 1, remaining - {m}, new_picks)

    return maps, value, after


def value_lost(base_logit: dict[str, float], gamma: float, veto: list[tuple[int, str, str]], temp: float) -> list[dict]:
    """One row per ban or pick: options, the acting team's best and chosen series probability, and `lost` ≥ 0."""
    steps = [(a, act) for a, act, _ in veto]
    maps, value, after = solve_veto(base_logit, gamma, steps, temp)
    remaining, picks = frozenset(maps), frozenset()
    out = []
    for i, (actor, action, chosen) in enumerate(veto):
        options = sorted(remaining)
        vals = {m: after(i, remaining, picks, m) for m in options}
        own = (lambda v: v) if actor == 1 else (lambda v: 1 - v)
        best = max(own(v) for v in vals.values())
        got = own(vals[chosen])
        out.append({"step": i + 1, "actor": actor, "action": action, "chosen": chosen, "options": options,
                    "best": next(m for m in options if own(vals[m]) == best), "value_best": best, "value_chosen": got,
                    "lost": max(0.0, best - got)})
        if action == "pick":
            picks = picks | {(chosen, actor)}
        remaining = remaining - {chosen}
    return out


def veto_steps(series: list[dict], vetoes: dict[str, pl.DataFrame], snaps: dict[str, dict], coefs: np.ndarray,
               temp: float) -> tuple[pl.DataFrame, dict]:
    c_u, gamma, c_ban, c_pick = coefs
    rows, skipped = [], {}
    for s in series:
        veto = vetoes.get(s["match2id"])
        if veto is None or s["match2id"] not in snaps:
            continue
        pat = pattern(veto)
        if pat not in PATTERNS or veto["map"].n_unique() != 7 or veto["opponent"].drop_nulls().n_unique() != 2:
            skipped[pat] = skipped.get(pat, 0) + 1
            continue
        feats = snaps[s["match2id"]]
        base_logit = {m: s["base"] + c_u * du + c_ban * db + c_pick * dp for m, (du, db, dp) in feats.items()}
        acts = [(int(r["opponent"]), r["action"], r["map"]) for r in veto.iter_rows(named=True) if r["action"] != "decider"]
        for r in value_lost(base_logit, gamma, acts, temp):
            lineage = s["lineages"][r["actor"] - 1]
            rows.append({"match2id": s["match2id"], "event": s["pagename"], "date": s["date"], "t": s["t"],
                         "best_of": PATTERNS[pat], "opponent": r["actor"], "lp_team": s["teams"][r["actor"] - 1],
                         "opponent_team": s["teams"][2 - r["actor"]], "lineage": lineage, "step": r["step"],
                         "action": r["action"], "chosen": r["chosen"], "best": r["best"], "options": r["options"],
                         "value_best": r["value_best"], "value_chosen": r["value_chosen"], "lost": r["lost"],
                         "model_version": MODEL_VERSION})
    df = pl.DataFrame(rows)
    df = df.with_columns(
        (pl.col("action") + " " + (pl.col("step").rank("ordinal").over("match2id", "action")).cast(pl.String))
        .alias("step_type"))
    return df, skipped


SERIES_VARIANTS = ("elo_veto", "model_veto", "model_pool")


def veto_series_probs(s: dict, veto: pl.DataFrame, feats: dict, coefs: np.ndarray, temp: float) -> dict[str, float]:
    """A's series probability from the actual veto's maps (picks plus decider) under Elo's map offsets and the map
    model, and from the map model averaged over the veto pool like Elo's v1."""
    c_u, gamma, c_ban, c_pick = coefs
    model = {m: s["base"] + c_u * du + c_ban * db + c_pick * dp for m, (du, db, dp) in feats.items()}
    elo = {m: s["base"] + s["offsets"][0].get(m, 0.0) - s["offsets"][1].get(m, 0.0) for m in feats}
    played = [(r["map"], int(r["opponent"]) if r["action"] == "pick" else 0)
              for r in veto.iter_rows(named=True) if r["action"] in ("pick", "decider")]
    pick_term = {0: 0.0, 1: gamma, 2: -gamma}
    p_pool = float(np.mean([1 / (1 + math.exp(-l)) for l in model.values()]))
    return {"elo_veto": series_prob([elo[m] for m, _ in played], temp),
            "model_veto": series_prob([model[m] + pick_term[who] for m, who in played], temp),
            "model_pool": series_prob([math.log(p_pool / (1 - p_pool))] * (len(played)), temp)}


def series_gate(series: list[dict], vetoes: dict[str, pl.DataFrame], snaps: dict[str, dict], coefs: np.ndarray,
                temp: float) -> dict:
    """Series log loss on vetoed series against Elo's v1 series probability, events resampled."""
    rows = []
    for s in series:
        veto = vetoes.get(s["match2id"])
        if veto is None or s["match2id"] not in snaps or s.get("p") is None:
            continue
        pat = pattern(veto)
        if pat not in PATTERNS or veto["map"].n_unique() != 7 or veto["opponent"].drop_nulls().n_unique() != 2:
            continue
        if PATTERNS[pat] != s["bestOf"]:
            continue
        rows.append({"event": s["pagename"], "date": s["date"], "best_of": PATTERNS[pat], "y": s["y"], "v1": s["p"],
                     **veto_series_probs(s, veto, snaps[s["match2id"]], coefs, temp)})
    df = pl.DataFrame(rows)
    out = {}
    slices = (("2026 vetoed", pl.col("date") >= TEST_FROM),
              ("2026 Bo1", (pl.col("date") >= TEST_FROM) & (pl.col("best_of") == 1)),
              ("2026 Bo3", (pl.col("date") >= TEST_FROM) & (pl.col("best_of") == 3)),
              ("before 2026 (in-sample coefs)", pl.col("date") < TEST_FROM))
    for name, sel in slices:
        d = df.filter(sel)
        if d.height == 0:
            continue
        y, events = d["y"].to_numpy().astype(float), d["event"].to_numpy()
        v1 = _ll(y, d["v1"].to_numpy())
        r = {"series": d.height, "events": d["event"].n_unique(), "v1": float(v1.mean())}
        for v in SERIES_VARIANTS:
            ll = _ll(y, d[v].to_numpy())
            r[v] = float(ll.mean())
            r[f"{v}_gain"] = float((v1 - ll).mean())
            r[f"{v}_ci"] = warcheck.paired_ci(v1 - ll, events)
        out[name] = r
    out["passed"] = out["2026 vetoed"]["model_veto_ci"][0] > 0
    return out


def series_gate_lines(sg: dict) -> list[str]:
    lines = ["", "## Series gate", "",
             "Series log loss on vetoed series against Elo's v1 series probability (map probability averaged over the "
             "active pool). `Elo, veto maps` and `Model, veto maps` play the actual picks and decider; `Model, pool` "
             "averages the map model over the veto pool. Gain is v1 minus variant; 90% interval resamples events.", "",
             "| Series | n | Events | v1 | Elo, veto maps | Model, veto maps | Model, pool |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    for name, r in sg.items():
        if name == "passed":
            continue
        cells = [f"{_f(r[v])} ({_f(r[f'{v}_gain'], 4, True)}, CI {_ci(r[f'{v}_ci'], 4)})" for v in SERIES_VARIANTS]
        lines.append(f"| {name} | {r['series']:,} | {r['events']} | {_f(r['v1'])} | " + " | ".join(cells) + " |")
    lines += ["", f"Veto-aware series odds (v2): **{'PASS' if sg['passed'] else 'FAIL'}** (passing needs the 2026 "
                  "`Model, veto maps` gain's lower bound above 0)."]
    return lines


def with_stints(steps: pl.DataFrame) -> pl.DataFrame:
    """Per (series, team): veto value lost in total, on bans and on picks, with the IGL stint."""
    per = steps.group_by("match2id", "event", "date", "t", "opponent", "lp_team", "opponent_team").agg(
        pl.col("lost").sum(), pl.col("lost").filter(pl.col("action") == "ban").sum().alias("lost_bans"),
        pl.col("lost").filter(pl.col("action") == "pick").sum().alias("lost_picks"))
    maps = per.select("match2id", "date", pl.col("lp_team").alias("team_a"), pl.col("opponent_team").alias("team_b"),
                      pl.lit(None, pl.UInt64).alias("igl_a"), pl.lit(None, pl.UInt64).alias("igl_b"))
    table = load_table(IGL_TABLE) if IGL_TABLE.exists() else None
    stints = assign_stints(maps, table).select("match2id", pl.col("team_a").alias("lp_team"),
                                               pl.col("stint_a").alias("stint_id"), pl.col("stint_label_a").alias("label"),
                                               pl.col("igl_name_a").alias("igl_player"))
    return per.join(stints, on=["match2id", "lp_team"]).sort("t", "match2id", "opponent")


def _unit(per: pl.DataFrame, unit_type: str) -> pl.DataFrame:
    return per.with_columns(pl.col("stint_id" if unit_type == "stint" else "lp_team").alias("unit"))


def split_half(per: pl.DataFrame, unit_type: str, resamples: int, seed: int = 0) -> dict:
    """Alternating-series split-half r of mean lost per series, units with MIN_HALF_SERIES+ series in each half."""
    d = _unit(per, unit_type).sort("t", "match2id").with_columns(
        (pl.int_range(pl.len()).over("unit") % 2).alias("half"))
    counts = d.group_by("unit", "half").len().pivot(on="half", index="unit", values="len").fill_null(0)
    keep = counts.filter((pl.col("0") >= MIN_HALF_SERIES) & (pl.col("1") >= MIN_HALF_SERIES))["unit"]
    d = d.filter(pl.col("unit").is_in(keep.implode()))
    if keep.len() < 5:
        return {"units": keep.len(), "r": None, "r_ci": (None, None), "half_series": None}
    units = sorted(keep.to_list())
    ui = {u: i for i, u in enumerate(units)}
    u_idx = np.array([ui[u] for u in d["unit"].to_list()])
    h = d["half"].to_numpy()
    lost = d["lost"].to_numpy()
    _, s_idx = np.unique(d["match2id"].to_numpy(), return_inverse=True)
    cell = 2 * u_idx + h

    def r_of(w: np.ndarray) -> float | None:
        num = np.bincount(cell, weights=w * lost, minlength=2 * len(units))
        den = np.bincount(cell, weights=w, minlength=2 * len(units))
        ok = (den[0::2] > 0) & (den[1::2] > 0)
        return _corr(num[0::2][ok] / den[0::2][ok], num[1::2][ok] / den[1::2][ok]) if ok.sum() >= 5 else None

    r = r_of(np.ones(len(lost)))
    boot = [r_of(m[s_idx]) for m in _mults(int(s_idx.max()) + 1, resamples, seed)]
    half_series = float(np.median(np.bincount(cell)))
    return {"units": len(units), "r": r, "r_ci": _z_ci(r, boot), "half_series": half_series}


def quarter_to_quarter(per: pl.DataFrame, unit_type: str, resamples: int, seed: int = 0) -> dict:
    """r of a unit's mean lost per series in one calendar quarter with the next quarter it played."""
    d = _unit(per, unit_type).with_columns(
        (pl.col("date").str.slice(0, 4) + "Q" + ((pl.col("date").str.slice(5, 2).cast(pl.Int64) - 1) // 3 + 1)
         .cast(pl.String)).alias("quarter"))
    counts = d.group_by("unit", "quarter").len().filter(pl.col("len") >= MIN_QUARTER_SERIES)
    d = d.join(counts.select("unit", "quarter"), on=["unit", "quarter"])
    cells = d.select("unit", "quarter").unique().sort("unit", "quarter")
    cells = cells.with_columns(pl.col("quarter").shift(-1).over("unit").alias("next")).with_row_index("cell")
    pairs = cells.join(cells.select(pl.col("cell").alias("cell_next"), "unit", pl.col("quarter").alias("next")),
                       on=["unit", "next"])
    if pairs.height < 5:
        return {"pairs": pairs.height, "r": None, "r_ci": (None, None)}
    cid = d.join(cells.select("unit", "quarter", "cell"), on=["unit", "quarter"])
    cell = cid["cell"].to_numpy()
    lost = cid["lost"].to_numpy()
    _, s_idx = np.unique(cid["match2id"].to_numpy(), return_inverse=True)
    a, b = pairs["cell"].to_numpy(), pairs["cell_next"].to_numpy()

    def r_of(w: np.ndarray) -> float | None:
        num = np.bincount(cell, weights=w * lost, minlength=cells.height)
        den = np.bincount(cell, weights=w, minlength=cells.height)
        ok = (den[a] > 0) & (den[b] > 0)
        return _corr(num[a][ok] / den[a][ok], num[b][ok] / den[b][ok]) if ok.sum() >= 5 else None

    r = r_of(np.ones(len(lost)))
    boot = [r_of(m[s_idx]) for m in _mults(int(s_idx.max()) + 1, resamples, seed)]
    return {"pairs": pairs.height, "r": r, "r_ci": _z_ci(r, boot)}


def hidden_information(steps: pl.DataFrame, maps: pl.DataFrame, coefs: np.ndarray, resamples: int,
                       seed: int = 0) -> dict:
    """Slope of the picking team's map result over the model (`y − p`) on that pick's `lost`, series resampled."""
    picks = steps.filter(pl.col("action") == "pick").select("match2id", pl.col("chosen").alias("map"), "opponent", "lost")
    played = maps.filter(pl.col("vetoed")).with_columns(pl.Series("p_model", predict(maps.filter(pl.col("vetoed")), coefs)))
    d = picks.join(played.select("match2id", "map", "y", "p_model"), on=["match2id", "map"])
    if d.height < 20:
        return {"picks": d.height, "slope": None, "slope_ci": (None, None)}
    sign = np.where(d["opponent"].to_numpy() == 1, 1.0, -1.0)
    resid = sign * (d["y"].to_numpy() - d["p_model"].to_numpy())
    x = d["lost"].to_numpy()
    _, s_idx = np.unique(d["match2id"].to_numpy(), return_inverse=True)

    def slope(w: np.ndarray) -> float | None:
        if w.sum() < 3:
            return None
        mx, my = (w @ x) / w.sum(), (w @ resid) / w.sum()
        vx = w @ (x - mx) ** 2
        return None if vx <= 0 else float((w @ ((x - mx) * (resid - my))) / vx)

    obs = slope(np.ones(len(x)))
    boot = np.array([b for b in (slope(m[s_idx]) for m in _mults(int(s_idx.max()) + 1, resamples, seed)) if b is not None])
    ci = (None, None) if obs is None or len(boot) < 10 else (
        float(np.quantile(boot - boot.mean() + obs, 0.05)), float(np.quantile(boot - boot.mean() + obs, 0.95)))
    return {"picks": d.height, "mean_resid": float(resid.mean()), "slope": obs, "slope_ci": ci}


def team_table(per: pl.DataFrame, persistence: dict, resamples: int, seed: int = 0) -> pl.DataFrame:
    """Per unit: mean lost per series (total, bans, picks), shrunk toward the mean by the split-half reliability,
    with p5 / p95 from resampling the unit's series."""
    rng = np.random.default_rng(seed)
    tables = []
    for unit_type in ("stint", "team"):
        sh = persistence[unit_type]["split"]
        r, half = sh["r"], sh["half_series"]
        k = half * (1 - r) / r if r is not None and r > 0 and half else math.inf
        d = _unit(per, unit_type)
        mean = float(d["lost"].mean())
        rows = []
        for (unit,), g in d.group_by("unit"):
            x = g["lost"].to_numpy()
            n = len(x)
            boots = x[rng.integers(0, n, size=(resamples, n))].mean(axis=1) if n > 1 else np.full(1, x.mean())
            w = n / (n + k) if math.isfinite(k) else 0.0
            rows.append({"unit_type": unit_type, "unit_id": unit, "lp_team": g["lp_team"][-1],
                         "label": g["label"][-1] if unit_type == "stint" else unit,
                         "igl_player": g["igl_player"][-1] if unit_type == "stint" else None, "series": n,
                         "lost": float(x.mean()), "lost_bans": float(g["lost_bans"].mean()),
                         "lost_picks": float(g["lost_picks"].mean()), "lost_p5": float(np.quantile(boots, 0.05)),
                         "lost_p95": float(np.quantile(boots, 0.95)), "lost_shrunk": mean + w * (float(x.mean()) - mean)})
        tables.append(pl.DataFrame(rows))
    return pl.concat(tables).sort("unit_type", "series", descending=[False, True])


def _f(v, d=4, signed=False):
    return "n/a" if v is None else (f"{v:+.{d}f}" if signed else f"{v:.{d}f}")


def _ci(ci, d=3, signed=True):
    return "n/a" if ci[0] is None else f"({_f(ci[0], d, signed)}, {_f(ci[1], d, signed)})"


def report_lines(best: dict, g: dict, n_vetoed: int, steps: pl.DataFrame | None, skipped: dict, persistence: dict | None,
                 hidden: dict | None, published: bool) -> list[str]:
    c = best["coefs"]
    lines = [
        "# Veto value lost", "",
        "Map model: `logit P(A wins map) = Elo base logit + c_u·(u[A,map] − u[B,map]) + γ·pick + δ_ban·Δban rate + "
        "δ_pick·Δpick rate`. `u` is a lineage's decayed mean residual against base Elo on that map, shrunk by "
        "`n / (n + k)` and centred on the lineage's mean over the series' pool; ban and pick rates are the lineage's own, from earlier HLTV vetoes, centred on its pool mean. "
        f"Everything is walk-forward. Tuned on {TRAIN_YEAR}, scored from {TEST_FROM}. {n_vetoed:,} series have a veto.", "",
        f"- Tuned: k = {best['k']:g} maps, decay {best['tau']:g} days; c_u = {c[0]:.3f}, γ = {c[1]:.3f}, "
        f"δ_ban = {c[2]:.3f}, δ_pick = {c[3]:.3f}.", "",
        "## Model gate", "",
        "Per-map log loss on played maps from 2026, against Elo's map probability at the series start (rating plus map "
        "offset). The in-series column is Elo's probability after earlier maps of the same series, for reference. 90% "
        "interval resamples events.", "",
        "| Maps | n | Events | Base Elo | Elo map (series start) | Elo map (in series) | Model | Gain | 90% CI |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for name in ("all", "vetoed"):
        r = g[name]
        lines.append(f"| {name} | {r['maps']:,} | {r['events']} | {_f(r['base'])} | {_f(r['engine'])} | "
                     f"{_f(r['engine_in_series'])} | {_f(r['model'])} | {_f(r['gain'], 4, True)} | {_ci(r['gain_ci'], 4)} |")
    lines += ["", f"Gate: **{'PASS' if g['passed'] else 'FAIL'}**."]
    if steps is None:
        lines += ["", "The map model doesn't beat Elo's map probability, so veto value lost isn't measurable yet and "
                      "nothing past the gate was computed."]
        return lines
    by_type = steps.group_by("step_type").agg(pl.len().alias("n"), pl.col("lost").mean(),
                                              (pl.col("lost") > 1e-9).mean().alias("nonzero")).sort("step_type")
    lines += ["", "## Value lost", "",
              "Backward induction over the real step order, both teams playing the model's best option afterwards. "
              "`lost` is the acting team's series win probability given up against its best option, from information "
              "before the series. Side choice isn't in HLTV's veto box and is ignored.", "",
              f"{steps['match2id'].n_unique():,} series, {steps.height:,} steps. Skipped (non-standard veto): "
              f"{sum(skipped.values())} ({', '.join(f'{k}: {v}' for k, v in sorted(skipped.items())) or 'none'}).", "",
              "| Step | n | Mean lost | Share non-zero |", "| --- | --- | --- | --- |"]
    for r in by_type.iter_rows(named=True):
        lines.append(f"| {r['step_type']} | {r['n']:,} | {_f(r['lost'])} | {100 * r['nonzero']:.0f}% |")
    lines += ["", "## Persistence", "",
              f"Mean lost per series. Split-half alternates series within a unit ({MIN_HALF_SERIES}+ per half); "
              f"quarter pairs need {MIN_QUARTER_SERIES}+ series in each quarter. 90% intervals resample series.", "",
              "| Unit | Units | Split-half r | 90% CI | Quarter pairs | Quarter r | 90% CI |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    for unit in ("stint", "team"):
        p = persistence[unit]
        lines.append(f"| {unit} | {p['split']['units']} | {_f(p['split']['r'], 3, True)} | {_ci(p['split']['r_ci'])} | "
                     f"{p['quarter']['pairs']} | {_f(p['quarter']['r'], 3, True)} | {_ci(p['quarter']['r_ci'])} |")
    lines += ["", f"Persistence: **{'PASS' if persistence['passed'] else 'FAIL'}** (stint split-half and quarter lower "
                  "bounds above 0)."]
    lines += ["", "## Hidden information", "",
              "On played picks, the picking team's `y − p_model` regressed on the pick's `lost`. A positive slope means "
              "picks the model calls costly keep winning, so teams know something the model doesn't.", "",
              f"- {hidden['picks']:,} picks; mean `y − p_model` for the picker {_f(hidden.get('mean_resid'), 4, True)}; "
              f"slope {_f(hidden['slope'], 3, True)}, 90% CI {_ci(hidden['slope_ci'])}."]
    if hidden["slope_ci"][0] is not None and hidden["slope_ci"][0] > 0:
        lines.append("- Reading: teams beat the model on its \"mistakes\"; publish as disagreement with the model, not "
                     "value lost.")
    lines += ["", f"Published: {'yes' if published else 'no'}."]
    return lines


def export_public(teams: pl.DataFrame, persistence: dict, hidden_positive: bool) -> int:
    stint = teams.filter(pl.col("unit_type") == "stint")
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model_version": MODEL_VERSION,
        "label": "disagreement with the model" if hidden_positive else "veto value lost",
        "descriptive": True,
        "team_decision": True,
        "split_half_r": persistence["stint"]["split"]["r"],
        "split_half_r_ci": list(persistence["stint"]["split"]["r_ci"]),
        "source": SOURCE,
        "teams": [{"stint_id": r["unit_id"], "label": r["label"], "lp_team": r["lp_team"],
                   "liquipedia_url": f"https://liquipedia.net/counterstrike/{r['lp_team'].replace(' ', '_')}",
                   "igl_player": r["igl_player"], "series": r["series"],
                   **{k: round(r[k], 4) for k in ("lost", "lost_bans", "lost_picks", "lost_p5", "lost_p95", "lost_shrunk")}}
                  for r in stint.iter_rows(named=True)],
    }
    PUBLIC_WAR.mkdir(parents=True, exist_ok=True)
    (PUBLIC_WAR / "team-veto.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {stint.height} stints to {PUBLIC_WAR / 'team-veto.json'}")
    return 0


def build(resamples: int = 1000, publish: bool = False) -> int:
    for path, cmd in ((ELO_MAPS, "npm run export-map-elo"), (ELO_SERIES, "npm run export-map-elo")):
        if not path.exists():
            raise FileNotFoundError(f"{path} not found; run `{cmd}` first")
    series = load_series()
    vetoes = load_vetoes()
    n_vetoed = sum(1 for s in series if s["match2id"] in vetoes)
    print(f"{len(series):,} series, {n_vetoed:,} with a veto; tuning on {TRAIN_YEAR}")
    best = tune(series, vetoes)
    g = gate(best["df"], best["coefs"])

    steps = per = persistence = hidden = snaps = None
    skipped: dict = {}
    published = False
    if g["passed"]:
        df, snaps = walk(series, vetoes, best["k"], best["tau"], snapshot=True)
        steps, skipped = veto_steps(series, vetoes, snaps, best["coefs"], elo_params()["seriesMapTemp"])
        per = with_stints(steps)
        persistence = {u: {"split": split_half(per, u, resamples), "quarter": quarter_to_quarter(per, u, resamples)}
                       for u in ("stint", "team")}
        st = persistence["stint"]
        persistence["passed"] = all(c[0] is not None and c[0] > 0 for c in (st["split"]["r_ci"], st["quarter"]["r_ci"]))
        hidden = hidden_information(steps, df, best["coefs"], resamples)
        teams = team_table(per, persistence, resamples)
        VETO_STEPS.parent.mkdir(parents=True, exist_ok=True)
        steps.write_parquet(VETO_STEPS)
        teams.write_parquet(VETO_TEAMS)
        if publish and persistence["passed"]:
            hidden_positive = hidden["slope_ci"][0] is not None and hidden["slope_ci"][0] > 0
            published = export_public(teams, persistence, hidden_positive) == 0
        elif publish:
            print("Persistence failed; skipping team-veto.json.")

    lines = report_lines(best, g, n_vetoed, steps, skipped, persistence, hidden, published)
    if snaps is not None:
        lines += series_gate_lines(series_gate(series, vetoes, snaps, best["coefs"], elo_params()["seriesMapTemp"]))
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "veto.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0
