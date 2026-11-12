"""Shortest-path distance over a CS2 nav mesh from any world position to each bombsite."""

import heapq
import math
from dataclasses import dataclass, field

import numpy as np
import polars as pl
from awpy import NavMesh

# awpy-data ClientVersion (CS2 patch 1.41.9.1, 2026-10-20). Pinned so distances don't move when Valve edits a map.
NAV_RELEASE = 2000934
# Positions are cached on this grid (Hammer units); areas are tens to hundreds of units across.
LOOKUP_GRID = 16.0
# A player standing just off the mesh (a boost, a ledge) snaps to the nearest area centroid within this XY radius.
SNAP_RADIUS = 96.0
SITES = ("A", "B")


def dijkstra(sources: set[int], reverse_adj: dict[int, list[tuple[int, float]]]) -> dict[int, float]:
    """Distance from every area to the nearest source, walking edges backwards."""
    dist = {s: 0.0 for s in sources}
    heap = [(0.0, s) for s in sources]
    heapq.heapify(heap)
    while heap:
        d, a = heapq.heappop(heap)
        if d > dist.get(a, math.inf):
            continue
        for prev, w in reverse_adj.get(a, ()):
            nd = d + w
            if nd < dist.get(prev, math.inf):
                dist[prev] = nd
                heapq.heappush(heap, (nd, prev))
    return dist


@dataclass
class SiteDistance:
    """`plants` holds the finished-plant positions seen on this map, which define each site's target areas."""

    map_name: str
    plants: pl.DataFrame
    weight: str = "distance"
    nav: NavMesh = field(init=False)
    stats: dict[str, int] = field(default_factory=lambda: {"area": 0, "snapped": 0, "missed": 0})

    def __post_init__(self) -> None:
        self.nav = NavMesh(self.map_name, version=NAV_RELEASE)
        areas = self.nav.areas
        self._ids = areas["area_id"].to_numpy().astype(np.int64)
        self._xy = np.column_stack([areas["centroid_x"].to_numpy(), areas["centroid_y"].to_numpy()])
        centroid = {
            int(a): (x, y, z)
            for a, x, y, z in zip(self._ids, areas["centroid_x"], areas["centroid_y"], areas["centroid_z"])
        }
        reverse: dict[int, list[tuple[int, float]]] = {}
        for a in centroid:
            for b in self.nav.neighbors(a):
                w = 1.0 if self.weight == "hops" else math.dist(centroid[a], centroid.get(b, centroid[a]))
                reverse.setdefault(b, []).append((a, w))

        self.site_areas: dict[str, set[int]] = {}
        self.site_centroid: dict[str, tuple[float, float, float]] = {}
        self._dist: dict[str, dict[int, float]] = {}
        for site in SITES:
            pts = self.plants.filter(pl.col("bombsite") == site)
            if pts.is_empty():
                continue
            areas_hit = {self.nav.find_area((float(x), float(y), float(z))) for x, y, z in pts.select("x", "y", "z").iter_rows()}
            areas_hit.discard(None)
            if not areas_hit:
                continue
            self.site_areas[site] = areas_hit
            self.site_centroid[site] = tuple(float(pts[c].mean()) for c in ("x", "y", "z"))
            self._dist[site] = dijkstra(areas_hit, reverse)
        self._cache: dict[tuple[int, int, int], tuple[int | None, str]] = {}

    def area(self, x: float, y: float, z: float) -> int | None:
        key = (round(x / LOOKUP_GRID), round(y / LOOKUP_GRID), round(z / LOOKUP_GRID))
        if key not in self._cache:
            found = self.nav.find_area((float(x), float(y), float(z)))
            kind = "area"
            if found is None:
                d2 = ((self._xy - (x, y)) ** 2).sum(axis=1)
                i = int(d2.argmin())
                found = int(self._ids[i]) if d2[i] <= SNAP_RADIUS**2 else None
                kind = "snapped" if found is not None else "missed"
            self._cache[key] = (found, kind)
        found, kind = self._cache[key]
        self.stats[kind] += 1
        return found

    def distances(self, xs: np.ndarray, ys: np.ndarray, zs: np.ndarray) -> dict[str, np.ndarray]:
        """`graph_<site>` (nav path length, NaN off the mesh or without that site) and `euclid_<site>` per position."""
        n = len(xs)
        out: dict[str, np.ndarray] = {}
        if n == 0:
            for site in SITES:
                out[f"graph_{site}"] = np.empty(0, dtype=np.float64)
                out[f"euclid_{site}"] = np.empty(0, dtype=np.float64)
            return out

        keys = np.column_stack([
            np.rint(xs / LOOKUP_GRID).astype(np.int64),
            np.rint(ys / LOOKUP_GRID).astype(np.int64),
            np.rint(zs / LOOKUP_GRID).astype(np.int64),
        ])
        uniq_keys, first_idx, inv, counts = np.unique(
            keys, axis=0, return_index=True, return_inverse=True, return_counts=True
        )
        uniq_areas: list[int | None] = [None] * len(uniq_keys)
        for u, idx in enumerate(first_idx):
            key = (int(uniq_keys[u, 0]), int(uniq_keys[u, 1]), int(uniq_keys[u, 2]))
            if key not in self._cache:
                x, y, z = float(xs[idx]), float(ys[idx]), float(zs[idx])
                found = self.nav.find_area((x, y, z))
                kind = "area"
                if found is None:
                    d2 = ((self._xy - (x, y)) ** 2).sum(axis=1)
                    i = int(d2.argmin())
                    found = int(self._ids[i]) if d2[i] <= SNAP_RADIUS**2 else None
                    kind = "snapped" if found is not None else "missed"
                self._cache[key] = (found, kind)
            found, kind = self._cache[key]
            self.stats[kind] += int(counts[u])
            uniq_areas[u] = found

        for site in SITES:
            dist = self._dist.get(site)
            if dist is None:
                out[f"graph_{site}"] = np.full(n, math.nan, dtype=np.float64)
            else:
                uniq_dist = np.array(
                    [dist.get(a, math.nan) if a is not None else math.nan for a in uniq_areas],
                    dtype=np.float64,
                )
                out[f"graph_{site}"] = uniq_dist[inv]
            c = self.site_centroid.get(site)
            out[f"euclid_{site}"] = (
                np.sqrt((xs - c[0]) ** 2 + (ys - c[1]) ** 2 + (zs - c[2]) ** 2) if c else np.full(n, math.nan)
            )
        return out

    def coverage(self) -> float:
        total = sum(self.stats.values())
        return (self.stats["area"] + self.stats["snapped"]) / total if total else 1.0
