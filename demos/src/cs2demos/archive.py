"""Unpack an HLTV series archive and pair each .dem with its map number."""

import re
import shutil
import subprocess
from pathlib import Path

from .liquipedia import LpMap

MAP_NUMBER = re.compile(r"[-_]m(\d+)[-_]", re.IGNORECASE)
PART_NUMBER = re.compile(r"[-_]p(\d+)\.dem$", re.IGNORECASE)


def extract(archive: Path, work_dir: Path) -> list[Path]:
    """Into a fresh, empty directory; anything resolving outside it is rejected."""
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True)
    # Homebrew's 7zz ships without the RAR codec, and HLTV serves RAR5.
    if archive.suffix.lower() == ".rar":
        cmd = ["unar", "-q", "-f", "-D", "-o", str(work_dir), str(archive)]
    else:
        cmd = ["7zz", "x", "-y", "-bso0", "-bsp0", f"-o{work_dir}", str(archive)]
    subprocess.run(cmd, check=True)
    root = work_dir.resolve()
    dems = [p for p in work_dir.rglob("*") if p.suffix.lower() == ".dem"]
    for p in dems:
        if not p.resolve().is_relative_to(root) or p.is_symlink():
            raise ValueError(f"archive entry escapes the work dir: {p}")
    return sorted(dems)


def group_by_map(dems: list[Path], lp_maps: list[LpMap]) -> dict[int, list[Path]]:
    """Map number → demo parts in order. Falls back to the map name when the filename has no -mN-."""
    out: dict[int, list[Path]] = {}
    for p in dems:
        if m := MAP_NUMBER.search(p.name):
            out.setdefault(int(m.group(1)), []).append(p)
            continue
        named = [lp.number for lp in lp_maps if lp.demo_map.removeprefix("de_") in p.name.lower()]
        if len(named) == 1:
            out.setdefault(named[0], []).append(p)
    if not out and len(dems) == 1 and len(lp_maps) == 1:
        out[lp_maps[0].number] = dems

    def part(p: Path) -> int:
        m = PART_NUMBER.search(p.name)
        return int(m.group(1)) if m else 0

    return {n: sorted(paths, key=part) for n, paths in out.items()}
