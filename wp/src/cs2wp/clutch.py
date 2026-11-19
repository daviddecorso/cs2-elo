"""Clutch and man-advantage conversion (Phase 7, order 5): rounds won from an X v Y state beyond what the
win-probability model expects there.

Each side's first entry per round into a class is valued with the map's own out-of-sample WP model at `elo_diff_ct`
0, so the expectation carries no team strength (Elo absorbs whatever converting well produces). The spec's gate is
year-to-year stability; a class that fails stays off the site.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl

from . import duelstats as ds
from . import unitstats as us
from .book import ModelBook
from .data import catalog
from .features import with_derived
from .paths import (CLUTCH_ENTRIES, CLUTCH_UNITS, PUBLIC_WAR, STATES, TEAM_MAP_RESIDUALS, TEAM_ROUNDS,
                    WAR_REPORTS)
from .pipeline import map_predictor
from .publish import SOURCE
from .states import CT, T
from .tactics import season

CLASSES = ("clutch", "adv", "disadv")
LABELS = {"clutch": "Clutch (1vN)", "adv": "Man advantage", "disadv": "Man disadvantage"}
UNITS = {"player": "Player", "stint": "IGL stint", "team": "Team (`lp_team`)"}
# Unit kinds each class is measured for: a clutch belongs to its survivor, team classes to the team.
CLASS_UNITS = {"clutch": ("player", "stint", "team"), "adv": ("stint", "team"), "disadv": ("stint", "team")}
MIN_YEAR = {"player": 30, "stint": 60, "team": 60}
EVENT_COLUMNS = ["round_num", "seq", "lethal", "victim", "post_ct_alive", "post_t_alive", "alive_ct", "alive_t",
                 "terminal", "ct_win"]
TOP = 10


def entries(events: pl.DataFrame) -> pl.DataFrame:
    """Each side's first post-event state per round in each class, skipping events that end the round.

    `clutch`: one alive against at least one; `survivor` is that player. `adv` / `disadv`: more / fewer alive than
    the opponent, both sides with someone alive.
    """
    ev = events.filter(pl.col("terminal").is_nan() | pl.col("terminal").is_null())
    frames = []
    for code, own, opp, alive, won in ((CT, "post_ct_alive", "post_t_alive", "alive_ct", pl.col("ct_win")),
                                        (T, "post_t_alive", "post_ct_alive", "alive_t", ~pl.col("ct_win"))):
        frames.append(ev.select("round_num", "seq", pl.lit(code).alias("side"),
                                pl.col(own).cast(pl.Int64).alias("own"), pl.col(opp).cast(pl.Int64).alias("opp"),
                                won.alias("won"), pl.col(alive).alias("alive"), "victim", "lethal"))
    long = pl.concat(frames)
    cls = {"clutch": (pl.col("own") == 1) & (pl.col("opp") >= 1),
           "adv": (pl.col("own") > pl.col("opp")) & (pl.col("opp") >= 1),
           "disadv": (pl.col("own") < pl.col("opp")) & (pl.col("own") >= 1)}
    out = pl.concat([long.filter(cond).with_columns(pl.lit(name).alias("cls")) for name, cond in cls.items()])
    out = out.sort("seq").group_by("round_num", "side", "cls", maintain_order=True).first()
    survivor = [None if c != "clutch" else next((p for p in (a or []) if not (lth and p == v)), None)
                for c, a, v, lth in zip(*(out[k].to_list() for k in ("cls", "alive", "victim", "lethal")))]
    return (out.with_columns(pl.Series("survivor", survivor, dtype=pl.UInt64))
            .drop("alive", "victim", "lethal").sort("round_num", "seq", "side", "cls"))


def centred(rows: pl.DataFrame) -> pl.DataFrame:
    """`conv` = won − p, minus its league mean per class, X v Y and side, so leftover model bias in rare states
    cancels."""
    raw = pl.col("won").cast(pl.Float64) - pl.col("p")
    return rows.with_columns(raw.alias("conv_raw")).with_columns(
        (pl.col("conv_raw") - pl.col("conv_raw").mean().over("cls", "own", "opp", "side")).alias("conv"))


def build_entries(model: str) -> pl.DataFrame:
    rounds = pl.read_parquet(TEAM_ROUNDS, columns=["key", "round_num", "ct_lp_team", "t_lp_team", "series", "event",
                                                   "date"])
    keys = set(rounds["key"].unique().to_list())
    refs = catalog()
    book = ModelBook(model)
    frames, missing = [], 0
    todo = [r for r in refs if r.key in keys]
    for i, ref in enumerate(todo, 1):
        path = STATES / ref.slug / "events.parquet"
        predictor = map_predictor(book, ref, refs) if path.exists() else None
        if predictor is None:
            missing += 1
            continue
        _, _, p = predictor
        events = pl.read_parquet(path)
        found = entries(events.select(EVENT_COLUMNS))
        if found.is_empty():
            continue
        states = (found.select("round_num", "seq").unique()
                  .join(events, on=["round_num", "seq"], how="left")
                  .with_columns(pl.lit(0.0).cast(events.schema["elo_diff_ct"]).alias("elo_diff_ct")))
        states = with_derived(states, "post_")
        p_ct = states.select("round_num", "seq", pl.Series("p_ct", p(states, "post")))
        frames.append(found.join(p_ct, on=["round_num", "seq"], how="left")
                      .with_columns(pl.lit(ref.key).alias("key"), pl.lit(ref.map).alias("map")))
        if i % 500 == 0:
            print(f"  {i}/{len(todo)}", flush=True)
    if missing:
        print(f"clutch: {missing} maps without states or a model for their month")
    rows = (pl.concat(frames)
            .with_columns(pl.when(pl.col("side") == CT).then(pl.col("p_ct")).otherwise(1 - pl.col("p_ct")).alias("p"))
            .join(rounds, on=["key", "round_num"], how="inner")
            .with_columns(pl.when(pl.col("side") == CT).then(pl.col("ct_lp_team")).otherwise(pl.col("t_lp_team"))
                          .alias("team"))
            .drop("ct_lp_team", "t_lp_team"))
    stints = pl.read_parquet(TEAM_MAP_RESIDUALS, columns=["key", "lp_team", "stint_id", "stint_label"])
    rows = rows.join(stints.rename({"lp_team": "team", "stint_id": "stint"}), on=["key", "team"], how="left")
    return centred(rows).with_columns(pl.col("survivor").cast(pl.String).alias("player"),
                                      pl.col("date").str.slice(0, 4).alias("year"),
                                      pl.col("date").map_elements(season, return_dtype=pl.String).alias("season"))


def unit_elo(residuals: pl.DataFrame) -> pl.DataFrame:
    """Mean pre-map Elo per stint and per team, for the strength check (the expectation leaves Elo out)."""
    return pl.concat([
        residuals.group_by(pl.col("stint_id").alias("unit_id")).agg(pl.col("elo").mean().alias("elo"))
        .with_columns(pl.lit("stint").alias("unit_type")),
        residuals.group_by(pl.col("lp_team").alias("unit_id")).agg(pl.col("elo").mean().alias("elo"))
        .with_columns(pl.lit("team").alias("unit_type")),
    ])


def results(rows: pl.DataFrame, resamples: int, elo: pl.DataFrame) -> tuple[dict, pl.DataFrame]:
    res, tables = {}, []
    for cls in CLASSES:
        sub = rows.filter(pl.col("cls") == cls)
        res[cls] = {}
        for unit in CLASS_UNITS[cls]:
            u = sub.filter(pl.col(unit).is_not_null())
            n = MIN_YEAR[unit]
            res[cls][unit] = {
                "entries": u.height,
                "year": us.persistence(u, unit, "conv", "year", n, resamples),
                "season": us.persistence(u, unit, "conv", "season", n / 2, resamples),
                "split": us.split_half(u, unit, "conv", n, resamples),
            }
            est = (us.estimates(u, unit, "conv", resamples).rename({unit: "unit_id"})
                   .with_columns(pl.lit(cls).alias("cls"), pl.lit(unit).alias("unit_type"))
                   .join(elo, on=["unit_id", "unit_type"], how="left"))
            big = est.filter((pl.col("n") >= 2 * n) & pl.col("elo").is_not_null())
            res[cls][unit]["r_elo"] = ds._corr(big["mean"].to_numpy(), big["elo"].to_numpy()) if unit != "player" else None
            tables.append(est)
    return res, pl.concat(tables, how="diagonal_relaxed")


def passes(t: dict) -> bool:
    ci = t["year"]["r_ci"]
    return ci[0] is not None and ci[0] > 0


def _f(v, d=3, signed=False):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "—"
    return f"{v:+.{d}f}" if signed else f"{v:.{d}f}"


def _ci(ci, d=3):
    return f"({_f(ci[0], d)}, {_f(ci[1], d)})"


def _labels(rows: pl.DataFrame) -> dict[str, str]:
    out = {s: lab for s, lab in rows.select("stint", "stint_label").unique("stint").drop_nulls().iter_rows()}
    path = PUBLIC_WAR / "players.json"
    if path.exists():
        for p in json.loads(path.read_text()).get("players", []):
            out[str(p["steamid"])] = p.get("name") or str(p["steamid"])
    return out


def report_lines(rows: pl.DataFrame, res: dict, est: pl.DataFrame, labels: dict[str, str]) -> list[str]:
    lines = ["# Clutch and man-advantage conversion", "",
             f"{rows.height:,} entries on {rows['key'].n_unique():,} maps "
             f"({rows['date'].min()} to {rows['date'].max()}). Expectation: the map's own out-of-sample WP fold at "
             "`elo_diff_ct` 0. Conversion is win − p, centred per class, X v Y and side. Intervals are 90%, "
             "resampling series.", "",
             "## Gates (year-to-year, 2025 → 2026)", ""]
    for cls in CLASSES:
        for unit in CLASS_UNITS[cls]:
            t = res[cls][unit]
            verdict = "**PASS**" if passes(t) else "**FAIL**"
            lines.append(f"- {LABELS[cls]}, {UNITS[unit]}: r {_f(t['year']['r'])} {_ci(t['year']['r_ci'])} over "
                         f"{t['year']['pairs']} units with {MIN_YEAR[unit]}+ entries both years: {verdict}.")
    lines += ["", "## Model bias by state (before centring)", "",
              "| Class | State | Side | Entries | Mean p | Win rate | Win − p |", "| --- | --- | --- | --- | --- | --- | --- |"]
    bias = (rows.group_by("cls", "own", "opp", "side")
            .agg(pl.len().alias("n"), pl.col("p").mean().alias("p"), pl.col("won").cast(pl.Float64).mean().alias("w"))
            .filter(pl.col("n") >= 200).sort("cls", "own", "opp", "side"))
    for x in bias.iter_rows(named=True):
        lines.append(f"| {x['cls']} | {x['own']}v{x['opp']} | {'CT' if x['side'] == CT else 'T'} | {x['n']:,} | "
                     f"{x['p']:.3f} | {x['w']:.3f} | {x['w'] - x['p']:+.3f} |")
    lines += ["", "## Reliability", "",
              "| Class | Unit | Entries | Year r (90% CI, units) | Half-year r (90% CI, pairs) | Split-half r (90% CI, units) | r with Elo |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    for cls in CLASSES:
        for unit in CLASS_UNITS[cls]:
            t = res[cls][unit]
            lines.append(f"| {LABELS[cls]} | {UNITS[unit]} | {t['entries']:,} | "
                         + " | ".join(f"{_f(t[k]['r'])} {_ci(t[k]['r_ci'])}, {t[k]['pairs']}"
                                      for k in ("year", "season", "split")) + f" | {_f(t['r_elo'], 2)} |")
    for cls in CLASSES:
        for unit in ("player", "stint"):
            if unit not in CLASS_UNITS[cls]:
                continue
            q = (est.filter((pl.col("cls") == cls) & (pl.col("unit_type") == unit) & (pl.col("n") >= 2 * MIN_YEAR[unit]))
                 .sort("mean", descending=True))
            if q.is_empty():
                continue
            lines += ["", f"### {LABELS[cls]}, {UNITS[unit]}: top and bottom {TOP} ({2 * MIN_YEAR[unit]}+ entries)", "",
                      "| Unit | Entries | Conversion per entry (90% CI) |", "| --- | --- | --- |"]
            for x in pl.concat([q.head(TOP), q.tail(TOP)]).unique("unit_id", maintain_order=True).iter_rows(named=True):
                lines.append(f"| {labels.get(x['unit_id'], x['unit_id'])} | {x['n']:,} | {_f(x['mean'], 3, True)} "
                             f"({_f(x['p5'], 3, True)}, {_f(x['p95'], 3, True)}) |")
    return lines


def _rate(x: dict) -> dict:
    return {"per100": round(100 * x["mean"], 2), "p5": round(100 * x["p5"], 2), "p95": round(100 * x["p95"], 2)}


def _meta(cls: str, t: dict) -> dict:
    return {"label": LABELS[cls], "year_r": t["year"]["r"], "year_r_ci": list(t["year"]["r_ci"]),
            "split_half_r": t["split"]["r"], "split_half_r_ci": list(t["split"]["r_ci"]), "r_elo": t["r_elo"],
            "entries": t["entries"]}


def export_public(est: pl.DataFrame, res: dict, labels: dict[str, str], residuals: pl.DataFrame,
                  out_dir: Path = PUBLIC_WAR) -> int:
    """`clutch.json`: stint rows for the team classes and player rows for clutches, each only where that class and
    unit passed year-to-year stability. Rates are round wins per 100 entries above expectation."""
    team_classes = [c for c in CLASSES if passes(res[c]["stint"])]
    players_pass = passes(res["clutch"]["player"])
    if not team_classes and not players_pass:
        print("No clutch class passed year-to-year stability; skipping clutch.json.")
        return 1
    stints = (residuals.group_by("stint_id")
              .agg(pl.col("stint_label").first().alias("label"), pl.col("lp_team").first(),
                   pl.col("igl_player").first(), pl.col("key").n_unique().alias("maps")))
    records: dict[str, dict] = {}
    for cls in team_classes:
        q = est.filter((pl.col("cls") == cls) & (pl.col("unit_type") == "stint")
                       & (pl.col("n") >= 2 * MIN_YEAR["stint"]))
        for x in q.join(stints, left_on="unit_id", right_on="stint_id").iter_rows(named=True):
            records.setdefault(x["unit_id"], {
                "stint_id": x["unit_id"], "label": x["label"], "lp_team": x["lp_team"], "igl_player": x["igl_player"],
                "maps": int(x["maps"])})[cls] = {**_rate(x), "entries": int(x["n"])}
    players = []
    if players_pass:
        q = est.filter((pl.col("cls") == "clutch") & (pl.col("unit_type") == "player")
                       & (pl.col("n") >= 2 * MIN_YEAR["player"]))
        players = [{"steamid": x["unit_id"], "name": labels.get(x["unit_id"], x["unit_id"]), "entries": int(x["n"]),
                    "clutch": _rate(x)} for x in q.sort("mean", descending=True).iter_rows(named=True)]
    payload = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "min_entries": {"stint": 2 * MIN_YEAR["stint"], "player": 2 * MIN_YEAR["player"]},
               "team_stats": {c: _meta(c, res[c]["stint"]) for c in team_classes},
               "player_stats": {"clutch": _meta("clutch", res["clutch"]["player"])} if players_pass else {},
               "source": SOURCE, "teams": sorted(records.values(), key=lambda x: -x["maps"]), "players": players}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "clutch.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {out_dir / 'clutch.json'}")
    return 0


def build(model: str, resamples: int = 1000, publish: bool = False) -> int:
    for path, cmd in ((TEAM_MAP_RESIDUALS, "cs2wp team-factor"), (TEAM_ROUNDS, "cs2wp team-stats")):
        if not path.exists():
            raise FileNotFoundError(f"{path} not found; run `{cmd}` first")
    rows = build_entries(model)
    rows.write_parquet(CLUTCH_ENTRIES)
    residuals = pl.read_parquet(TEAM_MAP_RESIDUALS)
    res, est = results(rows, resamples, unit_elo(residuals))
    est.write_parquet(CLUTCH_UNITS)
    labels = _labels(rows)
    lines = report_lines(rows, res, est, labels)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "clutch.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {CLUTCH_ENTRIES}, {CLUTCH_UNITS}")
    return export_public(est, res, labels, residuals) if publish else 0
