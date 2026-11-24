"""WAR validation without roster moves: split-half reliability per round, whether prior lineup WAR adds to Elo, and team-context leakage."""

import math

from pathlib import Path

import numpy as np
import polars as pl
from sklearn.linear_model import LogisticRegression

from .baselines import BLENDS, VERSIONS, versions_in
from .data import MapRef, catalog
from .paths import ROLE_ROUNDS, ROLE_ROUNDS_BLEND, WAR_REPORTS
from .pipeline import player_rounds
from .war import bootstrap_players, load_adjusted, load_round_values, map_outcomes, shrunk_rate

# The usage split is scored on the version whose WAA `k` sets the site gate for conversion.
TERM_VERSION = "wpa_opp"
TERMS = ("context", "usage", "conversion")
METRICS = (*VERSIONS, *TERMS, "rating3", "kd_diff")
LABELS = {
    "wpa": "WAA (WPA)",
    "nwpa_mancount": "WAA (neutral man-count)",
    "nwpa_event": "WAA (neutral event)",
    "wpa_opp": "WAA (WPA, own team at avg Elo)",
    "context": "Context (WPA, own team at avg Elo)",
    "usage": "Usage (WPA, own team at avg Elo)",
    "conversion": "Conversion (WPA, own team at avg Elo)",
    "rating3": "HLTV Rating 3.0",
    "kd_diff": "K−D / round",
    **{b: f"WAA (blend w={w:.2f})" for b, w in BLENDS.items()},
}
MIN_PLAYER_ROUNDS = 300
SITE_GATE_K_RATIO = 2
DEFAULT_TEST_FROM = "2026-03-01"
BOOTSTRAPS = 2000
# Players below this many prior rounds count as uncovered in the coverage figure; shrinkage still uses what they have.
COVERED_ROUNDS = 100


def metrics_in(columns) -> tuple[str, ...]:
    """`METRICS` with each blend present as `num_<b>`, `dev_<b>` or a rate column inserted after the versions."""
    cols = set(columns)
    blends = tuple(b for b in BLENDS if cols & {b, f"num_{b}", f"dev_{b}"})
    return (*VERSIONS, *blends, *METRICS[len(VERSIONS):])


def player_maps(adjusted: pl.DataFrame, box: pl.DataFrame) -> pl.DataFrame:
    """One row per (key, steamid): rounds and each metric's per-map numerator, so rates are `num_<m> / rounds`.

    A map without a usage split has null term numerators, so it drops out of those metrics only.
    """
    rows = adjusted.filter(pl.col("role").is_not_null())
    term = {"context": f"{TERM_VERSION}_context", "usage": f"{TERM_VERSION}_usage",
            "conversion": f"{TERM_VERSION}_conversion_rw"}
    term_exprs = [
        (pl.when(pl.col(c).is_not_null().all()).then(pl.col(c).sum()) if c in rows.columns
         else pl.lit(None, pl.Float64)).alias(f"num_{t}")
        for t, c in term.items()
    ]
    has_igl = "is_igl" in rows.columns
    war = rows.group_by("key", "steamid").agg(
        pl.col("date").first(),
        pl.col("event").first(),
        pl.col("lp_team").first(),
        (pl.col("is_igl").any() if has_igl else pl.lit(False)).alias("is_igl"),
        pl.col("rounds").sum(),
        *(pl.col(f"{v}_rw").sum().alias(f"num_{v}") for v in versions_in(rows.columns)),
        *term_exprs,
    )
    if box.is_empty():
        war = war.with_columns(pl.lit(None, pl.Float64).alias("num_rating3"), pl.lit(None, pl.Float64).alias("num_kd_diff"))
    else:
        b = box.unique(subset=["key", "steamid"], maintain_order=True).select(
            "key", "steamid",
            (pl.col("rating3") * pl.col("rounds")).alias("num_rating3"),
            (pl.col("kills").cast(pl.Float64) - pl.col("deaths").cast(pl.Float64)).alias("num_kd_diff"),
        )
        war = war.join(b, on=["key", "steamid"], how="left")
    return war.with_columns(pl.col("key").str.split("/").list.first().alias("series")).sort("date", "key", "steamid")


def _paired_halves(rows: pl.DataFrame, unit: list[str], col: str, min_half_rounds: float = 0, weight: str = "rounds") -> dict:
    """Correlation of per-unit rates `col / weight` between `half` 0 and 1, and `k` = half weight × (1 − r) / r.

    The returned `half_rounds` and `k` are in units of `weight`.
    """
    rows = rows.filter(pl.col(col).is_not_null())
    rates = rows.group_by(*unit, "half").agg((pl.col(col).sum() / pl.col(weight).sum()).alias("rate"),
                                             pl.col(weight).sum().alias("rounds"))
    rates = rates.filter(pl.col("rounds") >= min_half_rounds)
    paired = rates.filter(pl.col("half") == 0).join(rates.filter(pl.col("half") == 1), on=unit, suffix="_b")
    if paired.height < 10:
        return {"r": None, "k": None, "players": paired.height, "half_rounds": None}
    r = float(np.corrcoef(paired["rate"].to_numpy(), paired["rate_b"].to_numpy())[0, 1])
    half_rounds = float(np.median(np.concatenate([paired["rounds"].to_numpy(), paired["rounds_b"].to_numpy()])))
    k = half_rounds * (1 - r) / r if r > 0 else math.inf
    return {"r": r, "k": k, "players": paired.height, "half_rounds": half_rounds}


def _alternating(rows: pl.DataFrame, unit: list[str]) -> pl.DataFrame:
    halves = (
        rows.group_by(*unit, "series").agg(pl.col("date").min().alias("_d"))
        .sort(*unit, "_d", "series")
        .with_columns((pl.int_range(pl.len()).over(unit) % 2).alias("half"))
        .drop("_d")
    )
    return rows.join(halves, on=[*unit, "series"])


def split_half(pm: pl.DataFrame, min_rounds: int = MIN_PLAYER_ROUNDS) -> dict[str, dict]:
    """Per metric: correlation between a player's alternating-series halves, and `k`, the rounds at which reliability is 0.5.

    Reliability at n rounds is n / (n + k), which is also the shrinkage weight `cs2wp validate-war` uses.
    """
    totals = pm.group_by("steamid").agg(pl.col("rounds").sum())
    elig = totals.filter(pl.col("rounds") >= min_rounds)["steamid"]
    sub = _alternating(pm.filter(pl.col("steamid").is_in(elig.implode())), ["steamid"])
    return {m: _paired_halves(sub, ["steamid"], f"num_{m}") for m in metrics_in(pm.columns)}


def split_half_deltas(pm: pl.DataFrame, ref: str = TERM_VERSION, min_rounds: int = MIN_PLAYER_ROUNDS,
                      n: int = BOOTSTRAPS, seed: int = 0) -> dict[str, dict]:
    """Split-half r of each WAA version minus `ref`'s, on the same players and halves, with a 90% player-bootstrap interval."""
    totals = pm.group_by("steamid").agg(pl.col("rounds").sum())
    elig = totals.filter(pl.col("rounds") >= min_rounds)["steamid"]
    sub = _alternating(pm.filter(pl.col("steamid").is_in(elig.implode())), ["steamid"])
    versions = [m for m in metrics_in(pm.columns) if m in VERSIONS or m in BLENDS]
    rates = (sub.group_by("steamid", "half").agg(*((pl.col(f"num_{v}").sum() / pl.col("rounds").sum()).alias(v) for v in versions))
             .sort("steamid"))
    a, b = rates.filter(pl.col("half") == 0), rates.filter(pl.col("half") == 1)
    paired = a.join(b, on="steamid", suffix="_b")
    if paired.height < 10:
        return {}

    def corr(v: str, idx: np.ndarray) -> np.ndarray:
        x, y = paired[v].to_numpy()[idx], paired[f"{v}_b"].to_numpy()[idx]
        xc, yc = x - x.mean(axis=-1, keepdims=True), y - y.mean(axis=-1, keepdims=True)
        return (xc * yc).sum(axis=-1) / np.sqrt((xc ** 2).sum(axis=-1) * (yc ** 2).sum(axis=-1))

    rng = np.random.default_rng(seed)
    draws = rng.integers(0, paired.height, size=(n, paired.height))
    full = np.arange(paired.height)
    ref_full, ref_draws = corr(ref, full), corr(ref, draws)
    out = {}
    for v in versions:
        if v == ref:
            continue
        lo, hi = np.quantile(corr(v, draws) - ref_draws, [0.05, 0.95])
        out[v] = {"d": float(corr(v, full) - ref_full), "lo": float(lo), "hi": float(hi), "players": paired.height}
    return out


TEAM_UNIT = ["steamid", "lp_team"]
SPLITS = {
    "alternating": "Alternating series",
    "team_elo": "Team pre-map Elo above vs below the stint's median",
    "result": "Map won vs lost",
}
# Each half of a player-team stint needs this many rounds, so lopsided won/lost splits don't pair tiny samples.
MIN_HALF_ROUNDS = 100
TOP_N = 20


def with_team_deviation(pm: pl.DataFrame) -> pl.DataFrame:
    """Adds `dev_<m>`: the player's numerator minus rounds × the team's rate on that map."""
    team = ["key", "lp_team"]
    return pm.with_columns(
        (pl.col(f"num_{m}") - pl.col("rounds") * (
            pl.col(f"num_{m}").sum().over(team) / pl.col("rounds").filter(pl.col(f"num_{m}").is_not_null()).sum().over(team)
        )).alias(f"dev_{m}")
        for m in metrics_in(pm.columns)
    )


def team_context_maps(pm: pl.DataFrame, refs: list[MapRef], outcomes: pl.DataFrame) -> pl.DataFrame:
    """Player maps with the team's pre-map Elo, the map result, and `dev_<m>` (see `with_team_deviation`)."""
    elo = pl.DataFrame([{"key": r.key, "lp_team": t, "team_elo": float(e)} for r in refs for t, e in r.elo],
                       schema={"key": pl.String, "lp_team": pl.String, "team_elo": pl.Float64}).unique(["key", "lp_team"])
    team = ["key", "lp_team"]
    return with_team_deviation(pm).join(elo, on=team).join(outcomes, on=team)


def _rate(col: str) -> pl.Expr:
    return pl.col(col).sum() / pl.col("rounds").filter(pl.col(col).is_not_null()).sum()


def team_context(tc: pl.DataFrame, pm: pl.DataFrame, ks: dict[str, float], min_rounds: int = MIN_PLAYER_ROUNDS) -> dict:
    """Leakage checks on player-team stints: within-team reliability under form splits, link to team Elo, and top-N concentration."""
    stints = tc.group_by(TEAM_UNIT).agg(pl.col("rounds").sum()).filter(pl.col("rounds") >= min_rounds).select(TEAM_UNIT)
    sub = tc.join(stints, on=TEAM_UNIT)
    halves = {
        "alternating": _alternating(sub, TEAM_UNIT),
        "team_elo": sub.with_columns((pl.col("team_elo") >= pl.col("team_elo").median().over(TEAM_UNIT)).cast(pl.Int8).alias("half")),
        "result": sub.with_columns(pl.col("won").cast(pl.Int8).alias("half")),
    }
    metrics = metrics_in(tc.columns)
    within = {s: {m: _paired_halves(h, TEAM_UNIT, f"dev_{m}", MIN_HALF_ROUNDS) for m in metrics} for s, h in halves.items()}

    stint_rates = sub.group_by(TEAM_UNIT).agg(
        pl.col("team_elo").mean(), *(_rate(f"num_{m}").alias(m) for m in metrics), *(_rate(f"dev_{m}").alias(f"dev_{m}") for m in metrics)
    )
    between = {}
    for m in metrics:
        s = stint_rates.filter(pl.col(m).is_finite() & pl.col(f"dev_{m}").is_finite())
        if s.height < 10:
            continue
        total, dev = s[m].to_numpy(), s[f"dev_{m}"].to_numpy()
        between[m] = {"stints": s.height, "r_team_elo": float(np.corrcoef(total, s["team_elo"].to_numpy())[0, 1]),
                      "team_share": float(1 - dev.var() / total.var())}

    main_team = (pm.group_by("steamid", "lp_team").agg(pl.col("rounds").sum())
                 .sort("rounds", descending=True).unique("steamid", keep="first"))
    rated = shrunk_rates(pm, ks).filter(pl.col("prior_rounds") >= min_rounds).join(main_team.select("steamid", "lp_team"), on="steamid")
    top = {}
    for m in metrics:
        k = ks.get(m)
        if k is None or not math.isfinite(k):
            continue
        counts = rated.sort(m, descending=True).head(TOP_N)["lp_team"].value_counts().sort(["count", "lp_team"], descending=[True, False])
        top[m] = {"teams": counts.height, "max_one_team": int(counts["count"][0]), "leader": counts["lp_team"][0]}
    return {"stints": stints.height, "within": within, "between": between, "top": top, "players": rated.height}


def shrunk_rates(prior: pl.DataFrame, ks: dict[str, float]) -> pl.DataFrame:
    """Per player, each metric's prior rate shrunk toward the league mean by `k` rounds, minus that mean."""
    metrics = metrics_in(prior.columns)
    agg = prior.group_by("steamid").agg(
        pl.col("rounds").sum(),
        *(pl.col(f"num_{m}").sum() for m in metrics),
        *(pl.col("rounds").filter(pl.col(f"num_{m}").is_not_null()).sum().alias(f"rds_{m}") for m in metrics),
    )
    cols = []
    for m in metrics:
        n_all = prior.filter(pl.col(f"num_{m}").is_not_null())
        mean = float(n_all[f"num_{m}"].sum() / n_all["rounds"].sum()) if n_all.height else 0.0
        cols.append((shrunk_rate(pl.col(f"num_{m}"), pl.col(f"rds_{m}"), ks.get(m), mean) - mean).fill_null(0.0).alias(m))
    return agg.select("steamid", pl.col("rounds").alias("prior_rounds"), *cols)


CALIBRATION_CUTOFFS = ("2025-10-01", "2026-01-01", "2026-03-01", "2026-06-01")
Z90 = 1.6448536269514722
SPOT_CHECK_PLAYERS = 20


def map_moments(round_values: pl.DataFrame, dates: pl.DataFrame) -> pl.DataFrame:
    """Per (steamid, key): rounds, date, series, and per version the sum `s_<v>` and sum of squares `q_<v>` of round values."""
    return (
        round_values.group_by("steamid", "key")
        .agg(pl.len().alias("rounds"),
             *(pl.col(f"{v}_rw").fill_null(0.0).sum().alias(f"s_{v}") for v in VERSIONS),
             *(pl.col(f"{v}_rw").fill_null(0.0).pow(2).sum().alias(f"q_{v}") for v in VERSIONS))
        .join(dates, on="key")
        .with_columns(pl.col("key").str.split("/").list.first().alias("series"))
    )


def _half_rates(moments: pl.DataFrame, unit: str) -> pl.DataFrame:
    """Per (steamid, half): each version's rate and the SE a bootstrap over `unit` ('round' or 'map') estimates."""
    def se(v: str) -> pl.Expr:
        n, rate = pl.col("rounds").sum(), pl.col(f"s_{v}").sum() / pl.col("rounds").sum()
        if unit == "round":
            return ((pl.col(f"q_{v}").sum() / n - rate ** 2).clip(lower_bound=0.0) / n).sqrt()
        return (((pl.col(f"s_{v}") - rate * pl.col("rounds")) ** 2).sum() / n ** 2).sqrt()

    return moments.group_by("steamid", "half").agg(
        pl.col("rounds").sum(),
        *((pl.col(f"s_{v}").sum() / pl.col("rounds").sum()).alias(f"rate_{v}") for v in VERSIONS),
        *(se(v).alias(f"se_{v}") for v in VERSIONS),
    )


def _coverage(halves: pl.DataFrame, unit: str, min_half_rounds: int) -> dict[str, dict]:
    rates = _half_rates(halves, unit).filter(pl.col("rounds") >= min_half_rounds)
    paired = rates.filter(pl.col("half") == 0).join(rates.filter(pl.col("half") == 1), on="steamid", suffix="_b")
    out = {}
    for v in VERSIONS:
        se = np.sqrt(paired[f"se_{v}"].to_numpy() ** 2 + paired[f"se_{v}_b"].to_numpy() ** 2)
        z = np.abs(paired[f"rate_{v}"].to_numpy() - paired[f"rate_{v}_b"].to_numpy()) / np.where(se > 0, se, np.nan)
        z = z[np.isfinite(z)]
        out[v] = {"players": len(z), "coverage": float((z < Z90).mean()) if len(z) else None,
                  "c": float(np.quantile(z, 0.9) / Z90) if len(z) else None}
    return out


def interval_calibration(moments: pl.DataFrame, min_rounds: int = MIN_PLAYER_ROUNDS,
                         cutoffs: tuple[str, ...] = CALIBRATION_CUTOFFS) -> dict:
    """How often two halves of a player's record land within each other's 90% intervals, under round and map resampling.

    `alternating` splits by alternating series (no real change, so calibrated intervals cover 90%). `next` pairs the
    rounds before and after each cutoff (real change lowers coverage). `c` is the 90th percentile of |z| over 1.645:
    the factor the intervals would need to widen by.
    """
    totals = moments.group_by("steamid").agg(pl.col("rounds").sum())
    elig = totals.filter(pl.col("rounds") >= min_rounds)["steamid"].implode()
    alt = _alternating(moments.filter(pl.col("steamid").is_in(elig)), ["steamid"])
    nxt = pl.concat([moments.with_columns((pl.col("date") >= c).cast(pl.Int64).alias("half"),
                                          (pl.col("steamid").cast(pl.String) + "@" + c).alias("steamid"))
                     for c in cutoffs])
    return {split: {unit: _coverage(h, unit, mh) for unit in ("round", "map")}
            for split, h, mh in (("alternating", alt, 0), ("next", nxt, min_rounds))}


def spot_check_round_se(round_values: pl.DataFrame, moments: pl.DataFrame, n_players: int = SPOT_CHECK_PLAYERS,
                        seed: int = 0) -> float:
    """Median ratio of the round bootstrap's 90% half-width to 1.645 × the analytical round SE, on `wpa_opp`."""
    players = (moments.group_by("steamid").agg(pl.col("rounds").sum()).filter(pl.col("rounds") >= MIN_PLAYER_ROUNDS)
               .sort("steamid").sample(min(n_players, moments["steamid"].n_unique()), seed=seed, shuffle=False))
    sids = players["steamid"].to_list()
    boot = bootstrap_players(round_values, sids, 1.0, columns={"wpa_opp": "wpa_opp_rw"})
    se = _half_rates(moments.filter(pl.col("steamid").is_in(sids)).with_columns(pl.lit(0).alias("half")), "round")
    j = boot.join(se, on="steamid")
    ratio = (j["wpa_opp_per100_p95"] - j["wpa_opp_per100_p5"]) / 2 / (100 * Z90 * j["se_wpa_opp"])
    return float(ratio.median())


def calibration_lines(cal: dict, spot: float, min_rounds: int) -> list[str]:
    pct = lambda r: "n/a" if r["coverage"] is None else f"{100 * r['coverage']:.0f}%"
    cf = lambda r: "n/a" if r["c"] is None else f"{r['c']:.2f}"
    lines = [
        "",
        "## Interval calibration",
        "",
        "Share of players whose two halves fall within each other's 90% intervals (|z| < 1.645, "
        "z = rate difference / √(se₀² + se₁²)). Calibrated intervals give 90% on alternating series, where the true rate "
        f"doesn't change; next period pairs {min_rounds}+ rounds before and after "
        f"{', '.join(CALIBRATION_CUTOFFS)}, so real change lowers it. `c` is the factor intervals would need to widen by. "
        f"The round SE matches the published round bootstrap: median half-width ratio {spot:.3f}.",
        "",
        "| Metric | Alternating: players | Round | Map | c round | c map | Next: pairs | Round | Map | c round | c map |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for v in VERSIONS:
        a, n = cal["alternating"], cal["next"]
        lines.append(f"| {LABELS[v]} | {a['round'][v]['players']} | {pct(a['round'][v])} | {pct(a['map'][v])} | "
                     f"{cf(a['round'][v])} | {cf(a['map'][v])} | {n['round'][v]['players']} | {pct(n['round'][v])} | "
                     f"{pct(n['map'][v])} | {cf(n['round'][v])} | {cf(n['map'][v])} |")
    return lines


def map_lineups(
    refs: list[MapRef],
    pm: pl.DataFrame,
    scores_or_outcomes: pl.DataFrame,
    ks: dict[str, float],
    test_from: str = "",
    within_ks: dict[str, float] | None = None,
    mode: str = "prior",
    require_elo: bool = False,
    include_sides: bool = False,
) -> pl.DataFrame:
    """One row per map: both lineups' steamids and IGLs, optional scores/Elo, and out-of-sample rate differences.

    `mode='prior'` uses maps dated strictly before each event starts; `mode='loeo'` uses every other event.
    """
    if mode not in ("prior", "loeo"):
        raise ValueError(f"Unknown mode: {mode}")
    if within_ks is not None:
        pm = with_team_deviation(pm)
    starts = dict(pm.group_by("event").agg(pl.col("date").min()).iter_rows())
    keys_event = dict(pm.select("key", "event").unique("key").iter_rows())
    lineups = {k: g for (k,), g in pm.group_by("key")}
    has_igl = "is_igl" in pm.columns
    has_scores = "rounds_won" in scores_or_outcomes.columns and "rounds" in scores_or_outcomes.columns
    score_lookup = {(r["key"], r["lp_team"]): r for r in scores_or_outcomes.iter_rows(named=True)}
    teams_by_key: dict[str, list[str]] = {}
    for k, t in score_lookup:
        teams_by_key.setdefault(k, []).append(t)
    by_event: dict[str, list[MapRef]] = {}
    for ref in refs:
        if ref.date >= test_from and ref.key in keys_event:
            by_event.setdefault(keys_event[ref.key], []).append(ref)

    features = _features(within_ks is not None, pm.columns)
    metrics = metrics_in(pm.columns)
    rows = []
    for event, event_refs in by_event.items():
        other = pm.filter(pl.col("date") < starts[event]) if mode == "prior" else pm.filter(pl.col("event") != event)
        rates = shrunk_rates(other, ks)
        if within_ks is not None:
            devs = shrunk_rates(other.select("steamid", "rounds", *(pl.col(f"dev_{m}").alias(f"num_{m}") for m in metrics)), within_ks)
            rates = rates.join(devs.select("steamid", *(pl.col(m).alias(f"within_{m}") for m in metrics)), on="steamid", how="left")
        for ref in event_refs:
            if len(ref.elo) == 2:
                (a, ra), (b, rb) = ref.elo
                elo_a, elo_b, elo_logit = float(ra), float(rb), (ra - rb) * math.log(10) / 400
            elif require_elo:
                continue
            else:
                ts = sorted(teams_by_key.get(ref.key, ()))
                if len(ts) != 2:
                    continue
                a, b = ts
                elo_a = elo_b = elo_logit = None
            if (ref.key, a) not in score_lookup or (ref.key, b) not in score_lookup:
                continue
            key_lu = lineups[ref.key]
            lu = key_lu.select("steamid", "lp_team").join(rates, on="steamid", how="left").fill_null(0)
            side = {t: lu.filter(pl.col("lp_team") == t) for t in (a, b)}
            if side[a].height < 5 or side[b].height < 5:
                continue
            n_cov = int((side[a]["prior_rounds"] >= COVERED_ROUNDS).sum() + (side[b]["prior_rounds"] >= COVERED_ROUNDS).sum())
            raw_side = {t: key_lu.filter(pl.col("lp_team") == t) for t in (a, b)}

            def _igl(df: pl.DataFrame) -> int | None:
                if not has_igl:
                    return None
                ids = df.filter(pl.col("is_igl"))["steamid"].to_list()
                return int(ids[0]) if len(ids) == 1 else None

            sc_a, sc_b = score_lookup[(ref.key, a)], score_lookup[(ref.key, b)]
            rds = int(sc_a["rounds"]) if has_scores else None
            rw_a = int(sc_a["rounds_won"]) if has_scores else None
            rw_b = int(sc_b["rounds_won"]) if has_scores else None
            share_a = float(rw_a) / float(rds) if (has_scores and rds) else None
            row = {
                "key": ref.key, "series": ref.key.split("/")[0], "event": event, "date": ref.date,
                "team_a": a, "team_b": b,
                "steamids_a": [int(s) for s in side[a]["steamid"].to_list()],
                "steamids_b": [int(s) for s in side[b]["steamid"].to_list()],
                "igl_a": _igl(raw_side[a]), "igl_b": _igl(raw_side[b]),
                "rounds": rds, "rounds_won_a": rw_a, "rounds_won_b": rw_b,
                "share_a": share_a, "share_diff": (share_a - 0.5) if share_a is not None else None,
                "y": float(sc_a["won"]),
                "elo_a": elo_a, "elo_b": elo_b, "elo_logit": elo_logit,
                "covered": float(n_cov / 10),
                "all_covered": side[a].height == 5 and side[b].height == 5 and n_cov == 10,
            }
            for f in features:
                sa, sb = 100.0 * float(side[a][f].sum()), 100.0 * float(side[b][f].sum())
                row[f] = sa - sb
                if include_sides:
                    row[f"{f}_a"] = sa
                    row[f"{f}_b"] = sb
            rows.append(row)
    side_schema = {f"{f}_{s}": pl.Float64 for f in features for s in ("a", "b")} if include_sides else {}
    schema = {
        "key": pl.String, "series": pl.String, "event": pl.String, "date": pl.String,
        "team_a": pl.String, "team_b": pl.String,
        "steamids_a": pl.List(pl.UInt64), "steamids_b": pl.List(pl.UInt64),
        "igl_a": pl.UInt64, "igl_b": pl.UInt64,
        "rounds": pl.Int64, "rounds_won_a": pl.Int64, "rounds_won_b": pl.Int64,
        "share_a": pl.Float64, "share_diff": pl.Float64,
        "y": pl.Float64,
        "elo_a": pl.Float64, "elo_b": pl.Float64, "elo_logit": pl.Float64,
        "covered": pl.Float64, "all_covered": pl.Boolean,
        **{f: pl.Float64 for f in features},
        **side_schema,
    }
    return pl.DataFrame(rows, schema_overrides=schema) if rows else pl.DataFrame(schema=schema)


def lineup_rows(refs: list[MapRef], pm: pl.DataFrame, outcomes: pl.DataFrame, ks: dict[str, float], test_from: str,
                within_ks: dict[str, float] | None = None) -> pl.DataFrame:
    """One row per test map: Elo logit for the first Elo team, its result, and lineup differences in each prior metric.

    With `within_ks`, also `within_<m>`: the lineup difference in prior within-team deviations, shrunk by those `k`.
    Prior data is every map dated before the map's event starts, so nothing from the same event leaks in.
    """
    cols = ["key", "series", "event", "date", "y", "elo_logit", "covered", *_features(within_ks is not None, pm.columns)]
    return map_lineups(refs, pm, outcomes, ks, test_from=test_from, within_ks=within_ks, mode="prior", require_elo=True).select(cols)


def _features(within: bool, columns=()) -> list[str]:
    metrics = metrics_in(columns)
    return [*metrics, *(f"within_{m}" for m in metrics)] if within else list(metrics)


def _label(feature: str) -> str:
    return f"Within-team {LABELS[feature.removeprefix('within_')]}" if feature.startswith("within_") else LABELS[feature]


def _log_loss(y: np.ndarray, p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def _scaled(rows: pl.DataFrame, features: list[str]) -> np.ndarray:
    """Features divided by their SD (not centred: the fit has no intercept because team order is arbitrary)."""
    x = rows.select(features).to_numpy().astype(np.float64)
    return x / np.where(x.std(axis=0) > 0, x.std(axis=0), 1.0)


def cv_losses(rows: pl.DataFrame, features: list[str]) -> np.ndarray:
    """Per-map log loss of a no-intercept logistic fit, leaving one event out at a time."""
    x, y, groups = _scaled(rows, features), rows["y"].to_numpy(), rows["event"].to_numpy()
    out = np.empty(len(y))
    for g in np.unique(groups):
        test = groups == g
        fit = LogisticRegression(fit_intercept=False, C=1e4).fit(x[~test], y[~test])
        out[test] = _log_loss(y[test], fit.predict_proba(x[test])[:, 1])
    return out


def paired_ci(diff: np.ndarray, clusters: np.ndarray, n: int = BOOTSTRAPS, seed: int = 0) -> tuple[float, float]:
    """90% interval for the mean of `diff`, resampling whole clusters (series) so maps of one series move together."""
    rng = np.random.default_rng(seed)
    ids, inv = np.unique(clusters, return_inverse=True)
    sums, counts = np.bincount(inv, weights=diff), np.bincount(inv)
    draws = rng.integers(0, len(ids), size=(n, len(ids)))
    means = sums[draws].sum(axis=1) / counts[draws].sum(axis=1)
    lo, hi = np.quantile(means, [0.05, 0.95])
    return float(lo), float(hi)


def prediction(rows: pl.DataFrame) -> dict:
    y = rows["y"].to_numpy()
    raw = _log_loss(y, 1 / (1 + np.exp(-rows["elo_logit"].to_numpy())))
    base = cv_losses(rows, ["elo_logit"])
    clusters = rows["series"].to_numpy()
    res = {"maps": rows.height, "series": int(rows["series"].n_unique()), "events": int(rows["event"].n_unique()),
           "covered": float(rows["covered"].mean()), "elo_raw": float(raw.mean()), "elo_cv": float(base.mean()), "metrics": {}}
    for m in _features("within_wpa" in rows.columns, rows.columns):
        if rows[m].abs().sum() == 0:
            continue
        alone = cv_losses(rows, [m])
        both = cv_losses(rows, ["elo_logit", m])
        coef = LogisticRegression(fit_intercept=False, C=1e4).fit(_scaled(rows, ["elo_logit", m]), y).coef_[0]
        lo, hi = paired_ci(base - both, clusters)
        res["metrics"][m] = {"alone": float(alone.mean()), "with_elo": float(both.mean()), "gain": float((base - both).mean()),
                             "gain_lo": lo, "gain_hi": hi, "coef_elo": float(coef[0]), "coef": float(coef[1]),
                             "r_elo": float(np.corrcoef(rows[m].to_numpy(), rows["elo_logit"].to_numpy())[0, 1])}
    return res


def report_lines(rel: dict[str, dict], pred: dict, test_from: str, min_rounds: int) -> list[str]:
    f = lambda v, d=3: "n/a" if v is None else f"{v:.{d}f}"
    lines = [
        "# WAR validation",
        "",
        f"## Split-half reliability ({min_rounds}+ rounds, alternating series)",
        "",
        "`k` is the rounds at which reliability reaches 0.5; reliability at n rounds is n / (n + k).",
        "",
        "| Metric | Players | Half rounds (median) | Half r | k | Rel. at 1,000 rds | Rel. at 3,000 rds |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for m, r in rel.items():
        k = r["k"]
        at = lambda n: "n/a" if k is None or not math.isfinite(k) else f"{n / (n + k):.2f}"
        lines.append(f"| {LABELS[m]} | {r['players']} | {f(r['half_rounds'], 0)} | {f(r['r'])} | "
                     f"{'n/a' if k is None else ('∞' if not math.isfinite(k) else f'{k:,.0f}')} | {at(1000)} | {at(3000)} |")
    k_conv, k_waa = rel["conversion"]["k"], rel[TERM_VERSION]["k"]
    if k_conv is not None and k_waa is not None:
        passed = k_conv <= SITE_GATE_K_RATIO * k_waa
        lines += ["", f"Site gate for usage and conversion: conversion `k` ≤ {SITE_GATE_K_RATIO} × WAA `k` "
                  f"({LABELS[TERM_VERSION]}): {k_conv:,.0f} vs {SITE_GATE_K_RATIO * k_waa:,.0f}, "
                  f"**{'pass' if passed else 'fail'}**. The sense checks in `usage.md` are the other half."]
    lines += [
        "",
        f"## Does prior lineup WAR add to Elo? (maps from {test_from})",
        "",
        f"{pred['maps']:,} maps in {pred['series']:,} series from {pred['events']} events. Features use only maps before each "
        f"event, shrunk by `k`. {100 * pred['covered']:.0f}% of player slots have {COVERED_ROUNDS}+ prior rounds. "
        f"Log loss is leave-one-event-out. Elo as published: {pred['elo_raw']:.4f}; Elo refit: {pred['elo_cv']:.4f}.",
        "",
        "Gain is Elo-refit loss minus Elo+metric loss (positive = metric helps), with a 90% interval from resampling series. "
        "Coefficients are per SD of each feature, from a fit on all test maps.",
        "",
        "| Metric | Alone | Elo + metric | Gain | 90% CI | Elo coef | Metric coef | r with Elo |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for m, r in pred["metrics"].items():
        lines.append(f"| {_label(m)} | {r['alone']:.4f} | {r['with_elo']:.4f} | {r['gain']:+.4f} | "
                     f"({r['gain_lo']:+.4f}, {r['gain_hi']:+.4f}) | {r['coef_elo']:.3f} | {r['coef']:+.3f} | {r['r_elo']:.2f} |")
    return lines


def delta_lines(deltas: dict[str, dict]) -> list[str]:
    if not deltas:
        return []
    players = next(iter(deltas.values()))["players"]
    lines = ["", f"## Split-half r against {LABELS[TERM_VERSION]} ({players} players, same halves)", "",
             "90% interval from resampling players.", "", "| Metric | Δ half r | 90% CI |", "| --- | --- | --- |"]
    for m, d in deltas.items():
        lines.append(f"| {LABELS[m]} | {d['d']:+.3f} | ({d['lo']:+.3f}, {d['hi']:+.3f}) |")
    return lines


def team_context_lines(tc: dict, min_rounds: int) -> list[str]:
    kf = lambda k: "n/a" if k is None else ("∞" if not math.isfinite(k) else f"{k:,.0f}")
    rf = lambda v: "n/a" if v is None else f"{v:.3f}"
    lines = [
        "",
        f"## Team-context leakage ({tc['stints']} player-team stints with {min_rounds}+ rounds)",
        "",
        "Within-team rate: the player's rate minus the team's rate on the same maps. Halves need "
        f"{MIN_HALF_ROUNDS}+ rounds each. If ranks within a team hold as the team's form changes, `k` under the form splits "
        "should match `k` under alternating series. Much larger `k` there means credit moves between teammates with results.",
        "",
        "| Metric | " + " | ".join(f"{SPLITS[s]}: r / k (stints)" for s in SPLITS) + " |",
        "| --- | " + " | ".join("---" for _ in SPLITS) + " |",
    ]
    metrics = list(tc["within"]["alternating"])
    for m in metrics:
        cells = [f"{rf(r['r'])} / {kf(r['k'])} ({r['players']})" for r in (tc["within"][s][m] for s in SPLITS)]
        lines.append(f"| {LABELS[m]} | " + " | ".join(cells) + " |")
    lines += [
        "",
        "Team share is the fraction of stint-rate variance that the team's own rate explains (1 − var(within) / var(total)). "
        "With five players per team, pure noise gives about 0.2. "
        f"Top {TOP_N} uses each player's whole-archive rate shrunk by `k` ({tc['players']} players with {min_rounds}+ rounds), "
        "assigned to the team they played most rounds for.",
        "",
        f"| Metric | r with team Elo | Team share | Teams in top {TOP_N} | Most from one team |",
        "| --- | --- | --- | --- | --- |",
    ]
    for m in metrics:
        b, t = tc["between"].get(m), tc["top"].get(m)
        teams, most = (str(t["teams"]), f"{t['max_one_team']} ({t['leader']})") if t else ("n/a", "n/a")
        lines.append(f"| {LABELS[m]} | {rf(b and b['r_team_elo'])} | {rf(b and b['team_share'])} | {teams} | {most} |")
    return lines


def build(
    test_from: str = DEFAULT_TEST_FROM,
    min_rounds: int = MIN_PLAYER_ROUNDS,
    role_rounds: Path = ROLE_ROUNDS,
) -> int:
    adjusted, _ = load_adjusted(role_rounds=role_rounds)
    refs = catalog()
    pm = player_maps(adjusted, player_rounds(refs))

    rel = split_half(pm, min_rounds)
    ks = {m: r["k"] for m, r in rel.items()}
    outcomes = map_outcomes(refs)
    tc = team_context(team_context_maps(pm, refs, outcomes), pm, ks, min_rounds)
    within_ks = {m: r["k"] for m, r in tc["within"]["alternating"].items()}
    rows = lineup_rows(refs, pm, outcomes, ks, test_from, within_ks)
    if rows.height < 50:
        print(f"Only {rows.height} test maps from {test_from}; move --test-from earlier.")
        return 1
    lines = report_lines(rel, prediction(rows), test_from, min_rounds) + team_context_lines(tc, min_rounds)
    if any(b in rel for b in BLENDS):
        lines += delta_lines(split_half_deltas(pm, min_rounds=min_rounds))
    if Path(role_rounds).resolve() == ROLE_ROUNDS.resolve():
        round_values = load_round_values(refs, adjusted)
        moments = map_moments(round_values, pm.select("key", "date").unique("key"))
        lines += calibration_lines(interval_calibration(moments, min_rounds), spot_check_round_se(round_values, moments),
                                   min_rounds)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    suffix = {ROLE_ROUNDS.resolve(): "", ROLE_ROUNDS_BLEND.resolve(): ".blend"}.get(Path(role_rounds).resolve(), ".sub")
    out_name = f"war-validation{suffix}.md"
    (WAR_REPORTS / out_name).write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0
