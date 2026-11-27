"""Player map tendencies: per-map positional heatmaps, utility lineups and callout summaries."""

import calendar
import gzip
import json
import os
import shutil
import warnings
from concurrent.futures import ProcessPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl
from cs2demos.store import R2
from scipy.sparse import csr_matrix
from scipy.spatial import cKDTree

from .data import MapRef, catalog
from .paths import (HEATMAPS_CALLOUTS, HEATMAPS_LINEUPS, HEATMAPS_RAW, HEATMAPS_ROUNDS, PUBLIC_HEATMAPS, RADAR_META)
from .publish import SOURCE
from .radar import RADAR_SIZE, levels_for, load_radar_meta, map_slug
from .resources import GRENADE_COLUMNS, GRENADE_COUNT, thrower_grenades
from .roles import openings
from .states import CT, SIDE_CODE, TICK_RATE, T

SCHEMA_VERSION = 2
R2_PREFIX = f"heatmaps/v{SCHEMA_VERSION}/"
GRID_SIZE = 64
CELL_PX = RADAR_SIZE // GRID_SIZE
LINEUP_GRID = 32
LINEUP_CELL_PX = RADAR_SIZE // LINEUP_GRID

PHASES = ("setup", "mid", "late", "post")
SETUP_MAX_S = 20.0
MID_MAX_S = 50.0

GRENADE_LABEL = {"smoke": "smoke", "flashbang": "flash", "he": "he", "molotov": "molotov"}
GRENADE_TYPES = tuple(GRENADE_LABEL.values())
EVENT_LAYERS = ("kills", "deaths", "open_kill", "open_death", "plant", *(f"util_land:{t}" for t in GRENADE_TYPES))

MIN_MAPS = 3
LOW_SAMPLE_MAPS = 8
MAX_ZONES = 10
MAX_ORIGINS = 8
MIN_LINEUP_THROWS = 2
MIN_ZONE_RADIUS_PX = 8
LAND_RADIUS_PX = {"smoke": 32.0, "molotov": 36.0, "he": 40.0, "flash": 56.0}
ORIGIN_RADIUS_PX = 24.0
TOP_CALLOUTS = 5
AVG_SCALE = 10_000

MAX_FILE_GZ_BYTES = 30 * 1024
MAX_TOTAL_GZ_BYTES = 15 * 1024 * 1024

SIDE_STR = {T: "t", CT: "ct"}
KILL_SIDE_STR = {"terrorist": "t", "counter-terrorist": "ct"}

TICK_COLS = ["tick", "round_num", "steamid", "side", "x", "y", "z", "health", "last_place_name", *GRENADE_COUNT.values()]
KILL_COLS = [
    "tick", "round_num", "attacker_steamid", "attacker_side", "attacker_x", "attacker_y", "attacker_z",
    "victim_steamid", "victim_side", "victim_x", "victim_y", "victim_z", "victim_traded",
]
BOMB_COLS = ["tick", "round_num", "event", "steamid", "x", "y", "z"]

GRID_SCHEMA = {
    "map_key": pl.String, "date": pl.String, "map": pl.String, "lp_team": pl.String, "steamid": pl.UInt64,
    "side": pl.String, "layer": pl.String, "phase": pl.String, "level": pl.String, "cell": pl.Int32, "value": pl.UInt32,
}
LINEUP_SCHEMA = {
    "map_key": pl.String, "date": pl.String, "map": pl.String, "lp_team": pl.String, "steamid": pl.UInt64,
    "side": pl.String, "type": pl.String, "level": pl.String, "throw_cell": pl.Int32, "land_cell": pl.Int32,
    "throw_px": pl.Float32, "throw_py": pl.Float32, "land_px": pl.Float32, "land_py": pl.Float32, "throw_t": pl.Float32,
}
CALLOUT_SCHEMA = {
    "map_key": pl.String, "date": pl.String, "map": pl.String, "lp_team": pl.String, "steamid": pl.UInt64,
    "side": pl.String, "kind": pl.String, "phase": pl.String, "callout": pl.String, "value": pl.UInt32,
}
ROUND_SCHEMA = {
    "map_key": pl.String, "date": pl.String, "map": pl.String, "lp_team": pl.String, "steamid": pl.UInt64,
    "side": pl.String, "rounds": pl.UInt32, "open_kills": pl.UInt32, "open_deaths": pl.UInt32,
    "deaths": pl.UInt32, "deaths_traded": pl.UInt32,
}


def subtract_months(iso_date: str, months: int) -> str:
    d = date.fromisoformat(iso_date)
    total = d.year * 12 + (d.month - 1) - months
    year, month = divmod(total, 12)
    month += 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day).isoformat()


def assign_phase(dt_seconds: float, has_plant: bool = False, after_plant: bool = False) -> str:
    """Phase label from seconds since freeze end and plant state."""
    if has_plant and after_plant:
        return "post"
    if dt_seconds < SETUP_MAX_S:
        return "setup"
    if dt_seconds < MID_MAX_S:
        return "mid"
    return "late"


def _phase_expr(tick_col: str = "tick") -> pl.Expr:
    dt = (pl.col(tick_col) - pl.col("fe")) / float(TICK_RATE)
    return (
        pl.when(pl.col("plant_tick").is_not_null() & (pl.col(tick_col) >= pl.col("plant_tick")))
        .then(pl.lit("post"))
        .when(dt < SETUP_MAX_S)
        .then(pl.lit("setup"))
        .when(dt < MID_MAX_S)
        .then(pl.lit("mid"))
        .otherwise(pl.lit("late"))
    )


def _coords_exprs(entry: dict, x_col: str, y_col: str, z_col: str, grid: int = GRID_SIZE) -> tuple[pl.Expr, pl.Expr, pl.Expr, pl.Expr]:
    px = (pl.col(x_col).cast(pl.Float64) - entry["pos_x"]) / entry["scale"]
    py = (entry["pos_y"] - pl.col(y_col).cast(pl.Float64)) / entry["scale"]
    cell_px = RADAR_SIZE // grid
    cell = (py.floor().cast(pl.Int32) // cell_px) * grid + (px.floor().cast(pl.Int32) // cell_px)
    if "lower_max" in entry:
        level = (
            pl.when((pl.col(z_col) >= entry["lower_min"]) & (pl.col(z_col) < entry["lower_max"]))
            .then(pl.lit("lower"))
            .otherwise(pl.lit("upper"))
        )
    else:
        level = pl.lit("upper")
    return px, py, cell, level


def _on_radar(px_col: str = "_px", py_col: str = "_py") -> pl.Expr:
    return (
        pl.col(px_col).is_finite()
        & pl.col(py_col).is_finite()
        & (pl.col(px_col) >= 0)
        & (pl.col(px_col) < RADAR_SIZE)
        & (pl.col(py_col) >= 0)
        & (pl.col(py_col) < RADAR_SIZE)
    )


def encode_grid(cells: dict[int, int] | list[tuple[int, int]]) -> dict:
    """Sparse delta-coded grid: {max, n, cells: [dIdx, v, ...]}."""
    items = cells.items() if isinstance(cells, dict) else cells
    nonzero = sorted((int(idx), int(v)) for idx, v in items if int(v) > 0)
    if not nonzero:
        return {"max": 0, "n": 0, "cells": []}
    encoded: list[int] = []
    prev = 0
    max_v = 0
    total = 0
    for idx, v in nonzero:
        encoded.append(idx - prev)
        encoded.append(v)
        prev = idx
        if v > max_v:
            max_v = v
        total += v
    return {"max": max_v, "n": total, "cells": encoded}


def decode_grid(grid: dict, size: int = GRID_SIZE * GRID_SIZE) -> np.ndarray:
    """Decode sparse delta-coded grid back to a dense 1D array of length `size`."""
    arr = np.zeros(size, dtype=np.int64)
    cells = grid.get("cells") or []
    idx = 0
    for i in range(0, len(cells), 2):
        idx += cells[i]
        if 0 <= idx < size:
            arr[idx] = cells[i + 1]
    return arr


def _greedy_clusters(xs: np.ndarray, ys: np.ndarray, radius: float, weights: np.ndarray | None = None) -> list[np.ndarray]:
    m = len(xs)
    if m == 0:
        return []
    w = np.ones(m) if weights is None else np.asarray(weights, dtype=np.float64)
    pairs = cKDTree(np.column_stack([xs, ys])).query_pairs(radius * (1 + 1e-9), output_type="ndarray")
    pairs = pairs[(xs[pairs[:, 0]] - xs[pairs[:, 1]]) ** 2 + (ys[pairs[:, 0]] - ys[pairs[:, 1]]) ** 2 <= radius * radius]
    diag = np.arange(m)
    within = csr_matrix(
        (np.ones(2 * len(pairs) + m), (np.r_[pairs[:, 0], pairs[:, 1], diag], np.r_[pairs[:, 1], pairs[:, 0], diag])),
        shape=(m, m),
    )
    assigned = np.zeros(m, dtype=bool)
    clusters: list[np.ndarray] = []
    while not assigned.all():
        counts = within @ np.where(assigned, 0.0, w)
        counts[assigned] = -1
        seed = int(np.argmax(counts))
        row = np.sort(within.indices[within.indptr[seed]:within.indptr[seed + 1]])
        members = row[~assigned[row]]
        assigned[members] = True
        clusters.append(members)
    return clusters


def group_lineups(df: pl.DataFrame, max_lineups: int = MAX_ZONES, min_throws: int = MIN_LINEUP_THROWS) -> dict[str, list[dict]]:
    """Cluster utility throws into landing zones per (type, level), keeping top `max_lineups` per type."""
    out: dict[str, list[dict]] = {}
    if df.is_empty():
        return out
    totals = dict(df.group_by("type").len().iter_rows())
    for gtype in GRENADE_TYPES:
        type_df = df.filter(pl.col("type") == gtype)
        if type_df.is_empty():
            continue
        denom = max(int(totals.get(gtype, 0)), 1)
        land_radius = LAND_RADIUS_PX[gtype]
        zones: list[dict] = []
        for (level,), lvl_df in sorted(type_df.partition_by("level", as_dict=True).items()):
            lpx = lvl_df["land_px"].to_numpy().astype(np.float64)
            lpy = lvl_df["land_py"].to_numpy().astype(np.float64)
            tpx = lvl_df["throw_px"].to_numpy().astype(np.float64)
            tpy = lvl_df["throw_py"].to_numpy().astype(np.float64)
            throw_t = lvl_df["throw_t"].to_numpy().astype(np.float64)

            for members in _greedy_clusters(lpx, lpy, land_radius):
                n = int(len(members))
                if n < min_throws:
                    continue
                cx = float(lpx[members].mean())
                cy = float(lpy[members].mean())
                dists = np.hypot(lpx[members] - cx, lpy[members] - cy)
                spread = max(MIN_ZONE_RADIUS_PX, round(float(np.percentile(dists, 80))))

                tx = tpx[members]
                ty = tpy[members]
                origins = [
                    [round(float(tx[oc].mean())), round(float(ty[oc].mean())), int(len(oc))]
                    for oc in _greedy_clusters(tx, ty, ORIGIN_RADIUS_PX)
                ]
                origins.sort(key=lambda o: (-o[2], o[0], o[1]))
                origins = origins[:MAX_ORIGINS]

                zones.append({
                    "land": [round(cx), round(cy)],
                    "r": spread,
                    "n": n,
                    "share": round(n / denom, 3),
                    "tMed": round(float(np.median(throw_t[members])), 1),
                    "level": level,
                    "from": origins,
                })

        if not zones:
            continue
        zones.sort(key=lambda z: (-z["n"], z["tMed"]))
        out[gtype] = zones[:max_lineups]
    return out


def resolve_scope(
    player_maps: pl.DataFrame,
    min_maps: int = MIN_MAPS,
) -> pl.DataFrame:
    """Decide per-(steamid, map) whether to use current `lp_team` maps (>= `min_maps`) or fall back to all teams.

    Input columns: `steamid`, `map`, `map_key`, `date`, `lp_team`.
    Returns one row per qualifying `(steamid, map)`: `steamid, map, current_team, scope_type, scope_team, maps`.
    """
    if player_maps.is_empty():
        return pl.DataFrame(schema={
            "steamid": pl.UInt64, "map": pl.String, "current_team": pl.String,
            "scope_type": pl.String, "scope_team": pl.String, "maps": pl.UInt32,
        })
    latest_team = (
        player_maps.filter(pl.col("lp_team").is_not_null() & (pl.col("lp_team") != ""))
        .sort(["date", "map_key"], descending=[True, True])
        .group_by("steamid", maintain_order=True)
        .agg(pl.col("lp_team").first().alias("current_team"))
    )
    pm = player_maps.join(latest_team, on="steamid", how="left")
    counts = (
        pm.group_by("steamid", "map", "current_team")
        .agg(
            pl.col("map_key").n_unique().cast(pl.UInt32).alias("all_maps"),
            pl.col("map_key")
            .filter(pl.col("current_team").is_not_null() & (pl.col("lp_team") == pl.col("current_team")))
            .n_unique()
            .cast(pl.UInt32)
            .alias("team_maps"),
        )
        .filter(pl.col("all_maps") >= min_maps)
    )
    use_team = pl.col("current_team").is_not_null() & (pl.col("team_maps") >= min_maps)
    return counts.select(
        "steamid",
        "map",
        "current_team",
        pl.when(use_team).then(pl.lit("team")).otherwise(pl.lit("all")).alias("scope_type"),
        pl.when(use_team).then(pl.col("current_team")).otherwise(pl.lit(None, pl.String)).alias("scope_team"),
        pl.when(use_team).then(pl.col("team_maps")).otherwise(pl.col("all_maps")).alias("maps"),
    )


def round_nades(ref: MapRef, entry: dict, ticks_raw: pl.DataFrame, rctx: pl.DataFrame,
                attributed_only: bool = True) -> pl.DataFrame | None:
    """Grenades thrown in live play, with radar coordinates; None when the map has no grenades table.

    `ticks_raw` is `TICK_COLS` with `steamid` cast to UInt64; `rctx` has `round_num`, `fe`, `end_tick`. Rows carry
    `round_num`, `steamid`, `side_str`, `gtype`, `throw_t` (seconds from freeze end), world `x, y, z` / `x0, y0, z0`,
    and radar `land_px/py`, `cell`, `level`, `throw_px/py`, `throw_cell`, `land_cell`. With `attributed_only=False`,
    grenades with no inferred thrower stay in with null `steamid` and `side_str`.
    """
    gpath = ref.dir / "grenades.parquet"
    if not gpath.exists():
        return None
    g_raw = pl.read_parquet(gpath, columns=[*GRENADE_COLUMNS, "z"])
    attributed = pl.col("thrower").is_not_null() & pl.col("side").is_in([CT, T])
    nades = (
        thrower_grenades(g_raw, ticks_raw, types=tuple(GRENADE_COUNT), with_origin=True)
        .filter(attributed if attributed_only else attributed | pl.col("thrower").is_null())
        .join(rctx, on="round_num", how="inner")
        .filter((pl.col("t0") >= pl.col("fe")) & (pl.col("end_tick").is_null() | (pl.col("t0") <= pl.col("end_tick"))))
        .with_columns(
            pl.col("thrower").cast(pl.UInt64).alias("steamid"),
            pl.col("side").replace_strict(SIDE_STR).alias("side_str"),
            pl.col("type").replace_strict(GRENADE_LABEL).alias("gtype"),
            ((pl.col("t0") - pl.col("fe")) / float(TICK_RATE)).cast(pl.Float32).alias("throw_t"),
        )
    )
    if nades.is_empty():
        return nades
    lpx, lpy, lcell64, llevel = _coords_exprs(entry, "x", "y", "z", GRID_SIZE)
    tpx, tpy, tcell32, _ = _coords_exprs(entry, "x0", "y0", "z0", LINEUP_GRID)
    _, _, lcell32, _ = _coords_exprs(entry, "x", "y", "z", LINEUP_GRID)
    return nades.with_columns(
        lpx.alias("land_px"), lpy.alias("land_py"), lcell64.alias("cell"), llevel.alias("level"),
        tpx.alias("throw_px"), tpy.alias("throw_py"), tcell32.alias("throw_cell"), lcell32.alias("land_cell"),
    )


def map_layers(
    ref: MapRef,
    radar_meta: dict[str, dict] | None = None,
) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame, pl.DataFrame] | None:
    """Extract (grid_rows, lineup_rows, callout_rows, round_rows) for a single map."""
    warnings.filterwarnings("ignore", message="Sortedness of columns cannot be checked")
    meta = radar_meta if radar_meta is not None else load_radar_meta()
    entry = meta.get(ref.map)
    if entry is None:
        return None

    rounds = (
        ref.table("rounds", ["round_num", "start_tick", "freeze_end_tick", "end_tick"])
        .with_columns(
            pl.col("round_num").cast(pl.Int64),
            pl.col("freeze_end_tick").fill_null(pl.col("start_tick")).cast(pl.Int64).alias("fe"),
            pl.col("end_tick").cast(pl.Int64),
        )
        .select("round_num", "fe", "end_tick")
    )
    bomb = (
        ref.table("bomb", BOMB_COLS)
        .filter(pl.col("event") == "finish_plant")
        .with_columns(pl.col("round_num").cast(pl.Int64), pl.col("tick").cast(pl.Int64))
        .sort("tick")
        .unique("round_num", keep="first")
    )
    rctx = rounds.join(bomb.select("round_num", pl.col("tick").alias("plant_tick")), on="round_num", how="left")
    players = (
        ref.table("players", ["steamid", "lp_team"])
        .filter(pl.col("steamid") > 0)
        .unique("steamid")
        .select(pl.col("steamid").cast(pl.UInt64), "lp_team")
    )

    ticks_raw = (
        ref.table("ticks", TICK_COLS)
        .filter((pl.col("steamid") > 0) & pl.col("side").is_in([CT, T]))
        .with_columns(
            pl.col("round_num").cast(pl.Int64),
            pl.col("tick").cast(pl.Int64),
            pl.col("steamid").cast(pl.UInt64),
            pl.col("side").replace_strict(SIDE_STR).alias("side_str"),
        )
    )

    def add_meta(df: pl.DataFrame, schema: dict) -> pl.DataFrame:
        if df.is_empty():
            return pl.DataFrame(schema=schema)
        return (
            df.join(players, on="steamid", how="left")
            .with_columns(
                pl.lit(ref.key).alias("map_key"),
                pl.lit(ref.date).alias("date"),
                pl.lit(ref.map).alias("map"),
            )
            .select(list(schema))
            .cast(schema)
        )

    # Round participation per (steamid, side)
    round_counts = (
        ticks_raw.group_by("steamid", pl.col("side_str").alias("side"))
        .agg(pl.col("round_num").n_unique().cast(pl.UInt32).alias("rounds"))
    )

    # Alive ticks in live play for presence & callouts
    alive = (
        ticks_raw.filter(pl.col("health") > 0)
        .join(rctx, on="round_num", how="inner")
        .filter((pl.col("tick") >= pl.col("fe")) & (pl.col("end_tick").is_null() | (pl.col("tick") <= pl.col("end_tick"))))
        .with_columns(_phase_expr("tick").alias("phase"))
    )
    px, py, cell, level = _coords_exprs(entry, "x", "y", "z", GRID_SIZE)
    presence_grid = (
        alive.with_columns(px.alias("_px"), py.alias("_py"), cell.alias("cell"), level.alias("level"))
        .filter(_on_radar())
        .group_by("steamid", pl.col("side_str").alias("side"), "phase", "level", "cell")
        .agg(pl.len().cast(pl.UInt32).alias("value"))
        .with_columns(pl.lit("presence").alias("layer"))
    )

    presence_callouts = (
        alive.filter(pl.col("last_place_name").is_not_null() & (pl.col("last_place_name") != ""))
        .group_by("steamid", pl.col("side_str").alias("side"), "phase", pl.col("last_place_name").alias("callout"))
        .agg(pl.len().cast(pl.UInt32).alias("value"))
        .with_columns(pl.lit("presence").alias("kind"))
    )

    # Kills, deaths, opening duels & traded deaths
    kills_raw = ref.table("kills", KILL_COLS).with_columns(
        pl.col("round_num").cast(pl.Int64),
        pl.col("tick").cast(pl.Int64),
        pl.col("attacker_steamid").cast(pl.UInt64),
        pl.col("victim_steamid").cast(pl.UInt64),
    )
    kills = (
        kills_raw.filter(
            pl.col("attacker_steamid").is_not_null()
            & (pl.col("attacker_steamid") > 0)
            & pl.col("victim_steamid").is_not_null()
            & (pl.col("victim_steamid") > 0)
            & pl.col("attacker_side").is_in(list(KILL_SIDE_STR))
            & pl.col("victim_side").is_in(list(KILL_SIDE_STR))
            & (pl.col("attacker_side") != pl.col("victim_side"))
        )
        .join(rctx, on="round_num", how="inner")
        .filter((pl.col("tick") >= pl.col("fe")) & (pl.col("end_tick").is_null() | (pl.col("tick") <= pl.col("end_tick"))))
        .with_columns(
            pl.col("attacker_side").replace_strict(KILL_SIDE_STR).alias("a_side"),
            pl.col("victim_side").replace_strict(KILL_SIDE_STR).alias("v_side"),
        )
    )

    grid_parts: list[pl.DataFrame] = [presence_grid]
    callout_parts: list[pl.DataFrame] = [presence_callouts]

    if not kills.is_empty():
        apx, apy, acell, alevel = _coords_exprs(entry, "attacker_x", "attacker_y", "attacker_z", GRID_SIZE)
        vpx, vpy, vcell, vlevel = _coords_exprs(entry, "victim_x", "victim_y", "victim_z", GRID_SIZE)
        grid_parts.append(
            kills.with_columns(apx.alias("_px"), apy.alias("_py"), acell.alias("cell"), alevel.alias("level"))
            .filter(_on_radar())
            .group_by(pl.col("attacker_steamid").alias("steamid"), pl.col("a_side").alias("side"), "level", "cell")
            .agg(pl.len().cast(pl.UInt32).alias("value"))
            .with_columns(pl.lit("kills").alias("layer"), pl.lit("all").alias("phase"))
        )
        grid_parts.append(
            kills.with_columns(vpx.alias("_px"), vpy.alias("_py"), vcell.alias("cell"), vlevel.alias("level"))
            .filter(_on_radar())
            .group_by(pl.col("victim_steamid").alias("steamid"), pl.col("v_side").alias("side"), "level", "cell")
            .agg(pl.len().cast(pl.UInt32).alias("value"))
            .with_columns(pl.lit("deaths").alias("layer"), pl.lit("all").alias("phase"))
        )

        # Callouts for kills and deaths via backward asof join onto ticks
        place_ticks = (
            ticks_raw.filter(pl.col("last_place_name").is_not_null() & (pl.col("last_place_name") != ""))
            .select("tick", "steamid", pl.col("last_place_name").alias("callout"))
            .sort("tick")
        )
        if not place_ticks.is_empty():
            ks = kills.sort("tick")
            ak = (
                ks.select("tick", pl.col("attacker_steamid").alias("steamid"), pl.col("a_side").alias("side"))
                .join_asof(place_ticks, on="tick", by="steamid", strategy="backward", tolerance=TICK_RATE)
                .filter(pl.col("callout").is_not_null())
                .group_by("steamid", "side", "callout")
                .agg(pl.len().cast(pl.UInt32).alias("value"))
                .with_columns(pl.lit("kills").alias("kind"), pl.lit("all").alias("phase"))
            )
            vk = (
                ks.select("tick", pl.col("victim_steamid").alias("steamid"), pl.col("v_side").alias("side"))
                .join_asof(place_ticks, on="tick", by="steamid", strategy="backward", tolerance=TICK_RATE)
                .filter(pl.col("callout").is_not_null())
                .group_by("steamid", "side", "callout")
                .agg(pl.len().cast(pl.UInt32).alias("value"))
                .with_columns(pl.lit("deaths").alias("kind"), pl.lit("all").alias("phase"))
            )
            callout_parts.extend([ak, vk])

    # Opening duels from roles.openings()
    opens = openings(rounds.rename({"fe": "freeze_end_tick"}).with_columns(pl.col("freeze_end_tick").alias("start_tick")), kills_raw)
    open_kill_counts = pl.DataFrame(schema={"steamid": pl.UInt64, "side": pl.String, "open_kills": pl.UInt32})
    open_death_counts = pl.DataFrame(schema={"steamid": pl.UInt64, "side": pl.String, "open_deaths": pl.UInt32})
    if not opens.is_empty():
        first_kills = (
            kills.sort("tick")
            .group_by("round_num", maintain_order=True)
            .first()
            .join(
                opens.select("round_num", pl.col("attacker").cast(pl.UInt64), pl.col("victim").cast(pl.UInt64)),
                left_on=["round_num", "attacker_steamid", "victim_steamid"],
                right_on=["round_num", "attacker", "victim"],
                how="inner",
            )
        )
        if not first_kills.is_empty():
            apx, apy, acell, alevel = _coords_exprs(entry, "attacker_x", "attacker_y", "attacker_z", GRID_SIZE)
            vpx, vpy, vcell, vlevel = _coords_exprs(entry, "victim_x", "victim_y", "victim_z", GRID_SIZE)
            grid_parts.append(
                first_kills.with_columns(apx.alias("_px"), apy.alias("_py"), acell.alias("cell"), alevel.alias("level"))
                .filter(_on_radar())
                .group_by(pl.col("attacker_steamid").alias("steamid"), pl.col("a_side").alias("side"), "level", "cell")
                .agg(pl.len().cast(pl.UInt32).alias("value"))
                .with_columns(pl.lit("open_kill").alias("layer"), pl.lit("all").alias("phase"))
            )
            grid_parts.append(
                first_kills.with_columns(vpx.alias("_px"), vpy.alias("_py"), vcell.alias("cell"), vlevel.alias("level"))
                .filter(_on_radar())
                .group_by(pl.col("victim_steamid").alias("steamid"), pl.col("v_side").alias("side"), "level", "cell")
                .agg(pl.len().cast(pl.UInt32).alias("value"))
                .with_columns(pl.lit("open_death").alias("layer"), pl.lit("all").alias("phase"))
            )
            open_kill_counts = (
                first_kills.group_by(pl.col("attacker_steamid").alias("steamid"), pl.col("a_side").alias("side"))
                .agg(pl.len().cast(pl.UInt32).alias("open_kills"))
            )
            open_death_counts = (
                first_kills.group_by(pl.col("victim_steamid").alias("steamid"), pl.col("v_side").alias("side"))
                .agg(pl.len().cast(pl.UInt32).alias("open_deaths"))
            )

    # Death & traded-death counts per (steamid, side)
    death_counts = (
        kills.group_by(pl.col("victim_steamid").alias("steamid"), pl.col("v_side").alias("side"))
        .agg(
            pl.len().cast(pl.UInt32).alias("deaths"),
            pl.col("victim_traded").fill_null(False).sum().cast(pl.UInt32).alias("deaths_traded"),
        )
        if not kills.is_empty()
        else pl.DataFrame(schema={"steamid": pl.UInt64, "side": pl.String, "deaths": pl.UInt32, "deaths_traded": pl.UInt32})
    )

    round_summary = (
        round_counts
        .join(open_kill_counts, on=["steamid", "side"], how="left")
        .join(open_death_counts, on=["steamid", "side"], how="left")
        .join(death_counts, on=["steamid", "side"], how="left")
        .with_columns(pl.col("open_kills", "open_deaths", "deaths", "deaths_traded").fill_null(0).cast(pl.UInt32))
    )

    # Plants (T only)
    plants = bomb.filter(pl.col("steamid").is_not_null() & (pl.col("steamid") > 0)).with_columns(pl.col("steamid").cast(pl.UInt64))
    if not plants.is_empty():
        bpx, bpy, bcell, blevel = _coords_exprs(entry, "x", "y", "z", GRID_SIZE)
        grid_parts.append(
            plants.with_columns(bpx.alias("_px"), bpy.alias("_py"), bcell.alias("cell"), blevel.alias("level"))
            .filter(_on_radar())
            .group_by("steamid", "level", "cell")
            .agg(pl.len().cast(pl.UInt32).alias("value"))
            .with_columns(pl.lit("t").alias("side"), pl.lit("plant").alias("layer"), pl.lit("all").alias("phase"))
        )

    # Utility landings and lineups
    lineup_df = pl.DataFrame(schema=LINEUP_SCHEMA)
    nades_c = round_nades(ref, entry, ticks_raw, rctx)
    if nades_c is not None and not nades_c.is_empty():
        land_ok = nades_c.filter(_on_radar("land_px", "land_py"))
        if not land_ok.is_empty():
            grid_parts.append(
                land_ok.group_by("steamid", pl.col("side_str").alias("side"), "gtype", "level", "cell")
                .agg(pl.len().cast(pl.UInt32).alias("value"))
                .with_columns(
                    (pl.lit("util_land:") + pl.col("gtype")).alias("layer"),
                    pl.lit("all").alias("phase"),
                )
                .drop("gtype")
            )
        both_ok = land_ok.filter(_on_radar("throw_px", "throw_py"))
        if not both_ok.is_empty():
            lineup_df = add_meta(
                both_ok.select(
                    "steamid", pl.col("side_str").alias("side"), pl.col("gtype").alias("type"), "level",
                    "throw_cell", "land_cell", pl.col("throw_px").cast(pl.Float32),
                    pl.col("throw_py").cast(pl.Float32), pl.col("land_px").cast(pl.Float32),
                    pl.col("land_py").cast(pl.Float32), "throw_t",
                ),
                LINEUP_SCHEMA,
            )

    grid_cols = ["steamid", "side", "layer", "phase", "level", "cell", "value"]
    grids = pl.concat([p.select(grid_cols) for p in grid_parts if not p.is_empty()], how="vertical") if grid_parts else pl.DataFrame()
    callout_cols = ["steamid", "side", "kind", "phase", "callout", "value"]
    callouts = pl.concat([p.select(callout_cols) for p in callout_parts if not p.is_empty()], how="vertical") if callout_parts else pl.DataFrame()

    return (
        add_meta(grids, GRID_SCHEMA),
        lineup_df,
        add_meta(callouts, CALLOUT_SCHEMA),
        add_meta(round_summary, ROUND_SCHEMA),
    )


_WORKER_META: dict[str, dict] = {}


def _init_worker(meta: dict[str, dict]) -> None:
    global _WORKER_META
    _WORKER_META = meta


def _worker(ref: MapRef) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame, pl.DataFrame] | None:
    return map_layers(ref, _WORKER_META)


def _read_cached(path: Path, schema: dict) -> pl.DataFrame | None:
    if not path.exists():
        return None
    if set(pl.read_parquet_schema(path)) != set(schema):
        return None
    return pl.read_parquet(path)


def build_raw(
    refs: list[MapRef],
    radar_meta: dict[str, dict],
    rebuild: bool = False,
    workers: int | None = None,
) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    """Build or incrementally extend the cached raw heatmap tables for `refs`."""
    paths_schemas = (
        (HEATMAPS_RAW, GRID_SCHEMA),
        (HEATMAPS_LINEUPS, LINEUP_SCHEMA),
        (HEATMAPS_CALLOUTS, CALLOUT_SCHEMA),
        (HEATMAPS_ROUNDS, ROUND_SCHEMA),
    )
    cached = [None if rebuild else _read_cached(p, s) for p, s in paths_schemas]
    all_present = all(c is not None for c in cached)
    have = set(cached[3]["map_key"].unique().to_list()) if all_present else set()

    eligible = [r for r in refs if r.map in radar_meta]
    todo = [r for r in eligible if r.key not in have]

    buckets: list[list[pl.DataFrame]] = [[c] if (all_present and c is not None) else [] for c in cached]
    if todo:
        n = workers or min(os.cpu_count() or 1, 6)
        print(f"heatmaps: {len(todo)} maps to extract ({len(have)} cached), {n} workers", flush=True)
        with ProcessPoolExecutor(max_workers=n, initializer=_init_worker, initargs=(radar_meta,)) as ex:
            for i, res in enumerate(ex.map(_worker, todo, chunksize=4), 1):
                if res is not None:
                    for b, df in zip(buckets, res):
                        if not df.is_empty():
                            b.append(df)
                if i % 200 == 0:
                    print(f"  {i}/{len(todo)}", flush=True)

    out: list[pl.DataFrame] = []
    for (path, schema), parts in zip(paths_schemas, buckets):
        df = pl.concat(parts, how="vertical") if parts else pl.DataFrame(schema=schema)
        if todo or rebuild or not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            df.write_parquet(path)
        out.append(df)
    return out[0], out[1], out[2], out[3]


def _top_callouts(df: pl.DataFrame, limit: int = TOP_CALLOUTS, include_count: bool = False) -> list[dict]:
    if df.is_empty():
        return []
    total = int(df["value"].sum())
    if total <= 0:
        return []
    top = df.group_by("callout").agg(pl.col("value").sum()).sort(["value", "callout"], descending=[True, False]).head(limit)
    rows = []
    for r in top.iter_rows(named=True):
        item: dict = {"callout": r["callout"], "share": round(int(r["value"]) / total, 3)}
        if include_count:
            item["n"] = int(r["value"])
        rows.append(item)
    return rows


def _build_grids_payload(df: pl.DataFrame, levels: list[str]) -> dict:
    """Structure grids as { level: { presence: { phase: grid }, <layer>: grid } }."""
    if df.is_empty():
        return {}
    agg = df.group_by("level", "layer", "phase", "cell").agg(pl.col("value").sum().cast(pl.Int64))
    by_key: dict[tuple[str, str, str], list[tuple[int, int]]] = {}
    for lvl, layer, phase, cell, val in agg.iter_rows():
        by_key.setdefault((lvl, layer, phase), []).append((int(cell), int(val)))

    out: dict[str, dict] = {}
    for lvl in levels:
        lvl_obj: dict = {}
        pres: dict[str, dict] = {}
        for ph in PHASES:
            pts = by_key.get((lvl, "presence", ph))
            if pts:
                pres[ph] = encode_grid(pts)
        if pres:
            lvl_obj["presence"] = pres
        for layer in EVENT_LAYERS:
            pts = by_key.get((lvl, layer, "all"))
            if pts:
                lvl_obj[layer] = encode_grid(pts)
        if lvl_obj:
            out[lvl] = lvl_obj
    return out


def _build_avg_map_payload(
    scoped_grids: pl.DataFrame,
    scoped_rounds: pl.DataFrame,
    map_name: str,
    levels: list[str],
    meta_fields: dict,
) -> dict:
    """Average per-round rates across all qualifying players on `map_name`."""
    # Denominator per (steamid, side): total rounds in that player's scope on this map
    p_rounds = scoped_rounds.group_by("steamid", "side").agg(pl.col("rounds").sum().cast(pl.Float64))
    n_players = int(p_rounds["steamid"].n_unique())
    side_players = dict(p_rounds.filter(pl.col("rounds") > 0).group_by("side").agg(pl.col("steamid").n_unique()).iter_rows())

    rates = (
        scoped_grids.group_by("steamid", "side", "level", "layer", "phase", "cell")
        .agg(pl.col("value").sum().cast(pl.Float64))
        .join(p_rounds.filter(pl.col("rounds") > 0), on=["steamid", "side"], how="inner")
        .with_columns((pl.col("value") / pl.col("rounds")).alias("rate"))
        .group_by("side", "level", "layer", "phase", "cell")
        .agg(pl.col("rate").sum().alias("rate_sum"))
    )

    sides_out: dict[str, dict] = {}
    for side in ("t", "ct"):
        denom_p = int(side_players.get(side, 0))
        if denom_p == 0:
            continue
        sub = rates.filter(pl.col("side") == side)
        by_key: dict[tuple[str, str, str], list[tuple[int, int]]] = {}
        for _, lvl, layer, phase, cell, rate_sum in sub.iter_rows():
            scaled = round((float(rate_sum) / denom_p) * AVG_SCALE)
            if scaled > 0:
                by_key.setdefault((lvl, layer, phase), []).append((int(cell), scaled))
        grids_lvl: dict[str, dict] = {}
        for lvl in levels:
            lvl_obj: dict = {}
            pres: dict[str, dict] = {}
            for ph in PHASES:
                pts = by_key.get((lvl, "presence", ph))
                if pts:
                    pres[ph] = encode_grid(pts)
            if pres:
                lvl_obj["presence"] = pres
            for layer in EVENT_LAYERS:
                pts = by_key.get((lvl, layer, "all"))
                if pts:
                    lvl_obj[layer] = encode_grid(pts)
            if lvl_obj:
                grids_lvl[lvl] = lvl_obj
        sides_out[side] = {"grids": grids_lvl}

    return {
        "version": SCHEMA_VERSION,
        "map": map_slug(map_name),
        "players": n_players,
        "scale": AVG_SCALE,
        "levels": levels,
        "gridSize": GRID_SIZE,
        **meta_fields,
        "sides": sides_out,
    }


def generate_files(
    grids: pl.DataFrame,
    lineups: pl.DataFrame,
    callouts: pl.DataFrame,
    rounds_df: pl.DataFrame,
    radar_meta: dict[str, dict],
    window: dict,
    generated_at: str,
) -> dict[str, bytes]:
    """Aggregate scoped player-map files, player index files and map averages into {rel_key: json_bytes}."""
    meta_fields = {"generatedAt": generated_at, "window": window, "source": SOURCE}
    player_maps = rounds_df.select("steamid", "map", "map_key", "date", "lp_team").unique(["steamid", "map_key"])
    scopes = resolve_scope(player_maps, min_maps=MIN_MAPS)
    if scopes.is_empty():
        return {}

    # Tag every qualifying (steamid, map, map_key)
    selected_keys = (
        player_maps.join(scopes, on=["steamid", "map"], how="inner")
        .filter((pl.col("scope_type") == "all") | (pl.col("lp_team") == pl.col("scope_team")))
        .select("steamid", "map", "map_key")
        .unique()
    )

    s_rounds = rounds_df.join(selected_keys, on=["steamid", "map", "map_key"], how="inner")
    s_grids = grids.join(selected_keys, on=["steamid", "map", "map_key"], how="inner")
    s_lineups = lineups.join(selected_keys, on=["steamid", "map", "map_key"], how="inner")
    s_callouts = callouts.join(selected_keys, on=["steamid", "map", "map_key"], how="inner")

    def dump(obj: dict) -> bytes:
        return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    files: dict[str, bytes] = {}

    # Average baselines per map
    for map_name in sorted(scopes["map"].unique().to_list()):
        slug = map_slug(map_name)
        lvls = levels_for(map_name, radar_meta)
        avg_payload = _build_avg_map_payload(
            s_grids.filter(pl.col("map") == map_name),
            s_rounds.filter(pl.col("map") == map_name),
            map_name,
            lvls,
            meta_fields,
        )
        files[f"v{SCHEMA_VERSION}/_avg/{slug}.json"] = dump(avg_payload)

    # Partition by (steamid, map) for fast per-player emission
    rounds_by_pm = {k: df for k, df in s_rounds.partition_by("steamid", "map", as_dict=True).items()}
    grids_by_pm = {k: df for k, df in s_grids.partition_by("steamid", "map", as_dict=True).items()}
    lineups_by_pm = {k: df for k, df in s_lineups.partition_by("steamid", "map", as_dict=True).items()}
    callouts_by_pm = {k: df for k, df in s_callouts.partition_by("steamid", "map", as_dict=True).items()}

    scopes_sorted = scopes.sort(["steamid", "maps", "map"], descending=[False, True, False])
    for (sid,), p_scopes in scopes_sorted.partition_by("steamid", as_dict=True, maintain_order=True).items():
        sid_str = str(sid)
        index_maps: list[dict] = []
        for row in p_scopes.iter_rows(named=True):
            map_name = row["map"]
            slug = map_slug(map_name)
            n_maps = int(row["maps"])
            low_sample = n_maps < LOW_SAMPLE_MAPS
            scope_obj = {"type": row["scope_type"], "team": row["current_team"]}
            lvls = levels_for(map_name, radar_meta)

            pm_key = (sid, map_name)
            pm_rounds = rounds_by_pm.get(pm_key, pl.DataFrame(schema=ROUND_SCHEMA))
            pm_grids = grids_by_pm.get(pm_key, pl.DataFrame(schema=GRID_SCHEMA))
            pm_lineups = lineups_by_pm.get(pm_key, pl.DataFrame(schema=LINEUP_SCHEMA))
            pm_callouts = callouts_by_pm.get(pm_key, pl.DataFrame(schema=CALLOUT_SCHEMA))

            side_totals = {
                r["side"]: r
                for r in pm_rounds.group_by("side").agg(
                    pl.col("rounds").sum(),
                    pl.col("open_kills").sum(),
                    pl.col("open_deaths").sum(),
                    pl.col("deaths").sum(),
                    pl.col("deaths_traded").sum(),
                ).iter_rows(named=True)
            }
            rounds_obj = {s: int(side_totals[s]["rounds"]) if s in side_totals else 0 for s in ("t", "ct")}

            index_sides: dict[str, dict] = {}
            map_sides: dict[str, dict] = {}
            for side in ("t", "ct"):
                st = side_totals.get(side)
                deaths_n = int(st["deaths"]) if st else 0
                traded_n = int(st["deaths_traded"]) if st else 0
                sc = pm_callouts.filter(pl.col("side") == side)
                pres_callouts = {
                    ph: _top_callouts(sc.filter((pl.col("kind") == "presence") & (pl.col("phase") == ph)))
                    for ph in PHASES
                }
                index_sides[side] = {
                    "presence": {ph: rows for ph, rows in pres_callouts.items() if rows},
                    "kills": _top_callouts(sc.filter(pl.col("kind") == "kills"), include_count=True),
                    "deaths": _top_callouts(sc.filter(pl.col("kind") == "deaths"), include_count=True),
                    "openings": {
                        "wins": int(st["open_kills"]) if st else 0,
                        "losses": int(st["open_deaths"]) if st else 0,
                    },
                    "tradedDeathShare": round(traded_n / deaths_n, 3) if deaths_n > 0 else None,
                }
                map_sides[side] = {
                    "grids": _build_grids_payload(pm_grids.filter(pl.col("side") == side), lvls),
                    "lineups": group_lineups(pm_lineups.filter(pl.col("side") == side)),
                }

            index_maps.append({
                "map": slug,
                "maps": n_maps,
                "rounds": rounds_obj,
                "scope": scope_obj,
                "lowSample": low_sample,
                "levels": lvls,
                "sides": index_sides,
            })

            files[f"v{SCHEMA_VERSION}/{sid_str}/{slug}.json"] = dump({
                "version": SCHEMA_VERSION,
                "steamid": sid_str,
                "map": slug,
                "maps": n_maps,
                "rounds": rounds_obj,
                "scope": scope_obj,
                "lowSample": low_sample,
                "levels": lvls,
                "gridSize": GRID_SIZE,
                **meta_fields,
                "sides": map_sides,
            })

        files[f"v{SCHEMA_VERSION}/{sid_str}/index.json"] = dump({
            "version": SCHEMA_VERSION,
            "steamid": sid_str,
            **meta_fields,
            "maps": index_maps,
        })

    return files


def check_budget(files: dict[str, bytes]) -> tuple[dict, list[str]]:
    """Measure raw and gzipped sizes across all emitted files and verify budget constraints."""
    total_raw = 0
    total_gz = 0
    sizes: list[tuple[str, int, int]] = []
    violations: list[str] = []
    for key, raw in files.items():
        gz_len = len(gzip.compress(raw, compresslevel=6, mtime=0))
        total_raw += len(raw)
        total_gz += gz_len
        sizes.append((key, len(raw), gz_len))
        is_player_map = not key.endswith("/index.json") and "/_avg/" not in key
        if is_player_map and gz_len > MAX_FILE_GZ_BYTES:
            violations.append(f"{key}: {gz_len / 1024:.1f} KB gzipped > {MAX_FILE_GZ_BYTES // 1024} KB limit")
    if total_gz > MAX_TOTAL_GZ_BYTES:
        violations.append(f"total: {total_gz / (1024 * 1024):.2f} MB gzipped > {MAX_TOTAL_GZ_BYTES // (1024 * 1024)} MB limit")
    sizes.sort(key=lambda x: -x[2])
    return {"files": len(files), "total_raw": total_raw, "total_gz": total_gz, "largest": sizes[:10]}, violations


def build(
    months: int = 6,
    window_from: str | None = None,
    rebuild: bool = False,
    publish: bool = False,
    upload: bool = False,
    out_dir: Path = PUBLIC_HEATMAPS,
) -> int:
    radar_meta = load_radar_meta(RADAR_META)
    refs = catalog()
    if not refs:
        print("no mirrored maps found in catalog")
        return 1
    window_to = max(r.date for r in refs)
    start_date = window_from or subtract_months(window_to, months)
    in_window = [r for r in refs if r.date >= start_date]
    window = {"from": start_date, "to": window_to, "months": None if window_from else months}

    grids, lineups, callouts, rounds_df = build_raw(in_window, radar_meta, rebuild=rebuild)
    w_keys = [r.key for r in in_window if r.map in radar_meta]
    grids_w = grids.filter(pl.col("map_key").is_in(w_keys))
    lineups_w = lineups.filter(pl.col("map_key").is_in(w_keys))
    callouts_w = callouts.filter(pl.col("map_key").is_in(w_keys))
    rounds_w = rounds_df.filter(pl.col("map_key").is_in(w_keys))

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    files = generate_files(grids_w, lineups_w, callouts_w, rounds_w, radar_meta, window, generated_at)
    report, violations = check_budget(files)

    n_players = sum(1 for k in files if k.endswith("/index.json"))
    n_maps = sum(1 for k in files if not k.endswith("/index.json") and "/_avg/" not in k)
    print(
        f"heatmaps ({start_date} → {window_to}): {len(w_keys)} maps, {n_players} players, "
        f"{n_maps} player-maps, {report['files']} files"
    )
    print(
        f"size: {report['total_raw'] / (1024 * 1024):.2f} MB raw, "
        f"{report['total_gz'] / (1024 * 1024):.2f} MB gzipped"
    )
    print("largest files (gzipped):")
    for key, raw_sz, gz_sz in report["largest"]:
        print(f"  {gz_sz / 1024:6.1f} KB gz ({raw_sz / 1024:6.1f} KB raw)  {key}")

    if violations:
        for v in violations:
            print(f"BUDGET EXCEEDED: {v}")
        return 1

    if publish:
        version_dir = out_dir / f"v{SCHEMA_VERSION}"
        if version_dir.exists():
            shutil.rmtree(version_dir)
        for rel_key, body in files.items():
            dest = out_dir / rel_key
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
        print(f"wrote {len(files)} files to {out_dir}")

    if upload:
        r2 = R2.public()
        r2_files = {f"heatmaps/{rel_key}": body for rel_key, body in files.items()}
        stats = r2.sync_json_gz(R2_PREFIX, r2_files)
        print(
            f"uploaded to R2 ({r2.bucket}): {stats['uploaded']} uploaded, "
            f"{stats['skipped']} unchanged, {stats['deleted']} deleted"
        )

    return 0
