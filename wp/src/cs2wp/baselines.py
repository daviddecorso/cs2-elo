"""Role baselines: average credit per round for each map, side and role, partially pooled (Phase 6, item 4)."""

import datetime as dt
import math

import numpy as np
import polars as pl

from .data import MapRef, catalog
from .paths import (
    CREDITS,
    CT_POSITIONS,
    ROLE_BASELINES,
    ROLE_BASELINES_BLEND,
    ROLE_BASELINES_SUB,
    ROLE_ROUNDS,
    ROLE_ROUNDS_BLEND,
    ROLE_ROUNDS_SUB,
    STATES,
    T_ROLES,
    WAR_REPORTS,
)
from .states import CT, T

VERSIONS = ("wpa", "nwpa_event", "nwpa_mancount", "wpa_opp")
# Below this many other maps, a player's pooled entry share is too noisy and that map's own share is used.
MIN_OTHER_MAPS = 5
# Keeps k finite when the observed spread between cells is all sampling noise (full pooling).
TAU2_FLOOR = 1e-8
CELL = ["map", "side", "role"]
# Experimental credit valued at w · wpa_opp + (1 − w) · nwpa_event. Every version shares the same split weights, so
# blending credit rows equals blending event values. Only `cs2wp baselines --blend` fits these.
BLENDS = {"blend_25": 0.25, "blend_50": 0.5, "blend_62": 0.625, "blend_75": 0.75, "blend_88": 0.875}


def versions_in(columns) -> tuple[str, ...]:
    """`VERSIONS` plus each blend whose credit, baseline or above-baseline column is present."""
    cols = set(columns)
    return VERSIONS + tuple(b for b in BLENDS if cols & {b, f"{b}_baseline", f"{b}_above"})


def with_blends(credits: pl.DataFrame) -> pl.DataFrame:
    """Null where `wpa_opp` is null (no team Elo), as at the w = 1 endpoint."""
    return credits.with_columns(
        (w * pl.col("wpa_opp") + (1 - w) * pl.col("nwpa_event")).alias(b) for b, w in BLENDS.items())


def side_rows(roster: pl.DataFrame, credits: pl.DataFrame) -> pl.DataFrame:
    """Per (key, steamid, side): rounds played and summed credit. Rounds without any credit count as zero.

    `team` is the player's side in their first round, which identifies their team for the whole map.
    """
    versions = list(versions_in(credits.columns))
    per_round = (credits.group_by("key", "round_num", "steamid").agg(pl.col(versions).sum())
                 .with_columns(pl.col("round_num").cast(roster.schema["round_num"])))
    team = roster.sort("round_num").group_by("steamid").agg(pl.col("side").first().alias("team"))
    return (roster.join(per_round, on=["key", "round_num", "steamid"], how="left")
            .with_columns(pl.col(versions).fill_null(0.0))
            .group_by("key", "steamid", "side").agg(pl.len().alias("rounds"), pl.col(versions).sum())
            .join(team, on="steamid"))


def load_sides(refs: list[MapRef], blend: bool = False) -> pl.DataFrame:
    rows = []
    for ref in refs:
        cpath, rpath = CREDITS / f"{ref.slug}.parquet", STATES / ref.slug / "roster.parquet"
        if not cpath.exists() or not rpath.exists():
            continue
        credits = pl.read_parquet(cpath)
        rows.append(side_rows(pl.read_parquet(rpath), with_blends(credits) if blend else credits).with_columns(
            pl.lit(ref.date).alias("date"), pl.lit(ref.map).alias("map"), pl.lit(ref.lp_pagename).alias("event")))
    if not rows:
        raise FileNotFoundError(
            f"no maps with both {CREDITS}/*.parquet and {STATES}/*/roster.parquet; "
            "run `cs2wp states` and `cs2wp credit` first"
        )
    return pl.concat(rows, how="vertical_relaxed")


def assign_roles(
    sides: pl.DataFrame, t_roles: pl.DataFrame, positions: pl.DataFrame, use_subpositions: bool = True,
) -> pl.DataFrame:
    """Adds `role`: T AWPer / Entry / Rifler, CT AWPer or the CT position (sub-position when enabled).

    The Entry is the team's non-AWPer with the top entry share over their *other* maps, because a map's own entry
    share counts opening deaths and so leaks that map's outcome into the label.
    """
    opening = pl.col("opening_kills") + pl.col("opening_deaths")
    t = (t_roles.select("key", "steamid", "lp_team", "lp_player", "t_role", "entry_share", "t_rounds",
                        opening.alias("_opening"))
         .with_columns((pl.len().over("steamid") - 1).alias("_other_maps"),
                       ((pl.col("_opening").sum().over("steamid") - pl.col("_opening"))
                        / (pl.col("t_rounds").sum().over("steamid") - pl.col("t_rounds"))).alias("_loo")))
    pooled = pl.col("_other_maps") >= MIN_OTHER_MAPS
    t = t.with_columns(pl.when(pooled).then("_loo").otherwise("entry_share").alias("_share"),
                       pl.when(pooled).then(pl.lit("pooled")).otherwise(pl.lit("map")).alias("_source"))

    has_sub = use_subpositions and "subposition" in positions.columns
    pos_cols = ["key", "steamid", "position", "subposition"] if has_sub else ["key", "steamid", "position"]
    df = (sides.join(t, on=["key", "steamid"], how="left")
          .join(positions.select(pos_cols), on=["key", "steamid"], how="left")
          .sort("key", "steamid", "side"))
    awper = pl.col("t_role") == "AWPer"
    t_rifle = (pl.col("side") == T) & ~awper
    candidate = pl.when(t_rifle).then(pl.col("_share"))
    entry = candidate.rank("ordinal", descending=True).over("key", "team", "side") == 1
    ct_pos = pl.coalesce("subposition", "position") if has_sub else pl.col("position")
    role = (pl.when(pl.col("t_role").is_null()).then(None)
            .when(awper).then(pl.lit("AWPer"))
            .when(pl.col("side") == CT).then(ct_pos)
            .when(entry).then(pl.lit("Entry"))
            .otherwise(pl.lit("Rifler")))
    parent_col = [pl.when((pl.col("side") == CT) & ~awper & pl.col("t_role").is_not_null())
                  .then(pl.col("position")).alias("position")] if use_subpositions else []
    out = df.with_columns(
        role.alias("role"),
        pl.when(t_rifle).then(pl.col("_source")).alias("role_source"),
        *parent_col,
    )
    drops = ["_opening", "_other_maps", "_loo", "_share", "_source", "entry_share", "t_rounds"]
    if has_sub:
        drops.append("subposition")
    if not use_subpositions:
        drops.append("position")
    return out.drop(drops)


def sigma2(rows: pl.DataFrame, version: str) -> float:
    """Per-round variance of credit around its cell mean, measured on player-map-sides so it absorbs any
    correlation between rounds of the same map."""
    rate = pl.col(version) / pl.col("rounds")
    mean = pl.col(version).sum().over(CELL) / pl.col("rounds").sum().over(CELL)
    return rows.select((pl.col("rounds") * (rate - mean) ** 2).sum() / pl.len()).item()


def shrink_weights(raw: np.ndarray, n: np.ndarray, parent: np.ndarray, s2: float) -> tuple[np.ndarray, float]:
    """Empirical-Bayes weight on each cell's raw rate, n / (n + k), and k = σ² / τ² in rounds.

    τ² is by method of moments: the rounds-weighted spread of raw around parent, minus the sampling noise.
    """
    tau2 = max(TAU2_FLOOR, (np.sum(n * (raw - parent) ** 2) - len(n) * s2) / np.sum(n))
    k = s2 / tau2
    return n / (n + k), k


def _pool(cells: pl.DataFrame, parent: pl.Expr, version: str, s2: float) -> tuple[pl.DataFrame, float]:
    cells = cells.with_columns(parent.alias(f"{version}_parent"))
    w, k = shrink_weights(cells[f"{version}_raw"].to_numpy(), cells["rounds"].to_numpy().astype(float),
                          cells[f"{version}_parent"].to_numpy(), s2)
    raw, par = pl.col(f"{version}_raw"), pl.col(f"{version}_parent")
    return (cells.with_columns(pl.Series(f"{version}_weight", w))
            .with_columns((pl.col(f"{version}_weight") * raw + (1 - pl.col(f"{version}_weight")) * par)
                          .alias(f"{version}_baseline"))), k


def fit(rows: pl.DataFrame) -> tuple[pl.DataFrame, dict[str, dict[str, float]]]:
    """One row per (map, side, role) with raw, parent, weight and baseline per version, and k per level.

    T roles and the CT AWPer shrink toward the same role's mean across maps. CT positions shrink toward the map's
    CT non-AWPer mean, and sub-positions shrink toward their parent position's baseline.
    """
    rows = rows.filter(pl.col("role").is_not_null())
    versions = list(versions_in(rows.columns))
    parent_pos = pl.coalesce("position", "role") if "position" in rows.columns else pl.col("role")
    ct_rifle = rows.filter((pl.col("side") == CT) & (pl.col("role") != "AWPer")).with_columns(parent_pos.alias("_parent_pos"))

    cells = rows.group_by(CELL).agg(pl.col("rounds").sum(), pl.len().alias("player_maps"),
                                    pl.col("event").n_unique().alias("events"), pl.col(versions).sum())
    cells = cells.with_columns(*(
        (pl.col(v) / pl.col("rounds")).alias(f"{v}_raw") for v in versions)).drop(versions)
    cross_map = (pl.col("side") == T) | (pl.col("role") == "AWPer")
    ks: dict[str, dict[str, float]] = {}
    roles, positions = cells.filter(cross_map), cells.filter(~cross_map)

    role_to_pos = ct_rifle.select("map", "role", pl.col("_parent_pos").alias("position")).unique()
    positions = positions.join(role_to_pos, on=["map", "role"], how="left")
    parent_cells = (
        ct_rifle.group_by("map", pl.col("_parent_pos").alias("position"))
        .agg(pl.col("rounds").sum(), pl.len().alias("player_maps"),
             pl.col("event").n_unique().alias("events"), pl.col(versions).sum())
        .with_columns(pl.lit(CT, dtype=rows.schema["side"]).alias("side"))
        .with_columns(*((pl.col(v) / pl.col("rounds")).alias(f"{v}_raw") for v in versions))
        .drop(versions)
    )

    maps = ct_rifle.group_by("map").agg(pl.col("rounds").sum(), pl.col(versions).sum())
    maps = maps.with_columns(*((pl.col(v) / pl.col("rounds")).alias(f"{v}_raw") for v in versions))

    for v in versions:
        s2 = sigma2(rows, v)
        role_mean = (pl.col(v + "_raw") * pl.col("rounds")).sum().over("side", "role") / pl.col("rounds").sum().over(
            "side", "role")
        t_part, ks.setdefault("T role", {})[v] = _pool(roles.filter(pl.col("side") == T), role_mean, v, s2)
        a_part, ks.setdefault("CT AWPer", {})[v] = _pool(roles.filter(pl.col("side") == CT), role_mean, v, s2)
        roles = pl.concat([t_part, a_part], how="diagonal_relaxed")

        all_maps = ct_rifle[v].sum() / ct_rifle["rounds"].sum()
        m, ks.setdefault("CT map", {})[v] = _pool(maps, pl.lit(all_maps), v, s2)
        maps = maps.with_columns(m[f"{v}_baseline"].alias(f"{v}_map"))
        parent_cells = parent_cells.drop(f"{v}_map", strict=False).join(maps.select("map", f"{v}_map"), on="map")
        parent_cells, ks.setdefault("CT position", {})[v] = _pool(parent_cells, pl.col(f"{v}_map"), v, s2)
        parent_cells = parent_cells.drop(f"{v}_map")

    parent_cols = parent_cells.select(
        "map", "position", *(c for v in versions for c in (f"{v}_parent", f"{v}_weight", f"{v}_baseline")),
    )
    is_sub = pl.col("role") != pl.col("position")
    unsplit = positions.filter(~is_sub).join(parent_cols, on=["map", "position"], how="left")
    sub_cells = positions.filter(is_sub).join(
        parent_cells.select("map", "position", *(pl.col(f"{v}_baseline").alias(f"{v}_pos") for v in versions)),
        on=["map", "position"], how="left",
    )
    if not sub_cells.is_empty():
        for v in versions:
            sub_cells, ks.setdefault("CT sub-position", {})[v] = _pool(
                sub_cells, pl.col(f"{v}_pos"), v, sigma2(rows, v))
            sub_cells = sub_cells.drop(f"{v}_pos")
    positions = pl.concat([unsplit, sub_cells], how="diagonal_relaxed") if not sub_cells.is_empty() else unsplit

    return pl.concat([roles, positions], how="diagonal_relaxed").sort("map", "side", "role"), ks


def with_baselines(rows: pl.DataFrame, cells: pl.DataFrame) -> pl.DataFrame:
    """`<version>_above` = credit − baseline · rounds, per player-map-side."""
    versions = versions_in(cells.columns)
    base = cells.select(*CELL, *(pl.col(f"{v}_baseline") for v in versions))
    return (rows.join(base, on=CELL, how="left")
            .with_columns(*((pl.col(v) - pl.col(f"{v}_baseline") * pl.col("rounds")).alias(f"{v}_above")
                            for v in versions)))


def event_moves(rows: pl.DataFrame, cells: pl.DataFrame, s2: float) -> dict:
    """Refits without each event in turn (roles held fixed) and measures how far wpa cells move."""
    full = cells.select(*CELL, "rounds", "wpa_raw", "wpa_baseline")
    raw_max = shrunk_max = 0.0
    over_se, total = 0, 0
    for event in rows["event"].unique().to_list():
        refit, _ = fit(rows.filter(pl.col("event") != event))
        d = full.join(refit.select(*CELL, pl.col("wpa_raw").alias("r"), pl.col("wpa_baseline").alias("b")), on=CELL)
        se = np.sqrt(s2 / d["rounds"].to_numpy())
        raw_move = np.abs(d["r"].to_numpy() - d["wpa_raw"].to_numpy())
        shrunk_move = np.abs(d["b"].to_numpy() - d["wpa_baseline"].to_numpy())
        raw_max, shrunk_max = max(raw_max, raw_move.max()), max(shrunk_max, shrunk_move.max())
        over_se += int(np.sum(shrunk_move > se))
        total += len(se)
    return {"events": rows["event"].n_unique(), "raw_max": raw_max, "shrunk_max": shrunk_max,
            "over_se": over_se / total}


def split_half(rows: pl.DataFrame) -> tuple[float, float]:
    """Correlation across cells of wpa fit before vs after the median date: raw, then shrunk."""
    median = rows["date"].sort()[rows.height // 2]
    a, _ = fit(rows.filter(pl.col("date") < median))
    b, _ = fit(rows.filter(pl.col("date") >= median))
    d = a.join(b, on=CELL, suffix="_b")
    return (d.select(pl.corr("wpa_raw", "wpa_raw_b")).item(), d.select(pl.corr("wpa_baseline", "wpa_baseline_b")).item())


def _rifler_minus_entry(rows: pl.DataFrame, role: str) -> float:
    rate = {r: rows.filter(pl.col(role) == r) for r in ("Rifler", "Entry")}
    rate = {r: d["wpa"].sum() / d["rounds"].sum() for r, d in rate.items()}
    return rate["Rifler"] - rate["Entry"]


def _subposition_checks(rows: pl.DataFrame, cells: pl.DataFrame, shrunk_r: float) -> list[str]:
    valid = rows.filter(pl.col("role").is_not_null())
    s2_wpa = sigma2(valid, "wpa")
    s2_opp = sigma2(valid, "wpa_opp")
    sub = cells.filter((pl.col("side") == CT) & (pl.col("role") != "AWPer") & (pl.col("role") != pl.col("position")))
    if sub.is_empty():
        return []
    lines = ["", "## Sub-position Gate 2", "",
             "| Map | Position | Sub-positions | Max |Δ| / SE (wpa) | Max |Δ| / SE (wpa_opp, informational) | > 2 SE (wpa) |",
             "| --- | --- | --- | --- | --- | --- |"]
    n_split = 0
    n_sig = 0
    for (m, pos) in sorted(sub.select("map", "position").unique().iter_rows()):
        grp = sub.filter((pl.col("map") == m) & (pl.col("position") == pos)).sort("role").iter_rows(named=True)
        grp = list(grp)
        if len(grp) < 2:
            continue
        n_split += 1
        max_z_wpa = max_z_opp = 0.0
        for i in range(len(grp)):
            for j in range(i + 1, len(grp)):
                se_factor = math.sqrt(1.0 / grp[i]["rounds"] + 1.0 / grp[j]["rounds"])
                max_z_wpa = max(max_z_wpa, abs(grp[i]["wpa_raw"] - grp[j]["wpa_raw"]) / (math.sqrt(s2_wpa) * se_factor))
                max_z_opp = max(max_z_opp, abs(grp[i]["wpa_opp_raw"] - grp[j]["wpa_opp_raw"]) / (math.sqrt(s2_opp) * se_factor))
        sig = max_z_wpa > 2.0
        n_sig += int(sig)
        desc = ", ".join(f"{r['role']} ({r['rounds']:,} rds, wpa {r['wpa_raw']:+.4f} -> {r['wpa_baseline']:+.4f})" for r in grp)
        lines.append(f"| {m} | {pos} | {desc} | {max_z_wpa:.2f} | {max_z_opp:.2f} | {'YES' if sig else 'NO'} |")
    half_pass = n_split > 0 and 2 * n_sig >= n_split
    corr_pass = shrunk_r >= 0.96
    lines += [
        "",
        f"Significant positions (> 2 SE on wpa): {n_sig} of {n_split} ({'PASS' if half_pass else 'FAIL'}; need >= half). "
        f"Split-half shrunk r: {shrunk_r:.3f} ({'PASS' if corr_pass else 'FAIL'}; need >= 0.96). "
        f"Gate 2: {'PASS' if (half_pass and corr_pass) else 'FAIL'}.",
    ]
    return lines


def report(rows: pl.DataFrame, cells: pl.DataFrame, ks: dict, credits_date: str) -> list[str]:
    s2 = sigma2(rows.filter(pl.col("role").is_not_null()), "wpa")
    moves = event_moves(rows.filter(pl.col("role").is_not_null()), cells, s2)
    raw_r, shrunk_r = split_half(rows.filter(pl.col("role").is_not_null()))
    t_rows = rows.filter(pl.col("side") == T)
    unassigned = rows.filter(pl.col("role").is_null()).height
    versions = versions_in(rows.columns)

    lines = ["# Role baselines", "",
             f"Credit files written {credits_date}. WPA per round; the other versions are in the parquet.", "",
             "| Level | " + " | ".join(f"k ({v})" for v in versions) + " |", "|" + " --- |" * (1 + len(versions))]
    for level, by_v in ks.items():
        lines.append(f"| {level} | " + " | ".join(f"{by_v[v]:,.0f}" for v in versions) + " |")
    lines += ["", "k is in rounds: a cell with k rounds gets half its weight from its own data.", "",
              f"- Per-round SD (player-map level): {np.sqrt(s2):.3f}.",
              f"- Leave one event out ({moves['events']} events): largest cell move {moves['raw_max']:.4f} raw, "
              f"{moves['shrunk_max']:.4f} shrunk; {moves['over_se']:.1%} of shrunk moves exceed one SE.",
              f"- Split-half (before/after the median date) correlation across cells: raw {raw_r:.2f}, "
              f"shrunk {shrunk_r:.2f}.",
              f"- T Rifler − Entry, WPA per round: per-map labels {_rifler_minus_entry(t_rows, 't_role'):.4f}, "
              f"leave-one-out labels {_rifler_minus_entry(t_rows, 'role'):.4f}.",
              f"- Player-map-sides without a role: {unassigned} of {rows.height}."]
    if "CT sub-position" in ks and "position" in cells.columns:
        lines += _subposition_checks(rows, cells, shrunk_r)
    lines += ["", "| Map | Side | Role | Rounds | Events | Raw | Weight | Baseline |", "|" + " --- |" * 8]
    for c in cells.iter_rows(named=True):
        side = "CT" if c["side"] == CT else "T"
        lines.append(f"| {c['map'].removeprefix('de_')} | {side} | {c['role']} | {c['rounds']:,} | {c['events']} | "
                     f"{c['wpa_raw']:+.4f} | {c['wpa_weight']:.2f} | {c['wpa_baseline']:+.4f} |")
    return lines


def build(use_subpositions: bool = True, write_sub_copy: bool = False, blend: bool = False) -> int:
    rows = assign_roles(
        load_sides(catalog(), blend=blend), pl.read_parquet(T_ROLES), pl.read_parquet(CT_POSITIONS),
        use_subpositions=use_subpositions,
    )
    cells, ks = fit(rows)
    if blend:
        out_baselines, out_rounds, suffix = ROLE_BASELINES_BLEND, ROLE_ROUNDS_BLEND, ".blend"
    elif write_sub_copy:
        out_baselines, out_rounds, suffix = ROLE_BASELINES_SUB, ROLE_ROUNDS_SUB, ".sub"
    else:
        out_baselines, out_rounds, suffix = ROLE_BASELINES, ROLE_ROUNDS, ""
    out_report = WAR_REPORTS / f"role-baselines{suffix}.md"
    out_baselines.parent.mkdir(parents=True, exist_ok=True)
    cells.write_parquet(out_baselines)
    with_baselines(rows, cells).drop("team").write_parquet(out_rounds)
    stamp = dt.date.fromtimestamp((CREDITS / "neutral-base.parquet").stat().st_mtime).isoformat()
    lines = report(rows, cells, ks, stamp)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    out_report.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {out_baselines} ({cells.height} cells) and {out_rounds} ({rows.height} player-map-sides)")
    return 0
