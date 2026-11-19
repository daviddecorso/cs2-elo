"""Team tactics stats (Phase 7, order 4): execute success and post-plant conversion, map control at 30, 45 and 60 s,
and numbers at contact.

Expectations use map, economy and man-count only, never team Elo (Elo absorbs tactics, so a residual against it would
drift to zero); Elo enters only through the beyond-Elo label test.
"""

import json
import math
import os
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from . import duelstats as ds
from . import teamfactor as tf
from . import teamstats as ts
from . import warcheck
from .data import MapRef, catalog
from .nav import LOOKUP_GRID, SITES, SiteDistance
from .paths import (PUBLIC_WAR, TACTICS_MAPS, TACTICS_RAW, TACTICS_ROUNDS, TACTICS_SIDE_RATINGS, TACTICS_TEAMS,
                    TEAM_MAP_RESIDUALS, TEAM_ROUNDS, WAR_REPORTS)
from .publish import SOURCE
from .resources import GRENADE_COLUMNS, GRENADE_COUNT, thrower_grenades
from .states import CT, SIDE_CODE, TICK_RATE, T, map_plants

# Nav path distance (Hammer units) from the site's plant areas. Inside SITE_RADIUS a T has entered the site;
# HOLD_RADIUS adds the close holds around it, for defenders, first contact and utility thrown onto the site.
SITE_RADIUS = 500.0
HOLD_RADIUS = 1000.0
EXEC_PLAYERS = 3
EXEC_WINDOW = 5 * TICK_RATE
EXEC_UTIL = 2
# Utility for an execute is often thrown before the first T steps in; smokes land seconds before entry.
UTIL_LEAD = 8 * TICK_RATE
CONTROL_SECONDS = (30, 45, 60)
SEASON_SPLIT_MONTH = 7

CTRL = tuple(f"ctrl{s}" for s in CONTROL_SECONDS)
ZERO_SUM = (*CTRL, "contact")
WEIGHT = {**{c: f"n_{c}" for c in CTRL}, "contact": "n_contact"}
SIDE_STATS = ("exec", "post")
LABELS = {**{f"ctrl{s}": f"Map control at {s} s" for s in CONTROL_SECONDS}, "contact": "Numbers at contact",
          "exec": "Execute success", "post": "Post-plant conversion"}
SIDE_TARGET = {"exec": "take", "post": "t_win"}
EXEC_COLS = ["map", "site_b", "ct_equip", "t_equip", "t_alive_exec", "ct_alive_exec"]
POST_COLS = ["map", "site_b", "ct_equip", "t_equip", "t_alive_plant", "ct_alive_plant", "ct_kits_plant"]
MODEL_COLS = {"exec": EXEC_COLS, "post": POST_COLS}
MONOTONE = {"t_equip": 1, "ct_equip": -1, "t_alive_exec": 1, "ct_alive_exec": -1, "t_alive_plant": 1,
            "ct_alive_plant": -1, "ct_kits_plant": -1}
SIDE_ALPHA = 100.0
MIN_SIDE_N = 30
SPOT_CHECKS = 12

TICK_COLUMNS = ["tick", "round_num", "steamid", "side", "x", "y", "z", "health", "has_defuser", *GRENADE_COUNT.values()]
DAMAGE_COLUMNS = ["tick", "round_num", "attacker_steamid", "attacker_side", "victim_side", "attacker_x", "attacker_y",
                  "attacker_z", "victim_x", "victim_y", "victim_z"]


class NavGraph:
    """The nav mesh as a sparse directed graph (edge weight = centroid distance) with each area's 2D size."""

    def __init__(self, sd: SiteDistance):
        self.sd = sd
        areas = sd.nav.areas
        ids = areas["area_id"].to_numpy().astype(np.int64)
        self.index = {int(a): i for i, a in enumerate(ids)}
        self.sizes = areas["size"].to_numpy().astype(np.float64)
        cx, cy, cz = (areas[c].to_numpy().astype(np.float64) for c in ("centroid_x", "centroid_y", "centroid_z"))
        rows, cols, w = [], [], []
        for i, a in enumerate(ids):
            for b in sd.nav.neighbors(int(a)):
                j = self.index.get(int(b))
                if j is None or j == i:
                    continue
                rows.append(i)
                cols.append(j)
                # csgraph drops explicit zeros, so co-located centroids get a tiny positive weight.
                w.append(max(math.dist((cx[i], cy[i], cz[i]), (cx[j], cy[j], cz[j])), 1e-3))
        self.graph = csr_matrix((w, (rows, cols)), shape=(len(ids), len(ids)))

    def areas_of(self, xs: np.ndarray, ys: np.ndarray, zs: np.ndarray) -> np.ndarray:
        """Graph index of each position's nav area, −1 off the mesh."""
        if len(xs) == 0:
            return np.empty(0, dtype=np.int64)
        keys = np.column_stack([np.rint(v / LOOKUP_GRID).astype(np.int64) for v in (xs, ys, zs)])
        uniq, first, inv = np.unique(keys, axis=0, return_index=True, return_inverse=True)
        out = np.empty(len(uniq), dtype=np.int64)
        for u, i in enumerate(first):
            a = self.sd.area(float(xs[i]), float(ys[i]), float(zs[i]))
            out[u] = self.index.get(a, -1) if a is not None else -1
        return out[inv.reshape(-1)]


def territory_share(graph: csr_matrix, sizes: np.ndarray, ct_src: np.ndarray, t_src: np.ndarray) -> float | None:
    """CT share of the reachable nav area: each area goes to the side that can reach it first (ties split)."""
    if len(ct_src) == 0 or len(t_src) == 0:
        return None
    dc = dijkstra(graph, directed=True, indices=np.unique(ct_src), min_only=True)
    dt = dijkstra(graph, directed=True, indices=np.unique(t_src), min_only=True)
    reach = np.isfinite(dc) | np.isfinite(dt)
    total = sizes[reach].sum()
    if total <= 0:
        return None
    own = (dc < dt) + 0.5 * ((dc == dt) & np.isfinite(dc))
    return float((sizes * own)[reach].sum() / total)


def first_entries(ticks: np.ndarray, sids: np.ndarray) -> np.ndarray:
    """Sorted first tick of each player, from rows already sorted by tick."""
    if len(ticks) == 0:
        return np.empty(0, dtype=np.int64)
    _, first = np.unique(sids, return_index=True)
    return np.sort(ticks[first])


def site_hit(plant_site: str | None, entries: dict[str, np.ndarray]) -> str | None:
    """The plant site, else the site whose second T entry came first, else none."""
    if plant_site in SITES:
        return plant_site
    second = {s: e[1] for s, e in entries.items() if len(e) >= 2}
    return min(second, key=second.get) if second else None


def hit_tick(entries: np.ndarray, plant_tick: int | None) -> int | None:
    """When the T side reached the hit site: its first entry, else the plant."""
    return int(entries[0]) if len(entries) else plant_tick


def group_entry(entries: np.ndarray) -> tuple[int, int] | None:
    """(first, third) entry tick of the first EXEC_PLAYERS Ts to enter within EXEC_WINDOW, if any."""
    for i in range(len(entries) - EXEC_PLAYERS + 1):
        if entries[i + EXEC_PLAYERS - 1] - entries[i] <= EXEC_WINDOW:
            return int(entries[i]), int(entries[i + EXEC_PLAYERS - 1])
    return None


def _graph_to(d: dict[str, np.ndarray], site: str) -> np.ndarray:
    return d[f"graph_{site}"]


def map_rounds(ref: MapRef, sd: SiteDistance, nav: NavGraph) -> pl.DataFrame:
    """One row per round: site hit, executes, plant state, territory at 30/45/60 s and defenders at first contact."""
    rounds = ref.table("rounds").select("round_num", "start_tick", "freeze_end_tick", "end_tick").sort("round_num")
    tk = (ref.table("ticks", TICK_COLUMNS).filter((pl.col("steamid") > 0) & pl.col("side").is_in([CT, T]))
          .with_columns(pl.col("round_num").cast(pl.Int64)).sort("round_num", "tick"))
    xs, ys, zs = (tk[c].to_numpy().astype(np.float64) for c in ("x", "y", "z"))
    d = sd.distances(xs, ys, zs)
    area = nav.areas_of(xs, ys, zs)
    rnum, tick, sid = tk["round_num"].to_numpy(), tk["tick"].to_numpy(), tk["steamid"].to_numpy()
    side, hp = tk["side"].to_numpy(), tk["health"].fill_null(0).to_numpy()
    kit = tk["has_defuser"].fill_null(False).to_numpy().astype(bool)

    plants = {r: (t, s) for r, t, s in ref.table("bomb", ["round_num", "event", "tick", "bombsite"])
              .filter(pl.col("event") == "finish_plant").sort("tick").unique("round_num", keep="first")
              .select(pl.col("round_num").cast(pl.Int64), "tick", "bombsite").iter_rows()}

    gpath = ref.dir / "grenades.parquet"
    nades = None
    if gpath.exists():
        g = thrower_grenades(pl.read_parquet(gpath, columns=[*GRENADE_COLUMNS, "z"]), tk)
        g = g.filter(pl.col("side") == T)
        gd = sd.distances(*(g[c].to_numpy().astype(np.float64) for c in ("x", "y", "z")))
        nades = (g["round_num"].to_numpy(), g["pop_tick"].to_numpy(), gd)

    dmg = (ref.table("damages", DAMAGE_COLUMNS)
           .filter(pl.col("attacker_steamid").is_not_null() & pl.col("attacker_side").is_not_null()
                   & pl.col("victim_side").is_not_null() & (pl.col("attacker_side") != pl.col("victim_side")))
           .with_columns(pl.col("round_num").cast(pl.Int64), (pl.col("attacker_side") == "terrorist").alias("t_att"))
           .sort("tick"))
    t_att = dmg["t_att"].to_numpy()
    tx, ty, tz = (np.where(t_att, dmg[f"attacker_{c}"].to_numpy(), dmg[f"victim_{c}"].to_numpy()).astype(np.float64)
                  for c in "xyz")
    dd = sd.distances(tx, ty, tz)
    d_round, d_tick = dmg["round_num"].to_numpy(), dmg["tick"].to_numpy()

    bounds = {r: (int(np.searchsorted(rnum, r, "left")), int(np.searchsorted(rnum, r, "right")))
              for r in rounds["round_num"].to_list()}

    def snapshot(lo: int, hi: int, target: int) -> slice | None:
        i = int(np.searchsorted(tick[lo:hi], target, "right")) - 1
        if i < 0:
            return None
        s = tick[lo + i]
        return slice(lo + int(np.searchsorted(tick[lo:hi], s, "left")), lo + int(np.searchsorted(tick[lo:hi], s, "right")))

    def alive(sl: slice, code: int) -> np.ndarray:
        return np.flatnonzero((side[sl] == code) & (hp[sl] > 0)) + sl.start

    out = []
    for rn, start, fe, end in rounds.iter_rows():
        rn = int(rn)
        fe = int(fe if fe is not None else start)
        lo, hi = bounds[rn]
        plant = plants.get(rn)
        cutoff = plant[0] if plant else end
        row = {"round_num": rn, "plant_site": plant[1] if plant else None, "freeze_end_tick": fe}

        span = np.arange(lo, hi)
        live = span[(tick[span] >= fe) & (tick[span] <= cutoff) & (side[span] == T) & (hp[span] > 0)]
        entries = {s: first_entries(tick[live][_graph_to(d, s)[live] <= SITE_RADIUS],
                                    sid[live][_graph_to(d, s)[live] <= SITE_RADIUS]) for s in SITES}
        hit = site_hit(plant[1] if plant else None, entries)
        row["hit_site"] = hit
        if hit is not None:
            row["hit_tick"] = hit_tick(entries[hit], plant[0] if plant else None)
        row["group_entry"] = False
        row["execute"] = False
        if hit is not None:
            ge = group_entry(entries[hit])
            if ge is not None:
                first, third = ge
                util = 0
                if nades is not None:
                    nr, nt, nd = nades
                    util = int(np.sum((nr == rn) & (nt >= first - UTIL_LEAD) & (nt <= third)
                                      & (_graph_to(nd, hit) <= HOLD_RADIUS)))
                sl = snapshot(lo, hi, third)
                row.update(group_entry=True, exec_tick=third, exec_util=util, execute=util >= EXEC_UTIL,
                           t_alive_exec=len(alive(sl, T)) if sl else None,
                           ct_alive_exec=len(alive(sl, CT)) if sl else None)
        if plant:
            sl = snapshot(lo, hi, plant[0])
            if sl:
                cts = alive(sl, CT)
                row.update(t_alive_plant=len(alive(sl, T)), ct_alive_plant=len(cts), ct_kits_plant=int(kit[cts].sum()))

        for s in CONTROL_SECONDS:
            target = fe + s * TICK_RATE
            if target >= end or (plant and plant[0] <= target):
                continue
            sl = snapshot(lo, hi, target)
            if sl is None:
                continue
            cts, tts = alive(sl, CT), alive(sl, T)
            share = territory_share(nav.graph, nav.sizes, area[cts][area[cts] >= 0], area[tts][area[tts] >= 0])
            if share is not None:
                row.update({f"share{s}": share, f"ct_alive{s}": len(cts), f"t_alive{s}": len(tts)})

        if hit is not None:
            m = (d_round == rn) & (d_tick > fe) & (d_tick <= cutoff) & (_graph_to(dd, hit) <= HOLD_RADIUS)
            contact = int(d_tick[m][0]) if m.any() else None
            if plant and (contact is None or plant[0] < contact):
                contact = int(plant[0])
            sl = snapshot(lo, hi, contact) if contact is not None else None
            if sl:
                cts = alive(sl, CT)
                row.update(contact_tick=contact, contact_ct_alive=len(cts),
                           defenders=int(np.sum(_graph_to(d, hit)[cts] <= HOLD_RADIUS)))
        out.append(row)

    schema = {"round_num": pl.Int64, "plant_site": pl.String, "freeze_end_tick": pl.Int64, "hit_site": pl.String,
              "hit_tick": pl.Int64, "group_entry": pl.Boolean,
              "execute": pl.Boolean, "exec_tick": pl.Int64, "exec_util": pl.Int64, "t_alive_exec": pl.Int64,
              "ct_alive_exec": pl.Int64, "t_alive_plant": pl.Int64, "ct_alive_plant": pl.Int64,
              "ct_kits_plant": pl.Int64,
              **{k: v for s in CONTROL_SECONDS for k, v in ((f"share{s}", pl.Float64), (f"ct_alive{s}", pl.Int64),
                                                             (f"t_alive{s}", pl.Int64))},
              "contact_tick": pl.Int64, "contact_ct_alive": pl.Int64, "defenders": pl.Int64}
    return pl.DataFrame(out, schema=schema).with_columns(pl.lit(ref.key).alias("key"), pl.lit(ref.map).alias("map"))


_WORKER_PLANTS: dict[str, pl.DataFrame] = {}
_WORKER_NAV: dict[str, tuple[SiteDistance, NavGraph] | None] = {}


def _init_worker(plants: dict[str, pl.DataFrame]) -> None:
    global _WORKER_PLANTS, _WORKER_NAV
    _WORKER_PLANTS, _WORKER_NAV = plants, {}


def _worker(ref: MapRef) -> tuple[pl.DataFrame | None, dict]:
    if ref.map not in _WORKER_NAV:
        try:
            sd = SiteDistance(ref.map, _WORKER_PLANTS[ref.map])
            _WORKER_NAV[ref.map] = (sd, NavGraph(sd))
        except (FileNotFoundError, KeyError):
            _WORKER_NAV[ref.map] = None
    nav = _WORKER_NAV[ref.map]
    if nav is None:
        return None, {}
    sd, graph = nav
    before = dict(sd.stats)
    rows = map_rounds(ref, sd, graph)
    return rows, {k: sd.stats[k] - before[k] for k in sd.stats}


def build_raw(refs: list[MapRef], rebuild: bool = False, workers: int | None = None) -> tuple[pl.DataFrame, dict]:
    """Per-round geometry for every map, computed once per map and cached in `tactics-raw.parquet`."""
    stale = TACTICS_RAW.exists() and "hit_tick" not in pl.read_parquet_schema(TACTICS_RAW)
    cached = pl.read_parquet(TACTICS_RAW) if TACTICS_RAW.exists() and not (rebuild or stale) else None
    have = set(cached["key"].unique().to_list()) if cached is not None else set()
    todo = [r for r in refs if r.key not in have]
    frames = [cached.filter(pl.col("key").is_in([r.key for r in refs]))] if cached is not None else []
    coverage = {"area": 0, "snapped": 0, "missed": 0}
    skipped: set[str] = set()
    if todo:
        plants = map_plants([r for r in refs if r.map in {t.map for t in todo}])
        n = workers or min(os.cpu_count() or 1, 6)
        print(f"tactics: {len(todo)} maps to build ({len(have)} cached), {n} workers", flush=True)
        with ProcessPoolExecutor(max_workers=n, initializer=_init_worker, initargs=(plants,)) as ex:
            for i, (ref, (rows, cov)) in enumerate(zip(todo, ex.map(_worker, todo, chunksize=4)), 1):
                if rows is None:
                    skipped.add(ref.map)
                    continue
                frames.append(rows)
                for k, v in cov.items():
                    coverage[k] += v
                if i % 200 == 0:
                    print(f"  {i}/{len(todo)}", flush=True)
    raw = pl.concat(frames, how="diagonal_relaxed") if frames else pl.DataFrame()
    TACTICS_RAW.parent.mkdir(parents=True, exist_ok=True)
    raw.write_parquet(TACTICS_RAW)
    return raw, {"built": len(todo), "cached": len(have), "coverage": coverage, "skipped_maps": sorted(skipped)}


def tactics_rounds(raw: pl.DataFrame, rounds: pl.DataFrame) -> pl.DataFrame:
    """Raw geometry joined to `team-rounds.parquet` (teams, buys, `p_econ`), with territory centred per map and
    man-count and defenders centred per map, site and CTs alive."""
    r = rounds.join(raw.drop("map"), on=["key", "round_num"], how="inner").with_columns(
        (~pl.col("ct_win")).alias("t_win"), (pl.col("hit_site") == "B").cast(pl.Float64).alias("site_b"),
        (pl.col("plant_site") == pl.col("hit_site")).fill_null(False).alias("take"))
    r = r.with_columns(
        *((pl.col(f"share{s}") - pl.col(f"share{s}").mean().over("map", f"ct_alive{s}", f"t_alive{s}")).alias(f"ctrl{s}")
          for s in CONTROL_SECONDS),
        (pl.col("defenders") - pl.col("defenders").mean().over("map", "hit_site", "contact_ct_alive")).alias("contact"))
    return r


def expectations(r: pl.DataFrame, device: str = "cpu") -> tuple[pl.DataFrame, dict]:
    """`p_take` on executes and `p_post` on planted rounds, each cross-fit by event."""
    info = {}
    for name, flag, col in (("exec", "execute", "p_take"), ("post", None, "p_post")):
        cols = MODEL_COLS[name]
        target = SIDE_TARGET[name]
        sub = r.filter(pl.all_horizontal(pl.col(c).is_not_null() for c in cols))
        if flag:
            sub = sub.filter(pl.col(flag))
        p, n = ts.cross_fit(sub, cols, device, target=target, monotone=MONOTONE)
        y = sub[target].cast(pl.Float64).to_numpy()
        info[name] = {"rows": sub.height, "rate": float(y.mean()), "trees": n,
                      "base": float(ts._log_loss(y, np.full(len(y), y.mean())).mean()),
                      "model": float(ts._log_loss(y, p).mean())}
        r = r.join(sub.select("key", "round_num", pl.Series(col, p)), on=["key", "round_num"], how="left")
    return r, info


def side_frame(r: pl.DataFrame, stat: str) -> pl.DataFrame:
    """Rows in the shape the adjusted T/CT ratings take: `p_econ` and `ct_win` become the CT side's chance and
    result of stopping the T event, so `o` is T offense and `d` CT defense."""
    p, target = ("p_take", "take") if stat == "exec" else ("p_post", "t_win")
    return (r.filter(pl.col(p).is_not_null())
            .select("key", "round_num", "series", "event", "date", "ct_lp_team", "t_lp_team",
                    (1 - pl.col(p)).alias("p_econ"), (~pl.col(target)).alias("ct_win")))


def season(date: str) -> str:
    return f"{date[:4]}H{1 if int(date[5:7]) < SEASON_SPLIT_MONTH else 2}"


def season_persistence(r: pl.DataFrame, alpha: float, min_n: float, resamples: int, seed: int = 0) -> dict:
    """Does a unit's `o` (T) and `d` (CT) carry from one half-year season to the next? Fit per season, correlate
    consecutive seasons over units with `min_n` rows on that side in both, 90% interval resampling series."""
    units, ct_idx, t_idx, y, off = ts._side_arrays(r)
    n_u = len(units)
    X = ts.side_design(ct_idx, t_idx, n_u)
    seasons = np.array([season(d) for d in r["date"].to_list()])
    labels = sorted(set(seasons.tolist()))
    masks = [seasons == s for s in labels]
    _, s_ids = np.unique(r["series"].to_numpy(), return_inverse=True)
    n_s = int(s_ids.max()) + 1
    counts = [(np.bincount(ct_idx[m], minlength=n_u), np.bincount(t_idx[m], minlength=n_u)) for m in masks]

    def fits(w: np.ndarray | None, start: list | None = None) -> list[np.ndarray]:
        return [ts.fit_logit_ridge(X[m], y[m], off[m], alpha, w=None if w is None else w[m],
                                   start=None if start is None else start[i]) for i, m in enumerate(masks)]

    def corrs(bs: list[np.ndarray]) -> dict:
        out = {}
        for name, sl, k in (("ct_def", slice(0, n_u), 0), ("t_off", slice(n_u, 2 * n_u), 1)):
            a, b = [], []
            for i in range(len(bs) - 1):
                ok = (counts[i][k] >= min_n) & (counts[i + 1][k] >= min_n)
                a.append(bs[i][sl][ok])
                b.append(bs[i + 1][sl][ok])
            va, vb = np.concatenate(a), np.concatenate(b)
            out[name] = (ds._corr(va, vb) if len(va) >= tf.MIN_HALF_TEAMS else None, len(va))
        return out

    if len(labels) < 2:
        return {s: {"r": None, "r_ci": (None, None), "pairs": 0} for s in ts.SIDE_LABELS} | {"seasons": labels}
    base = fits(None)
    obs = corrs(base)
    rng = np.random.default_rng(seed)
    boots = [corrs(fits(m[s_ids], base)) for m in
             rng.multinomial(n_s, np.full(n_s, 1.0 / n_s), size=resamples).astype(np.float64)]
    return {name: {"r": obs[name][0], "pairs": obs[name][1],
                   "r_ci": ds._z_ci(obs[name][0], [b[name][0] for b in boots if b[name][0] is not None])}
            for name in obs} | {"seasons": labels}


def side_results(r: pl.DataFrame, residuals: pl.DataFrame, resamples: int) -> tuple[dict, pl.DataFrame]:
    res, tables = {}, []
    n = min(resamples, ts.SIDE_RESAMPLES)
    for stat in SIDE_STATS:
        frame = side_frame(r, stat)
        res[stat] = {}
        for unit in ds.UNITS:
            u = ts._side_units(frame, residuals, unit)
            sh = ts.side_split_half(u, SIDE_ALPHA, MIN_SIDE_N, n)
            sp = season_persistence(u, SIDE_ALPHA, MIN_SIDE_N, n)
            est = (ts.side_ratings(u, SIDE_ALPHA, n).join(ts._unit_elo(residuals, unit), on="unit_id", how="left")
                   .with_columns(pl.lit(unit).alias("unit_type"), pl.lit(stat).alias("stat")))
            elig = est.filter(pl.col("rounds") >= 2 * MIN_SIDE_N)
            r_elo = {s: ds._corr(elig.filter(pl.col("side") == s)["per100"].to_numpy(),
                                 elig.filter(pl.col("side") == s)["elo_mean"].to_numpy()) for s in ts.SIDE_LABELS}
            res[stat][unit] = {"rows": u.height, "split": sh, "season": sp, "r_elo": r_elo}
            tables.append(est)
    return res, pl.concat(tables, how="diagonal_relaxed")


def per_team(r: pl.DataFrame) -> pl.DataFrame:
    """Per (key, lp_team): each zero-sum stat summed from the team's view (CT as is, T negated) and its count."""
    long = pl.concat([
        r.select("key", pl.col("ct_lp_team").alias("lp_team"), *ZERO_SUM),
        r.select("key", pl.col("t_lp_team").alias("lp_team"), *(-pl.col(s) for s in ZERO_SUM)),
    ])
    return long.group_by("key", "lp_team").agg(
        *(pl.col(s).sum() for s in ZERO_SUM),
        *(pl.col(s).is_not_null().sum().cast(pl.Float64).alias(WEIGHT[s]) for s in ZERO_SUM))


def stat_maps(per: pl.DataFrame, residuals: pl.DataFrame) -> pl.DataFrame:
    war = residuals.select("key", pl.col("lp_team").alias("team_a"), pl.col("all_covered").alias("war_covered"),
                           pl.col("expected_win_prob").clip(1e-4, 1 - 1e-4).alias("_p"))
    maps = ds.pair_maps(per, residuals, weights=list(WEIGHT.values()), stats=list(ZERO_SUM))
    return (maps.join(war, on=["key", "team_a"], how="left")
            .with_columns((pl.col("_p") / (1 - pl.col("_p"))).log().alias("war_logit")).drop("_p")
            .filter(pl.all_horizontal(pl.col(w) > 0 for w in WEIGHT.values())))


def beyond_war(maps: pl.DataFrame, forward: dict) -> dict | None:
    """Leave-one-event-out log loss of the map result from the summed-prior-WAR expectation alone and with the
    walk-forward stat difference, on maps where all ten players have priors."""
    if forward.get("pred") is None or not np.any(forward["pred"]):
        return None
    rows = (maps.with_columns(pl.Series("prior", forward["pred"]), pl.Series("_ev", forward["evaluated"]))
            .filter(pl.col("_ev") & pl.col("war_covered").fill_null(False) & pl.col("war_logit").is_not_null()))
    if rows["event"].n_unique() < 3:
        return None
    base = warcheck.cv_losses(rows, ["war_logit"])
    both = warcheck.cv_losses(rows, ["war_logit", "prior"])
    lo, hi = warcheck.paired_ci(base - both, rows["event"].to_numpy())
    return {"maps": rows.height, "events": int(rows["event"].n_unique()), "war": float(base.mean()),
            "with": float(both.mean()), "gain": float((base - both).mean()), "gain_ci": (lo, hi)}


def contact_round_test(r: pl.DataFrame) -> dict | None:
    """Does the defender excess at contact predict the round beyond the economy expectation? Leave-one-event-out
    log loss, 90% interval resampling events."""
    rows = (r.filter(pl.col("contact").is_not_null() & pl.col("p_econ").is_not_null())
            .with_columns(pl.col("ct_win").cast(pl.Int64).alias("y"),
                          (pl.col("p_econ").clip(1e-6, 1 - 1e-6) / (1 - pl.col("p_econ").clip(1e-6, 1 - 1e-6)))
                          .log().alias("econ_logit")))
    if rows["event"].n_unique() < 3:
        return None
    base = warcheck.cv_losses(rows, ["econ_logit"])
    both = warcheck.cv_losses(rows, ["econ_logit", "contact"])
    lo, hi = warcheck.paired_ci(base - both, rows["event"].to_numpy())
    return {"rounds": rows.height, "econ": float(base.mean()), "with": float(both.mean()),
            "gain": float((base - both).mean()), "gain_ci": (lo, hi)}


def zero_sum_results(maps: pl.DataFrame, min_rounds: int, resamples: int) -> tuple[dict, pl.DataFrame]:
    res, est = ds.team_results(maps, min_rounds, resamples, stats=ZERO_SUM, weight=WEIGHT.get)
    for unit in ds.UNITS:
        for stat in ZERO_SUM:
            wcol = WEIGHT[stat]
            min_w = min_rounds / 2 * maps[wcol].sum() / maps["rounds"].sum()
            t = res[unit][stat]
            t["persist"] = tf.window_persistence(maps, unit=unit, resid_col=stat, min_window=min_w,
                                                 resamples=resamples, weight_col=wcol)
            if stat in CTRL:
                t["war"] = beyond_war(maps, t["forward"])
    return res, est


def gates(zs: dict, side: dict, contact_test: dict | None) -> dict:
    """Split-half on stints for every stat, plus each stat's own test from the spec."""
    stint = zs["stint"]
    split = {s: ds._passes(stint[s]["split"]["r_ci"]) for s in ZERO_SUM}
    own = {s: stint[s]["war"] is not None and ds._passes(stint[s]["war"]["gain_ci"]) for s in CTRL}
    own["contact"] = contact_test is not None and ds._passes(contact_test["gain_ci"])
    for stat in SIDE_STATS:
        s = side[stat]["stint"]
        split[stat] = ds._passes(s["split"]["t_off"]["r_ci"])
        own[stat] = ds._passes(s["season"]["t_off"]["r_ci"])
    published = [s for s in (*ZERO_SUM, *SIDE_STATS) if split[s] and own[s]]
    return {"split": split, "own": own, "published": published}


OWN_TEST = {**{c: "adds beyond WAR" for c in CTRL}, "contact": "predicts the round beyond economy",
            "exec": "T offense persists across seasons", "post": "T offense persists across seasons"}


def _f(v, d=3, signed=False):
    return tf._fmt_f(v, d, signed)


def _ci(ci, d=3, signed=False):
    return tf._fmt_ci(ci, d, signed)


def _verdict(ok: bool) -> str:
    return "**PASS**" if ok else "**FAIL**"


def detection_lines(r: pl.DataFrame, info: dict) -> list[str]:
    t = (r.group_by("map").agg(
        pl.len().alias("rounds"), pl.col("hit_site").is_not_null().mean().alias("hit"),
        pl.col("plant_site").is_not_null().mean().alias("plant"), pl.col("group_entry").mean().alias("group"),
        pl.col("execute").mean().alias("execute"), pl.col("take").filter(pl.col("execute")).mean().alias("take"),
        pl.col("t_win").filter(pl.col("plant_site").is_not_null()).mean().alias("post"),
        pl.col("defenders").mean().alias("defenders"),
        *(pl.col(f"share{s}").mean().alias(f"s{s}") for s in CONTROL_SECONDS),
        *(pl.col(f"share{s}").is_not_null().mean().alias(f"n{s}") for s in CONTROL_SECONDS))
         .sort("rounds", descending=True))
    lines = ["## Detection", "",
             f"Site radius {SITE_RADIUS:g} and hold radius {HOLD_RADIUS:g} nav units from the plant areas. An execute is "
             f"{EXEC_PLAYERS}+ Ts entering the hit site within {EXEC_WINDOW // TICK_RATE} s, with {EXEC_UTIL}+ T grenades "
             f"landing in the hold radius from {UTIL_LEAD // TICK_RATE} s before the first entry to the third. "
             f"{info['raw']['built']:,} maps built, {info['raw']['cached']:,} cached; skipped maps without a nav mesh: "
             f"{', '.join(info['raw']['skipped_maps']) or 'none'}.", "",
             "| Map | Rounds | Site hit | Planted | 3 in 5 s | Execute | Take after execute | T win after plant | "
             "Defenders at contact | CT share 30 / 45 / 60 s | Rounds live at 30 / 45 / 60 s |", "|" + " --- |" * 11]
    for x in t.iter_rows(named=True):
        lines.append(f"| {x['map']} | {x['rounds']:,} | {_f(x['hit'], 2)} | {_f(x['plant'], 2)} | {_f(x['group'], 2)} | "
                     f"{_f(x['execute'], 2)} | {_f(x['take'], 2)} | {_f(x['post'], 2)} | {_f(x['defenders'], 2)} | "
                     f"{' / '.join(_f(x[f's{s}'], 2) for s in CONTROL_SECONDS)} | "
                     f"{' / '.join(_f(x[f'n{s}'], 2) for s in CONTROL_SECONDS)} |")
    ex = r.filter(pl.col("execute"))
    lines += ["", "Execute rate by T buy:", "", "| T buy | T rounds | Execute | Take after execute |", "| --- | --- | --- | --- |"]
    for x in (r.with_columns(ts._buy("t_equip").alias("buy")).group_by("buy")
              .agg(pl.len().alias("n"), pl.col("execute").mean().alias("e"),
                   pl.col("take").filter(pl.col("execute")).mean().alias("t")).sort("buy").iter_rows(named=True)):
        lines.append(f"| {x['buy']} | {x['n']:,} | {_f(x['e'], 2)} | {_f(x['t'], 2)} |")
    lines += ["", f"Spot checks ({SPOT_CHECKS} random executes; ticks are demo ticks):", "",
              "| Map key | Round | Site | Third entry tick | T grenades | Planted |", "| --- | --- | --- | --- | --- | --- |"]
    for x in ex.sample(min(SPOT_CHECKS, ex.height), seed=0).sort("key", "round_num").iter_rows(named=True):
        lines.append(f"| {x['key']} | {x['round_num']} | {x['hit_site']} | {x['exec_tick']} | {x['exec_util']} | "
                     f"{'yes' if x['take'] else 'no'} |")
    cov = info["raw"]["coverage"]
    total = sum(cov.values())
    if total:
        lines += ["", f"Positions on the nav mesh this build: {100 * (cov['area'] + cov['snapped']) / total:.1f}% "
                      f"({100 * cov['snapped'] / total:.1f}% snapped)."]
    return lines


def report_lines(r: pl.DataFrame, info: dict, maps: pl.DataFrame, zs: dict, side: dict, contact_test: dict | None,
                 est: pl.DataFrame, side_est: pl.DataFrame, g: dict, min_rounds: int) -> list[str]:
    lines = [
        "# Tactics stats", "",
        f"{r.height:,} rounds on {r['key'].n_unique():,} maps; {maps.height:,} maps have both teams' stints, Elo and "
        f"every stat ({int(maps['war_covered'].fill_null(False).sum()):,} with all ten players' WAR priors). Every "
        "interval is 90%, resampling whole series unless marked. No expectation includes team Elo.", "",
        "## Gates", "",
        *(f"- {LABELS[s]}: stint split-half {_verdict(g['split'][s])}, {OWN_TEST[s]} {_verdict(g['own'][s])}."
          for s in (*ZERO_SUM, *SIDE_STATS)),
        f"- Published: {', '.join(g['published']) or 'none'}.", "",
        *detection_lines(r, info), "",
        "## Expectations (cross-fit by event, no Elo)", "",
        "| Model | Rows | Rate | Inputs | Trees | Base log loss | Model log loss |", "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for name, label in (("exec", "`p_take`: execute → plant"), ("post", "`p_post`: plant → T win")):
        m = info["models"][name]
        lines.append(f"| {label} | {m['rows']:,} | {m['rate']:.3f} | {', '.join(MODEL_COLS[name])} | {m['trees']} | "
                     f"{m['base']:.4f} | {m['model']:.4f} |")

    lines += ["", "## Execute success and post-plant conversion", "",
              "`logit P(CT stops it) = logit(1 − p) + d[CT unit] − o[T unit]`, logistic ridge at alpha "
              f"{SIDE_ALPHA:g}. Split-half is alternating series; season persistence correlates consecutive half-year "
              f"seasons (split at month {SEASON_SPLIT_MONTH}) over units with {MIN_SIDE_N}+ rows on that side in both.", "",
              "| Stat | Unit | Rows | T split-half r (90% CI) | CT split-half r (90% CI) | T season r (90% CI, pairs) | "
              "CT season r (90% CI, pairs) | T r Elo | CT r Elo |", "|" + " --- |" * 9]
    for stat in SIDE_STATS:
        for unit, name in ds.UNITS.items():
            s = side[stat][unit]
            sh, sp = s["split"], s["season"]
            lines.append(
                f"| {LABELS[stat]} | {name} | {s['rows']:,} | {_f(sh['t_off']['r'])} {_ci(sh['t_off']['r_ci'])} | "
                f"{_f(sh['ct_def']['r'])} {_ci(sh['ct_def']['r_ci'])} | {_f(sp['t_off']['r'])} {_ci(sp['t_off']['r_ci'])}, "
                f"{sp['t_off']['pairs']} | {_f(sp['ct_def']['r'])} {_ci(sp['ct_def']['r_ci'])}, {sp['ct_def']['pairs']} | "
                f"{_f(s['r_elo']['t_off'], 2)} | {_f(s['r_elo']['ct_def'], 2)} |")

    for unit, name in ds.UNITS.items():
        lines += ["", f"## Map control and numbers at contact by {name} ({min_rounds}+ rounds)", "",
                  "Map control is the CT share of reachable nav area (each area to the side that reaches it first), "
                  "centred per map and men alive on each side; per 100 rounds it is share points. Numbers at contact is "
                  "CT defenders within the hold radius at first contact on the hit site, centred per map, site and CTs "
                  "alive. Team view: CT as is, T negated. The WAR test is leave-one-event-out map-result log loss, "
                  "summed-prior-WAR expectation against it plus the walk-forward stat.", "",
                  "| Stat | Units | Split-half r | 90% CI | k | Quarter r | 90% CI | Forward gain % | r with Elo | "
                  "Elo + stat gain (90% CI) | WAR + stat gain (90% CI) |", "|" + " --- |" * 11]
        for stat in ZERO_SUM:
            t = zs[unit][stat]
            sh, fw, el, pr, wr = t["split"], t["forward"], t["elo"], t["persist"], t.get("war")
            pct = None if fw.get("gain") is None or not fw["mse_zero"] else 100 * fw["gain"] / fw["mse_zero"]
            lines.append(f"| {LABELS[stat]} | {sh['units']} | {_f(sh['r'])} | {_ci(sh['r_ci'])} | {tf._fmt_k(sh['k_rounds'])} | "
                         f"{_f(pr['r'])} | {_ci(pr['r_ci'])} | {_f(pct, 2, True)} | {_f(t['r_elo'], 2)} | "
                         f"{_f(el and el['gain'], 4, True)} {_ci(el['gain_ci'] if el else (None, None), 4, True)} | "
                         f"{_f(wr and wr['gain'], 4, True)} {_ci(wr['gain_ci'] if wr else (None, None), 4, True)} |")
    if contact_test:
        c = contact_test
        lines += ["", f"Numbers at contact, round test: {c['rounds']:,} rounds, log loss {c['econ']:.4f} economy only, "
                      f"{c['with']:.4f} with the defender excess, gain {c['gain']:+.5f} {_ci(c['gain_ci'], 5, True)}."]

    stint = est.filter((pl.col("unit_type") == "stint") & (pl.col("rounds") >= min_rounds))
    for stat in ZERO_SUM:
        q = stint.filter(pl.col("stat") == stat).sort("per100_rounds", descending=True)
        if q.is_empty():
            continue
        lines += ["", f"### {LABELS[stat]}: top and bottom {ds.TOP} stints", "",
                  "| Stint | Maps | Rounds | Per 100 rounds (90% CI) |", "| --- | --- | --- | --- |"]
        for x in pl.concat([q.head(ds.TOP), q.tail(ds.TOP)]).unique("unit_id", maintain_order=True).iter_rows(named=True):
            lines.append(f"| {x['label']} | {x['maps']} | {x['rounds']:,} | {_f(x['per100_rounds'], 2, True)} "
                         f"({_f(x['per100_rounds_p5'], 2, True)}, {_f(x['per100_rounds_p95'], 2, True)}) |")
    st = side_est.filter((pl.col("unit_type") == "stint") & (pl.col("rounds") >= 2 * MIN_SIDE_N))
    for stat in SIDE_STATS:
        for s, label in (("t_off", "T offense"), ("ct_def", "CT defense")):
            q = st.filter((pl.col("stat") == stat) & (pl.col("side") == s)).sort("per100", descending=True)
            if q.is_empty():
                continue
            lines += ["", f"### {LABELS[stat]}, {label}: top and bottom {ds.TOP} stints (points per 100)", "",
                      "| Stint | Rows | Per 100 (90% CI) |", "| --- | --- | --- |"]
            for x in pl.concat([q.head(ds.TOP), q.tail(ds.TOP)]).unique("unit_id", maintain_order=True).iter_rows(named=True):
                lines.append(f"| {x['label']} | {x['rounds']:,} | {_f(x['per100'], 2, True)} "
                             f"({_f(x['per100_p5'], 2, True)}, {_f(x['per100_p95'], 2, True)}) |")
    return lines


def _rate(per100: float, p5: float, p95: float) -> dict:
    return {"per100": round(float(per100), 3), "p5": round(float(p5), 3), "p95": round(float(p95), 3)}


def export_public(est: pl.DataFrame, side_est: pl.DataFrame, zs: dict, side: dict, g: dict, min_rounds: int,
                  out_dir: Path = PUBLIC_WAR) -> int:
    """`tactics.json`: stint estimates for the stats that passed, each marked descriptive unless it adds to Elo."""
    if not g["published"]:
        print("No tactics stat passed its gates; skipping tactics.json.")
        return 1
    meta, records = {}, {}

    def record(x: dict) -> dict:
        return records.setdefault(x["unit_id"], {
            "stint_id": x["unit_id"], "label": x["label"], "lp_team": x["lp_team"],
            "liquipedia_url": f"https://liquipedia.net/counterstrike/{x['lp_team'].replace(' ', '_')}",
            "igl_player": x["igl_player"], "maps": int(x["maps"])})

    stint = est.filter((pl.col("unit_type") == "stint") & (pl.col("rounds") >= min_rounds))
    for stat in (s for s in g["published"] if s in ZERO_SUM):
        t = zs["stint"][stat]
        el = t["elo"]
        meta[stat] = {"label": LABELS[stat], "split_half_r": t["split"]["r"], "split_half_r_ci": list(t["split"]["r_ci"]),
                      "descriptive": not (el is not None and ds._passes(el["gain_ci"]))}
        for x in stint.filter(pl.col("stat") == stat).iter_rows(named=True):
            record(x)[stat] = _rate(x["per100_rounds"], x["per100_rounds_p5"], x["per100_rounds_p95"])
    st = side_est.filter((pl.col("unit_type") == "stint") & (pl.col("rounds") >= 2 * MIN_SIDE_N))
    for stat in (s for s in g["published"] if s in SIDE_STATS):
        s = side[stat]["stint"]
        meta[stat] = {"label": LABELS[stat], "split_half_r": s["split"]["t_off"]["r"],
                      "split_half_r_ci": list(s["split"]["t_off"]["r_ci"]), "season_r": s["season"]["t_off"]["r"],
                      "season_r_ci": list(s["season"]["t_off"]["r_ci"]), "descriptive": True}
        for x in st.filter(pl.col("stat") == stat).iter_rows(named=True):
            record(x)[f"{stat}_{x['side']}"] = _rate(x["per100"], x["per100_p5"], x["per100_p95"])
    payload = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "min_rounds": min_rounds,
               "stats": meta, "source": SOURCE, "teams": sorted(records.values(), key=lambda x: -x["maps"])}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "tactics.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {len(records)} stints to {out_dir / 'tactics.json'}")
    return 0


def build(min_rounds: int = ds.MIN_TEAM_ROUNDS, resamples: int = tf.DEFAULT_RESAMPLES, publish: bool = False,
          rebuild: bool = False, device: str = "cpu") -> int:
    for path, cmd in ((TEAM_MAP_RESIDUALS, "cs2wp team-factor"), (TEAM_ROUNDS, "cs2wp team-stats")):
        if not path.exists():
            raise FileNotFoundError(f"{path} not found; run `{cmd}` first")
    residuals = pl.read_parquet(TEAM_MAP_RESIDUALS)
    rounds = pl.read_parquet(TEAM_ROUNDS)
    keys = set(rounds["key"].unique().to_list())
    refs = [ref for ref in catalog() if ref.key in keys]
    raw, raw_info = build_raw(refs, rebuild)
    r = tactics_rounds(raw, rounds)
    r, models = expectations(r, device)
    r.write_parquet(TACTICS_ROUNDS)
    info = {"raw": raw_info, "models": models}

    maps = stat_maps(per_team(r), residuals)
    zs, est = zero_sum_results(maps, min_rounds, resamples)
    contact_test = contact_round_test(r)
    side, side_est = side_results(r, residuals, resamples)
    g = gates(zs, side, contact_test)

    maps.write_parquet(TACTICS_MAPS)
    est.write_parquet(TACTICS_TEAMS)
    side_est.write_parquet(TACTICS_SIDE_RATINGS)
    lines = report_lines(r, info, maps, zs, side, contact_test, est, side_est, g, min_rounds)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "tactics.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {TACTICS_ROUNDS}, {TACTICS_MAPS}, {TACTICS_TEAMS}, {TACTICS_SIDE_RATINGS}")
    return export_public(est, side_est, zs, side, g, min_rounds) if publish else 0
