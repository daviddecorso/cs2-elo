"""T-side predictability (Phase 7, order 5): how much better a scout who studied a team's earlier T rounds predicts
its site, timing and execute than a league prior does, given map and economy.

The spec's test is whether predictable teams underperform prepared opponents. Prepared is a rematch (the two teams
met in an earlier series within REMATCH_DAYS), with Bo3+ (the series ran past one map) as a diagnostic.
"""

import json
import math
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import polars as pl
from sklearn.linear_model import LogisticRegression

from . import duelstats as ds
from . import unitstats as us
from . import warcheck
from .evaluate import _buy
from .paths import (PREDICT_MAPS, PREDICT_ROUNDS, PREDICT_TEAMS, PUBLIC_WAR, TACTICS_ROUNDS, TEAM_MAP_RESIDUALS,
                    WAR_REPORTS)
from .publish import SOURCE
from .states import TICK_RATE

SITES = ("A", "B", "none")
# Seconds from freeze end to the first T entry into the hit site.
TIMING_EDGES = (20, 40, 60)
TIMINGS = ("<20", "20-40", "40-60", "60+")
EXECS = ("0", "1")
PRIOR_M = 20.0
PRIOR_SENSITIVITY = (10.0, 40.0)
MIN_PRIOR = 30
MIN_HALF = 75
MIN_QUARTER = 50
# A team's map-time predictability is its prior rounds' mean gain shrunk toward 0 by this many rounds.
TEAM_SHRINK = 100.0
MIN_TEAM_PRIOR = 50
REMATCH_DAYS = 60
UNITS = {"stint": "IGL stint", "team": "Team (`lp_team`)"}
COMPONENTS = ("gain_site", "gain_time", "gain_exec")
TOP = 10


def timing_bin(seconds: float | None) -> str | None:
    if seconds is None or (isinstance(seconds, float) and math.isnan(seconds)):
        return None
    for edge, label in zip(TIMING_EDGES, TIMINGS):
        if seconds < edge:
            return label
    return TIMINGS[-1]


def outcomes(r: pl.DataFrame) -> pl.DataFrame:
    """T rounds with `buy`, `site`, `timing` and `exec` (the last two null when no site was hit)."""
    secs = (pl.col("hit_tick") - pl.col("freeze_end_tick")) / TICK_RATE
    return (r.with_columns(
        pl.when(pl.col("pistol")).then(pl.lit("pistol")).otherwise(_buy("t_equip")).alias("buy"),
        pl.col("hit_site").fill_null("none").alias("site"),
        secs.map_elements(timing_bin, return_dtype=pl.String).alias("timing"),
        pl.when(pl.col("hit_site").is_not_null()).then(pl.col("execute").cast(pl.Int8).cast(pl.String)).alias("exec"))
        .with_columns(pl.when(pl.col("site") == "none").then(None).otherwise(pl.col("timing")).alias("timing")))


class _Counts:
    """Category counts per context, for a league prior (add-one) and a unit's history smoothed toward it."""

    def __init__(self):
        self.n = defaultdict(float)
        self.total = defaultdict(float)

    def add(self, ctx, x):
        self.n[(ctx, x)] += 1
        self.total[ctx] += 1

    def league(self, ctx, x, k: int) -> float:
        return (self.n[(ctx, x)] + 1.0) / (self.total[ctx] + k)

    def scout(self, ctx, x, prior: float, m: float) -> float:
        return (self.n[(ctx, x)] + m * prior) / (self.total[ctx] + m)


def walk_forward(r: pl.DataFrame, unit: str, m: float = PRIOR_M, min_prior: int = MIN_PRIOR) -> pl.DataFrame:
    """Per T round: league and scout surprise (−log P) for site, timing given site and execute given site, both
    from rounds on dates strictly before the round's. `eligible` needs `min_prior` earlier T rounds of the unit on
    the map. Gains are league minus scout surprise: positive means the team was predictable."""
    rows = r.select("date", "map", "buy", "site", "timing", "exec", unit).to_dicts()
    order = sorted(range(len(rows)), key=lambda i: rows[i]["date"])
    league, scout, per_map = _Counts(), _Counts(), defaultdict(int)
    out = np.full((len(rows), 3), np.nan)
    eligible = np.zeros(len(rows), dtype=bool)
    i = 0
    while i < len(order):
        j = i
        while j < len(order) and rows[order[j]]["date"] == rows[order[i]]["date"]:
            j += 1
        day = order[i:j]
        for k in day:
            x = rows[k]
            u = x[unit]
            if u is None or per_map[(u, x["map"])] < min_prior:
                continue
            eligible[k] = True
            parts = [(("site", x["map"], x["buy"]), x["site"], len(SITES))]
            if x["site"] != "none":
                if x["timing"] is not None:
                    parts.append((("time", x["map"], x["buy"], x["site"]), x["timing"], len(TIMINGS)))
                if x["exec"] is not None:
                    parts.append((("exec", x["map"], x["buy"], x["site"]), x["exec"], len(EXECS)))
            gains = [0.0, 0.0, 0.0]
            for c, (ctx, val, kk) in enumerate(parts):
                slot = {"site": 0, "time": 1, "exec": 2}[ctx[0]]
                pl_ = league.league(ctx, val, kk)
                ps = scout.scout((u, *ctx), val, pl_, m)
                gains[slot] = math.log(ps) - math.log(pl_)
            out[k] = gains
        for k in day:
            x = rows[k]
            ctxs = [(("site", x["map"], x["buy"]), x["site"])]
            if x["site"] != "none":
                if x["timing"] is not None:
                    ctxs.append((("time", x["map"], x["buy"], x["site"]), x["timing"]))
                if x["exec"] is not None:
                    ctxs.append((("exec", x["map"], x["buy"], x["site"]), x["exec"]))
            for ctx, val in ctxs:
                league.add(ctx, val)
                if x[unit] is not None:
                    scout.add((x[unit], *ctx), val)
            if x[unit] is not None:
                per_map[(x[unit], x["map"])] += 1
        i = j
    out[~eligible] = np.nan
    return pl.DataFrame({**{c: out[:, n] for n, c in enumerate(COMPONENTS)}, "eligible": eligible}).with_columns(
        pl.when(pl.col("eligible")).then(pl.sum_horizontal(*COMPONENTS)).alias("pred"))


def team_rounds(tactics: pl.DataFrame, residuals: pl.DataFrame) -> pl.DataFrame:
    need = {"hit_tick", "freeze_end_tick"} - set(tactics.columns)
    if need:
        raise SystemExit(f"{TACTICS_ROUNDS} lacks {', '.join(sorted(need))}; run `cs2wp tactics` first")
    stints = residuals.select("key", pl.col("lp_team").alias("team"), pl.col("stint_id").alias("stint"), "stint_label")
    return (outcomes(tactics).rename({"t_lp_team": "team"})
            .join(stints, on=["key", "team"], how="left")
            .select("key", "round_num", "date", "series", "event", "map", "team", "stint", "stint_label",
                    "buy", "site", "timing", "exec"))


def rematch_flags(pairs: pl.DataFrame, days: int = REMATCH_DAYS) -> list[bool]:
    """Whether the two teams met in an earlier series dated within `days` before each row (needs `team_a`,
    `team_b`, `series`, `date`)."""
    met: dict[frozenset, list[tuple[date, str]]] = defaultdict(list)
    for a, b, s, d in pairs.select("team_a", "team_b", "series", "date").unique().iter_rows():
        met[frozenset((a, b))].append((date.fromisoformat(d), s))
    out = []
    for a, b, s, d in pairs.select("team_a", "team_b", "series", "date").iter_rows():
        day = date.fromisoformat(d)
        out.append(any(day - timedelta(days=days) <= when < day and other != s for when, other in met[frozenset((a, b))]))
    return out


def team_priors(r: pl.DataFrame, maps: pl.DataFrame) -> pl.DataFrame:
    """Each (key, team)'s predictability at map time: eligible `pred` from its earlier dates, shrunk toward 0."""
    daily = (r.filter(pl.col("eligible")).group_by("team", "date")
             .agg(pl.col("pred").sum().alias("s"), pl.len().alias("n")).sort("team", "date"))
    history = {team: (np.array(g["date"].to_list()), np.cumsum(g["s"].to_numpy()), np.cumsum(g["n"].to_numpy()))
               for (team,), g in daily.group_by("team")}
    out = []
    for team, d in maps.select("team", "date").unique().iter_rows():
        s = n = 0.0
        if team in history:
            dates, cs, cn = history[team]
            i = int(np.searchsorted(dates, d, "left"))
            if i:
                s, n = float(cs[i - 1]), float(cn[i - 1])
        out.append((team, d, n, s / (n + TEAM_SHRINK)))
    return pl.DataFrame(out, schema={"team": pl.String, "date": pl.String, "prior_rounds": pl.Float64,
                                     "prior_pred": pl.Float64}, orient="row")


def pair_maps(residuals: pl.DataFrame, priors: pl.DataFrame) -> pl.DataFrame:
    """One row per map (team_a the alphabetically first team): Elo logit, predictability difference and the two
    prepared flags."""
    rows = residuals.select("key", "series", "event", "date", pl.col("lp_team").alias("team"), "elo", "won")
    a = rows.join(priors, on=["team", "date"], how="left")
    pairs = (a.join(a, on="key", suffix="_b").filter(pl.col("team") < pl.col("team_b"))
             .select("key", "series", "event", "date", pl.col("team").alias("team_a"), "team_b", pl.col("won").alias("y"),
                     ((pl.col("elo") - pl.col("elo_b")) * math.log(10) / 400).alias("elo_logit"),
                     pl.col("prior_pred").alias("pred_a"), pl.col("prior_pred_b").alias("pred_b"),
                     pl.col("prior_rounds").alias("n_a"), pl.col("prior_rounds_b").alias("n_b")))
    maps_per_series = rows.group_by("series").agg(pl.col("key").n_unique().alias("_maps"))
    pairs = pairs.join(maps_per_series, on="series").with_columns(
        pl.Series("rematch", rematch_flags(pairs)), (pl.col("_maps") >= 2).alias("bo3")).drop("_maps")
    return pairs.with_columns((pl.col("pred_a") - pl.col("pred_b")).alias("pdiff")).with_columns(
        (pl.col("pdiff") * pl.col("rematch").cast(pl.Float64)).alias("pdiff_rematch"),
        (pl.col("pdiff") * pl.col("bo3").cast(pl.Float64)).alias("pdiff_bo3"))


def prepared_test(maps: pl.DataFrame, flag: str) -> dict | None:
    """Leave-one-event-out map log loss of Elo + predictability difference, with and without its interaction with
    `flag`; the interaction's sign comes from a fit on every map."""
    rows = maps.filter(pl.col("elo_logit").is_not_null() & (pl.col("n_a") >= MIN_TEAM_PRIOR)
                       & (pl.col("n_b") >= MIN_TEAM_PRIOR))
    if rows["event"].n_unique() < 3:
        return None
    inter = f"pdiff_{flag}"
    base = warcheck.cv_losses(rows, ["elo_logit", "pdiff"])
    full = warcheck.cv_losses(rows, ["elo_logit", "pdiff", inter])
    lo, hi = warcheck.paired_ci(base - full, rows["series"].to_numpy())
    x = warcheck._scaled(rows, ["elo_logit", "pdiff", inter])
    coef = LogisticRegression(fit_intercept=False, C=1e4).fit(x, rows["y"].to_numpy()).coef_[0]
    return {"maps": rows.height, "prepared": int(rows[flag].sum()), "events": int(rows["event"].n_unique()),
            "base": float(base.mean()), "with": float(full.mean()), "gain": float((base - full).mean()),
            "gain_ci": (lo, hi), "coef_pdiff": float(coef[1]), "coef_inter": float(coef[2])}


def prepared_passes(t: dict | None) -> bool:
    return t is not None and ds._passes(t["gain_ci"]) and t["coef_inter"] < 0


def _quarter(d: str) -> str:
    return f"{d[:4]}Q{(int(d[5:7]) - 1) // 3 + 1}"


def reliability(r: pl.DataFrame, resamples: int) -> dict:
    e = r.filter(pl.col("eligible")).with_columns(pl.col("date").map_elements(_quarter, return_dtype=pl.String)
                                                   .alias("quarter"))
    out = {}
    for unit in UNITS:
        u = e.filter(pl.col(unit).is_not_null())
        out[unit] = {"rounds": u.height,
                     "split": {c: us.split_half(u, unit, c, MIN_HALF, resamples) for c in ("pred", *COMPONENTS)},
                     "quarter": us.persistence(u, unit, "pred", "quarter", MIN_QUARTER, resamples)}
    return out


def _f(v, d=3, signed=False):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "—"
    return f"{v:+.{d}f}" if signed else f"{v:.{d}f}"


def _ci(ci, d=3, signed=False):
    return f"({_f(ci[0], d, signed)}, {_f(ci[1], d, signed)})"


def _verdict(ok: bool) -> str:
    return "**PASS**" if ok else "**FAIL**"


def report_lines(r: pl.DataFrame, sens: dict, rel: dict, maps: pl.DataFrame, tests: dict, est: pl.DataFrame,
                 g: dict) -> list[str]:
    e = r.filter(pl.col("eligible"))
    lines = ["# T-side predictability", "",
             f"{r.height:,} T rounds on {r['key'].n_unique():,} maps; {e.height:,} have {MIN_PRIOR}+ earlier T rounds "
             f"of the IGL stint on the map. Scout prior strength {PRIOR_M:g} rounds toward the league map × buy "
             f"distribution; timing bins {', '.join(TIMINGS)} s from freeze end to the first T entry into the hit "
             "site. Gains are nats per round (league − scout surprise); positive is predictable. Intervals are 90%, "
             "resampling series.", "",
             "## Gates", "",
             f"- Stint split-half of `pred`: {_verdict(g['split'])}.",
             f"- Predictable teams underperform rematch opponents: {_verdict(g['rematch'])}.",
             f"- Bo3+ (diagnostic): {_verdict(prepared_passes(tests['bo3']))}.",
             f"- Published: {'yes' if g['published'] else 'no'}.", "",
             "## Gain by component (stint, eligible rounds)", "",
             "| Prior m | Rounds | Site | Timing | Execute | Total |", "| --- | --- | --- | --- | --- | --- |"]
    for m, x in sens.items():
        lines.append(f"| {m:g} | {x['rounds']:,} | " + " | ".join(_f(x[c], 4, True) for c in (*COMPONENTS, "pred")) + " |")
    lines += ["", "## Reliability", "",
              f"| Unit | Rounds | Split-half `pred` (90% CI, units) | Site | Timing | Execute | Quarter r (90% CI, pairs) |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    for unit, name in UNITS.items():
        x = rel[unit]
        sp = x["split"]
        lines.append(f"| {name} | {x['rounds']:,} | {_f(sp['pred']['r'])} {_ci(sp['pred']['r_ci'])}, "
                     f"{sp['pred']['pairs']} | " + " | ".join(f"{_f(sp[c]['r'])} {_ci(sp[c]['r_ci'])}" for c in COMPONENTS)
                     + f" | {_f(x['quarter']['r'])} {_ci(x['quarter']['r_ci'])}, {x['quarter']['pairs']} |")
    lines += ["", "## Prepared opponents", "",
              f"Maps where both teams have {MIN_TEAM_PRIOR}+ earlier eligible T rounds. Team predictability at map time "
              f"is the mean of its earlier gains shrunk by {TEAM_SHRINK:g} rounds. Leave-one-event-out map log loss of "
              "Elo + predictability difference, with and without the difference × prepared. The hypothesis needs a "
              "positive gain and a negative interaction.", "",
              f"Rematch: the teams met in an earlier series within {REMATCH_DAYS} days ({100 * maps['rematch'].mean():.0f}% "
              f"of maps). Bo3+: the series ran past one map ({100 * maps['bo3'].mean():.0f}%).", "",
              "| Prepared | Maps (prepared) | Events | Base log loss | With interaction | Gain (90% CI) | Coef pdiff | Coef interaction |",
              "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for flag, t in tests.items():
        if t is None:
            lines.append(f"| {flag} | — | — | — | — | — | — | — |")
            continue
        lines.append(f"| {flag} | {t['maps']:,} ({t['prepared']:,}) | {t['events']} | {t['base']:.4f} | {t['with']:.4f} | "
                     f"{_f(t['gain'], 5, True)} {_ci(t['gain_ci'], 5, True)} | {_f(t['coef_pdiff'], 3, True)} | "
                     f"{_f(t['coef_inter'], 3, True)} |")
    q = est.filter((pl.col("unit_type") == "stint") & (pl.col("n") >= 2 * MIN_HALF)).sort("mean", descending=True)
    if not q.is_empty():
        lines += ["", f"### Most and least predictable stints ({2 * MIN_HALF}+ eligible rounds)", "",
                  "| Stint | Rounds | Gain per round (90% CI) |", "| --- | --- | --- |"]
        for x in pl.concat([q.head(TOP), q.tail(TOP)]).unique("unit_id", maintain_order=True).iter_rows(named=True):
            lines.append(f"| {x['label']} | {x['n']:,} | {_f(x['mean'], 4, True)} {_ci((x['p5'], x['p95']), 4, True)} |")
    return lines


def export_public(est: pl.DataFrame, rel: dict, tests: dict, out_dir: Path = PUBLIC_WAR) -> None:
    q = est.filter((pl.col("unit_type") == "stint") & (pl.col("n") >= 2 * MIN_HALF)).sort("mean", descending=True)
    sp = rel["stint"]["split"]["pred"]
    payload = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "split_half_r": sp["r"], "split_half_r_ci": list(sp["r_ci"]),
               "rematch_gain": tests["rematch"]["gain"], "rematch_gain_ci": list(tests["rematch"]["gain_ci"]),
               "source": SOURCE,
               "teams": [{"stint_id": x["unit_id"], "label": x["label"], "rounds": x["n"],
                          "per100": round(100 * x["mean"], 2), "p5": round(100 * x["p5"], 2),
                          "p95": round(100 * x["p95"], 2)} for x in q.iter_rows(named=True)]}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "predictability.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {out_dir / 'predictability.json'}")


def build(resamples: int = 1000, publish: bool = False) -> int:
    for path, cmd in ((TEAM_MAP_RESIDUALS, "cs2wp team-factor"), (TACTICS_ROUNDS, "cs2wp tactics")):
        if not path.exists():
            raise FileNotFoundError(f"{path} not found; run `{cmd}` first")
    residuals = pl.read_parquet(TEAM_MAP_RESIDUALS)
    base = team_rounds(pl.read_parquet(TACTICS_ROUNDS), residuals)

    sens = {}
    for m in (PRIOR_M, *PRIOR_SENSITIVITY):
        wf = walk_forward(base, "stint", m)
        e = wf.filter(pl.col("eligible"))
        sens[m] = {"rounds": e.height, **{c: e[c].mean() for c in (*COMPONENTS, "pred")}}
    r = pl.concat([base, walk_forward(base, "stint")], how="horizontal")
    team = walk_forward(base, "team").select(pl.col("eligible").alias("team_eligible"), pl.col("pred").alias("team_pred"))
    r = pl.concat([r, team], how="horizontal")
    r.write_parquet(PREDICT_ROUNDS)

    rel_rows = pl.concat([
        r.select("key", "date", "series", pl.col("stint"), pl.lit(None, pl.String).alias("team"), "eligible", "pred",
                 *COMPONENTS),
        r.select("key", "date", "series", pl.lit(None, pl.String).alias("stint"), "team",
                 pl.col("team_eligible").alias("eligible"), pl.col("team_pred").alias("pred"),
                 *(pl.lit(None, pl.Float64).alias(c) for c in COMPONENTS)),
    ])
    rel = reliability(rel_rows, resamples)
    priors = team_priors(r.select("team", "date", pl.col("team_eligible").alias("eligible"),
                                  pl.col("team_pred").alias("pred")),
                         residuals.select(pl.col("lp_team").alias("team"), "date"))
    maps = pair_maps(residuals, priors)
    maps.write_parquet(PREDICT_MAPS)
    tests = {"rematch": prepared_test(maps, "rematch"), "bo3": prepared_test(maps, "bo3")}

    est = pl.concat([
        us.estimates(r.filter(pl.col("eligible") & pl.col("stint").is_not_null()), "stint", "pred", resamples)
        .rename({"stint": "unit_id"}).with_columns(pl.lit("stint").alias("unit_type")),
        us.estimates(r.filter(pl.col("team_eligible")), "team", "team_pred", resamples)
        .rename({"team": "unit_id"}).with_columns(pl.lit("team").alias("unit_type")),
    ])
    labels = dict(r.select("stint", "stint_label").unique("stint").drop_nulls().iter_rows())
    est = est.with_columns(pl.col("unit_id").replace(labels).alias("label"))
    est.write_parquet(PREDICT_TEAMS)

    split_ok = ds._passes(rel["stint"]["split"]["pred"]["r_ci"])
    g = {"split": split_ok, "rematch": prepared_passes(tests["rematch"])}
    g["published"] = g["split"] and g["rematch"]
    lines = report_lines(r, sens, rel, maps, tests, est, g)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "predictability.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {PREDICT_ROUNDS}, {PREDICT_MAPS}, {PREDICT_TEAMS}")
    if publish:
        if not g["published"]:
            print("T-side predictability did not pass its gates; skipping predictability.json.")
            return 1
        export_public(est, rel, tests)
    return 0
