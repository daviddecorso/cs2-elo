"""T roles per map played: entry share from opening duels and AWP share of buy rounds (Phase 6, item 2)."""

from collections import Counter

import polars as pl

from .data import MapRef, catalog
from .paths import T_ROLES, WAR_REPORTS
from .states import BUY_WINDOW_TICKS, CT, SIDE_CODE, T

# Team equipment after buy time; team totals split cleanly into ecos and forces below this and full buys above.
BUY_TEAM_EQUIP = 20_000
# A team's top AWP share clears this on 93% of team-maps; the second-highest player's stays under it on 99%.
MIN_AWP_SHARE = 0.3
MIN_STABILITY_MAPS = 5


def player_rounds(rounds: pl.DataFrame, ticks: pl.DataFrame) -> pl.DataFrame:
    """One row per (steamid, round_num): side, whether the team bought, whether the player held the AWP.

    The AWP counts only in hand while alive during buy time after freeze end. Freeze time is left out because
    AWP drops put it in two players' hands, and later pickups from dead teammates don't make an AWPer.
    """
    start = pl.col("freeze_end_tick").fill_null(pl.col("start_tick"))
    buy_time = pl.col("tick").is_between(start, start + BUY_WINDOW_TICKS)
    per_player = (
        ticks.filter((pl.col("steamid") > 0) & pl.col("side").is_in([CT, T]))
        .join(rounds.select("round_num", "start_tick", "freeze_end_tick"), on="round_num")
        .group_by("steamid", "round_num")
        .agg(pl.col("side").first(),
             pl.col("equipment_value").filter(buy_time).max().fill_null(0).alias("equip"),
             ((pl.col("active_weapon") == "awp") & buy_time & (pl.col("health") > 0)).any().alias("awp"))
    )
    team = per_player.group_by("round_num", "side").agg(pl.col("equip").sum().alias("team_equip"))
    return (per_player.join(team, on=["round_num", "side"])
            .with_columns((pl.col("team_equip") >= BUY_TEAM_EQUIP).alias("buy"))
            .select("steamid", "round_num", "side", "buy", "awp"))


def openings(rounds: pl.DataFrame, kills: pl.DataFrame) -> pl.DataFrame:
    """Each round's first kill between opponents after freeze end: round_num, attacker, victim, attacker side."""
    start = pl.col("freeze_end_tick").fill_null(pl.col("start_tick"))
    return (
        kills.filter(pl.col("attacker_steamid").is_not_null() & (pl.col("attacker_steamid") > 0)
                     & pl.col("attacker_side").is_in(list(SIDE_CODE)) & pl.col("victim_side").is_in(list(SIDE_CODE))
                     & (pl.col("attacker_side") != pl.col("victim_side")))
        .join(rounds.select("round_num", "start_tick", "freeze_end_tick"), on="round_num")
        .filter(pl.col("tick") >= start)
        .sort("tick")
        .group_by("round_num", maintain_order=True).first()
        .select("round_num", pl.col("attacker_steamid").alias("attacker"), pl.col("victim_steamid").alias("victim"),
                pl.col("attacker_side").replace_strict(SIDE_CODE).alias("attacker_side"))
    )


def assign(prounds: pl.DataFrame, opens: pl.DataFrame) -> pl.DataFrame:
    """One row per player: T-side entry counts and shares, AWP rounds per side and the combined AWP share."""
    t_rounds = prounds.filter(pl.col("side") == T)
    ok = opens.filter(pl.col("attacker_side") == T).select("round_num", pl.col("attacker").alias("steamid"),
                                                             pl.lit(True).alias("ok"))
    od = opens.filter(pl.col("attacker_side") == CT).select("round_num", pl.col("victim").alias("steamid"),
                                                             pl.lit(True).alias("od"))
    entry = (t_rounds.join(ok, on=["round_num", "steamid"], how="left").join(od, on=["round_num", "steamid"], how="left")
             .group_by("steamid")
             .agg(pl.len().cast(pl.UInt32).alias("t_rounds"),
                  pl.col("ok").fill_null(False).sum().cast(pl.UInt32).alias("opening_kills"),
                  pl.col("od").fill_null(False).sum().cast(pl.UInt32).alias("opening_deaths")))
    awp = prounds.filter("buy").group_by("steamid").agg(
        expr for side, name in ((T, "t"), (CT, "ct"))
        for expr in (pl.col("awp").filter(pl.col("side") == side).len().cast(pl.UInt32).alias(f"{name}_buy_rounds"),
                     pl.col("awp").filter(pl.col("side") == side).sum().cast(pl.UInt32).alias(f"{name}_awp_rounds")))
    out = entry.join(awp, on="steamid", how="full", coalesce=True).with_columns(
        pl.col("t_rounds", "opening_kills", "opening_deaths", "t_buy_rounds", "t_awp_rounds", "ct_buy_rounds",
               "ct_awp_rounds").fill_null(0))
    return out.with_columns(
        ((pl.col("opening_kills") + pl.col("opening_deaths")) / pl.col("t_rounds")).alias("entry_share"),
        (pl.col("t_awp_rounds") / pl.col("t_buy_rounds")).alias("t_awp_share"),
        ((pl.col("t_awp_rounds") + pl.col("ct_awp_rounds"))
         / (pl.col("t_buy_rounds") + pl.col("ct_buy_rounds"))).alias("awp_share"),
    ).sort("steamid")


def label(df: pl.DataFrame) -> pl.DataFrame:
    """T role per player within each (key, team): the top AWP share is the AWPer, the top entry share of the rest
    is the Entry, everyone else is a Rifler. Ties go to the lower steamid."""
    awp = pl.col("awp_share").fill_nan(0).fill_null(0)
    df = df.sort("steamid")
    awper = (awp.rank("ordinal", descending=True).over("key", "team") == 1) & (awp >= MIN_AWP_SHARE)
    df = df.with_columns(awper.alias("_awper"))
    entry_rank = (pl.when(pl.col("_awper")).then(None).otherwise(pl.col("entry_share").fill_nan(0))
                  .rank("ordinal", descending=True).over("key", "team"))
    return df.with_columns(pl.when("_awper").then(pl.lit("AWPer")).when(entry_rank == 1).then(pl.lit("Entry"))
                           .otherwise(pl.lit("Rifler")).alias("t_role")).drop("_awper")


def map_roles(ref: MapRef) -> pl.DataFrame:
    rounds = ref.table("rounds", ["round_num", "start_tick", "freeze_end_tick"])
    ticks = ref.table("ticks", ["tick", "round_num", "steamid", "side", "health", "active_weapon", "equipment_value"])
    kills = ref.table("kills", ["tick", "round_num", "attacker_steamid", "attacker_side", "victim_steamid",
                                "victim_side"])
    players = ref.table("players", ["steamid", "lp_player", "lp_team", "team_clan_name"]).unique("steamid")
    out = (assign(player_rounds(rounds, ticks), openings(rounds, kills))
           .join(players, on="steamid", how="left")
           .with_columns(pl.coalesce("lp_team", "team_clan_name").alias("team"),
                         pl.lit(ref.key).alias("key"), pl.lit(ref.date).alias("date"), pl.lit(ref.map).alias("map")))
    return label(out).select("key", "date", "map", "lp_team", "lp_player", "steamid", "t_role", "entry_share",
                             "opening_kills", "opening_deaths", "t_rounds", "awp_share", "t_awp_share",
                             "t_awp_rounds", "t_buy_rounds", "ct_awp_rounds", "ct_buy_rounds")


def _reliability(df: pl.DataFrame, share: str, num: str, den: str) -> float:
    """Correlation of a player's per-map share with their pooled share on their other maps (10+ maps)."""
    d = (df.filter(pl.col("lp_player").is_not_null() & (pl.col(den) > 0))
         .with_columns(pl.len().over("lp_player").alias("_maps"), pl.col(num).sum().over("lp_player").alias("_num"),
                       pl.col(den).sum().over("lp_player").alias("_den"))
         .filter((pl.col("_maps") >= 10) & (pl.col("_den") > pl.col(den)))
         .with_columns(((pl.col("_num") - pl.col(num)) / (pl.col("_den") - pl.col(den))).alias("_rest")))
    return d.select(pl.corr(share, "_rest")).item() if d.height > 2 else float("nan")


def _diagnostics(df: pl.DataFrame) -> list[str]:
    df = df.with_columns((pl.col("t_awp_rounds") + pl.col("ct_awp_rounds")).alias("awp_rounds"),
                         (pl.col("t_buy_rounds") + pl.col("ct_buy_rounds")).alias("buy_rounds"),
                         (pl.col("opening_kills") + pl.col("opening_deaths")).alias("openings"))
    lines = ["# T roles", "", "| Map | Maps | Team-maps with an AWPer | Entry share: Entry / Rifler / AWPer | "
             "Entry reliability | AWP reliability | Role stability |", "| --- | --- | --- | --- | --- | --- | --- |"]
    maps = sorted(df["map"].unique().to_list(), key=lambda m: -df.filter(pl.col("map") == m)["key"].n_unique())
    for m in [*maps, None]:
        d = df if m is None else df.filter(pl.col("map") == m)
        teams = d.group_by("key", "lp_team").agg((pl.col("t_role") == "AWPer").any().alias("awper"))
        med = {r: d.filter(pl.col("t_role") == r)["entry_share"].median() for r in ("Entry", "Rifler", "AWPer")}
        roles = d.filter(pl.col("lp_player").is_not_null()).group_by("lp_player").agg(pl.col("t_role"))
        stable = [Counter(rs).most_common(1)[0][1] / len(rs) for rs in roles["t_role"].to_list()
                  if len(rs) >= MIN_STABILITY_MAPS]
        lines.append(
            f"| {m or '**All**'} | {d['key'].n_unique()} | {teams['awper'].mean():.0%} | "
            + " / ".join(f"{med[r]:.2f}" if med[r] is not None else "-" for r in med)
            + f" | {_reliability(d, 'entry_share', 'openings', 't_rounds'):.2f} | "
            f"{_reliability(d, 'awp_share', 'awp_rounds', 'buy_rounds'):.2f} | "
            f"{sum(stable) / len(stable) if stable else float('nan'):.2f} ({len(stable)}) |")
    pooled = (df.filter(pl.col("lp_player").is_not_null()).group_by("lp_player")
              .agg(pl.len().alias("maps"), (pl.col("openings").sum() / pl.col("t_rounds").sum()).alias("entry"),
                   (pl.col("awp_rounds").sum() / pl.col("buy_rounds").sum()).alias("awp"))
              .filter(pl.col("maps") >= 30))
    riflers = pooled.filter(pl.col("awp") < MIN_AWP_SHARE).sort("entry", descending=True)

    def names(f: pl.DataFrame, col: str) -> str:
        return ", ".join(f"{p} {v:.2f}" for p, v in zip(f["lp_player"], f[col]))

    lines += ["", "Reliability: correlation of a player's per-map share with their pooled share on their other maps "
              "(players with 10+ maps). Role stability: mean share of a player's maps (5+ on that map) at their most "
              "common role, with the player count in brackets.", "",
              "Pooled over all maps, players with 30+ maps:", "",
              f"- Highest entry share: {names(riflers.head(10), 'entry')}",
              f"- Lowest entry share: {names(riflers.tail(10).reverse(), 'entry')}",
              f"- Highest AWP share: {names(pooled.sort('awp', descending=True).head(10), 'awp')}"]
    return lines


def build(only: str | None = None) -> int:
    refs = [r for r in catalog() if r.key == only] if only else catalog()
    df = pl.concat([map_roles(r) for r in refs], how="vertical_relaxed")
    T_ROLES.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(T_ROLES)
    report = _diagnostics(df)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "t-roles.md").write_text("\n".join(report) + "\n")
    print("\n".join(report))
    print(f"\nwrote {T_ROLES} ({df.height} player-maps)")
    return 0
