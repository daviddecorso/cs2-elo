"""CS2 radar metadata and world-to-radar coordinate transforms, pinned to awpy's NAV_RELEASE."""

import json
from pathlib import Path

import awpy.data as awpy_data
import numpy as np
from PIL import Image

from .nav import NAV_RELEASE
from .paths import PUBLIC_RADAR, RADAR_META

RADAR_SIZE = 1024
ACTIVE_POOL = (
    "de_ancient",
    "de_anubis",
    "de_cache",
    "de_dust2",
    "de_inferno",
    "de_mirage",
    "de_nuke",
    "de_overpass",
    "de_train",
    "de_vertigo",
)


def canonical_map(map_name: str) -> str:
    return map_name if map_name.startswith("de_") else f"de_{map_name}"


def map_slug(map_name: str) -> str:
    return map_name.removeprefix("de_")


def _extract_entry(raw: dict) -> dict:
    entry: dict[str, float] = {
        "pos_x": float(raw["pos_x"]),
        "pos_y": float(raw["pos_y"]),
        "scale": float(raw["scale"]),
    }
    lower = (raw.get("verticalsections") or {}).get("lower")
    if lower is not None:
        entry["lower_min"] = float(lower["AltitudeMin"])
        entry["lower_max"] = float(lower["AltitudeMax"])
    return entry


def ensure_awpy_data(version: int = NAV_RELEASE, *, need_images: bool = False) -> None:
    """Ensure awpy's pinned release metadata (and radar PNGs when requested) are cached locally."""
    release_dir = awpy_data.AWPY_DATA_DIR / str(version)
    missing_meta = not (release_dir / "map_data.json").exists()
    missing_radars = need_images and not (release_dir / ".images.zip.done").exists()
    if missing_meta or missing_radars:
        awpy_data.update(version)


def load_awpy_map_data(version: int = NAV_RELEASE, maps: tuple[str, ...] = ACTIVE_POOL) -> dict[str, dict]:
    """Load `pos_x`, `pos_y`, `scale` and lower-level z bounds from awpy for `maps`."""
    ensure_awpy_data(version)
    raw = awpy_data.map_data(version)
    return {m: _extract_entry(raw[m]) for m in maps if m in raw}


def load_radar_meta(path: Path = RADAR_META) -> dict[str, dict]:
    """Load committed `data/war/radar.json` if present, otherwise fall back to awpy's pinned map_data."""
    if path.exists():
        return json.loads(path.read_text())["maps"]
    return load_awpy_map_data(NAV_RELEASE)


def has_lower_level(map_name: str, meta: dict[str, dict] | None = None) -> bool:
    table = meta if meta is not None else load_radar_meta()
    entry = table.get(canonical_map(map_name))
    return bool(entry and "lower_max" in entry)


def levels_for(map_name: str, meta: dict[str, dict] | None = None) -> list[str]:
    return ["upper", "lower"] if has_lower_level(map_name, meta) else ["upper"]


def world_to_radar(
    map_name: str,
    x: float,
    y: float,
    z: float | None = None,
    meta: dict[str, dict] | None = None,
) -> tuple[float, float, str]:
    """World (x, y, z) -> (px, py, level) on the 1024 px radar, matching awpy.plot.world_to_pixel."""
    table = meta if meta is not None else load_radar_meta()
    entry = table[canonical_map(map_name)]
    px = (float(x) - entry["pos_x"]) / entry["scale"]
    py = (entry["pos_y"] - float(y)) / entry["scale"]
    is_lower = (
        z is not None
        and "lower_max" in entry
        and entry["lower_min"] <= float(z) < entry["lower_max"]
    )
    return px, py, ("lower" if is_lower else "upper")


def world_to_radar_arrays(
    map_name: str,
    xs: np.ndarray,
    ys: np.ndarray,
    zs: np.ndarray | None = None,
    meta: dict[str, dict] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Vectorized world_to_radar returning (px, py, is_lower_bool)."""
    table = meta if meta is not None else load_radar_meta()
    entry = table[canonical_map(map_name)]
    px = (xs - entry["pos_x"]) / entry["scale"]
    py = (entry["pos_y"] - ys) / entry["scale"]
    if zs is not None and "lower_max" in entry:
        is_lower = (zs >= entry["lower_min"]) & (zs < entry["lower_max"])
    else:
        is_lower = np.zeros(len(xs), dtype=bool)
    return px, py, is_lower


def build_radars(
    maps: tuple[str, ...] = ACTIVE_POOL,
    out_dir: Path = PUBLIC_RADAR,
    meta_path: Path = RADAR_META,
    version: int = NAV_RELEASE,
) -> int:
    """Write committed `data/war/radar.json` and 1024 px WebP radars under `public/radar/`."""
    ensure_awpy_data(version, need_images=True)
    meta = load_awpy_map_data(version, maps)
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(
        json.dumps({"release": version, "size": RADAR_SIZE, "maps": meta}, indent=2) + "\n"
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    written: list[tuple[Path, int]] = []
    for map_name, entry in meta.items():
        slug = map_slug(map_name)
        variants = [(False, f"{slug}.webp")]
        if "lower_max" in entry:
            variants.append((True, f"{slug}_lower.webp"))
        for lower, filename in variants:
            src = awpy_data.radar_path(map_name, version, lower=lower)
            dest = out_dir / filename
            with Image.open(src) as img:
                if img.size != (RADAR_SIZE, RADAR_SIZE):
                    img = img.resize((RADAR_SIZE, RADAR_SIZE), Image.Resampling.LANCZOS)
                img.save(dest, format="WEBP", quality=85, method=6)
            written.append((dest, dest.stat().st_size))

    total = sum(sz for _, sz in written)
    print(f"wrote {meta_path} ({len(meta)} maps)")
    print(f"wrote {len(written)} radar webps to {out_dir} ({total / 1024:.1f} KB total)")
    return 0
