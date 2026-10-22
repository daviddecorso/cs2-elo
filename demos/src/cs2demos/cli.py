import argparse
import shutil
import sys
import time
import traceback
from pathlib import Path

from .archive import extract, group_by_map
from .hltv import ChallengeError, Hltv, PageBudgetExhausted, demo_path_from_html
from .identity import IdentityTable
from .liquipedia import LpMatch, load_event, load_steam_ids
from .parse import PARSER_VERSION, parse_map
from .paths import PARQUET, RAW_DEMOS, STEAM_PLAYERS, UNRESOLVED_PLAYERS, WORK
from .store import R2, Manifest, map_key, object_prefix, write_tables

RAW_RETENTION_DAYS = 30
TABLES = ("rounds", "players", "kills", "damages", "grenades", "flashes", "bomb", "ticks")


def raw_archive(hltv_id: int) -> Path | None:
    found = [p for p in RAW_DEMOS.glob(f"{hltv_id}.*") if not p.name.endswith(".part")]
    return found[0] if found else None


def is_done(manifest: Manifest, m: LpMatch) -> bool:
    entries = [manifest.get(map_key(m.hltv_id, lp.number)) for lp in m.maps]
    return all(e and e["status"] == "parsed" and e["parser_version"] == PARSER_VERSION for e in entries)


def fetch_archive(hltv: Hltv, m: LpMatch) -> Path | None:
    demo_path = demo_path_from_html(hltv.match_page(m.hltv_id))
    if not demo_path:
        print(f"  no demo link on HLTV match {m.hltv_id}")
        return None
    print(f"  downloading {demo_path}")
    return hltv.download(demo_path, RAW_DEMOS / str(m.hltv_id))


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
    code = 0
    try:
        with Hltv(args.max_pages) as hltv:
            for m in matches:
                label = f"{m.opponents[0].name} vs {m.opponents[1].name} ({m.hltv_id})"
                if not m.hltv_id:
                    print(f"{m.match2id}: no HLTV link on Liquipedia, skipped")
                    continue
                if is_done(manifest, m):
                    continue
                print(label)
                archive = raw_archive(m.hltv_id) or fetch_archive(hltv, m)
                if archive:
                    process_match(m, archive, manifest, identity, r2)
    except ChallengeError as e:
        print(e)
        code = 2
    except PageBudgetExhausted as e:
        print(f"{e}; rerun later to continue")
    finally:
        identity.save(STEAM_PLAYERS, UNRESOLVED_PLAYERS)
    return code


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
    manifest = Manifest(None if args.no_upload else R2())
    cutoff = time.time() - args.days * 86400
    for path in RAW_DEMOS.glob("*"):
        hltv_id = path.name.split(".")[0]
        quarantined = any(k.startswith(f"{hltv_id}/") and e["status"] != "parsed" for k, e in manifest.maps.items())
        if path.stat().st_mtime < cutoff and not quarantined:
            print(f"deleting {path.name}")
            path.unlink()
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
    p = sub.add_parser("prune", help=f"Delete raw demos older than --days (default {RAW_RETENTION_DAYS}) unless quarantined")
    p.add_argument("--days", type=int, default=RAW_RETENTION_DAYS)
    p.add_argument("--no-upload", action="store_true", help="Use the local manifest only")

    args = ap.parse_args()
    handlers = {"login": cmd_login, "run": cmd_run, "reparse": cmd_reparse, "prune": cmd_prune, "report": cmd_report}
    sys.exit(handlers[args.cmd](args))
