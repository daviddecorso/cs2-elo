"""CT positions per map played: each player's most common position 15-25 s into their CT rounds (Phase 6, item 1)."""

from collections import Counter
import json
import math
from pathlib import Path

import numpy as np
import polars as pl
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

from .data import MapRef, catalog
from .paths import CT_POSITION_TABLE, CT_POSITIONS, CT_SUBPOSITION_TABLE, WAR_REPORTS
from .states import CT, TICK_RATE

# Seconds after freeze end; by then CTs have reached their setup and haven't rotated yet.
WINDOW = (15, 25)
# Below this median share on a map, the table probably merges or splits positions wrongly.
MIN_MEDIAN_SHARE = 0.6
MIN_STABILITY_MAPS = 5
MIN_DOUBLED_SHARE = 0.25
MAX_SUBPOSITIONS = 4
MIN_PAIR_SEPARATION = 0.70
MIN_PAIR_SEP_LIFT = 0.15
MIN_SUB_STABILITY = 0.70
SUB_SAMPLE_MAX = 5000


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


def load_subpositions(
    path: Path = CT_SUBPOSITION_TABLE, table: dict[str, dict] | None = None,
) -> dict[str, dict[str, dict]]:
    """Load hand-named CT sub-position clusters, returning {} if absent."""
    if not path.exists():
        return {}
    raw = json.loads(path.read_text())
    for m, by_pos in raw.items():
        known = set(table[m]["positions"]) if table and m in table else None
        seen: set[str] = set(known or ())
        for pos, spec in by_pos.items():
            if known is not None and pos not in known:
                raise ValueError(f"{m}: subposition points at unknown position {pos}")
            centers, names = spec["centers"], spec["names"]
            if len(centers) < 2 or len(centers) != len(names) or len(set(names)) != len(names):
                raise ValueError(f"{m} {pos}: invalid centers/names in {path.name}")
            if clash := seen.intersection(names):
                raise ValueError(f"{m} {pos}: names {sorted(clash)} repeat another sub-position or a position on the map")
            seen.update(names)
    return raw


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


def _round_votes(
    samples: pl.DataFrame, callouts: dict[str, str | None],
) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    mapping = {c: p for c, p in callouts.items() if p is not None}
    voting = (samples.filter(pl.col("callout").is_in(list(mapping)))
              .with_columns(pl.col("callout").replace_strict(mapping).alias("position")))
    if voting.is_empty():
        r_type = samples.schema.get("round_num", pl.Int64)
        return (
            voting,
            pl.DataFrame(schema={"steamid": pl.UInt64, "round_num": r_type, "position": pl.String, "n": pl.UInt32, "samples": pl.UInt32}),
            pl.DataFrame(schema={"steamid": pl.UInt64, "position": pl.String, "samples": pl.UInt32}),
        )
    per_round = voting.group_by("steamid", "round_num", "position").len("n")
    raw = per_round.group_by("steamid", "position").agg(pl.col("n").sum().alias("samples"))
    round_vote = (per_round.join(raw, on=["steamid", "position"])
                  .sort(["n", "samples", "position"], descending=[True, True, False])
                  .group_by("steamid", "round_num", maintain_order=True).first())
    return voting, round_vote, raw


def _round_centroids_with_callout(
    samples: pl.DataFrame, callouts: dict[str, str | None], votes: tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame] | None = None,
) -> pl.DataFrame:
    voting, round_vote, _ = votes or _round_votes(samples, callouts)
    if round_vote.is_empty():
        r_type = samples.schema.get("round_num", pl.Int64)
        return pl.DataFrame(schema={"steamid": pl.UInt64, "round_num": r_type, "position": pl.String,
                                    "x": pl.Float64, "y": pl.Float64, "callout": pl.String})
    matched = voting.join(round_vote.select("steamid", "round_num", "position"), on=["steamid", "round_num", "position"])
    top_callout = (matched.group_by("steamid", "round_num", "position", "callout").len("cn")
                   .sort(["cn", "callout"], descending=[True, False])
                   .group_by("steamid", "round_num", "position", maintain_order=True).first()
                   .select("steamid", "round_num", "position", "callout"))
    return (matched.group_by("steamid", "round_num", "position")
            .agg(pl.col("x").mean().cast(pl.Float64).alias("x"),
                 pl.col("y").mean().cast(pl.Float64).alias("y"))
            .join(top_callout, on=["steamid", "round_num", "position"])
            .sort(["steamid", "round_num"]))


def round_centroids(
    samples: pl.DataFrame, callouts: dict[str, str | None], votes: tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame] | None = None,
) -> pl.DataFrame:
    """Per-(steamid, round) voted position and mean x, y of its callouts' samples."""
    return _round_centroids_with_callout(samples, callouts, votes).select("steamid", "round_num", "position", "x", "y")


def assign_subpositions(
    centroids: pl.DataFrame, modal_positions: pl.DataFrame, subpositions: dict[str, dict],
) -> pl.DataFrame:
    """Assign each player's modal-position rounds to their nearest center and pick the modal sub-position."""
    id_cols = ["key", "steamid"] if "key" in modal_positions.columns and "key" in centroids.columns else ["steamid"]
    empty_schema = {**{c: modal_positions.schema[c] for c in id_cols},
                    "subposition": pl.String, "sub_share": pl.Float64}
    if not subpositions or centroids.is_empty() or modal_positions.is_empty():
        return pl.DataFrame(schema=empty_schema)
    scoped = modal_positions.filter(pl.col("position").is_in(list(subpositions))).select(*id_cols, "position")
    if scoped.is_empty():
        return pl.DataFrame(schema=empty_schema)
    rounds = centroids.join(scoped, on=[*id_cols, "position"])
    if rounds.is_empty():
        return pl.DataFrame(schema=empty_schema)

    pieces = []
    for pos, spec in subpositions.items():
        sub = rounds.filter(pl.col("position") == pos)
        if sub.is_empty():
            continue
        xy = sub.select("x", "y").to_numpy()
        centers = np.asarray(spec["centers"], dtype=np.float64)
        d2 = ((xy[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        idx = np.argmin(d2, axis=1)
        min_d2 = d2[np.arange(len(idx)), idx]
        names = np.asarray(spec["names"])[idx]
        pieces.append(sub.select(*id_cols).with_columns(
            pl.Series("subposition", names, dtype=pl.String),
            pl.Series("d2", min_d2, dtype=pl.Float64),
        ))
    if not pieces:
        return pl.DataFrame(schema=empty_schema)

    voted = (pl.concat(pieces)
             .group_by(*id_cols, "subposition")
             .agg(pl.len().cast(pl.UInt32).alias("sub_rounds"), pl.col("d2").mean().alias("mean_d2"))
             .sort(["sub_rounds", "mean_d2", "subposition"], descending=[True, False, False]))
    return (voted.group_by(*id_cols, maintain_order=True)
            .agg(pl.col("subposition").first().cast(pl.String),
                 (pl.col("sub_rounds").first() / pl.col("sub_rounds").sum()).cast(pl.Float64).alias("sub_share")))


def assign(
    samples: pl.DataFrame, callouts: dict[str, str | None], subpositions: dict[str, dict] | None = None,
) -> pl.DataFrame:
    """One row per player: position, share of round votes, rounds_voted and every position's votes.

    Each round votes once, for the position the player stood in most during the window; ties within a round
    and across the map go to the position with more raw samples, then alphabetically.
    """
    votes_by_round = _round_votes(samples, callouts)
    _, round_vote, raw = votes_by_round
    schema = {"steamid": pl.UInt64, "position": pl.String, "share": pl.Float64, "rounds_voted": pl.UInt32,
              "votes": pl.List(pl.Struct({"position": pl.String, "rounds": pl.UInt32})),
              "subposition": pl.String, "sub_share": pl.Float64}
    if round_vote.is_empty():
        return pl.DataFrame(schema=schema)
    votes = (round_vote.group_by("steamid", "position").agg(pl.len().cast(pl.UInt32).alias("rounds"))
             .join(raw, on=["steamid", "position"])
             .sort(["rounds", "samples", "position"], descending=[True, True, False]))
    base = (
        votes.group_by("steamid", maintain_order=True)
        .agg(pl.col("position").first(),
             (pl.col("rounds").first() / pl.col("rounds").sum()).alias("share"),
             pl.col("rounds").sum().alias("rounds_voted"),
             pl.struct("position", "rounds").alias("votes"))
        .sort("steamid")
    )
    if subpositions:
        centroids = round_centroids(samples, callouts, votes_by_round)
        subs = assign_subpositions(centroids, base, subpositions)
        out = base.join(subs, on="steamid", how="left")
    else:
        out = base.with_columns(pl.lit(None, dtype=pl.String).alias("subposition"),
                                pl.lit(None, dtype=pl.Float64).alias("sub_share"))
    return out.cast(schema)


def map_positions(
    ref: MapRef, callouts: dict[str, str | None], subpositions: dict[str, dict] | None = None,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """(positions, window samples) for one map."""
    rounds = ref.table("rounds", ["round_num", "start_tick", "freeze_end_tick"])
    ticks = ref.table("ticks", ["tick", "round_num", "steamid", "side", "health", "last_place_name", "x", "y", "z"])
    players = ref.table("players", ["steamid", "lp_player", "lp_team"]).unique("steamid")
    samples = window_samples(rounds, ticks)
    out = (assign(samples, callouts, subpositions).join(ct_rounds(ticks), on="steamid", how="left")
           .join(players, on="steamid", how="left")
           .with_columns(pl.lit(ref.key).alias("key"), pl.lit(ref.date).alias("date"), pl.lit(ref.map).alias("map")))
    return out.select("key", "date", "map", "lp_team", "lp_player", "steamid", "position", "share",
                      "subposition", "sub_share", "rounds_voted", "rounds_ct", "votes"), samples


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


def pair_separation(cluster_rows: pl.DataFrame, cluster_sizes: list[int], k: int) -> tuple[float, float, int]:
    """Share of team-rounds with exact k teammates at this position that land in k distinct clusters, plus chance."""
    scoped = cluster_rows.filter(pl.col("lp_team").is_not_null())
    if scoped.is_empty():
        return float("nan"), float("nan"), 0
    exact_k = (scoped.group_by("key", "lp_team", "round_num")
               .agg(pl.len().alias("n"), pl.col("cluster").n_unique().alias("n_distinct"))
               .filter(pl.col("n") == k))
    n_rounds = exact_k.height
    total = sum(cluster_sizes)
    chance = math.factorial(k) * math.prod(s / total for s in cluster_sizes) if total > 0 else float("nan")
    obs = float((exact_k["n_distinct"] == k).mean()) if n_rounds > 0 else float("nan")
    return obs, chance, n_rounds


def _fit_position_clusters(
    m: str, pos: str, k: int, pos_df: pl.DataFrame, pos_centroids: pl.DataFrame, doubled_share: float,
    n_team_maps: int,
) -> tuple[dict, list[str]]:
    xy = pos_centroids.select("x", "y").to_numpy()
    km = KMeans(n_clusters=k, n_init=10, random_state=0).fit(xy)
    raw_labels = km.labels_
    order = sorted(range(k), key=lambda c: int((raw_labels == c).sum()), reverse=True)
    remap = {old: new for new, old in enumerate(order)}
    labels = np.array([remap[int(c)] for c in raw_labels], dtype=np.int32)
    centers = [[float(km.cluster_centers_[old, 0]), float(km.cluster_centers_[old, 1])] for old in order]
    sizes = [int((labels == c).sum()) for c in range(k)]
    sil = float(silhouette_score(xy, labels, sample_size=min(len(xy), SUB_SAMPLE_MAX), random_state=0))

    labeled = pos_centroids.with_columns(pl.Series("cluster", labels))
    obs_sep, chance_sep, n_sep_rounds = pair_separation(labeled, sizes, k)

    names = [f"cluster_{c}" for c in range(k)]
    spec = {pos: {"centers": centers, "names": names}}
    sub_assigned = (pos_df.drop("subposition", "sub_share", strict=False)
                    .join(assign_subpositions(pos_centroids, pos_df, spec), on=["key", "steamid"], how="left")
                    .with_columns(pl.coalesce("subposition", "position").alias("eff")))
    med_share = sub_assigned["sub_share"].median()
    med_share = float(med_share) if med_share is not None else float("nan")

    player_subs = (sub_assigned.filter(pl.col("lp_player").is_not_null() & pl.col("subposition").is_not_null())
                   .group_by("lp_player").agg(pl.col("subposition")))
    stabs = [Counter(ss).most_common(1)[0][1] / len(ss) for ss in player_subs["subposition"].to_list()
             if len(ss) >= MIN_STABILITY_MAPS]
    stab = sum(stabs) / len(stabs) if stabs else float("nan")

    sub_teams = sub_assigned.filter(pl.col("lp_team").is_not_null()).group_by("key", "lp_team").agg(pl.col("eff"))
    doubled_after = sum(1 for es in sub_teams["eff"].to_list() if any(n > 1 for n in Counter(es).values()))
    after_rate = doubled_after / max(n_team_maps, 1)

    passed = (
        not math.isnan(obs_sep)
        and not math.isnan(chance_sep)
        and not math.isnan(med_share)
        and not math.isnan(stab)
        and obs_sep >= MIN_PAIR_SEPARATION
        and (obs_sep - chance_sep) >= MIN_PAIR_SEP_LIFT
        and med_share >= MIN_MEDIAN_SHARE
        and stab >= MIN_SUB_STABILITY
    )
    summary = {
        "map": m, "position": pos, "doubled_share": doubled_share, "k": k, "centroids": pos_centroids.height,
        "sep_rounds": n_sep_rounds, "obs_sep": obs_sep, "chance_sep": chance_sep, "lift": obs_sep - chance_sep,
        "med_share": med_share, "stability": stab, "stab_players": len(stabs), "silhouette": sil,
        "after_rate": after_rate, "passed": passed,
    }
    section = [f"### {m} · {pos} (k={k}, doubled {doubled_share:.0%}, {'PASS' if passed else 'FAIL'})", "",
               "| Cluster | Name hint | Size | Share | Center (x, y) | Callout mix | Top players |",
               "| --- | --- | --- | --- | --- | --- | --- |"]
    for c in range(k):
        cl_rows = labeled.filter(pl.col("cluster") == c)
        mix = cl_rows.group_by("callout").len().sort("len", descending=True).head(3)
        mix_str = ", ".join(f"{r['callout']} {r['len'] / sizes[c]:.0%}" for r in mix.iter_rows(named=True))
        top_players = (cl_rows.filter(pl.col("lp_player").is_not_null())
                       .group_by("lp_player").len().sort("len", descending=True).head(4))
        p_str = ", ".join(f"{r['lp_player']} ({r['len']})" for r in top_players.iter_rows(named=True))
        section.append(f"| {c} | `cluster_{c}` | {sizes[c]:,} | {sizes[c] / len(xy):.1%} | "
                       f"({centers[c][0]:.0f}, {centers[c][1]:.0f}) | {mix_str} | {p_str} |")
    section.append("")
    return summary, section


def subpositions_report(only: str | None = None, out: Path = WAR_REPORTS / "ct-subpositions.md") -> int:
    """Cluster CT round centroids on doubled positions (25%+ of team-maps) and test Gate 1."""
    table = load_table()
    df_parts, centroid_parts = [], []
    for ref in _refs(only):
        if ref.map not in table:
            continue
        callouts = table[ref.map]["callouts"]
        df, samples = map_positions(ref, callouts)
        cents = (_round_centroids_with_callout(samples, callouts)
                 .join(df.select("steamid", "lp_team", "lp_player"), on="steamid", how="left")
                 .with_columns(pl.lit(ref.key).alias("key"), pl.lit(ref.map).alias("map")))
        df_parts.append(df)
        centroid_parts.append(cents)

    all_df = pl.concat(df_parts)
    all_cents = pl.concat(centroid_parts)

    summaries, sections = [], []
    for m in sorted(all_df["map"].unique().to_list(), key=lambda m: -all_df.filter(pl.col("map") == m)["key"].n_unique()):
        md = all_df.filter(pl.col("map") == m)
        mc = all_cents.filter(pl.col("map") == m)
        teams = md.filter(pl.col("lp_team").is_not_null()).group_by("key", "lp_team").agg(pl.col("position"))
        n_team_maps = max(teams.height, 1)
        pos_counts: dict[str, list[int]] = {}
        for ps in teams["position"].to_list():
            for pos, cnt in Counter(ps).items():
                if cnt > 1:
                    pos_counts.setdefault(pos, []).append(cnt)
        for pos, cnts in sorted(pos_counts.items(), key=lambda x: -len(x[1])):
            doubled_share = len(cnts) / n_team_maps
            if doubled_share < MIN_DOUBLED_SHARE:
                continue
            modal_cnt = sorted(Counter(cnts).items(), key=lambda x: (-x[1], x[0]))[0][0]
            k = min(modal_cnt, MAX_SUBPOSITIONS)
            pos_cents = mc.filter(pl.col("position") == pos)
            if pos_cents.height < k:
                continue
            summary, section = _fit_position_clusters(
                m, pos, k, md.filter(pl.col("position") == pos), pos_cents, doubled_share, n_team_maps,
            )
            summaries.append(summary)
            sections.extend(section)

    lines = ["# CT sub-positions (Gate 1)", "",
             f"Candidates: doubled on >= {MIN_DOUBLED_SHARE:.0%} of team-maps. "
             f"Gate 1: pair sep >= {MIN_PAIR_SEPARATION:.2f}, lift >= +{MIN_PAIR_SEP_LIFT:.2f}, "
             f"median share >= {MIN_MEDIAN_SHARE:.2f}, stability >= {MIN_SUB_STABILITY:.2f}.", "",
             "| Map | Position | Doubled | k | Rounds | k-rounds | Pair sep | Chance | Lift | Med share | Stability | Silhouette | Doubled after | Gate 1 |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for s in summaries:
        lines.append(
            f"| {s['map']} | {s['position']} | {s['doubled_share']:.0%} | {s['k']} | {s['centroids']:,} | "
            f"{s['sep_rounds']:,} | {s['obs_sep']:.3f} | {s['chance_sep']:.3f} | {s['lift']:+.3f} | "
            f"{s['med_share']:.3f} | {s['stability']:.3f} ({s['stab_players']}) | {s['silhouette']:.3f} | "
            f"{s['after_rate']:.0%} | {'PASS' if s['passed'] else 'FAIL'} |"
        )
    lines += ["", "## Cluster details", ""] + sections
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:len(summaries) + 6]))
    print(f"\nwrote {out}")
    return 0


def _diagnostics(
    df: pl.DataFrame, table: dict[str, dict], coverage: dict[str, Counter],
    subpositions: dict[str, dict[str, dict]] | None = None,
) -> list[str]:
    lines = ["# CT positions", "", "| Map | Maps | Players | Null callout | Median share | Share < 0.5 | "
             "Distinct per team | Stability | Most doubled | Doubled after | Sub stability | Most common setup |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    flagged = []
    for m in sorted(df["map"].unique().to_list(), key=lambda m: -df.filter(pl.col("map") == m)["key"].n_unique()):
        d = df.filter(pl.col("map") == m).with_columns(pl.coalesce("subposition", "position").alias("eff_position"))
        teams = d.filter(pl.col("lp_team").is_not_null()).group_by("key", "lp_team").agg(
            pl.col("position").sort(), pl.col("eff_position").sort())
        team_positions = teams["position"].to_list()
        eff_positions = teams["eff_position"].to_list()
        distinct = sum(len(set(p)) for p in team_positions) / max(len(team_positions), 1)
        setup, setup_n = Counter(tuple(p) for p in team_positions).most_common(1)[0]
        doubled = Counter(p for ps in team_positions for p, n in Counter(ps).items() if n > 1)
        doubled_after = Counter(p for ps in eff_positions for p, n in Counter(ps).items() if n > 1)
        player_maps = d.filter(pl.col("lp_player").is_not_null()).group_by("lp_player").agg(pl.col("position"))
        stable = [Counter(ps).most_common(1)[0][1] / len(ps) for ps in player_maps["position"].to_list()
                  if len(ps) >= MIN_STABILITY_MAPS]
        sub_maps = (d.filter(pl.col("lp_player").is_not_null() & pl.col("subposition").is_not_null())
                    .group_by("lp_player", "position").agg(pl.col("subposition")))
        sub_stable = [Counter(ss).most_common(1)[0][1] / len(ss) for ss in sub_maps["subposition"].to_list()
                      if len(ss) >= MIN_STABILITY_MAPS]
        sub_cell = f"{sum(sub_stable) / len(sub_stable):.2f} ({len(sub_stable)})" if sub_stable else "–"
        cov = coverage[m]
        median = d["share"].median() or 0
        if median < MIN_MEDIAN_SHARE:
            flagged.append(m)
        after_str = ", ".join(f"{p} {n / max(teams.height, 1):.0%}" for p, n in doubled_after.most_common(2)) or "0%"
        lines.append(
            f"| {m} | {d['key'].n_unique()} | {d.height} | {cov['null'] / max(cov['all'], 1):.1%} | {median:.2f} | "
            f"{(d['share'] < 0.5).mean():.1%} | {distinct:.2f} of {len(table[m]['positions'])} | "
            f"{sum(stable) / len(stable) if stable else float('nan'):.2f} ({len(stable)}) | "
            + ", ".join(f"{p} {n / max(teams.height, 1):.0%}" for p, n in doubled.most_common(2))
            + f" | {after_str} | {sub_cell} | {' / '.join(setup)} ({setup_n / len(team_positions):.0%}) |")
    lines += ["", "Stability: mean share of a player's maps (5+ on that map) at their most common position, "
              "with the player count in brackets.", ""]
    if subpositions:
        lines.append("Sub stability: same metric across a player's maps (5+) within each split position.")
    if flagged:
        lines.append(f"Median share below {MIN_MEDIAN_SHARE}: {', '.join(flagged)}.")
    return lines


def build(only: str | None = None) -> int:
    table = load_table()
    subpositions = load_subpositions(table=table)
    rows, missing = [], {}
    coverage: dict[str, Counter] = {}
    for ref in _refs(only):
        if ref.map not in table:
            missing.setdefault(ref.map, {})["(map not in table)"] = 1
            continue
        callouts = table[ref.map]["callouts"]
        df, samples = map_positions(ref, callouts, subpositions.get(ref.map))
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
    report = _diagnostics(df, table, coverage, subpositions)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "ct-positions.md").write_text("\n".join(report) + "\n")
    print("\n".join(report))
    print(f"\nwrote {CT_POSITIONS} ({df.height} player-maps)")
    return 0
