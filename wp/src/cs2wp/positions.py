"""CT positions per map played: each player's most common position 15-25 s into their CT rounds (Phase 6, item 1)."""

import json
from collections import Counter
from pathlib import Path

import polars as pl

from .data import MapRef, catalog
from .paths import CT_POSITION_TABLE, CT_POSITIONS, WAR_REPORTS
from .states import CT, TICK_RATE

# Seconds after freeze end; by then CTs have reached their setup and haven't rotated yet.
WINDOW = (15, 25)
# Below this median share on a map, the table probably merges or splits positions wrongly.
MIN_MEDIAN_SHARE = 0.6
MIN_STABILITY_MAPS = 5


class UnmappedCallouts(Exception):
    def __init__(self, missing: dict[str, dict[str, int]]):
        self.missing = missing
        lines = [f"{m}: " + ", ".join(f"{c} ({n} samples)" for c, n in sorted(cs.items(), key=lambda x: -x[1]))
                 for m, cs in sorted(missing.items())]
        super().__init__(f"callouts missing from {CT_POSITION_TABLE.name}:\n" + "\n".join(lines))


def load_table(path: Path = CT_POSITION_TABLE) -> dict[str, dict]:
    table = json.loads(path.read_text())
    for m, entry in table.items():
        bad = {p for p in entry["callouts"].values() if p is not None} - set(entry["positions"])
        if bad:
            raise ValueError(f"{m}: callouts point at unknown positions {sorted(bad)}")
    return table


def window_samples(rounds: pl.DataFrame, ticks: pl.DataFrame) -> pl.DataFrame:
    """Alive CT samples inside the window: round_num, steamid, callout, x, y, z."""
    start = pl.col("freeze_end_tick").fill_null(pl.col("start_tick"))
    return (
        ticks.filter((pl.col("side") == CT) & (pl.col("health") > 0) & (pl.col("steamid") > 0))
        .join(rounds.select("round_num", "start_tick", "freeze_end_tick"), on="round_num")
        .filter(pl.col("tick").is_between(start + WINDOW[0] * TICK_RATE, start + WINDOW[1] * TICK_RATE))
        .select("round_num", "steamid", pl.col("last_place_name").alias("callout"), "x", "y", "z")
    )


def ct_rounds(ticks: pl.DataFrame) -> pl.DataFrame:
    """Rounds each player started on CT, alive or not at the window."""
    return (ticks.filter((pl.col("side") == CT) & (pl.col("steamid") > 0))
            .group_by("steamid").agg(pl.col("round_num").n_unique().alias("rounds_ct")))


def unmapped(samples: pl.DataFrame, callouts: dict[str, str | None]) -> dict[str, int]:
    named = samples.filter(pl.col("callout").is_not_null() & (pl.col("callout") != ""))
    counts = named.filter(~pl.col("callout").is_in(list(callouts))).group_by("callout").len()
    return dict(zip(counts["callout"].to_list(), counts["len"].to_list()))


def assign(samples: pl.DataFrame, callouts: dict[str, str | None]) -> pl.DataFrame:
    """One row per player: position, share of round votes, rounds_voted and every position's votes.

    Each round votes once, for the position the player stood in most during the window; ties within a round
    and across the map go to the position with more raw samples, then alphabetically.
    """
    mapping = {c: p for c, p in callouts.items() if p is not None}
    voting = (samples.filter(pl.col("callout").is_in(list(mapping)))
              .with_columns(pl.col("callout").replace_strict(mapping).alias("position")))
    schema = {"steamid": pl.UInt64, "position": pl.String, "share": pl.Float64, "rounds_voted": pl.UInt32,
              "votes": pl.List(pl.Struct({"position": pl.String, "rounds": pl.UInt32}))}
    if voting.is_empty():
        return pl.DataFrame(schema=schema)
    per_round = voting.group_by("steamid", "round_num", "position").len("n")
    raw = per_round.group_by("steamid", "position").agg(pl.col("n").sum().alias("samples"))
    round_vote = (per_round.join(raw, on=["steamid", "position"])
                  .sort(["n", "samples", "position"], descending=[True, True, False])
                  .group_by("steamid", "round_num", maintain_order=True).first())
    votes = (round_vote.group_by("steamid", "position").agg(pl.len().cast(pl.UInt32).alias("rounds"))
             .join(raw, on=["steamid", "position"])
             .sort(["rounds", "samples", "position"], descending=[True, True, False]))
    return (
        votes.group_by("steamid", maintain_order=True)
        .agg(pl.col("position").first(),
             (pl.col("rounds").first() / pl.col("rounds").sum()).alias("share"),
             pl.col("rounds").sum().alias("rounds_voted"),
             pl.struct("position", "rounds").alias("votes"))
        .cast(schema)
        .sort("steamid")
    )


def map_positions(ref: MapRef, callouts: dict[str, str | None]) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(positions, window samples) for one map."""
    rounds = ref.table("rounds", ["round_num", "start_tick", "freeze_end_tick"])
    ticks = ref.table("ticks", ["tick", "round_num", "steamid", "side", "health", "last_place_name", "x", "y", "z"])
    players = ref.table("players", ["steamid", "lp_player", "lp_team"]).unique("steamid")
    samples = window_samples(rounds, ticks)
    out = (assign(samples, callouts).join(ct_rounds(ticks), on="steamid", how="left")
           .join(players, on="steamid", how="left")
           .with_columns(pl.lit(ref.key).alias("key"), pl.lit(ref.date).alias("date"), pl.lit(ref.map).alias("map")))
    return out.select("key", "date", "map", "lp_team", "lp_player", "steamid", "position", "share",
                      "rounds_voted", "rounds_ct", "votes"), samples


def _refs(only: str | None) -> list[MapRef]:
    refs = catalog()
    return [r for r in refs if r.key == only] if only else refs


def callout_report(only: str | None = None, out: Path = WAR_REPORTS / "callouts.md") -> int:
    """Every CT callout per map with its share, centroid and the callouts the same player also stood in that round."""
    by_map: dict[str, list[pl.DataFrame]] = {}
    for ref in _refs(only):
        _, samples = map_positions(ref, {})
        by_map.setdefault(ref.map, []).append(samples.with_columns(pl.lit(ref.key).alias("key")))

    lines = ["# CT callouts 15-25 s after freeze end", "",
             "Share of alive-CT samples, centroid, and the other callouts the same player stood in during the same "
             "round window (share of those player-rounds).", ""]
    for m in sorted(by_map, key=lambda m: -len(by_map[m])):
        s = pl.concat(by_map[m]).with_columns(pl.col("callout").fill_null("").replace("", "(none)"))
        total = s.height
        lines += [f"## {m} ({len(by_map[m])} maps)", "", "| Callout | Share | x | y | z | Also, same round |",
                  "| --- | --- | --- | --- | --- | --- |"]
        pr = s.select("key", "round_num", "steamid", "callout").unique()
        pairs = pr.join(pr, on=["key", "round_num", "steamid"]).filter(pl.col("callout") != pl.col("callout_right"))
        stats = s.group_by("callout").agg(pl.len().alias("n"), pl.col("x").mean(), pl.col("y").mean(), pl.col("z").mean())
        for r in stats.sort("n", descending=True).iter_rows(named=True):
            c = r["callout"]
            rounds_with = pr.filter(pl.col("callout") == c).height
            co = (pairs.filter(pl.col("callout") == c).group_by("callout_right").len().sort("len", descending=True).head(4))
            also = ", ".join(f"{o} {n / rounds_with:.0%}" for o, n in zip(co["callout_right"], co["len"]))
            lines.append(f"| {c} | {r['n'] / total:.2%} | {r['x']:.0f} | {r['y']:.0f} | {r['z']:.0f} | {also} |")
        lines.append("")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines))
    print(f"wrote {out}")
    return 0


def _diagnostics(df: pl.DataFrame, table: dict[str, dict], coverage: dict[str, Counter]) -> list[str]:
    lines = ["# CT positions", "", "| Map | Maps | Players | Null callout | Median share | Share < 0.5 | "
             "Distinct per team | Stability | Most doubled | Most common setup |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    flagged = []
    for m in sorted(df["map"].unique().to_list(), key=lambda m: -df.filter(pl.col("map") == m)["key"].n_unique()):
        d = df.filter(pl.col("map") == m)
        teams = d.filter(pl.col("lp_team").is_not_null()).group_by("key", "lp_team").agg(pl.col("position").sort())
        team_positions = teams["position"].to_list()
        distinct = sum(len(set(p)) for p in team_positions) / max(len(team_positions), 1)
        setup, setup_n = Counter(tuple(p) for p in team_positions).most_common(1)[0]
        doubled = Counter(p for ps in team_positions for p, n in Counter(ps).items() if n > 1)
        player_maps = d.filter(pl.col("lp_player").is_not_null()).group_by("lp_player").agg(pl.col("position"))
        stable = [Counter(ps).most_common(1)[0][1] / len(ps) for ps in player_maps["position"].to_list()
                  if len(ps) >= MIN_STABILITY_MAPS]
        cov = coverage[m]
        median = d["share"].median() or 0
        if median < MIN_MEDIAN_SHARE:
            flagged.append(m)
        lines.append(
            f"| {m} | {d['key'].n_unique()} | {d.height} | {cov['null'] / max(cov['all'], 1):.1%} | {median:.2f} | "
            f"{(d['share'] < 0.5).mean():.1%} | {distinct:.2f} of {len(table[m]['positions'])} | "
            f"{sum(stable) / len(stable) if stable else float('nan'):.2f} ({len(stable)}) | "
            + ", ".join(f"{p} {n / max(teams.height, 1):.0%}" for p, n in doubled.most_common(2))
            + f" | {' / '.join(setup)} ({setup_n / len(team_positions):.0%}) |")
    lines += ["", "Stability: mean share of a player's maps (5+ on that map) at their most common position, "
              "with the player count in brackets.", ""]
    if flagged:
        lines.append(f"Median share below {MIN_MEDIAN_SHARE}: {', '.join(flagged)}.")
    return lines


def build(only: str | None = None) -> int:
    table = load_table()
    rows, missing = [], {}
    coverage: dict[str, Counter] = {}
    for ref in _refs(only):
        if ref.map not in table:
            missing.setdefault(ref.map, {})["(map not in table)"] = 1
            continue
        callouts = table[ref.map]["callouts"]
        df, samples = map_positions(ref, callouts)
        if gaps := unmapped(samples, callouts):
            for c, n in gaps.items():
                missing.setdefault(ref.map, {}).setdefault(c, 0)
                missing[ref.map][c] += n
            continue
        cov = coverage.setdefault(ref.map, Counter())
        cov["all"] += samples.height
        cov["null"] += samples.filter(pl.col("callout").is_null() | (pl.col("callout") == "")).height
        rows.append(df)
    if missing:
        raise UnmappedCallouts(missing)

    df = pl.concat(rows)
    CT_POSITIONS.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(CT_POSITIONS)
    report = _diagnostics(df, table, coverage)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "ct-positions.md").write_text("\n".join(report) + "\n")
    print("\n".join(report))
    print(f"\nwrote {CT_POSITIONS} ({df.height} player-maps)")
    return 0
