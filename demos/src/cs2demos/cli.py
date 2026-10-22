import argparse
import fcntl
import json
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import date, timedelta
from pathlib import Path

from .archive import extract, group_by_map
from .backlog import build_queue, is_done
from .hltv import ChallengeError, Hltv, PageBudgetExhausted, demo_path_from_html
from .identity import IdentityTable
from .liquipedia import LpMatch, load_event, load_lan_events, load_steam_ids, resolve_from_results, save_link
from .parse import PARSER_VERSION, parse_map
from .paths import AUTO_LOCK, LAN_SERIES, PARQUET, RAW_DEMOS, REPO_ROOT, STEAM_PLAYERS, UNRESOLVED_PLAYERS, WORK
from .store import R2, Manifest, map_key, object_prefix, write_tables

RAW_RETENTION_DAYS = 30
RAW_CAP_GB = 10
MIN_FREE_GB = 10
AUTO_MAX_PAGES = 60
TABLES = ("rounds", "players", "kills", "damages", "grenades", "flashes", "bomb", "ticks")
GB = 1024**3


class DiskLow(Exception):
    pass


def raw_archive(hltv_id: int) -> Path | None:
    found = [p for p in RAW_DEMOS.glob(f"{hltv_id}.*") if not p.name.endswith(".part")]
    return found[0] if found else None


def fetch_archive(hltv: Hltv, m: LpMatch) -> Path | None:
    demo_path = demo_path_from_html(hltv.match_page(m.hltv_id))
    if not demo_path:
        print(f"  no demo link on HLTV match {m.hltv_id}")
        return None
    RAW_DEMOS.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(RAW_DEMOS).free
    if free < MIN_FREE_GB * GB:
        raise DiskLow(f"only {free / GB:.1f} GB free, need {MIN_FREE_GB} GB to download")
    print(f"  downloading {demo_path}")
    return hltv.download(demo_path, RAW_DEMOS / str(m.hltv_id))


def resolve_link(hltv: Hltv, m: LpMatch) -> int | None:
    """Finds a series Liquipedia has no HLTV link for on HLTV's results for its day, then the days either side."""
    day = date.fromisoformat(m.date[:10])
    for offset in (0, -1, 1):
        hit = resolve_from_results(m, hltv.results_day((day + timedelta(days=offset)).isoformat()))
        if hit:
            save_link(m.match2id, hit, "hltv-results")
            return hit
    return None


def process_match(m: LpMatch, archive: Path, manifest: Manifest, identity: IdentityTable, r2: R2 | None) -> None:
    work = WORK / str(m.hltv_id)
    try:
        groups = group_by_map(extract(archive, work), m.maps)
        for lp_map in m.maps:
            key = map_key(m.hltv_id, lp_map.number)
            base = {"lp_match2id": m.match2id, "lp_pagename": m.pagename, "map": lp_map.demo_map,
                    "official": list(lp_map.scores), "parser_version": PARSER_VERSION}
            parts = groups.get(lp_map.number, [])
            if not parts:
                manifest.record(key, **base, status="quarantined", reason="no demo for this map")
                print(f"  m{lp_map.number} quarantined: no demo for this map")
                continue
            try:
                parsed = parse_map(parts, m, lp_map, identity)
            except Exception as e:
                traceback.print_exc()
                parsed = None
                failures = [f"parser error: {type(e).__name__}: {e}"]
            else:
                failures = parsed.failures
            if failures:
                manifest.record(key, **base, status="quarantined", reason="; ".join(failures))
                print(f"  m{lp_map.number} quarantined: {'; '.join(failures)}")
                continue

            prefix = object_prefix(PARSER_VERSION, m.pagename, m.hltv_id, lp_map.number, parsed.demo_map)
            local = PARQUET / prefix
            write_tables(parsed.tables, local)
            keys = []
            if r2:
                keys = r2.upload_dir(local, prefix)
                shutil.rmtree(local)
            manifest.record(key, **base, status="parsed", rounds=len(parsed.rounds), parts=len(parts),
                            notes=parsed.notes, prefix=prefix, keys=keys)
            print(f"  m{lp_map.number} {parsed.demo_map} parsed: {len(parsed.rounds)} rounds", *parsed.notes, sep="; ")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def run_matches(matches: list[LpMatch], hltv: Hltv, manifest: Manifest, identity: IdentityTable, r2: R2 | None) -> None:
    for m in matches:
        label = f"{m.opponents[0].name} vs {m.opponents[1].name}"
        if not m.maps:
            continue
        if not m.hltv_id:
            m.hltv_id = resolve_link(hltv, m)
            if not m.hltv_id:
                print(f"{label} ({m.match2id}): not found on HLTV results, skipped")
                continue
        if is_done(manifest, m):
            continue
        print(f"{label} ({m.hltv_id})")
        archive = raw_archive(m.hltv_id) or fetch_archive(hltv, m)
        if archive:
            process_match(m, archive, manifest, identity, r2)


def drive(matches: list[LpMatch], max_pages: int, manifest: Manifest, identity: IdentityTable,
          r2: R2 | None) -> tuple[int, int]:
    """Runs until done or a stop condition. Returns (exit code, HLTV requests used)."""
    code = 0
    hltv = Hltv(max_pages)
    try:
        with hltv:
            run_matches(matches, hltv, manifest, identity, r2)
    except ChallengeError as e:
        print(e)
        code = 2
    except (PageBudgetExhausted, DiskLow) as e:
        print(f"{e}; rerun later to continue")
    finally:
        identity.save(STEAM_PLAYERS, UNRESOLVED_PLAYERS)
        prune_raw(manifest, RAW_RETENTION_DAYS, RAW_CAP_GB)
    return code, hltv.pages_used


def prune_raw(manifest: Manifest, days: int, max_gb: float, raw_dir: Path = RAW_DEMOS) -> list[Path]:
    """Deletes parsed series older than `days`, then the oldest parsed ones until `raw/` fits in `max_gb`."""
    quarantined = {k.split("/")[0] for k, e in manifest.maps.items() if e["status"] != "parsed"}
    files = sorted((p for p in raw_dir.glob("*") if p.is_file()), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    cutoff = time.time() - days * 86400
    deleted = []
    for path in files:
        if path.name.split(".")[0] in quarantined or path.name.endswith(".part"):
            continue
        if path.stat().st_mtime < cutoff or total > max_gb * GB:
            print(f"deleting {path.name}")
            total -= path.stat().st_size
            path.unlink()
            deleted.append(path)
    return deleted


def cmd_login(args) -> int:
    with Hltv(max_pages=1) as hltv:
        hltv.login()
    print("Profile saved.")
    return 0


def _setup(args):
    matches = load_event(args.event)
    if not matches:
        print(f"No finished matches for {args.event} in data/raw/")
        return None
    if args.match:
        matches = [m for m in matches if m.hltv_id == args.match]
    r2 = None if args.no_upload else R2()
    return matches, Manifest(r2), IdentityTable.load(load_steam_ids(), STEAM_PLAYERS), r2


def cmd_run(args) -> int:
    setup = _setup(args)
    if not setup:
        return 1
    matches, manifest, identity, r2 = setup
    return drive(matches, args.max_pages, manifest, identity, r2)[0]


def cmd_reparse(args) -> int:
    setup = _setup(args)
    if not setup:
        return 1
    matches, manifest, identity, r2 = setup
    try:
        for m in matches:
            archive = m.hltv_id and raw_archive(m.hltv_id)
            if archive and (args.all or not is_done(manifest, m)):
                print(f"{m.opponents[0].name} vs {m.opponents[1].name} ({m.hltv_id})")
                process_match(m, archive, manifest, identity, r2)
    finally:
        identity.save(STEAM_PLAYERS, UNRESOLVED_PLAYERS)
    return 0


def cmd_prune(args) -> int:
    prune_raw(Manifest(None if args.no_upload else R2()), args.days, args.max_gb)
    return 0


def cmd_report(args) -> int:
    setup = _setup(args)
    if not setup:
        return 1
    matches, manifest, _, r2 = setup
    total = parsed = 0
    for m in matches:
        print(f"{m.opponents[0].name} vs {m.opponents[1].name} ({m.hltv_id})")
        for lp_map in m.maps:
            total += 1
            e = manifest.get(map_key(m.hltv_id, lp_map.number)) if m.hltv_id else None
            official = f"{lp_map.scores[0]}-{lp_map.scores[1]}"
            if not e:
                print(f"  m{lp_map.number} {lp_map.map_name:<9} {official:>6}  missing")
                continue
            ok = e["status"] == "parsed" and e["parser_version"] == PARSER_VERSION
            if ok and r2:
                present = {k.rsplit("/", 1)[1] for k in r2.list_keys(e["prefix"] + "/")}
                lacking = [t for t in TABLES if f"{t}.parquet" not in present]
                if lacking:
                    ok = False
                    e = {**e, "status": "incomplete", "reason": f"missing in R2: {lacking}"}
            parsed += ok
            detail = f"{e['rounds']} rounds" if ok else e.get("reason", "")
            print(f"  m{lp_map.number} {lp_map.map_name:<9} {official:>6}  {e['status']:<11} {detail}")
    print(f"\n{parsed}/{total} maps parsed at {PARSER_VERSION}")
    return 0 if parsed == total else 1


def refresh_lan_series() -> None:
    """Pulls recent tier-1 LAN rows from the latest nightly run; on failure the copy on disk is used."""
    try:
        run_id = subprocess.run(
            ["gh", "run", "list", "-w", "update-data.yml", "-b", "main", "-s", "success", "-L", "1",
             "--json", "databaseId", "-q", ".[0].databaseId"],
            cwd=REPO_ROOT, capture_output=True, text=True, check=True, timeout=60,
        ).stdout.strip()
        if not run_id:
            raise RuntimeError("no successful update-data run")
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["gh", "run", "download", run_id, "-n", "lan-series", "-D", tmp],
                           cwd=REPO_ROOT, capture_output=True, text=True, check=True, timeout=300)
            LAN_SERIES.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(Path(tmp) / "lan-series.json", LAN_SERIES)
        print(f"lan-series from run {run_id}")
    except (OSError, RuntimeError, subprocess.SubprocessError) as e:
        detail = getattr(e, "stderr", "") or e
        print(f"warning: couldn't refresh lan-series ({str(detail).strip()}); using what's on disk")


def notify(message: str) -> None:
    if sys.platform == "darwin":
        subprocess.run(["osascript", "-e", f"display notification {json.dumps(message)} with title \"cs2demos\""],
                       check=False)


def _event_counts(manifest: Manifest, matches: list[LpMatch]) -> dict[str, int]:
    counts = {"parsed": 0, "quarantined": 0, "missing": 0, "unlinked": 0}
    for m in matches:
        for lp_map in m.maps:
            e = manifest.get(map_key(m.hltv_id, lp_map.number)) if m.hltv_id else None
            if not m.hltv_id:
                counts["unlinked"] += 1
            elif e and e["status"] == "parsed" and e["parser_version"] == PARSER_VERSION:
                counts["parsed"] += 1
            elif e and e["status"] == "quarantined":
                counts["quarantined"] += 1
            else:
                counts["missing"] += 1
    return counts


def cmd_auto(args) -> int:
    AUTO_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with open(AUTO_LOCK, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("another cs2demos auto run is in progress")
            return 1
        refresh_lan_series()
        r2 = None if args.no_upload else R2()
        manifest = Manifest(r2)
        queue = build_queue(load_lan_events(), manifest)
        pending = sum(not is_done(manifest, m) for e in queue for m in e.matches)
        print(f"{len(queue)} events, {pending} series pending; budget {args.max_pages} HLTV requests")
        if args.dry_run:
            for e in queue:
                left = sum(not is_done(manifest, m) for m in e.matches)
                print(f"  {e.start}..{e.end} {e.page:<50} {left}/{len(e.matches)} series pending")
            return 0

        before = {k: e.get("updated") for k, e in manifest.maps.items()}
        identity = IdentityTable.load(load_steam_ids(), STEAM_PLAYERS)
        code, used = drive([m for e in queue for m in e.matches], args.max_pages, manifest, identity, r2)
        changed = [e["status"] for k, e in manifest.maps.items() if before.get(k) != e.get("updated")]
        left = sum(not is_done(manifest, m) for e in queue for m in e.matches)
        print(f"\n{changed.count('parsed')} maps parsed, {changed.count('quarantined')} quarantined, "
              f"{used} HLTV requests, {left} series left")
        if code == 2:
            notify("HLTV challenge: run `uv run cs2demos login` in demos/")
        return code


def cmd_status(args) -> int:
    manifest = Manifest(None)
    totals = {"parsed": 0, "quarantined": 0, "missing": 0, "unlinked": 0}
    for e in build_queue(load_lan_events(), manifest, include_done=True):
        c = _event_counts(manifest, e.matches)
        totals = {k: totals[k] + c[k] for k in totals}
        maps = sum(c.values())
        extra = "".join(f", {c[k]} {k}" for k in ("quarantined", "unlinked") if c[k])
        print(f"{e.start}..{e.end} {e.page:<50} {c['parsed']:>4}/{maps:<4} parsed{extra}")
    print(f"\n{totals['parsed']}/{sum(totals.values())} maps parsed at {PARSER_VERSION}; "
          f"{totals['quarantined']} quarantined, {totals['unlinked']} without an HLTV link")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(prog="cs2demos")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login", help="Open HLTV in the saved browser profile to clear Cloudflare by hand")
    for name, help_ in (("run", "Download, parse, validate and store an event's demos"),
                        ("reparse", "Re-run parse/validate/store from raw demos on disk"),
                        ("report", "Per-map status for an event; exits 0 only if every map is parsed")):
        p = sub.add_parser(name, help=help_)
        p.add_argument("--event", required=True, help="Liquipedia tournament page, e.g. Thunderpick/World_Championship/2026")
        p.add_argument("--match", type=int, help="Only this HLTV match id")
        p.add_argument("--no-upload", action="store_true", help="Keep Parquet locally in data/demos/parquet/")
        if name == "run":
            p.add_argument("--max-pages", type=int, default=30, help="HLTV requests allowed this run")
        if name == "reparse":
            p.add_argument("--all", action="store_true", help="Also re-run maps already parsed at this version")
    p = sub.add_parser("auto", help="Scheduled run: new tier-1 LANs first, then the backfill, within a request budget")
    p.add_argument("--max-pages", type=int, default=AUTO_MAX_PAGES, help="HLTV requests allowed this run")
    p.add_argument("--dry-run", action="store_true", help="Print the queue without opening a browser")
    p.add_argument("--no-upload", action="store_true", help="Keep Parquet locally in data/demos/parquet/")
    sub.add_parser("status", help="Per-event map counts for every tier-1 LAN since 2025, from the local manifest")
    p = sub.add_parser("prune", help="Delete parsed raw demos older than --days or beyond --max-gb, oldest first")
    p.add_argument("--days", type=int, default=RAW_RETENTION_DAYS)
    p.add_argument("--max-gb", type=float, default=RAW_CAP_GB)
    p.add_argument("--no-upload", action="store_true", help="Use the local manifest only")

    args = ap.parse_args()
    handlers = {"login": cmd_login, "run": cmd_run, "reparse": cmd_reparse, "prune": cmd_prune,
                "report": cmd_report, "auto": cmd_auto, "status": cmd_status}
    sys.exit(handlers[args.cmd](args))
