"""Team utility protocols: how often each team lands utility in each league-wide landing zone, how early, and who
throws it, against the league on the same map, side and round class."""

import json
import math
import os
import re
import shutil
import warnings
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl
from cs2demos.store import R2
from scipy.spatial import cKDTree

from . import duelstats as ds
from .data import MapRef, catalog
from .heatmaps import (LAND_RADIUS_PX, MIN_ZONE_RADIUS_PX, ORIGIN_RADIUS_PX, TICK_COLS,
                       _greedy_clusters, _on_radar, check_budget, round_nades, subtract_months)
from .paths import (PROTOCOL_ZONES, PROTOCOLS_ATTRIBUTION, PROTOCOLS_RAW, PROTOCOLS_ROUNDS, PUBLIC_PROTOCOLS,
                    RADAR_META, RESOURCE_ROUNDS, TACTICS_RAW, TEAM_MAP_RESIDUALS, WAR_REPORTS)
from .publish import SOURCE
from .radar import levels_for, load_radar_meta, map_slug
from .states import CT, TICK_RATE, T
from .warcheck import _alternating

SCHEMA_VERSION = 1
R2_PREFIX = f"protocols/v{SCHEMA_VERSION}/"
SIDE_STR = {T: "t", CT: "ct"}
SIDES = ("t", "ct")
CLASSES = ("gun", "pistol", "light")
# A T round is a fast hit when 3+ Ts enter the site within 5 s (tactics' group entry) this soon after freeze end.
# Single-player first entries have no fast/slow split to cut at, and on Nuke they fire at 10–15 s on B without plants.
FAST_GROUP_S = 30.0
ZONE_CELL_PX = 8.0
# A league zone is kept when it gets utility in this share of the side's gun rounds on the map.
MIN_ZONE_RATE = 0.05
MATCH_MIN_RADIUS_PX = 30.0
# A team file lists a zone the team never used only on gun rounds, and only when the league uses it this often.
MIN_UNUSED_LEAGUE_RATE = 0.10
MAX_ORIGINS = 3
# Seconds from freeze end to a round's first throw into a zone: bins [0, 5), [5, 10), ..., [50, ∞).
TIME_EDGES = (5.0, 10.0, 20.0, 35.0, 50.0)
MIN_MAPS = 5
LOW_SAMPLE_MAPS = 10
MIN_HALF_ROUNDS = 30
MIN_RELIABILITY_TEAMS = 5
# Report-only: below this, most of the spread in a zone's team rates is sampling noise.
MIN_RELIABILITY = 0.3
GATE_MIN_R = 0.5
MIN_THROWER_SHARE = 0.1
MAX_THROWERS = 3
ATTRIBUTION_FLAG = 0.10
MAX_FILE_GZ_BYTES = 40 * 1024
MAX_TOTAL_GZ_BYTES = 8 * 1024 * 1024

NADE_SCHEMA = {
    "map_key": pl.String, "date": pl.String, "map": pl.String, "lp_team": pl.String, "steamid": pl.UInt64,
    "side": pl.String, "round_num": pl.Int64, "type": pl.String, "level": pl.String, "throw_t": pl.Float32,
    "land_px": pl.Float32, "land_py": pl.Float32, "throw_px": pl.Float32, "throw_py": pl.Float32,
    "land_place": pl.String,
}
ROUND_SCHEMA = {
    "map_key": pl.String, "date": pl.String, "map": pl.String, "round_num": pl.Int64, "side": pl.String,
    "lp_team": pl.String, "steamid": pl.UInt64,
}
ATTRIBUTION_SCHEMA = {"map_key": pl.String, "type": pl.String, "grenades": pl.UInt32, "attributed": pl.UInt32}


def nearest_places(points: np.ndarray, samples: np.ndarray, names: np.ndarray) -> np.ndarray:
    """Callout of the nearest player sample (x, y, z) to each point; empty input gives nulls."""
    if len(points) == 0:
        return np.array([], dtype=object)
    if len(samples) == 0:
        return np.full(len(points), None, dtype=object)
    _, idx = cKDTree(samples).query(points)
    return names[idx]


def map_rows(ref: MapRef, radar_meta: dict[str, dict]) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame] | None:
    """(grenade rows, player-round rows, attribution counts) for one map, or None off the radar pool."""
    warnings.filterwarnings("ignore", message="Sortedness of columns cannot be checked")
    entry = radar_meta.get(ref.map)
    if entry is None:
        return None
    rounds = (
        ref.table("rounds", ["round_num", "start_tick", "freeze_end_tick", "end_tick", "ct_lp_team", "t_lp_team"])
        .with_columns(
            pl.col("round_num").cast(pl.Int64),
            pl.col("freeze_end_tick").fill_null(pl.col("start_tick")).cast(pl.Int64).alias("fe"),
            pl.col("end_tick").cast(pl.Int64),
        )
    )
    rctx = rounds.select("round_num", "fe", "end_tick")
    teams = pl.concat([
        rounds.select("round_num", pl.lit("ct").alias("side"), pl.col("ct_lp_team").alias("lp_team")),
        rounds.select("round_num", pl.lit("t").alias("side"), pl.col("t_lp_team").alias("lp_team")),
    ]).filter(pl.col("lp_team").is_not_null() & (pl.col("lp_team") != ""))
    meta = {"map_key": ref.key, "date": ref.date, "map": ref.map}

    ticks_raw = (
        ref.table("ticks", TICK_COLS)
        .filter((pl.col("steamid") > 0) & pl.col("side").is_in([CT, T]))
        .with_columns(pl.col("round_num").cast(pl.Int64), pl.col("tick").cast(pl.Int64), pl.col("steamid").cast(pl.UInt64))
    )
    player_rounds = (
        ticks_raw.join(rctx, on="round_num", how="inner")
        .filter(pl.col("tick") >= pl.col("fe"))
        .select("round_num", "steamid", pl.col("side").replace_strict(SIDE_STR))
        .unique()
        .join(teams, on=["round_num", "side"], how="inner")
        .with_columns(**{k: pl.lit(v) for k, v in meta.items()})
        .select(list(ROUND_SCHEMA)).cast(ROUND_SCHEMA)
    )

    nades = round_nades(ref, entry, ticks_raw, rctx, attributed_only=False)
    if nades is None or nades.is_empty():
        return pl.DataFrame(schema=NADE_SCHEMA), player_rounds, pl.DataFrame(schema=ATTRIBUTION_SCHEMA)
    attribution = (
        nades.group_by(pl.col("gtype").alias("type"))
        .agg(pl.len().cast(pl.UInt32).alias("grenades"), pl.col("steamid").is_not_null().sum().cast(pl.UInt32).alias("attributed"))
        .with_columns(pl.lit(ref.key).alias("map_key"))
        .select(list(ATTRIBUTION_SCHEMA)).cast(ATTRIBUTION_SCHEMA)
    )

    landed = (
        nades.filter(pl.col("steamid").is_not_null() & _on_radar("land_px", "land_py") & _on_radar("throw_px", "throw_py"))
        .join(teams, left_on=["round_num", "side_str"], right_on=["round_num", "side"], how="inner")
    )
    placed = ticks_raw.filter(pl.col("last_place_name").is_not_null() & (pl.col("last_place_name") != ""))
    places = nearest_places(
        landed.select("x", "y", "z").to_numpy().astype(np.float64),
        placed.select("x", "y", "z").to_numpy().astype(np.float64),
        placed["last_place_name"].to_numpy(),
    )
    rows = (
        landed.with_columns(pl.Series("land_place", places, dtype=pl.String), **{k: pl.lit(v) for k, v in meta.items()})
        .select("map_key", "date", "map", "lp_team", "steamid", pl.col("side_str").alias("side"), "round_num",
                pl.col("gtype").alias("type"), "level", "throw_t", "land_px", "land_py", "throw_px", "throw_py",
                "land_place")
        .cast(NADE_SCHEMA)
    )
    return rows, player_rounds, attribution


_WORKER_META: dict[str, dict] = {}


def _init_worker(meta: dict[str, dict]) -> None:
    global _WORKER_META
    _WORKER_META = meta


def _worker(ref: MapRef) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame] | None:
    return map_rows(ref, _WORKER_META)


def _read_cached(path: Path, schema: dict) -> pl.DataFrame | None:
    if not path.exists() or dict(pl.read_parquet_schema(path)) != schema:
        return None
    return pl.read_parquet(path)


def build_raw(refs: list[MapRef], radar_meta: dict[str, dict] | None = None, rebuild: bool = False,
              workers: int | None = None) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    """Extract maps missing from the cached raw tables (all of them with `rebuild`) and return the three tables."""
    radar_meta = radar_meta if radar_meta is not None else load_radar_meta()
    paths = ((PROTOCOLS_RAW, NADE_SCHEMA), (PROTOCOLS_ROUNDS, ROUND_SCHEMA), (PROTOCOLS_ATTRIBUTION, ATTRIBUTION_SCHEMA))
    cached = [None if rebuild else _read_cached(p, s) for p, s in paths]
    complete = all(c is not None for c in cached)
    have = set(cached[1]["map_key"].unique().to_list()) if complete else set()
    todo = [r for r in refs if r.map in radar_meta and r.key not in have]
    buckets: list[list[pl.DataFrame]] = [[c] if complete else [] for c in cached]
    if todo:
        n = workers or min(os.cpu_count() or 1, 6)
        print(f"protocols: {len(todo)} maps to extract ({len(have)} cached), {n} workers", flush=True)
        with ProcessPoolExecutor(max_workers=n, initializer=_init_worker, initargs=(radar_meta,)) as ex:
            for i, res in enumerate(ex.map(_worker, todo, chunksize=4), 1):
                if res is not None:
                    for b, df in zip(buckets, res):
                        if not df.is_empty():
                            b.append(df)
                if i % 100 == 0:
                    print(f"  {i}/{len(todo)}", flush=True)
    out = []
    for (path, schema), parts in zip(paths, buckets):
        df = pl.concat(parts, how="vertical") if parts else pl.DataFrame(schema=schema)
        if todo or not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            df.write_parquet(path)
        out.append(df)
    return out[0], out[1], out[2]


def team_slug(name: str) -> str:
    """Same as `teamSlug` in src/utils/teams.ts, which the site uses to find the file."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def round_classes(player_rounds: pl.DataFrame, resources: pl.DataFrame, tactics: pl.DataFrame) -> pl.DataFrame:
    """One row per team-side round: `map_key, date, map, round_num, side, lp_team, series, cls, fast`.

    `cls` is `pistol`, `gun` (full buy) or `light` (eco or force), null when the buy is unknown. `fast` marks T rounds
    with a group entry before FAST_GROUP_S.
    """
    keys = ["map_key", "round_num", "side"]
    team = player_rounds.select("map_key", "date", "map", "round_num", "side", "lp_team").unique(keys)
    buys = (
        resources.select(pl.col("key").alias("map_key"), pl.col("round_num").cast(pl.Int64),
                         pl.col("side").replace_strict(SIDE_STR, default=None, return_dtype=pl.String), "team_buy",
                         "pistol")
        .unique(keys)
    )
    fast = (
        tactics.filter(pl.col("group_entry").fill_null(False)
                       & ((pl.col("exec_tick") - pl.col("freeze_end_tick")) / float(TICK_RATE) < FAST_GROUP_S))
        .select(pl.col("key").alias("map_key"), pl.col("round_num").cast(pl.Int64), pl.lit("t").alias("side"),
                pl.lit(True).alias("fast"))
        .unique(keys)
    )
    return (
        team.join(buys, on=keys, how="left").join(fast, on=keys, how="left")
        .with_columns(
            pl.when(pl.col("pistol")).then(pl.lit("pistol"))
            .when(pl.col("team_buy") == "full").then(pl.lit("gun"))
            .when(pl.col("team_buy").is_in(["eco", "force"])).then(pl.lit("light"))
            .alias("cls"),
            pl.col("fast").fill_null(False),
            pl.col("map_key").str.split("/").list.first().alias("series"),
        )
        .drop("team_buy", "pistol")
    )


def _nearest(px: np.ndarray, py: np.ndarray, cx: np.ndarray, cy: np.ndarray, radius: float) -> np.ndarray:
    """Index of the nearest centre within `radius` of each point, -1 when none is."""
    if len(cx) == 0 or len(px) == 0:
        return np.full(len(px), -1, dtype=np.int64)
    dist, idx = cKDTree(np.column_stack([cx, cy])).query(np.column_stack([px, py]), distance_upper_bound=radius)
    return np.where(np.isfinite(dist), idx, -1).astype(np.int64)


def _cluster_centres(px: np.ndarray, py: np.ndarray, radius: float) -> tuple[np.ndarray, np.ndarray]:
    """Greedy density clusters over ZONE_CELL_PX cells weighted by throws; returns cluster centres."""
    cell = np.floor(np.column_stack([px, py]) / ZONE_CELL_PX).astype(np.int64)
    uniq, inv, counts = np.unique(cell, axis=0, return_inverse=True, return_counts=True)
    inv = inv.ravel()
    mx = np.bincount(inv, weights=px) / counts
    my = np.bincount(inv, weights=py) / counts
    cx, cy = [], []
    for members in _greedy_clusters(mx, my, radius, weights=counts):
        w = counts[members]
        cx.append(float((mx[members] * w).sum() / w.sum()))
        cy.append(float((my[members] * w).sum() / w.sum()))
    return np.array(cx), np.array(cy)


def find_zones(nades: pl.DataFrame, rounds: pl.DataFrame, min_rate: float = MIN_ZONE_RATE) -> pl.DataFrame:
    """League landing zones per (map, side, type, level) that get utility in `min_rate` of the side's gun rounds.

    Columns: `map, side, type, level, cx, cy, radius, r, place, origins, throws`, where `origins` lists the top throw
    spots as `[px, py, n]` and `r` is the 80th-percentile landing distance from the centre.
    """
    gun = rounds.filter(pl.col("cls") == "gun").select("map_key", "round_num", "side")
    gun_n = dict(((m, s), n) for m, s, n in rounds.filter(pl.col("cls") == "gun").group_by("map", "side").len().iter_rows())
    out = []
    for (map_name, side, gtype, level), g in sorted(nades.partition_by("map", "side", "type", "level", as_dict=True).items()):
        denom = gun_n.get((map_name, side), 0)
        if denom == 0:
            continue
        radius = LAND_RADIUS_PX[gtype]
        px = g["land_px"].to_numpy().astype(np.float64)
        py = g["land_py"].to_numpy().astype(np.float64)
        cx, cy = _cluster_centres(px, py, radius)
        cand = g.with_columns(pl.Series("zone", _nearest(px, py, cx, cy, radius)))
        hit = (cand.filter(pl.col("zone") >= 0).join(gun, on=["map_key", "round_num", "side"], how="semi")
               .group_by("zone").agg(pl.struct("map_key", "round_num").n_unique().alias("hits")))
        keep = np.sort(hit.filter(pl.col("hits") / denom >= min_rate)["zone"].to_numpy())
        if len(keep) == 0:
            continue
        idx = _nearest(px, py, cx[keep], cy[keep], radius)
        places = g["land_place"].to_numpy()
        tpx = g["throw_px"].to_numpy().astype(np.float64)
        tpy = g["throw_py"].to_numpy().astype(np.float64)
        for k in range(len(keep)):
            members = np.flatnonzero(idx == k)
            if len(members) == 0:
                continue
            lx, ly = float(px[members].mean()), float(py[members].mean())
            r80 = max(MIN_ZONE_RADIUS_PX, round(float(np.percentile(np.hypot(px[members] - lx, py[members] - ly), 80))))
            named = [p for p in places[members] if p]
            origins = [[round(float(tpx[members][oc].mean())), round(float(tpy[members][oc].mean())), int(len(oc))]
                       for oc in _greedy_clusters(tpx[members], tpy[members], ORIGIN_RADIUS_PX)]
            origins.sort(key=lambda o: (-o[2], o[0], o[1]))
            out.append({
                "map": map_name, "side": side, "type": gtype, "level": level,
                "cx": float(cx[keep][k]), "cy": float(cy[keep][k]), "radius": radius,
                "lx": round(lx), "ly": round(ly), "r": r80,
                "place": Counter(named).most_common(1)[0][0] if named else None,
                "origins": origins[:MAX_ORIGINS], "throws": int(len(members)),
            })
    schema = {"map": pl.String, "side": pl.String, "type": pl.String, "level": pl.String, "cx": pl.Float64,
              "cy": pl.Float64, "radius": pl.Float64, "lx": pl.Int64, "ly": pl.Int64, "r": pl.Int64,
              "place": pl.String, "origins": pl.List(pl.List(pl.Int64)), "throws": pl.Int64}
    return pl.DataFrame(out, schema=schema)


def assign_zones(nades: pl.DataFrame, zones: pl.DataFrame) -> pl.DataFrame:
    """`nades` with `zone` (the zone's `id`), dropping throws that land in no zone."""
    parts = []
    by_group = zones.partition_by("map", "side", "type", "level", as_dict=True)
    for key, g in nades.partition_by("map", "side", "type", "level", as_dict=True).items():
        z = by_group.get(key)
        if z is None:
            continue
        idx = _nearest(g["land_px"].to_numpy().astype(np.float64), g["land_py"].to_numpy().astype(np.float64),
                       z["cx"].to_numpy(), z["cy"].to_numpy(), float(z["radius"][0]))
        ids = np.where(idx >= 0, z["id"].to_numpy()[np.maximum(idx, 0)], -1)
        parts.append(g.with_columns(pl.Series("zone", ids, dtype=pl.Int64)).filter(pl.col("zone") >= 0))
    return pl.concat(parts) if parts else nades.with_columns(pl.lit(None, pl.Int64).alias("zone")).clear()


def _bin_expr(col: str = "first_t") -> pl.Expr:
    return pl.sum_horizontal([(pl.col(col) >= e).cast(pl.Int64) for e in TIME_EDGES]).alias("bin")


def _timing_aggs() -> list[pl.Expr]:
    return [pl.len().alias("hits"), pl.col("first_t").median().alias("t_med"),
            pl.concat_list([(pl.col("bin") == i).sum() for i in range(len(TIME_EDGES) + 1)]).alias("bins")]


def round_hits(assigned: pl.DataFrame, rounds: pl.DataFrame) -> pl.DataFrame:
    """One row per team-side round and zone the team landed utility in: its class, series, date and first throw time."""
    return (
        assigned.group_by("map_key", "map", "round_num", "side", "lp_team", "zone")
        .agg(pl.col("throw_t").min().cast(pl.Float64).alias("first_t"))
        .join(rounds.select("map_key", "round_num", "side", "cls", "series", "date"), on=["map_key", "round_num", "side"])
        .with_columns(_bin_expr())
    )


def load_overrides(path: Path = PROTOCOL_ZONES) -> dict[str, list[dict]]:
    """Load `data/war/protocol-zones.json` keyed by map slug, or an empty dict if absent."""
    if not path.exists():
        return {}
    raw = json.loads(path.read_text())
    return {map_slug(m): entries for m, entries in (raw.get("maps") or {}).items()}


def _merge_origins(origin_lists: list[list[list[int]]]) -> list[list[int]]:
    pts = [o for lst in origin_lists for o in (lst or []) if len(o) == 3 and o[2] > 0]
    if not pts:
        return []
    xs = np.array([p[0] for p in pts], dtype=np.float64)
    ys = np.array([p[1] for p in pts], dtype=np.float64)
    ws = np.array([p[2] for p in pts], dtype=np.float64)
    merged = []
    for oc in _greedy_clusters(xs, ys, ORIGIN_RADIUS_PX, weights=ws):
        w = ws[oc]
        merged.append([round(float((xs[oc] * w).sum() / w.sum())), round(float((ys[oc] * w).sum() / w.sum())), int(w.sum())])
    merged.sort(key=lambda o: (-o[2], o[0], o[1]))
    return merged[:MAX_ORIGINS]


def apply_overrides(
    zones: pl.DataFrame,
    assigned: pl.DataFrame,
    overrides: dict[str, list[dict]],
    allow_stale: bool = False,
) -> tuple[pl.DataFrame, pl.DataFrame, list[str]]:
    """Match override entries to provisional zones by geometry, merge multi-point entries, and remap `assigned`.

    `zones` must carry a globally unique provisional `id` column matching `assigned["zone"]`.
    """
    rows_by_id = {int(r["id"]): r for r in zones.iter_rows(named=True)}
    by_group: dict[tuple[str, str, str, str], list[dict]] = {}
    for r in rows_by_id.values():
        key = (map_slug(r["map"]), r["side"], r["type"], r["level"])
        by_group.setdefault(key, []).append(r)

    claimed: dict[int, str] = {}
    groups: list[tuple[list[int], dict]] = []
    errors: list[str] = []

    for slug, entries in overrides.items():
        slug = map_slug(slug)
        for idx, entry in enumerate(entries):
            side, gtype, level = entry["side"], entry["type"], entry["level"]
            match_pts = entry.get("match") or []
            if not match_pts:
                errors.append(f"{slug} entry #{idx} ({entry.get('name') or 'unnamed'}): empty match list")
                continue
            candidates = by_group.get((slug, side, gtype, level), [])
            matched: list[int] = []
            tag = f"{slug} #{idx} ({entry.get('name') or 'unnamed'})"
            for pt in match_pts:
                mx, my = float(pt[0]), float(pt[1])
                best_id, best_d = None, math.inf
                for c in candidates:
                    d = math.hypot(float(c["lx"]) - mx, float(c["ly"]) - my)
                    if d <= max(float(c["r"]), MATCH_MIN_RADIUS_PX) and d < best_d:
                        best_id, best_d = int(c["id"]), d
                if best_id is None:
                    errors.append(f"{slug} ({side}/{gtype}/{level}) point {pt}: matched no zone")
                elif best_id in claimed:
                    errors.append(
                        f"{slug} ({side}/{gtype}/{level}) point {pt}: zone already claimed by {claimed[best_id]}"
                    )
                else:
                    claimed[best_id] = tag
                    matched.append(best_id)
            if matched:
                groups.append((matched, entry))

    if errors and not allow_stale:
        raise ValueError("protocol-zones overrides failed:\n  " + "\n  ".join(errors))

    id_map: dict[int, int] = {}
    out_rows: list[dict] = []

    for matched_ids, entry in groups:
        new_id = len(out_rows)
        for oid in matched_ids:
            id_map[oid] = new_id
        parts = [rows_by_id[oid] for oid in matched_ids]
        if len(parts) == 1:
            base = dict(parts[0])
        else:
            ws = [max(int(p["throws"]), 1) for p in parts]
            total_w = sum(ws)
            lx = round(sum(p["lx"] * w for p, w in zip(parts, ws)) / total_w)
            ly = round(sum(p["ly"] * w for p, w in zip(parts, ws)) / total_w)
            cx = sum(p["cx"] * w for p, w in zip(parts, ws)) / total_w
            cy = sum(p["cy"] * w for p, w in zip(parts, ws)) / total_w
            r_cov = max(MIN_ZONE_RADIUS_PX, *(round(math.hypot(p["lx"] - lx, p["ly"] - ly) + p["r"]) for p in parts))
            place = next((p["place"] for p in sorted(parts, key=lambda p: -p["throws"]) if p["place"]), None)
            base = {
                "map": parts[0]["map"], "side": parts[0]["side"], "type": parts[0]["type"], "level": parts[0]["level"],
                "cx": cx, "cy": cy, "radius": max(float(p["radius"]) for p in parts),
                "lx": lx, "ly": ly, "r": int(r_cov), "place": place,
                "origins": _merge_origins([p["origins"] for p in parts]),
                "throws": sum(int(p["throws"]) for p in parts),
            }
        base["id"] = new_id
        base["name"] = entry.get("name")
        base["description"] = entry.get("description")
        base["reviewed"] = entry.get("reviewed")
        out_rows.append(base)

    for oid in sorted(rows_by_id):
        if oid in claimed:
            continue
        new_id = len(out_rows)
        id_map[oid] = new_id
        base = dict(rows_by_id[oid])
        base["id"] = new_id
        base["name"] = None
        base["description"] = None
        base["reviewed"] = None
        out_rows.append(base)

    schema = {
        "map": pl.String, "side": pl.String, "type": pl.String, "level": pl.String,
        "cx": pl.Float64, "cy": pl.Float64, "radius": pl.Float64,
        "lx": pl.Int64, "ly": pl.Int64, "r": pl.Int64, "place": pl.String,
        "origins": pl.List(pl.List(pl.Int64)), "throws": pl.Int64, "id": pl.Int64,
        "name": pl.String, "description": pl.String, "reviewed": pl.Boolean,
    }
    new_zones = pl.DataFrame(out_rows, schema=schema)
    new_assigned = (
        assigned.with_columns(pl.col("zone").replace_strict(id_map).alias("zone"))
        if not assigned.is_empty() else assigned
    )
    return new_zones, new_assigned, errors


def number_zones(zones: pl.DataFrame, assigned: pl.DataFrame, rounds: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Give each zone an `id` unique on its map, ordered by side then league median first-throw time on gun rounds."""
    t_gun = (
        round_hits(assigned, rounds).filter(pl.col("cls") == "gun")
        .group_by("zone").agg(pl.col("first_t").median().alias("t_gun"))
    )
    numbered = (
        zones.join(t_gun, left_on="id", right_on="zone", how="left")
        .sort("map", pl.col("side").replace_strict({"t": 0, "ct": 1}), pl.col("t_gun").fill_null(1e9), "type", "cx", "cy")
        .with_columns(pl.int_range(pl.len()).over("map").alias("new_id"))
        .drop("t_gun")
    )
    id_map = dict(zip(numbered["id"].to_list(), numbered["new_id"].to_list()))
    out_zones = numbered.drop("id").rename({"new_id": "id"})
    out_assigned = (
        assigned.with_columns(pl.col("zone").replace_strict(id_map).alias("zone"))
        if not assigned.is_empty() else assigned
    )
    return out_zones, out_assigned


def league_stats(hits: pl.DataFrame, rounds: pl.DataFrame) -> pl.DataFrame:
    """Per (map, side, cls, zone): `rounds, hits, rate, t_med, bins` over every team in the window."""
    n = rounds.filter(pl.col("cls").is_not_null()).group_by("map", "side", "cls").agg(pl.len().alias("rounds"))
    return (
        hits.filter(pl.col("cls").is_not_null()).group_by("map", "side", "cls", "zone").agg(_timing_aggs())
        .join(n, on=["map", "side", "cls"])
        .with_columns((pl.col("hits") / pl.col("rounds")).alias("rate"))
    )


def team_windows(rounds: pl.DataFrame, residuals: pl.DataFrame, start: str) -> pl.DataFrame:
    """Per `lp_team`: `from` = the later of `start` and the first map of the team's latest IGL stint, plus its label."""
    latest = (residuals.sort("date", "key").group_by("lp_team")
              .agg(pl.col("stint_id").last(), pl.col("stint_label").last()))
    stint = (residuals.join(latest, on=["lp_team", "stint_id"], how="semi").group_by("lp_team")
             .agg(pl.col("date").min().alias("stint_from"), pl.col("stint_label").first()))
    return (
        rounds.select("lp_team").unique().join(stint, on="lp_team", how="left")
        .with_columns(pl.max_horizontal(pl.lit(start), pl.col("stint_from").fill_null(start)).alias("from"))
    )


def scope_rounds(rounds: pl.DataFrame, windows: pl.DataFrame, min_maps: int = MIN_MAPS) -> pl.DataFrame:
    """Rounds inside each team's window on maps it played `min_maps` times there, with `maps` per team-map."""
    inside = rounds.join(windows.select("lp_team", "from"), on="lp_team").filter(pl.col("date") >= pl.col("from"))
    maps = (inside.group_by("lp_team", "map").agg(pl.col("map_key").n_unique().alias("maps"))
            .filter(pl.col("maps") >= min_maps))
    return inside.join(maps, on=["lp_team", "map"]).drop("from")


def _interval(h: np.ndarray, r: np.ndarray, resamples: int, seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Series-bootstrap 5th and 95th percentiles and variance of hits/rounds per zone; `h` is series × zones."""
    w = ds._mults(len(r), resamples, seed)
    with np.errstate(invalid="ignore", divide="ignore"):
        boot = (w @ h) / (w @ r)[:, None]
    lo, hi = np.nanquantile(boot, [0.05, 0.95], axis=0)
    return lo, hi, np.nanvar(boot, axis=0)


def team_stats(scoped: pl.DataFrame, hits: pl.DataFrame, zones: pl.DataFrame, league: pl.DataFrame,
               resamples: int, seed: int = 0) -> pl.DataFrame:
    """Per (lp_team, map, side, cls, zone) over every league zone of that map and side: rounds, hits, rate, the
    league rate, `diff` with its 90% series-bootstrap interval `lo`/`hi`, bootstrap `var`, `t_med` and `bins`."""
    s = scoped.filter(pl.col("cls").is_not_null())
    team_hits = hits.join(s.select("map_key", "round_num", "side", "lp_team"), on=["map_key", "round_num", "side", "lp_team"], how="semi")
    per_series_h = team_hits.group_by("lp_team", "map", "side", "cls", "series", "zone").agg(pl.len().alias("h"))
    per_series_r = s.group_by("lp_team", "map", "side", "cls", "series").agg(pl.len().alias("r"))
    timing = team_hits.group_by("lp_team", "map", "side", "cls", "zone").agg(_timing_aggs()).drop("hits")
    zone_ids = {k: g["id"].to_numpy() for k, g in zones.partition_by("map", "side", as_dict=True).items()}
    lg = {(m, sd, c, z): rate for m, sd, c, z, rate in league.select("map", "side", "cls", "zone", "rate").iter_rows()}
    h_by = per_series_h.partition_by("lp_team", "map", "side", "cls", as_dict=True)

    rows = []
    for (team, map_name, side, cls), rg in per_series_r.partition_by("lp_team", "map", "side", "cls", as_dict=True).items():
        ids = zone_ids.get((map_name, side))
        if ids is None:
            continue
        series = rg["series"].to_list()
        r = rg["r"].to_numpy().astype(np.float64)
        h = np.zeros((len(series), len(ids)))
        hg = h_by.get((team, map_name, side, cls))
        if hg is not None:
            s_ix = {sid: i for i, sid in enumerate(series)}
            z_ix = {int(z): j for j, z in enumerate(ids)}
            for sid, z, n in hg.select("series", "zone", "h").iter_rows():
                h[s_ix[sid], z_ix[int(z)]] = n
        lo, hi, var = _interval(h, r, resamples, seed)
        total = r.sum()
        for j, z in enumerate(ids):
            base = lg.get((map_name, side, cls, int(z)), 0.0)
            rate = h[:, j].sum() / total
            rows.append((team, map_name, side, cls, int(z), int(total), int(h[:, j].sum()), rate, base, rate - base,
                         lo[j] - base, hi[j] - base, var[j]))
    cols = ["lp_team", "map", "side", "cls", "zone", "rounds", "hits", "rate", "league", "diff", "lo", "hi", "var"]
    out = pl.DataFrame(rows, schema=cols, orient="row")
    return out.join(timing, on=["lp_team", "map", "side", "cls", "zone"], how="left")


def reliability(stats: pl.DataFrame) -> pl.DataFrame:
    """Per (map, side, cls, zone): share of the spread in team rates that isn't bootstrap noise, over teams that
    played it; null under MIN_RELIABILITY_TEAMS teams."""
    return (
        stats.group_by("map", "side", "cls", "zone")
        .agg(pl.len().alias("teams"), pl.col("rate").var().alias("spread"), pl.col("var").mean().alias("noise"))
        .with_columns(
            pl.when((pl.col("teams") >= MIN_RELIABILITY_TEAMS) & (pl.col("spread") > 0))
            .then((1 - pl.col("noise") / pl.col("spread")).clip(0.0, 1.0))
            .alias("reliability")
        )
        .select("map", "side", "cls", "zone", "teams", "reliability")
    )


def throwers(scoped: pl.DataFrame, assigned: pl.DataFrame, player_rounds: pl.DataFrame,
             stats: pl.DataFrame) -> pl.DataFrame:
    """Per (lp_team, map, side, cls, zone, steamid): rounds the player landed utility in the zone, `share` of the
    team's hit rounds and `rate` per round the player played."""
    keys = ["map_key", "round_num", "side", "lp_team"]
    cls = scoped.filter(pl.col("cls").is_not_null()).select(*keys, "map", "cls")
    played = (player_rounds.join(cls, on=keys).group_by("lp_team", "map", "side", "cls", "steamid")
              .agg(pl.len().alias("p_rounds")))
    thrown = (assigned.select(*keys, "zone", "steamid").unique().join(cls, on=keys)
              .group_by("lp_team", "map", "side", "cls", "zone", "steamid").agg(pl.len().alias("p_hits")))
    return (
        thrown.join(stats.select("lp_team", "map", "side", "cls", "zone", "hits"), on=["lp_team", "map", "side", "cls", "zone"])
        .join(played, on=["lp_team", "map", "side", "cls", "steamid"])
        .with_columns((pl.col("p_hits") / pl.col("hits")).alias("share"), (pl.col("p_hits") / pl.col("p_rounds")).alias("rate"))
    )


def _deviation_cells(scoped_gun: pl.DataFrame, hits: pl.DataFrame, league: pl.DataFrame, zones: pl.DataFrame) -> pl.DataFrame:
    """Per (lp_team, map, side, zone, half): rate minus the league gun rate, on team-map-sides with
    MIN_HALF_ROUNDS in both halves."""
    halves = _alternating(scoped_gun, ["lp_team", "map"])
    r = halves.group_by("lp_team", "map", "side", "half").agg(pl.len().alias("r"))
    ok = (r.group_by("lp_team", "map", "side").agg(pl.col("r").min().alias("min_r"), pl.len().alias("n_halves"))
          .filter((pl.col("n_halves") == 2) & (pl.col("min_r") >= MIN_HALF_ROUNDS)))
    h = (hits.join(halves.select("map_key", "round_num", "side", "lp_team", "half"), on=["map_key", "round_num", "side", "lp_team"])
         .group_by("lp_team", "map", "side", "half", "zone").agg(pl.len().alias("h")))
    lg = league.filter(pl.col("cls") == "gun").select("map", "side", "zone", pl.col("rate").alias("league"))
    grid = (r.join(ok, on=["lp_team", "map", "side"], how="semi")
            .join(zones.select("map", "side", pl.col("id").alias("zone")), on=["map", "side"]))
    return (grid.join(h, on=["lp_team", "map", "side", "half", "zone"], how="left")
            .join(lg, on=["map", "side", "zone"], how="left")
            .with_columns((pl.col("h").fill_null(0) / pl.col("r") - pl.col("league").fill_null(0.0)).alias("dev")))


def split_half_gate(scoped: pl.DataFrame, hits: pl.DataFrame, league: pl.DataFrame, zones: pl.DataFrame,
                    resamples: int, seed: int = 0) -> dict:
    """Correlation of team-minus-league gun-round zone rates between alternating series, pooled over every
    (team, map, side, zone), with a 90% interval resampling teams; also per map."""
    cells = _deviation_cells(scoped.filter(pl.col("cls") == "gun"), hits, league, zones)
    wide = (cells.with_columns(pl.col("half").cast(pl.String))
            .pivot(on="half", index=["lp_team", "map", "side", "zone"], values="dev").drop_nulls()
            .sort("lp_team", "map", "side", "zone"))
    if wide.is_empty():
        return {"r": None, "r_ci": (None, None), "teams": 0, "team_map_sides": 0, "cells": 0, "per_map": {}, "passed": False}
    a, b = wide["0"].to_numpy(), wide["1"].to_numpy()
    teams, t_ix = np.unique(wide["lp_team"].to_numpy(), return_inverse=True)
    rows_of = [np.flatnonzero(t_ix == i) for i in range(len(teams))]
    obs = ds._corr(a, b)
    rng = np.random.default_rng(seed)
    boots = []
    for _ in range(resamples if obs is not None else 0):
        rows = np.concatenate([rows_of[i] for i in rng.integers(0, len(teams), len(teams))])
        boots.append(ds._corr(a[rows], b[rows]))
    lo, hi = ds._z_ci(obs, boots)
    per_map = {m: ds._corr(g["0"].to_numpy(), g["1"].to_numpy())
               for (m,), g in sorted(wide.partition_by("map", as_dict=True).items())}
    return {"r": obs, "r_ci": (lo, hi), "teams": len(teams),
            "team_map_sides": wide.select("lp_team", "map", "side").unique().height, "cells": wide.height,
            "per_map": per_map, "passed": lo is not None and lo > GATE_MIN_R}


def attribution_check(attribution: pl.DataFrame, scoped: pl.DataFrame) -> pl.DataFrame:
    """Per team and grenade type: share of grenades with an inferred thrower over its maps, against the league, flagged
    when ATTRIBUTION_FLAG or more apart. Both teams on a map share its rate, so this only catches large gaps."""
    league = attribution.group_by("type").agg((pl.col("attributed").sum() / pl.col("grenades").sum()).alias("league"))
    team_maps = scoped.select("lp_team", "map_key").unique()
    return (
        attribution.join(team_maps, on="map_key").group_by("lp_team", "type")
        .agg((pl.col("attributed").sum() / pl.col("grenades").sum()).alias("share"))
        .join(league, on="type")
        .with_columns(((pl.col("share") - pl.col("league")).abs() >= ATTRIBUTION_FLAG).alias("flagged"))
        .sort("lp_team", "type")
    )


def player_names(refs: list[MapRef]) -> dict[int, str]:
    """steamid → in-game name on the latest map it appears on."""
    names: dict[int, str] = {}
    for ref in refs:
        path = ref.dir / "players.parquet"
        if path.exists():
            for sid, name in pl.read_parquet(path, columns=["steamid", "name"]).iter_rows():
                if sid and name:
                    names[int(sid)] = name
    return names


def _r3(v: float | None) -> float | None:
    return None if v is None or not np.isfinite(v) else round(float(v), 3)


def _dump(obj: dict) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def league_files(zones: pl.DataFrame, league: pl.DataFrame, rel: pl.DataFrame, rounds: pl.DataFrame,
                 radar_meta: dict, meta: dict) -> dict[str, bytes]:
    """`v1/_league/<map>.json`: zone geometry, league rates and timing per class, and reliability."""
    lg = {(m, s, c, z): row for m, s, c, z, *row in league.select("map", "side", "cls", "zone", "rate", "t_med", "bins", "hits").iter_rows()}
    rl = {(m, s, c, z): v for m, s, c, z, v in rel.select("map", "side", "cls", "zone", "reliability").iter_rows()}
    n = {(m, s, c): k for m, s, c, k in rounds.filter(pl.col("cls").is_not_null()).group_by("map", "side", "cls").len().iter_rows()}
    fast = {m: v for m, v in rounds.filter((pl.col("side") == "t") & (pl.col("cls") == "gun")).group_by("map")
            .agg(pl.col("fast").mean()).iter_rows()}
    files = {}
    for (map_name,), z in sorted(zones.partition_by("map", as_dict=True).items()):
        out_zones = []
        for row in z.sort("id").iter_rows(named=True):
            key = (map_name, row["side"])
            out_zones.append({
                "id": row["id"], "side": row["side"], "type": row["type"], "level": row["level"],
                "land": [row["lx"], row["ly"]], "r": row["r"], "place": row["place"], "from": row["origins"],
                **({"name": row["name"]} if row.get("name") is not None else {}),
                **({"description": row["description"]} if row.get("description") is not None else {}),
                **({"reviewed": row["reviewed"]} if row.get("reviewed") is not None else {}),
                "league": {c: {"rate": _r3(v[0]), "tMed": _r3(v[1]), "bins": v[2], "hits": v[3]}
                           for c in CLASSES if (v := lg.get((*key, c, row["id"])))},
                "reliability": {c: _r3(rl.get((*key, c, row["id"]))) for c in CLASSES},
            })
        files[f"v{SCHEMA_VERSION}/_league/{map_slug(map_name)}.json"] = _dump({
            "version": SCHEMA_VERSION, "map": map_slug(map_name), "levels": levels_for(map_name, radar_meta), **meta,
            "rounds": {s: {c: n.get((map_name, s, c), 0) for c in CLASSES} for s in SIDES},
            "fastShare": _r3(fast.get(map_name)), "timeEdges": list(TIME_EDGES), "zones": out_zones,
        })
    return files


def team_files(stats: pl.DataFrame, thrown: pl.DataFrame, scoped: pl.DataFrame, windows: pl.DataFrame,
               names: dict[int, str], meta: dict) -> dict[str, bytes]:
    """`v1/teams/<slug>.json`: per map and side, the round mix and each zone's team rate against the league."""
    top = (thrown.filter(pl.col("share") >= MIN_THROWER_SHARE).sort("share", descending=True)
           .group_by("lp_team", "map", "side", "cls", "zone", maintain_order=True)
           .agg(pl.concat_list(pl.col("steamid").cast(pl.String), pl.col("share").round(3).cast(pl.String),
                               pl.col("rate").round(3).cast(pl.String)).head(MAX_THROWERS).alias("throwers")))
    by_zone = {(t, m, s, c, z): rows for t, m, s, c, z, rows in top.iter_rows()}
    mix = (scoped.group_by("lp_team", "map", "side")
           .agg(*[(pl.col("cls") == c).sum().alias(c) for c in CLASSES], pl.len().alias("all"),
                pl.col("fast").filter(pl.col("cls") == "gun").mean().alias("fast"),
                pl.col("map_key").n_unique().alias("maps")))
    mix_by = {(t, m, s): row for t, m, s, *row in mix.iter_rows()}
    files = {}
    for (team,), ts in sorted(stats.partition_by("lp_team", as_dict=True).items()):
        win = windows.filter(pl.col("lp_team") == team).row(0, named=True)
        steamids: set[str] = set()
        maps_out = []
        for (map_name,), tm in sorted(ts.partition_by("map", as_dict=True).items()):
            n_maps = max(mix_by[(team, map_name, s)][-1] for s in SIDES if (team, map_name, s) in mix_by)
            sides = {}
            for side in SIDES:
                mx = mix_by.get((team, map_name, side))
                if mx is None:
                    continue
                classes = {}
                for cls in CLASSES:
                    rows = tm.filter((pl.col("side") == side) & (pl.col("cls") == cls)).sort("zone")
                    zs = []
                    for r in rows.iter_rows(named=True):
                        if r["hits"] == 0 and (cls != "gun" or r["league"] < MIN_UNUSED_LEAGUE_RATE):
                            continue
                        tw = [[sid, float(sh), float(rt)] for sid, sh, rt in by_zone.get((team, map_name, side, cls, r["zone"]), [])]
                        steamids.update(t[0] for t in tw)
                        zs.append({
                            "id": r["zone"], "hits": r["hits"], "rate": _r3(r["rate"]),
                            "diff": _r3(r["diff"]), "lo": _r3(r["lo"]), "hi": _r3(r["hi"]),
                            **({"tMed": _r3(r["t_med"]), "bins": r["bins"]} if r["hits"] else {}),
                            **({"throwers": tw} if tw else {}),
                        })
                    if rows.height:
                        classes[cls] = {"rounds": int(rows["rounds"][0]), "zones": zs}
                sides[side] = {"rounds": dict(zip(CLASSES, (int(v) for v in mx[:3]))), "allRounds": int(mx[3]),
                               "fastShare": _r3(mx[4]) if side == "t" else None, "classes": classes}
            maps_out.append({"map": map_slug(map_name), "maps": int(n_maps), "lowSample": n_maps < LOW_SAMPLE_MAPS,
                             "sides": sides})
        files[f"v{SCHEMA_VERSION}/teams/{team_slug(team)}.json"] = _dump({
            "version": SCHEMA_VERSION, "team": team, **meta,
            "from": win["from"], "stint": ({"label": win["stint_label"], "from": win["stint_from"]}
                                           if win["stint_label"] and win["stint_from"] == win["from"] else None),
            "players": {sid: names.get(int(sid), sid) for sid in sorted(steamids)},
            "maps": sorted(maps_out, key=lambda m: -m["maps"]),
        })
    return files


def report_lines(gate: dict, zones: pl.DataFrame, league: pl.DataFrame, rel: pl.DataFrame, rounds: pl.DataFrame,
                 scoped: pl.DataFrame, attribution: pl.DataFrame, window: dict) -> list[str]:
    gun = rounds.filter(pl.col("cls") == "gun")
    lines = [
        "# Team utility protocols", "",
        f"Window {window['from']} → {window['to']}. {rounds['map_key'].n_unique():,} maps, {rounds.height:,} team-side rounds "
        f"({gun.height:,} gun). {zones.height} league zones (≥{MIN_ZONE_RATE:.0%} of the side's gun rounds). "
        f"{scoped['lp_team'].n_unique()} teams on {scoped.select('lp_team', 'map').unique().height} team-maps with "
        f"{MIN_MAPS}+ maps in their window.", "",
        "## Gate: split-half of team − league gun-round zone rates (alternating series)", "",
        f"Pooled r **{_f(gate['r'])}** (90% CI {_f(gate['r_ci'][0])}, {_f(gate['r_ci'][1])}) over {gate['cells']:,} "
        f"(team, map, side, zone) cells, {gate['team_map_sides']} team-map-sides with {MIN_HALF_ROUNDS}+ gun rounds a half, "
        f"{gate['teams']} teams. Passes when the lower bound is above {GATE_MIN_R}: **{'passes' if gate['passed'] else 'fails'}**.", "",
        "| Map | r |", "| --- | --- |",
        *[f"| {m} | {_f(r)} |" for m, r in gate["per_map"].items()], "",
        "## Reliability per zone (gun rounds)", "",
    ]
    rg = rel.filter((pl.col("cls") == "gun") & pl.col("reliability").is_not_null())
    if rg.height:
        q = rg["reliability"].quantile
        lines += [f"{rg.height} zones with {MIN_RELIABILITY_TEAMS}+ teams: median {_f(q(0.5))}, quartiles {_f(q(0.25))} / "
                  f"{_f(q(0.75))}; {(rg['reliability'] >= MIN_RELIABILITY).sum()} at {MIN_RELIABILITY}+. Low reliability "
                  "usually means every team does the same thing (low spread), not that the rates are wrong.", ""]
    lines += ["## Round mix (league, share of team-side rounds)", "", "| Map | Side | Gun | Pistol | Light | Unknown buy | Fast gun T |",
              "| --- | --- | --- | --- | --- | --- | --- |"]
    for (m, s), g in sorted(rounds.partition_by("map", "side", as_dict=True).items()):
        sh = {c: (g["cls"] == c).mean() for c in CLASSES}
        fast = g.filter(pl.col("cls") == "gun")["fast"].mean() if s == "t" else None
        lines.append(f"| {m} | {s} | {sh['gun']:.2f} | {sh['pistol']:.2f} | {sh['light']:.2f} | {g['cls'].is_null().mean():.2f} | "
                     f"{_f(fast, 2)} |")
    lines += ["", "## Top league zones per map and side (gun rounds)", ""]
    lj = league.filter(pl.col("cls") == "gun").join(zones.select("map", "side", pl.col("id").alias("zone"), "type", "place"),
                                                   on=["map", "side", "zone"])
    for (m, s), g in sorted(lj.partition_by("map", "side", as_dict=True).items()):
        lines += [f"**{m} {s.upper()}**", "", "| Zone | Type | Place | Rate | Median s |", "| --- | --- | --- | --- | --- |"]
        for r in g.sort("rate", descending=True).head(10).iter_rows(named=True):
            lines.append(f"| {r['zone']} | {r['type']} | {r['place']} | {r['rate']:.2f} | {r['t_med']:.1f} |")
        lines.append("")
    flagged = attribution.filter(pl.col("flagged"))
    lines += ["## Attribution", "",
              "League share of grenades with an inferred thrower: " + ", ".join(
                  f"{t} {v:.2f}" for t, v in attribution.group_by("type").agg(pl.col("league").first()).sort("type").iter_rows()) + ".",
              f"{flagged.height} team-types {ATTRIBUTION_FLAG:.0%}+ off the league" + (":" if flagged.height else "."), ""]
    lines += [f"- {r['lp_team']} {r['type']}: {r['share']:.2f} (league {r['league']:.2f})" for r in flagged.iter_rows(named=True)]
    return lines


def _f(v, d: int = 3) -> str:
    return "—" if v is None else f"{v:.{d}f}"


def build(months: int = 6, rebuild: bool = False, resamples: int = 1000, publish: bool = False,
          upload: bool = False, out_dir: Path = PUBLIC_PROTOCOLS, overrides_path: Path = PROTOCOL_ZONES,
          allow_stale_overrides: bool = False) -> int:
    radar_meta = load_radar_meta(RADAR_META)
    refs = catalog()
    window_to = max(r.date for r in refs)
    start = subtract_months(window_to, months)
    in_window = [r for r in refs if r.date >= start and r.map in radar_meta]
    window = {"from": start, "to": window_to, "months": months}

    nades, player_rounds, attribution = build_raw(in_window, radar_meta, rebuild=rebuild)
    keys = {r.key for r in in_window}
    nades = nades.filter(pl.col("map_key").is_in(keys))
    player_rounds = player_rounds.filter(pl.col("map_key").is_in(keys))
    attribution = attribution.filter(pl.col("map_key").is_in(keys))

    rounds = round_classes(player_rounds, pl.read_parquet(RESOURCE_ROUNDS, columns=["key", "round_num", "side", "team_buy", "pistol"]),
                           pl.read_parquet(TACTICS_RAW, columns=["key", "round_num", "group_entry", "exec_tick", "freeze_end_tick"]))
    zones = find_zones(nades, rounds).with_columns(pl.int_range(pl.len()).alias("id"))
    assigned = assign_zones(nades, zones)
    overrides = load_overrides(overrides_path)
    try:
        zones, assigned, override_warnings = apply_overrides(zones, assigned, overrides, allow_stale=allow_stale_overrides)
    except ValueError as err:
        print(err)
        return 1
    if override_warnings:
        print("override warnings (--allow-stale-overrides):\n  " + "\n  ".join(override_warnings))
    zones, assigned = number_zones(zones, assigned, rounds)
    hits = round_hits(assigned, rounds)
    league = league_stats(hits, rounds)

    windows = team_windows(rounds, pl.read_parquet(TEAM_MAP_RESIDUALS, columns=["key", "date", "lp_team", "stint_id", "stint_label"]), start)
    scoped = scope_rounds(rounds, windows)
    stats = team_stats(scoped, hits, zones, league, resamples)
    rel = reliability(stats)
    gate = split_half_gate(scoped, hits, league, zones, resamples)
    thrown = throwers(scoped, assigned, player_rounds, stats)
    attr = attribution_check(attribution, scoped)

    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    report = WAR_REPORTS / "protocols.md"
    report.write_text("\n".join(report_lines(gate, zones, league, rel, rounds, scoped, attr, window)) + "\n")
    print(f"protocols ({start} → {window_to}): {zones.height} zones, {scoped['lp_team'].n_unique()} teams; "
          f"split-half r {_f(gate['r'])} ({_f(gate['r_ci'][0])}, {_f(gate['r_ci'][1])}) "
          f"{'passes' if gate['passed'] else 'FAILS'}; wrote {report}")
    if not (publish or upload):
        return 0
    if not gate["passed"]:
        print("gate failed; not publishing")
        return 1

    meta = {"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "window": window, "source": SOURCE}
    files = {**league_files(zones, league, rel, rounds, radar_meta, meta),
             **team_files(stats, thrown, scoped, windows, player_names(in_window), meta)}
    sizes, _ = check_budget(files)
    print(f"{sizes['files']} files, {sizes['total_raw'] / 1e6:.2f} MB raw, {sizes['total_gz'] / 1e6:.2f} MB gzipped; largest "
          + ", ".join(f"{k} {gz / 1024:.1f} KB" for k, _, gz in sizes["largest"][:3]))
    violations = [f"{k}: {gz / 1024:.1f} KB gzipped > {MAX_FILE_GZ_BYTES // 1024} KB" for k, _, gz in sizes["largest"]
                  if gz > MAX_FILE_GZ_BYTES]
    if sizes["total_gz"] > MAX_TOTAL_GZ_BYTES:
        violations.append(f"total {sizes['total_gz'] / 1e6:.2f} MB gzipped")
    if violations:
        print("BUDGET EXCEEDED:\n  " + "\n  ".join(violations))
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
        stats_up = r2.sync_json_gz(R2_PREFIX, {f"protocols/{k}": v for k, v in files.items()})
        print(f"uploaded to R2 ({r2.bucket}): {stats_up['uploaded']} uploaded, {stats_up['skipped']} unchanged, "
              f"{stats_up['deleted']} deleted")
    return 0
