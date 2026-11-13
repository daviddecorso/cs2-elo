"""Player WAA/WAR: zero-sum IGL adjustment, map-win conversion, and per-round bootstrap intervals (Phase 6, items 6-8)."""

from datetime import datetime, timezone
import json
import math
from pathlib import Path

import numpy as np
import polars as pl

from .baselines import VERSIONS
from .data import MapRef, catalog
from .igls import assign_igls, load_table as load_igl_table
from .paths import (
    CREDITS,
    CT_POSITIONS,
    DUEL_SIDES,
    IGLS,
    MODELS,
    PLAYER_WAR,
    PUBLIC_WAR,
    ROLE_ROUNDS,
    STATES,
    T_ROLES,
    USAGE,
    USAGE_ROUNDS,
    WAR_REPORTS,
)
from .pipeline import _summed, player_rounds
from .publish import SOURCE
from .rolecheck import SITE_POSITIONS
from .states import CT, T

MIN_PLAYER_ROUNDS = 300
DEFAULT_RESAMPLES = 1000
MONTH_CUTOFFS = (100, 200, 300)


def analytical_mr12_rounds_per_win() -> float:
    """Marginal round-wins per map win at p = 0.5 under MR12 regulation plus repeating MR3 overtime."""
    def p_map(p: float) -> float:
        reg = sum(math.comb(12 + k, k) * (p**13) * ((1 - p) ** k) for k in range(12))
        tie = math.comb(24, 12) * (p**12) * ((1 - p) ** 12)
        ot_win = sum(math.comb(3 + k, k) * (p**4) * ((1 - p) ** k) for k in range(3))
        ot_tie = math.comb(6, 3) * (p**3) * ((1 - p) ** 3)
        return reg + tie * (ot_win / (1 - ot_tie))

    eps = 1e-5
    dp_dp = (p_map(0.5 + eps) - p_map(0.5 - eps)) / (2 * eps)
    e_reg = sum((13 + k) * 2 * math.comb(12 + k, k) * (0.5 ** (13 + k)) for k in range(12))
    tie = math.comb(24, 12) * (0.5**24)
    ot_tie = math.comb(6, 3) * (0.5**6)
    e_ot = sum((4 + k) * 2 * math.comb(3 + k, k) * (0.5 ** (4 + k)) for k in range(3)) + 6 * ot_tie
    return (e_reg + tie * (e_ot / (1 - ot_tie))) / dp_dp


def fit_igl_adjustment(rows: pl.DataFrame) -> pl.DataFrame:
    """Per-round adjustment by `(side, is_igl)` so both IGLs and non-IGLs center on 0.0 round-wins/round per side."""
    valid = rows.filter(pl.col("role").is_not_null())
    out = []
    for side in (CT, T):
        for is_igl in (True, False):
            sub = valid.filter((pl.col("side") == side) & (pl.col("is_igl") == is_igl))
            rds = int(sub["rounds"].sum())
            entry: dict[str, object] = {"side": side, "is_igl": is_igl, "fit_rounds": rds}
            for v in VERSIONS:
                entry[f"{v}_igl_adj"] = float(-sub[f"{v}_above"].sum() / rds) if rds > 0 else 0.0
            out.append(entry)
    return pl.DataFrame(out, schema_overrides={"side": pl.Int32, "is_igl": pl.Boolean})


TERMS = ("context", "usage", "conversion")
RESOURCE_COUNTS = ("eco_rounds", "force_rounds", "full_rounds", "eco_equip_share_sum", "force_equip_share_sum",
                   "full_equip_share_sum", "awp_rounds", "drop_received", "drop_given", "duels_all", "flash_support",
                   "self_flash", "smoke_support", "deaths", "deaths_traded")


def join_usage(rows: pl.DataFrame, path: Path = USAGE) -> pl.DataFrame:
    """Adds `<v>_context`, `<v>_usage`, `<v>_conversion` per player-map-side from `cs2wp usage`, null where missing."""
    if not path.exists():
        return rows
    u = pl.read_parquet(path).rename({"duels": "duels_all", "rounds": "usage_rounds"})
    return rows.join(u.drop(*(f"{v}_trade_return" for v in VERSIONS)), on=["key", "steamid", "side"], how="left")


def apply_igl_adjustment(rows: pl.DataFrame, adj: pl.DataFrame, replacement_rate: float = 0.0) -> pl.DataFrame:
    """Adds `<v>_rw`: round-wins above replacement (or above average when `replacement_rate == 0.0`).

    With usage joined, also `<v>_conversion_rw`: conversion plus the same IGL and replacement terms, so
    context + usage + conversion_rw = rw.
    """
    adj_cols = ["side", "is_igl", *(f"{v}_igl_adj" for v in VERSIONS)]
    shift = lambda v: (pl.col(f"{v}_igl_adj").fill_null(0.0) - replacement_rate) * pl.col("rounds")
    out = rows.join(adj.select(adj_cols), on=["side", "is_igl"], how="left").with_columns(
        (pl.col(f"{v}_above") + shift(v)).alias(f"{v}_rw") for v in VERSIONS)
    if "wpa_conversion" in out.columns:
        out = out.with_columns((pl.col(f"{v}_conversion") + shift(v)).alias(f"{v}_conversion_rw") for v in VERSIONS)
    return out


def map_outcomes(refs: list[MapRef]) -> pl.DataFrame:
    rows = []
    for ref in refs:
        rpath = ref.dir / "rounds.parquet"
        if not rpath.exists():
            continue
        last = pl.read_parquet(rpath, columns=["round_num", "ct_lp_team", "t_lp_team", "winner_lp_team"]).sort("round_num").row(-1, named=True)
        for team in (last["ct_lp_team"], last["t_lp_team"]):
            if team:
                rows.append({"key": ref.key, "lp_team": team, "won": float(team == last["winner_lp_team"])})
    return pl.DataFrame(rows) if rows else pl.DataFrame(schema={"key": pl.String, "lp_team": pl.String, "won": pl.Float64})


def estimate_rounds_per_win(adjusted_rows: pl.DataFrame, outcomes: pl.DataFrame) -> float:
    """Empirical round-WPA per map win from OLS of map win (0/1) on summed team `wpa_rw`."""
    rows = adjusted_rows.filter(pl.col("role").is_not_null()) if "role" in adjusted_rows.columns else adjusted_rows
    tm = (
        rows.group_by("key", "lp_team")
        .agg(pl.col("wpa_rw").sum())
        .join(outcomes, on=["key", "lp_team"], how="inner")
    )
    if tm.height < 10:
        return analytical_mr12_rounds_per_win()
    x = tm["wpa_rw"].to_numpy()
    y = tm["won"].to_numpy()
    vx = float(np.var(x))
    if vx <= 1e-12:
        return analytical_mr12_rounds_per_win()
    slope = float(np.mean((x - x.mean()) * (y - y.mean())) / vx)
    return 1.0 / slope if slope > 1e-6 else analytical_mr12_rounds_per_win()


def load_round_values(
    refs: list[MapRef],
    adjusted_rows: pl.DataFrame,
    replacement_rate: float = 0.0,
    usage_rounds: pl.DataFrame | None = None,
) -> pl.DataFrame:
    """Per `(steamid, key, round_num)` round-wins `<v>_rw`, including zero-credit rounds.

    With `usage_rounds`, also `<v>_<term>_r` for the three terms; conversion carries the IGL and replacement terms.
    """
    meta_cols = [
        "key",
        "steamid",
        "side",
        *(f"{v}_baseline" for v in VERSIONS),
        *(f"{v}_igl_adj" for v in VERSIONS),
    ]
    meta = adjusted_rows.filter(pl.col("role").is_not_null()).select(meta_cols)
    frames = []
    for ref in refs:
        cpath, rpath = CREDITS / f"{ref.slug}.parquet", STATES / ref.slug / "roster.parquet"
        if not cpath.exists() or not rpath.exists():
            continue
        roster = pl.read_parquet(rpath).select("steamid", "round_num", "side").with_columns(pl.lit(ref.key).alias("key"))
        cred = (
            pl.read_parquet(cpath)
            .group_by("steamid", "round_num")
            .agg(*(pl.col(v).sum() for v in VERSIONS))
            .with_columns(pl.col("round_num").cast(roster.schema["round_num"]))
        )
        frames.append(
            roster.join(cred, on=["steamid", "round_num"], how="left").with_columns(*(pl.col(v).fill_null(0.0) for v in VERSIONS))
        )
    if not frames:
        return pl.DataFrame()
    out = (
        pl.concat(frames, how="vertical_relaxed")
        .join(meta, on=["key", "steamid", "side"], how="inner")
        .with_columns(
            *(
                (pl.col(v) - pl.col(f"{v}_baseline") + pl.col(f"{v}_igl_adj") - replacement_rate).alias(f"{v}_rw")
                for v in VERSIONS
            )
        )
    )
    cols = [f"{v}_rw" for v in VERSIONS]
    if usage_rounds is not None:
        terms = [f"{v}_{t}" for v in VERSIONS for t in TERMS]
        out = (out.join(usage_rounds.select("key", pl.col("round_num").cast(out.schema["round_num"]), "steamid", *terms),
                        on=["key", "round_num", "steamid"], how="left")
               .with_columns(*(pl.col(f"{v}_{t}").alias(f"{v}_{t}_r") for v in VERSIONS for t in ("context", "usage")),
                             *((pl.col(f"{v}_conversion") + pl.col(f"{v}_igl_adj") - replacement_rate)
                               .alias(f"{v}_conversion_r") for v in VERSIONS)))
        cols += [f"{v}_{t}_r" for v in VERSIONS for t in TERMS]
    return out.select("steamid", "key", "round_num", *cols).sort("steamid", "key", "round_num")


def bootstrap_players(
    round_values: pl.DataFrame,
    steamids: list[int],
    r_win: float,
    resamples: int = DEFAULT_RESAMPLES,
    seed: int = 0,
    columns: dict[str, str] | None = None,
) -> pl.DataFrame:
    """90% (`p5`, `p95`) and `p50` intervals by resampling each player's played rounds with replacement.

    `columns` maps an output prefix to a per-round column; by default each version's `<v>_rw`. Rounds where a
    column is null count as zero.
    """
    if round_values.is_empty() or not steamids:
        return pl.DataFrame(schema={"steamid": pl.UInt64})
    columns = columns or {v: f"{v}_rw" for v in VERSIONS}
    sub = round_values.filter(pl.col("steamid").is_in(steamids)).sort("steamid", "key", "round_num")
    rng = np.random.default_rng(seed)
    out = []
    for part in sub.partition_by("steamid", maintain_order=True):
        sid = int(part["steamid"][0])
        vals = part.select(pl.col(list(columns.values())).fill_null(0.0)).to_numpy()
        n_r = len(vals)
        weights = rng.multinomial(n_r, np.full(n_r, 1.0 / n_r), size=resamples).astype(np.float64)
        means = (weights @ vals) / n_r
        q = np.quantile(means, [0.05, 0.50, 0.95], axis=0)
        row: dict[str, object] = {"steamid": sid}
        for j, prefix in enumerate(columns):
            for i, pct in enumerate(("p5", "p50", "p95")):
                row[f"{prefix}_waa_{pct}"] = float(n_r * q[i, j] / r_win)
                row[f"{prefix}_per100_{pct}"] = float(100.0 * q[i, j])
        out.append(row)
    return pl.DataFrame(out).with_columns(pl.col("steamid").cast(pl.UInt64))


def role_profiles(
    adjusted_rows: pl.DataFrame,
    t_roles: pl.DataFrame,
    ct_positions: pl.DataFrame,
) -> tuple[pl.DataFrame, dict[int, list[dict]]]:
    """Pooled T/CT role summaries and per-map modal CT roles for each `steamid` in `adjusted_rows`."""
    adjusted_rows = adjusted_rows.filter(pl.col("role").is_not_null())
    keys = adjusted_rows["key"].unique().to_list()
    t_sub = t_roles.filter(pl.col("key").is_in(keys))
    ct_sub = ct_positions.filter(pl.col("key").is_in(keys))

    t_modal = (
        adjusted_rows.filter((pl.col("side") == T) & pl.col("role").is_not_null())
        .group_by("steamid", "role")
        .agg(pl.col("rounds").sum().alias("rds"))
        .sort(["steamid", "rds", "role"], descending=[False, True, False])
        .group_by("steamid", maintain_order=True)
        .agg(pl.col("role").first().alias("t_role"))
    )
    t_shares = t_sub.group_by("steamid").agg(
        ((pl.col("opening_kills") + pl.col("opening_deaths")).sum() / pl.max_horizontal(pl.col("t_rounds").sum(), pl.lit(1))).alias(
            "entry_share"
        ),
        (
            (pl.col("t_awp_rounds") + pl.col("ct_awp_rounds")).sum()
            / pl.max_horizontal((pl.col("t_buy_rounds") + pl.col("ct_buy_rounds")).sum(), pl.lit(1))
        ).alias("awp_share"),
    )

    ct_rows = adjusted_rows.filter((pl.col("side") == CT) & pl.col("role").is_not_null())
    ct_summary = ct_rows.group_by("steamid").agg(
        (pl.col("rounds").filter(pl.col("role") == "AWPer").sum() / pl.col("rounds").sum()).alias("_ct_awp"),
        (
            pl.col("rounds").filter(pl.col("role").is_in(SITE_POSITIONS)).sum()
            / pl.max_horizontal(pl.col("rounds").filter(pl.col("role") != "AWPer").sum(), pl.lit(1))
        ).alias("site_share"),
    ).with_columns(
        pl.when(pl.col("_ct_awp") >= 0.5)
        .then(pl.lit("AWPer"))
        .when(pl.col("site_share") >= 0.5)
        .then(pl.lit("Anchor"))
        .otherwise(pl.lit("Rotator"))
        .alias("ct_role")
    ).drop("_ct_awp")

    ct_map_modal = (
        ct_rows.group_by("steamid", "map", "role")
        .agg(pl.len().alias("maps"), pl.col("rounds").sum().alias("rds"))
        .sort(["steamid", "maps", "rds", "map", "role"], descending=[False, True, True, False, False])
        .group_by("steamid", "map", maintain_order=True)
        .agg(pl.col("role").first().alias("role"), pl.col("maps").sum().alias("maps"))
        .sort(["steamid", "maps", "map"], descending=[False, True, False])
    )
    ct_by_map: dict[int, list[dict]] = {}
    for r in ct_map_modal.iter_rows(named=True):
        ct_by_map.setdefault(int(r["steamid"]), []).append(
            {"map": r["map"].removeprefix("de_"), "role": r["role"], "maps": int(r["maps"])}
        )

    latest = (
        adjusted_rows.sort("date", "key")
        .group_by("steamid")
        .agg(
            pl.col("lp_player").drop_nulls().last().alias("lp_player"),
            pl.col("lp_team").drop_nulls().last().alias("lp_team"),
            pl.col("key").n_unique().alias("maps"),
            pl.col("rounds").sum().alias("rounds"),
            (pl.col("rounds").filter(pl.col("is_igl")).sum() / pl.col("rounds").sum()).alias("igl_share"),
            *(pl.col(f"{v}_rw").sum() for v in VERSIONS),
        )
        .with_columns((pl.col("igl_share") >= 0.5).alias("is_igl"))
    )
    prof = (
        latest.join(t_modal, on="steamid", how="left")
        .join(t_shares, on="steamid", how="left")
        .join(ct_summary, on="steamid", how="left")
        .with_columns(
            pl.col("t_role").fill_null("Rifler"),
            pl.col("ct_role").fill_null("Rotator"),
            pl.col("awp_share").fill_null(0.0),
            pl.col("entry_share").fill_null(0.0),
            pl.col("site_share").fill_null(0.0),
        )
    )
    return prof, ct_by_map


def aggregate_players(
    adjusted_rows: pl.DataFrame,
    duel_sides: pl.DataFrame,
    box_per_map: pl.DataFrame,
    t_roles: pl.DataFrame,
    ct_positions: pl.DataFrame,
    r_win: float,
) -> tuple[pl.DataFrame, dict[int, list[dict]]]:
    adjusted_rows = adjusted_rows.filter(pl.col("role").is_not_null())
    prof, ct_by_map = role_profiles(adjusted_rows, t_roles, ct_positions)
    keys = adjusted_rows["key"].unique().to_list()
    duels = (
        duel_sides.filter(pl.col("key").is_in(keys))
        .group_by("steamid")
        .agg(pl.col("duels").sum(), pl.col("kills_above").sum(),
             *([pl.col("flash_gift").sum()] if "flash_gift" in duel_sides.columns else []))
    )
    box = (
        _summed(box_per_map.filter(pl.col("key").is_in(keys)).unique(subset=["key", "steamid"], maintain_order=True), ["steamid"]).select(
            "steamid", "name", "kd", "adr", "rating2_approx", "rating3", "swing"
        )
        if not box_per_map.is_empty()
        else pl.DataFrame(schema={"steamid": pl.UInt64})
    )

    players = (
        prof.join(duels, on="steamid", how="left")
        .join(box, on="steamid", how="left")
        .with_columns(
            pl.col("duels").fill_null(0),
            pl.col("kills_above").fill_null(0.0),
            (100.0 * pl.col("kills_above").fill_null(0.0) / pl.col("rounds")).alias("kills_above_per100"),
            *((pl.col(f"{v}_rw") / r_win).alias(f"{v}_waa") for v in VERSIONS),
            *((100.0 * pl.col(f"{v}_rw") / pl.col("rounds")).alias(f"{v}_per100") for v in VERSIONS),
        )
        .with_columns(pl.coalesce(pl.col("name"), pl.col("lp_player"), pl.col("steamid").cast(pl.String)).alias("name"))
    )
    return players, ct_by_map


def usage_players(adjusted_rows: pl.DataFrame, r_win: float) -> pl.DataFrame:
    """Per player: the three terms per version (WAA and per 100 rounds) and the resource detail, over the
    player-map-sides `cs2wp usage` covered."""
    rows = adjusted_rows.filter(pl.col("role").is_not_null() & pl.col("wpa_usage").is_not_null())
    term_col = lambda v, t: f"{v}_conversion_rw" if t == "conversion" else f"{v}_{t}"
    per100 = lambda c, d="usage_rounds": pl.when(pl.col(d) > 0).then(100.0 * pl.col(c) / pl.col(d))
    share = lambda c, d: pl.when(pl.col(d) > 0).then(pl.col(c) / pl.col(d))
    return (
        rows.group_by("steamid")
        .agg(pl.col("usage_rounds").sum(), *(pl.col(term_col(v, t)).sum().alias(f"{v}_{t}_sum")
                                            for v in VERSIONS for t in TERMS),
             *(pl.col(c).sum() for c in RESOURCE_COUNTS))
        .with_columns(
            *(per100(f"{v}_{t}_sum").alias(f"{v}_{t}_per100") for v in VERSIONS for t in TERMS),
            *((pl.col(f"{v}_{t}_sum") / r_win).alias(f"{v}_{t}_waa") for v in VERSIONS for t in TERMS),
            *(share(f"{b}_equip_share_sum", f"{b}_rounds").alias(f"{b}_equip_share") for b in ("eco", "force", "full")),
            share("awp_rounds", "usage_rounds").alias("awp_rate"),
            per100("drop_received").alias("drops_received_per100"),
            per100("drop_given").alias("drops_given_per100"),
            share("flash_support", "duels_all").alias("flash_support_share"),
            share("self_flash", "duels_all").alias("self_flash_share"),
            share("smoke_support", "duels_all").alias("smoke_support_share"),
            share("deaths_traded", "deaths").alias("traded_death_rate"),
        )
        .drop(*(f"{v}_{t}_sum" for v in VERSIONS for t in TERMS))
    )


def _corr_pair(df: pl.DataFrame, a: str, b: str) -> tuple[float | None, int]:
    d = df.select(a, b).drop_nulls().drop_nans()
    if d.height <= 2:
        return None, d.height
    val = float(np.corrcoef(d[a].to_numpy(), d[b].to_numpy())[0, 1])
    return (None if np.isnan(val) else val), d.height


def validation_metrics(
    adjusted_rows: pl.DataFrame,
    duel_sides: pl.DataFrame,
    box_per_map: pl.DataFrame,
    players: pl.DataFrame,
    min_rounds: int = MIN_PLAYER_ROUNDS,
) -> dict:
    adjusted_rows = adjusted_rows.filter(pl.col("role").is_not_null())
    keys = adjusted_rows["key"].unique().to_list()
    per_map_war = adjusted_rows.group_by("key", "date", "steamid").agg(
        pl.col("rounds").sum(),
        *(pl.col(v).sum() for v in VERSIONS),
        *(pl.col(f"{v}_rw").sum() for v in VERSIONS),
    )
    per_map_duels = duel_sides.filter(pl.col("key").is_in(keys)).group_by("key", "steamid").agg(pl.col("kills_above").sum())
    per_map = per_map_war.join(per_map_duels, on=["key", "steamid"], how="left").with_columns(
        pl.col("kills_above").fill_null(0.0),
        pl.col("date").str.slice(0, 7).alias("month"),
    )
    if not box_per_map.is_empty():
        per_map = per_map.join(
            box_per_map.unique(subset=["key", "steamid"], maintain_order=True).select(
                "key", "steamid", "kills", "deaths", "assists", "damage", "kast_rounds", "rating3", "swing", "lp_player", "name"
            ),
            on=["key", "steamid"],
            how="left",
        )

    rate_cols = [*(f"{v}_waa_r" for v in VERSIONS), "wpa_raw_r", "kills_above_r"]
    if not box_per_map.is_empty():
        rate_cols += ["rating2_approx", "rating3", "swing", "kd"]

    def group_rates(df: pl.DataFrame, by: list[str]) -> pl.DataFrame:
        has_box = "kills" in df.columns
        exprs = [
            pl.col("rounds").sum(),
            *(pl.col(f"{v}_rw").sum() for v in VERSIONS),
            pl.col("wpa").sum().alias("_wpa_raw"),
            pl.col("kills_above").sum(),
        ]
        if has_box:
            exprs += [
                *(pl.col(c).fill_null(0).sum() for c in ("kills", "deaths", "assists", "damage", "kast_rounds")),
                (pl.col("rating3") * pl.col("rounds")).sum().alias("_r3"),
                (pl.col("swing") * pl.col("rounds")).sum().alias("_sw"),
                pl.col("rounds").filter(pl.col("rating3").is_not_null()).sum().alias("_hr"),
            ]
        out = df.group_by(by).agg(*exprs).with_columns(
            *((pl.col(f"{v}_rw") / pl.col("rounds")).alias(f"{v}_waa_r") for v in VERSIONS),
            (pl.col("_wpa_raw") / pl.col("rounds")).alias("wpa_raw_r"),
            (pl.col("kills_above") / pl.col("rounds")).alias("kills_above_r"),
        )
        if has_box:
            from .ratings import rating2

            out = rating2(out).with_columns(
                pl.when(pl.col("_hr") > 0).then(pl.col("_r3") / pl.col("_hr")).alias("rating3"),
                pl.when(pl.col("_hr") > 0).then(pl.col("_sw") / pl.col("_hr")).alias("swing"),
            )
        return out

    monthly_all = group_rates(per_map, ["steamid", "month"])
    month_to_month: dict[int, dict[str, dict]] = {}
    for cutoff in MONTH_CUTOFFS:
        m = monthly_all.filter(pl.col("rounds") >= cutoff)
        months = sorted(m["month"].unique().to_list())
        pairs = [m.filter(pl.col("month") == a).join(m.filter(pl.col("month") == b), on="steamid", suffix="_next") for a, b in zip(months, months[1:])]
        paired = pl.concat(pairs, how="vertical_relaxed") if pairs else pl.DataFrame()
        res: dict[str, dict] = {}
        for col in rate_cols:
            if paired.is_empty() or col not in paired.columns:
                res[col] = {"r": None, "pairs": 0}
            else:
                r, n = _corr_pair(paired, col, f"{col}_next")
                res[col] = {"r": r, "pairs": n}
        month_to_month[cutoff] = res

    # Alternating chronological series keeps multi-map series against one opponent inside a single half.
    elig = players.filter(pl.col("rounds") >= min_rounds)["steamid"].to_list()
    with_series = per_map.filter(pl.col("steamid").is_in(elig)).with_columns(
        pl.col("key").str.split("/").list.first().alias("_series")
    )
    series_halves = (
        with_series.group_by("steamid", "_series")
        .agg(pl.col("date").min().alias("_sdate"))
        .sort("steamid", "_sdate", "_series")
        .with_columns((pl.int_range(pl.len()).over("steamid") % 2).alias("half"))
        .select("steamid", "_series", "half")
    )
    halves = with_series.join(series_halves, on=["steamid", "_series"], how="inner")
    h_rates = group_rates(halves, ["steamid", "half"])
    h_paired = h_rates.filter(pl.col("half") == 0).join(h_rates.filter(pl.col("half") == 1), on="steamid", suffix="_odd")
    split_half: dict[str, dict] = {}
    for col in rate_cols:
        if h_paired.is_empty() or col not in h_paired.columns:
            split_half[col] = {"r": None, "spearman_brown": None, "players": 0}
        else:
            r, n = _corr_pair(h_paired, col, f"{col}_odd")
            sb = (2 * r / (1 + r)) if (r is not None and (1 + r) > 1e-9) else None
            split_half[col] = {"r": r, "spearman_brown": sb, "players": n}

    qual = players.filter(pl.col("rounds") >= min_rounds)
    kd_map = {
        "wpa_waa_r": "wpa_per100",
        "nwpa_mancount_waa_r": "nwpa_mancount_per100",
        "nwpa_event_waa_r": "nwpa_event_per100",
        "kills_above_r": "kills_above_per100",
        "rating2_approx": "rating2_approx",
        "rating3": "rating3",
        "swing": "swing",
    }
    with_kd: dict[str, dict] = {}
    for key, col in kd_map.items():
        if col in qual.columns and "kd" in qual.columns:
            r, n = _corr_pair(qual, col, "kd")
            with_kd[key] = {"r": r, "players": n}
    return {"month_to_month": month_to_month, "split_half": split_half, "with_kd": with_kd}


def side_residuals(adjusted_rows: pl.DataFrame) -> dict:
    """WAA summed by (map, side) after role baselines and the IGL adjustment, which should be ~0: a large residual
    means the baselines don't absorb a side's systematic credit (credit.conservation's uncredited drift is CT-favoring).
    Per game and side the sum isn't 0 (the side that won more rounds gets more), so only its spread is reported."""
    valid = adjusted_rows.filter(pl.col("role").is_not_null()).with_columns(
        pl.when(pl.col("side") == CT).then(pl.lit("ct")).otherwise(pl.lit("t")).alias("side_name"))
    rw = [f"{v}_rw" for v in VERSIONS]
    by_map = (valid.group_by("map", "side_name")
              .agg(pl.col("rounds").sum().alias("player_rounds"), *(pl.col(c).sum() for c in rw))
              .with_columns(*((100 * pl.col(c) / pl.col("player_rounds")).alias(f"{c}_per100") for c in rw))
              .sort("map", "side_name"))
    games = valid.group_by("key", "side_name").agg(pl.col("rounds").sum().alias("player_rounds"), *(pl.col(c).sum() for c in rw))
    total = {c: float(valid[c].sum()) for c in rw}
    return {
        "by_map_side": by_map.to_dicts(),
        "max_abs_per100": {c: float(by_map[f"{c}_per100"].abs().max()) for c in rw},
        "total": total,
        "per_game_side": {c: {"mean": float(games[c].mean()), "sd": float(games[c].std())} for c in rw},
    }


def report_lines(
    adjusted_rows: pl.DataFrame,
    adj: pl.DataFrame,
    players: pl.DataFrame,
    val: dict,
    r_win: float,
    min_rounds: int,
    replacement_rate: float,
    window_from: str | None,
) -> list[str]:
    valid = adjusted_rows.filter(pl.col("role").is_not_null())
    dates = valid["date"]
    metric = "WAR" if replacement_rate != 0.0 else "WAA"
    qual = players.filter(pl.col("rounds") >= min_rounds).sort("wpa_waa", descending=True)

    lines = [
        f"# Player {metric}",
        "",
        f"Window: {dates.min()} to {dates.max()} ({valid['key'].n_unique():,} maps, {valid['event'].n_unique()} events"
        + (f", filtered `--from {window_from}`" if window_from else "")
        + "). "
        f"{qual.height} players with {min_rounds}+ rounds. "
        f"Empirical conversion: {r_win:.2f} round-wins per map win (analytical MR12 benchmark {analytical_mr12_rounds_per_win():.2f}). "
        f"Replacement rate: {100 * replacement_rate:+.2f} round-wins / 100 rounds.",
        "",
        "## Positional adjustment (`round-wins / 100 rounds`)",
        "",
        "| Side | Group | Fit rounds | WPA | Neutral (man-count) | Neutral (event) |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in adj.sort(["side", "is_igl"], descending=[True, True]).iter_rows(named=True):
        side = "CT" if r["side"] == CT else "T"
        grp = "IGL" if r["is_igl"] else "Non-IGL"
        lines.append(
            f"| {side} | {grp} | {r['fit_rounds']:,} | {100 * r['wpa_igl_adj']:+.2f} | "
            f"{100 * r['nwpa_mancount_igl_adj']:+.2f} | {100 * r['nwpa_event_igl_adj']:+.2f} |"
        )

    igl_mean = 100 * valid.filter(pl.col("is_igl"))["wpa_rw"].sum() / max(valid.filter(pl.col("is_igl"))["rounds"].sum(), 1)
    all_mean = 100 * valid["wpa_rw"].sum() / max(valid["rounds"].sum(), 1)
    lines += [
        "",
        f"Post-adjustment WPA check: IGL mean {igl_mean:+.4f} / 100 rounds, league mean {all_mean:+.4f} / 100 rounds.",
        "",
        "## Stability and K/D independence",
        "",
        "| Metric | M2M r (100+ rds) | M2M r (200+ rds) | M2M r (300+ rds) | Split-half r (SB) | r with K/D |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    labels = [
        ("wpa_waa_r", f"{metric} (WPA)"),
        ("nwpa_mancount_waa_r", f"{metric} (neutral man-count)"),
        ("nwpa_event_waa_r", f"{metric} (neutral event)"),
        ("wpa_raw_r", "Raw WPA / round"),
        ("kills_above_r", "Kills above expected / round"),
        ("rating2_approx", "Rating 2.0 (approx)"),
        ("rating3", "HLTV Rating 3.0"),
        ("swing", "HLTV Swing"),
        ("kd", "K/D"),
    ]
    fmt = lambda v: f"{v:.3f}" if v is not None else "n/a"
    for key, label in labels:
        m100 = val["month_to_month"][100].get(key, {})
        m200 = val["month_to_month"][200].get(key, {})
        m300 = val["month_to_month"][300].get(key, {})
        sh = val["split_half"].get(key, {})
        kd = val["with_kd"].get(key, {})
        sh_txt = f"{sh['r']:.3f} ({sh['spearman_brown']:.3f})" if sh.get("r") is not None and sh.get("spearman_brown") is not None else "n/a"
        kd_txt = "1.000" if key == "kd" else fmt(kd.get("r"))
        lines.append(
            f"| {label} | {fmt(m100.get('r'))} ({m100.get('pairs', 0)}) | "
            f"{fmt(m200.get('r'))} ({m200.get('pairs', 0)}) | "
            f"{fmt(m300.get('r'))} ({m300.get('pairs', 0)}) | {sh_txt} | {kd_txt} |"
        )

    lines += [
        "",
        f"## Top 20 players by {metric} (WPA, {min_rounds}+ rounds)",
        "",
        f"| # | Player | Team | Role | Rounds | {metric} (90% CI) | / 100 rds | Kills +/− | HLTV 3.0 | K/D |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for idx, r in enumerate(qual.head(20).iter_rows(named=True), 1):
        role = ("IGL · " if r["is_igl"] else "") + r["t_role"]
        r3 = f"{r['rating3']:.2f}" if r.get("rating3") is not None else "–"
        kd = f"{r['kd']:.2f}" if r.get("kd") is not None else "–"
        lines.append(
            f"| {idx} | {r['name']} | {r['lp_team'] or '–'} | {role} | {r['rounds']:,} | "
            f"{r['wpa_waa']:+.2f} ({r['wpa_waa_p5']:+.2f}, {r['wpa_waa_p95']:+.2f}) | "
            f"{r['wpa_per100']:+.2f} | {r['kills_above']:+.1f} | {r3} | {kd} |"
        )

    igls_q = qual.filter(pl.col("is_igl"))
    if igls_q.height:
        lines += [
            "",
            f"## Top and bottom IGLs ({igls_q.height} with {min_rounds}+ rounds)",
            "",
            f"| Player | Team | Rounds | {metric} (90% CI) | / 100 rds | K/D |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        shown = pl.concat([igls_q.head(5), igls_q.tail(min(5, max(0, igls_q.height - 5)))]).unique(subset=["steamid"], maintain_order=True)
        for r in shown.iter_rows(named=True):
            kd = f"{r['kd']:.2f}" if r.get("kd") is not None else "–"
            lines.append(
                f"| {r['name']} | {r['lp_team'] or '–'} | {r['rounds']:,} | "
                f"{r['wpa_waa']:+.2f} ({r['wpa_waa_p5']:+.2f}, {r['wpa_waa_p95']:+.2f}) | "
                f"{r['wpa_per100']:+.2f} | {kd} |"
            )
    return lines


def usage_lines(adjusted_rows: pl.DataFrame, players: pl.DataFrame, min_rounds: int, v: str = "wpa_opp") -> list[str]:
    valid = adjusted_rows.filter(pl.col("role").is_not_null())
    covered = valid.filter(pl.col(f"{v}_usage").is_not_null())
    gap = covered.select((pl.col(f"{v}_context") + pl.col(f"{v}_usage") + pl.col(f"{v}_conversion_rw")
                          - pl.col(f"{v}_rw")).abs().max()).item()
    qual = players.filter((pl.col("rounds") >= min_rounds) & pl.col(f"{v}_usage_per100").is_not_null())
    lines = ["", f"## Usage and conversion ({v}, per 100 rounds)", "",
             f"{covered['rounds'].sum():,} of {valid['rounds'].sum():,} player-rounds have a usage split. "
             f"Largest |context + usage + conversion − WAA| per player-map-side: {gap:.2e}. "
             "Conversion carries the IGL adjustment.", "",
             "| # | Player | Team | Rounds | WAA | Context | Usage (90% CI) | Conversion (90% CI) |",
             "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for i, r in enumerate(qual.sort(f"{v}_conversion_per100", descending=True).head(20).iter_rows(named=True), 1):
        lines.append(
            f"| {i} | {r['name']} | {r['lp_team'] or '–'} | {r['rounds']:,} | {r[f'{v}_per100']:+.2f} | "
            f"{r[f'{v}_context_per100']:+.2f} | {r[f'{v}_usage_per100']:+.2f} ({r[f'{v}_usage_per100_p5']:+.2f}, "
            f"{r[f'{v}_usage_per100_p95']:+.2f}) | {r[f'{v}_conversion_per100']:+.2f} "
            f"({r[f'{v}_conversion_per100_p5']:+.2f}, {r[f'{v}_conversion_per100_p95']:+.2f}) |")
    return lines


def _resources(r: dict) -> dict | None:
    if r.get("wpa_usage_per100") is None:
        return None
    num = lambda c, d=3: None if r.get(c) is None else round(float(r[c]), d)
    return {
        "equipShare": {b: num(f"{b}_equip_share") for b in ("eco", "force", "full")},
        "awpRate": num("awp_rate"),
        "dropsReceivedPer100": num("drops_received_per100", 2),
        "dropsGivenPer100": num("drops_given_per100", 2),
        "flashSupportShare": num("flash_support_share"),
        "selfFlashShare": num("self_flash_share"),
        "smokeSupportShare": num("smoke_support_share"),
        "tradedDeathRate": num("traded_death_rate"),
        "flashGift": num("flash_gift", 2),
    }


def export_public(
    players: pl.DataFrame,
    ct_by_map: dict[int, list[dict]],
    adj: pl.DataFrame,
    val: dict,
    adjusted_rows: pl.DataFrame,
    r_win: float,
    min_rounds: int,
    replacement_rate: float,
    model: str | None,
    allow_ungated: bool,
    out_dir: Path = PUBLIC_WAR,
) -> int:
    gate = None
    provisional = True
    if model:
        rpath = MODELS / model / "report.json"
        if not rpath.exists():
            print(f"Model report {rpath} is missing; not publishing.")
            return 1
        gate = json.loads(rpath.read_text()).get("gate", {})
        provisional = not bool(gate.get("passed"))
    if provisional and not allow_ungated:
        print(f"Model {model or '(unspecified)'} hasn't passed the Phase 5 gate; pass --allow-ungated to publish provisional WAA.")
        return 1

    adj_lookup: dict[str, dict[str, float]] = {}
    for v in VERSIONS:
        by_key = {(int(r["side"]), bool(r["is_igl"])): round(100.0 * float(r[f"{v}_igl_adj"]), 3) for r in adj.iter_rows(named=True)}
        adj_lookup[v] = {
            "ct": by_key.get((CT, True), 0.0),
            "t": by_key.get((T, True), 0.0),
            "nonIglCt": by_key.get((CT, False), 0.0),
            "nonIglT": by_key.get((T, False), 0.0),
        }

    qual = players.filter(pl.col("rounds") >= min_rounds).sort("wpa_waa", descending=True)
    records = []
    for r in qual.iter_rows(named=True):
        sid = int(r["steamid"])
        metrics = {
            v: {
                "waa": round(float(r[f"{v}_waa"]), 3),
                "waaP5": round(float(r[f"{v}_waa_p5"]), 3),
                "waaP95": round(float(r[f"{v}_waa_p95"]), 3),
                "per100": round(float(r[f"{v}_per100"]), 3),
                "per100P5": round(float(r[f"{v}_per100_p5"]), 3),
                "per100P95": round(float(r[f"{v}_per100_p95"]), 3),
            }
            for v in VERSIONS
        }
        if r.get("wpa_usage_per100") is not None:
            for v in VERSIONS:
                metrics[v]["context"] = round(float(r[f"{v}_context_per100"]), 3)
                for t in ("usage", "conversion"):
                    metrics[v][t] = {k: round(float(r[f"{v}_{t}_per100{s}"]), 3)
                                     for k, s in (("per100", ""), ("per100P5", "_p5"), ("per100P95", "_p95"))}
        records.append({
            "steamid": str(sid),
            "lpPlayer": r["lp_player"],
            "name": r["name"],
            "lpTeam": r["lp_team"],
            "maps": int(r["maps"]),
            "rounds": int(r["rounds"]),
            "isIgl": bool(r["is_igl"]),
            "iglShare": round(float(r["igl_share"]), 3),
            "tRole": r["t_role"],
            "ctRole": r["ct_role"],
            "awpShare": round(float(r["awp_share"]), 3),
            "entryShare": round(float(r["entry_share"]), 3),
            "ctByMap": ct_by_map.get(sid, [])[:5],
            "duels": int(r["duels"]),
            "killsAbove": round(float(r["kills_above"]), 2),
            "killsAbovePer100": round(float(r["kills_above_per100"]), 3),
            "kd": round(float(r["kd"]), 3) if r.get("kd") is not None else None,
            "adr": round(float(r["adr"]), 1) if r.get("adr") is not None else None,
            "rating2Approx": round(float(r["rating2_approx"]), 3) if r.get("rating2_approx") is not None else None,
            "rating3": round(float(r["rating3"]), 3) if r.get("rating3") is not None else None,
            "swing": round(float(r["swing"]), 3) if r.get("swing") is not None else None,
            "metrics": metrics,
            "resources": _resources(r),
        })

    valid = adjusted_rows.filter(pl.col("role").is_not_null())
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": model,
        "provisional": provisional,
        "gate": gate,
        "metric": "WAR" if replacement_rate != 0.0 else "WAA",
        "replacementRate": replacement_rate,
        "minRounds": min_rounds,
        "roundsPerWin": round(r_win, 3),
        "iglAdjustmentPer100": adj_lookup,
        "window": {
            "from": valid["date"].min(),
            "to": valid["date"].max(),
            "maps": int(valid["key"].n_unique()),
            "events": int(valid["event"].n_unique()),
        },
        "validation": {
            "monthToMonth100": val["month_to_month"][100],
            "monthToMonth200": val["month_to_month"][200],
            "monthToMonth300": val["month_to_month"][300],
            "splitHalf": val["split_half"],
            "withKd": val["with_kd"],
        },
        "source": SOURCE,
        "players": records,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "players.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {len(records)} players to {out_dir / 'players.json'}")
    return 0


def build(
    window_from: str | None = None,
    min_rounds: int = MIN_PLAYER_ROUNDS,
    resamples: int = DEFAULT_RESAMPLES,
    replacement_rate: float = 0.0,
    model: str | None = None,
    publish: bool = False,
    allow_ungated: bool = False,
) -> int:
    rr = pl.read_parquet(ROLE_ROUNDS)
    igls = pl.read_parquet(IGLS) if IGLS.exists() else assign_igls(rr, load_igl_table())
    joined = join_usage(rr.join(igls.select("key", "steamid", "is_igl"), on=["key", "steamid"], how="left").with_columns(
        pl.col("is_igl").fill_null(False)
    ))
    has_usage = "wpa_usage" in joined.columns
    if window_from:
        joined = joined.filter(pl.col("date") >= window_from)
    if joined.is_empty():
        print("No role-round rows in the requested window; run `cs2wp baselines` first.")
        return 1

    refs = [r for r in catalog() if (not window_from or r.date >= window_from)]
    adj = fit_igl_adjustment(joined)
    adjusted = apply_igl_adjustment(joined, adj, replacement_rate)
    r_win = estimate_rounds_per_win(adjusted, map_outcomes(refs))

    duel_sides = pl.read_parquet(DUEL_SIDES)
    t_roles = pl.read_parquet(T_ROLES)
    ct_pos = pl.read_parquet(CT_POSITIONS)
    box_per_map = player_rounds(refs)

    players, ct_by_map = aggregate_players(adjusted, duel_sides, box_per_map, t_roles, ct_pos, r_win)
    columns = {v: f"{v}_rw" for v in VERSIONS}
    usage_rounds = None
    if has_usage:
        players = players.join(usage_players(adjusted, r_win), on="steamid", how="left")
        usage_rounds = pl.read_parquet(USAGE_ROUNDS)
        columns |= {f"{v}_{t}": f"{v}_{t}_r" for v in VERSIONS for t in TERMS}
    round_vals = load_round_values(refs, adjusted, replacement_rate, usage_rounds)
    boot = bootstrap_players(round_vals, players["steamid"].to_list(), r_win, resamples=resamples, columns=columns)
    players = players.join(boot, on="steamid", how="left").sort("wpa_waa", descending=True)

    val = validation_metrics(adjusted, duel_sides, box_per_map, players, min_rounds=min_rounds)

    PLAYER_WAR.parent.mkdir(parents=True, exist_ok=True)
    players.write_parquet(PLAYER_WAR)
    lines = report_lines(adjusted, adj, players, val, r_win, min_rounds, replacement_rate, window_from)
    if has_usage:
        lines += usage_lines(adjusted, players, min_rounds)
    resid = side_residuals(adjusted)
    lines += ["", "## Side residuals (WAA summed by map and side; should be ~0)", "",
              "| Map | Side | Player-rounds | WPA / 100 | Neutral (man-count) / 100 | Neutral (event) / 100 |",
              "| --- | --- | --- | --- | --- | --- |"]
    for r in resid["by_map_side"]:
        lines.append(f"| {r['map']} | {r['side_name'].upper()} | {r['player_rounds']:,} | {r['wpa_rw_per100']:+.3f} | "
                     f"{r['nwpa_mancount_rw_per100']:+.3f} | {r['nwpa_event_rw_per100']:+.3f} |")
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "side-residuals.json").write_text(json.dumps(resid, indent=2, default=float))
    (WAR_REPORTS / "war.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {PLAYER_WAR} ({players.height} players)")

    if publish:
        return export_public(
            players, ct_by_map, adj, val, adjusted, r_win, min_rounds, replacement_rate, model, allow_ungated
        )
    return 0
