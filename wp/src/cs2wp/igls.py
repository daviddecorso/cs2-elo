"""Per-map IGL tags from date-bounded team stints, cross-checked against local Liquipedia data (Phase 6, item 6)."""

import json
from pathlib import Path

import polars as pl

from .paths import IGL_TABLE, IGLS, RAW_PLAYERS, RAW_SQUADS, ROLE_ROUNDS, WAR_REPORTS
from .states import CT, T


class UnmappedTeams(Exception):
    def __init__(self, missing: dict[str, int], hints: dict[str, list[str]] | None = None):
        self.missing = missing
        hints = hints or {}
        lines = [
            f"{team} ({maps} maps)" + (f" — candidates: {', '.join(hints[team])}" if hints.get(team) else "")
            for team, maps in sorted(missing.items(), key=lambda x: -x[1])
        ]
        super().__init__(f"teams missing from {IGL_TABLE.name}:\n" + "\n".join(lines))


class AmbiguousIGL(Exception):
    def __init__(self, rows: list[dict]):
        self.rows = rows
        lines = [f"{r['key']} ({r['date']}) {r['lp_team']}: {', '.join(sorted(r['igls']))}" for r in rows]
        super().__init__(f"multiple active IGLs matched on a team-map in {IGL_TABLE.name}:\n" + "\n".join(lines))


def load_table(path: Path = IGL_TABLE) -> dict[str, list[dict]]:
    table = json.loads(path.read_text())
    for team, stints in table.items():
        if not isinstance(stints, list):
            raise ValueError(f"{team}: stints must be a list")
        for s in stints:
            if not s.get("player"):
                raise ValueError(f"{team}: stint missing 'player'")
            if s.get("from") and s.get("to") and s["from"] > s["to"]:
                raise ValueError(f"{team} ({s['player']}): 'from' {s['from']} is after 'to' {s['to']}")
    return table


def _stints_frame(table: dict[str, list[dict]]) -> pl.DataFrame:
    rows = [
        {"lp_team": team, "lp_player": s["player"], "from": s.get("from") or "0000-01-01",
         "to": s.get("to") or "9999-12-31"}
        for team, stints in table.items() for s in stints
    ]
    if not rows:
        return pl.DataFrame(schema={"lp_team": pl.String, "lp_player": pl.String, "from": pl.String, "to": pl.String})
    return pl.DataFrame(rows)


def local_liquipedia_signals(squads_path: Path = RAW_SQUADS, players_path: Path = RAW_PLAYERS) -> tuple[set[tuple[str, str]], set[str]]:
    """Reads `data/raw/` without API calls; returns empty sets if the gitignored raw store is absent."""
    captains: set[tuple[str, str]] = set()
    if squads_path.exists():
        rows = json.loads(squads_path.read_text()).get("rows", [])
        captains = {(r["pagename"].replace("_", " "), r["link"]) for r in rows if r.get("role") == "Captain"}
    player_igls: set[str] = set()
    if players_path.exists():
        for p in json.loads(players_path.read_text()):
            ed = p.get("extradata")
            roles = list((ed.get("roles") or {}).values()) if isinstance(ed, dict) and isinstance(ed.get("roles"), dict) else []
            if any(str(v).lower() == "igl" for v in roles):
                player_igls.add(p["pagename"])
    return captains, player_igls


def _candidate_hints(role_rounds: pl.DataFrame, captains: set[tuple[str, str]], player_igls: set[str]) -> dict[str, list[str]]:
    tm = role_rounds.select("lp_team", "lp_player").drop_nulls().unique()
    out: dict[str, list[str]] = {}
    for (team,), g in tm.group_by("lp_team"):
        cands = [p for p in sorted(g["lp_player"].to_list()) if (team, p) in captains or p in player_igls]
        if cands:
            out[team] = cands
    return out


def assign_igls(
    role_rounds: pl.DataFrame,
    table: dict[str, list[dict]],
    captains: set[tuple[str, str]] | None = None,
    player_igls: set[str] | None = None,
) -> pl.DataFrame:
    """One row per player-map (`key`, `steamid`) with `is_igl`, failing on unknown teams or multi-IGL collisions."""
    pm = role_rounds.select("key", "date", "lp_team", "lp_player", "steamid").unique().sort("key", "lp_team", "steamid")
    unknown = pm.filter(pl.col("lp_team").is_not_null() & ~pl.col("lp_team").is_in(list(table)))
    if unknown.height:
        counts = unknown.group_by("lp_team").agg(pl.col("key").n_unique().alias("maps"))
        hints = _candidate_hints(unknown, captains or set(), player_igls or set())
        raise UnmappedTeams(dict(counts.iter_rows()), hints)

    stints = _stints_frame(table)
    matched = (
        pm.filter(pl.col("lp_player").is_not_null())
        .join(stints, on=["lp_team", "lp_player"], how="inner")
        .filter((pl.col("date") >= pl.col("from")) & (pl.col("date") <= pl.col("to")))
        .select("key", "steamid")
        .unique()
        .with_columns(pl.lit(True).alias("is_igl"))
    )
    out = pm.join(matched, on=["key", "steamid"], how="left").with_columns(pl.col("is_igl").fill_null(False))
    collisions = (
        out.filter(pl.col("is_igl"))
        .group_by("key", "date", "lp_team")
        .agg(pl.len().alias("n"), pl.col("lp_player").alias("igls"))
        .filter(pl.col("n") > 1)
        .sort("date", "key", "lp_team")
    )
    if collisions.height:
        raise AmbiguousIGL(collisions.to_dicts())
    return out


def report(role_rounds: pl.DataFrame, igls: pl.DataFrame, captains: set[tuple[str, str]], player_igls: set[str]) -> list[str]:
    tm = igls.group_by("key", "date", "lp_team").agg(pl.col("is_igl").sum().alias("n_igl"))
    tagged = tm.filter(pl.col("n_igl") == 1).height
    standin_gaps = (
        tm.filter(pl.col("n_igl") == 0)
        .group_by("lp_team")
        .agg(pl.len().alias("maps"), pl.col("date").min().alias("from"), pl.col("date").max().alias("to"))
        .sort("maps", descending=True)
    )

    rr = role_rounds.join(igls.select("key", "steamid", "is_igl"), on=["key", "steamid"], how="left").with_columns(
        pl.col("is_igl").fill_null(False)
    )
    lines = [
        "# IGL tags",
        "",
        f"{tagged:,} of {tm.height:,} team-maps ({tagged / tm.height:.1%}) have an active IGL from `{IGL_TABLE.name}` "
        f"across {igls['lp_team'].n_unique()} teams.",
    ]

    if captains or player_igls:
        pm = igls.with_columns(
            pl.struct("lp_team", "lp_player")
            .map_elements(lambda s: (s["lp_team"], s["lp_player"]) in captains, return_dtype=pl.Boolean)
            .alias("cap"),
            pl.col("lp_player").is_in(list(player_igls)).fill_null(False).alias("p_igl"),
        )
        cap_tm = pm.group_by("key", "lp_team").agg(pl.col("cap").sum().alias("n"))
        pigl_tm = pm.group_by("key", "lp_team").agg(pl.col("p_igl").sum().alias("n"))
        cap_one = cap_tm.filter(pl.col("n") == 1).height
        pigl_one = pigl_tm.filter(pl.col("n") == 1).height
        pigl_multi = pigl_tm.filter(pl.col("n") > 1).height
        agree_cap = pm.filter(pl.col("cap") & pl.col("is_igl")).height
        lines += [
            "",
            "Liquipedia raw-store comparison (no API calls):",
            "",
            f"- `squads.json` (`role == 'Captain'`): {cap_one:,}/{tm.height:,} ({cap_one / tm.height:.1%}) team-maps "
            f"have one Captain; {agree_cap:,} of {pm.filter(pl.col('cap')).height:,} Captain player-maps match the stint IGL "
            "(disagreements are mid-year caller swaps).",
            f"- `players.json` (`extradata.roles` includes `igl`): {pigl_one:,}/{tm.height:,} ({pigl_one / tm.height:.1%}) "
            f"team-maps have one IGL, and {pigl_multi:,} have 2+ career IGLs sharing a lineup.",
        ]

    lines += ["", "## Raw credit above role baseline before IGL adjustment", "",
              "| Side | Group | Rounds | WPA / 100 | Neutral (man-count) / 100 | Neutral (event) / 100 |",
              "| --- | --- | --- | --- | --- | --- |"]
    for side_label, filt in (("All", pl.lit(True)), ("CT", pl.col("side") == CT), ("T", pl.col("side") == T)):
        for is_igl, grp in ((True, "IGL"), (False, "Non-IGL")):
            sub = rr.filter(filt & (pl.col("is_igl") == is_igl))
            rds = sub["rounds"].sum()
            vals = [100 * sub[f"{v}_above"].sum() / rds for v in ("wpa", "nwpa_mancount", "nwpa_event")]
            lines.append(f"| {side_label} | {grp} | {rds:,} | {vals[0]:+.2f} | {vals[1]:+.2f} | {vals[2]:+.2f} |")

    if standin_gaps.height:
        lines += ["", "## Team-maps without an active stint IGL (stand-in series)", "",
                  "| Team | Maps | Dates |", "| --- | --- | --- |"]
        for r in standin_gaps.iter_rows(named=True):
            span = r["from"] if r["from"] == r["to"] else f"{r['from']}..{r['to']}"
            lines.append(f"| {r['lp_team']} | {r['maps']} | {span} |")
    return lines


def build() -> int:
    rr = pl.read_parquet(ROLE_ROUNDS)
    captains, player_igls = local_liquipedia_signals()
    igls = assign_igls(rr, load_table(), captains, player_igls)
    IGLS.parent.mkdir(parents=True, exist_ok=True)
    igls.write_parquet(IGLS)
    lines = report(rr, igls, captains, player_igls)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "igls.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {IGLS} ({igls.height:,} player-maps)")
    return 0
