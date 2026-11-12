"""Patch candidates from CS2's Steam announcements, for hand approval into wp/patches.json."""

import json
import re
import urllib.request
from datetime import UTC, date, datetime, timedelta

from .paths import PATCH_CANDIDATES

NEWS = ("https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=100&maxlength=0"
        "&feeds=steam_community_announcements")
# Checked against changelog lines, first match wins.
TYPES = {
    "economy": r"economy|money|loss bonus|kill reward|team award|\bprices?\b|\$\d",
    "map_pool": r"map pool",
    "mechanics": r"\bbomb\b|\bc4\b|defus|reload",
}
# A matching line about items, tooling, audio, UI or non-competitive modes rather than competitive gameplay.
COSMETIC = (r"trade.?up|\bskins?\b|\bcases?\b|sticker|charm|\bmarket|armory|collection|music kit|graffiti|\bpins?\b|"
            r"souvenir|\busd\b|workshop|script|instance\.|csplanted|csplayer|tools mode|community map|retakes|"
            r"defusal group|sound|animation|viewmodel|view model|wobbl|flicker|icon|radar|scoreboard|container|"
            r"x-ray|knives|knife|\bapi\b|gamerules|\bc4\.|\bmethod\b")
PRIORITY = ["economy", "map_pool", "mechanics"]


def _lines(contents: str) -> list[str]:
    text = re.sub(r"\[/?[a-z0-9*]+(=[^\]]*)?\]", "\n", contents, flags=re.IGNORECASE)
    return [ln.strip(" -*\t") for ln in text.splitlines() if ln.strip(" -*\t")]


def classify(contents: str) -> tuple[str | None, list[dict]]:
    """(type, evidence) for one announcement; type None when no line mentions a gameplay keyword."""
    evidence = []
    for line in _lines(contents):
        low = line.lower()
        for kind, pattern in TYPES.items():
            if re.search(pattern, low):
                evidence.append({"type": "cosmetic" if re.search(COSMETIC, low) else kind, "line": line[:300]})
                break
    if not evidence:
        return None, []
    kinds = {e["type"] for e in evidence}
    return next((k for k in PRIORITY if k in kinds), "cosmetic"), evidence


def _fetch(since: str) -> list[dict]:
    items, end = [], None
    while True:
        url = NEWS + (f"&enddate={end}" if end else "")
        with urllib.request.urlopen(url, timeout=30) as r:
            page = json.load(r)["appnews"]["newsitems"]
        page = [n for n in page if end is None or n["date"] < end]
        if not page:
            return items
        items += page
        end = min(n["date"] for n in page)
        if datetime.fromtimestamp(end, UTC).date().isoformat() < since:
            return items


WINDOW_DAYS = 30


def _mechanics(use_candidates: bool) -> list[dict]:
    """Approved mechanics patches from wp/patches.json, or with `use_candidates`, every candidate that touches mechanics."""
    from .paths import PATCHES

    if use_candidates:
        rows = json.loads(PATCH_CANDIDATES.read_text())["candidates"]
        rows = [{"date": c["date"], "name": c["title"]} for c in rows if "mechanics" in c["types"]]
    else:
        rows = json.loads(PATCHES.read_text())["patches"] if PATCHES.exists() else []
        rows = [p for p in rows if p.get("type") == "mechanics"]
    return list({r["date"]: r for r in rows}.values())


def postplant_report(model: str, use_candidates: bool = False) -> int:
    """Post-plant calibration in the WINDOW_DAYS before and after each mechanics patch. Each map is valued by its own
    month's out-of-sample model (book.py); 2025 cross-fit models saw later months, so pre-2026 rows are a weaker check."""
    import polars as pl

    from .book import ModelBook
    from .data import catalog
    from .features import with_derived
    from .paths import REPORTS, STATES

    book, refs = ModelBook(model), catalog()
    rows = []
    for patch in sorted(_mechanics(use_candidates), key=lambda p: p["date"]):
        d0 = date.fromisoformat(patch["date"])
        entry = {**patch}
        for label, lo, hi in (("before", d0 - timedelta(days=WINDOW_DAYS), d0), ("after", d0, d0 + timedelta(days=WINDOW_DAYS))):
            frames = []
            for ref in refs:
                if not (lo.isoformat() <= ref.date < hi.isoformat()):
                    continue
                e, path = book.entry(ref.date[:7]), STATES / ref.slug / "grid.parquet"
                if e is None or not path.exists():
                    continue
                g = with_derived(pl.read_parquet(path)).filter(pl.col("bomb_planted") == 1)
                if g.height:
                    frames.append(g.select("key", "round_num", "since_plant", "ct_win").with_columns(
                        pl.Series("p", book.predict(e, g))))
            if not frames:
                entry[label] = None
                continue
            d = pl.concat(frames)
            early = 40 - pl.col("since_plant") >= 20

            def stat(f: pl.DataFrame) -> dict:
                pred, obs = float(f["p"].mean()), float(f["ct_win"].cast(pl.Float64).mean())
                return {"rounds": f.select(pl.struct("key", "round_num").n_unique()).item(), "pred": pred, "obs": obs,
                        "gap": pred - obs}

            entry[label] = {"all": stat(d), "early": stat(d.filter(early)), "late": stat(d.filter(~early))}
        rows.append(entry)
        parts = []
        for label in ("before", "after"):
            s = entry[label]
            parts.append(f"{label} " + ("no maps" if s is None else
                         f"gap {s['all']['gap']:+.3f} (early {s['early']['gap']:+.3f}, late {s['late']['gap']:+.3f}; "
                         f"{s['all']['rounds']} rounds)"))
        print(f"{patch['date']} {patch['name'][:40]:<40} " + " | ".join(parts))
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / "patch_postplant.json").write_text(json.dumps(rows, indent=2))
    return 0


def candidates(since: str = "2025-01-01") -> int:
    out = []
    for n in _fetch(since):
        day = datetime.fromtimestamp(n["date"], UTC).date().isoformat()
        if day < since:
            continue
        kind, evidence = classify(n["contents"])
        if kind is None:
            continue
        types = [k for k in [*PRIORITY, "cosmetic"] if any(e["type"] == k for e in evidence)]
        out.append({"date": day, "title": n["title"], "url": n["url"], "type": kind, "types": types,
                    "evidence": sorted(evidence, key=lambda e: types.index(e["type"]))})
    out.sort(key=lambda c: c["date"])
    PATCH_CANDIDATES.write_text(json.dumps({"fetched": date.today().isoformat(), "since": since, "candidates": out},
                                           indent=2, ensure_ascii=False) + "\n")
    counts = {k: sum(c["type"] == k for c in out) for k in [*PRIORITY, "cosmetic"]}
    print(f"{len(out)} candidates since {since} in {PATCH_CANDIDATES}: {counts}")
    for c in out:
        if c["type"] != "cosmetic":
            print(f"  {c['date']} {c['type']:<9} {c['title']}: {c['evidence'][0]['line'][:100]}")
    return 0
