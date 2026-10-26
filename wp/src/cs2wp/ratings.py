"""Per-player box-score stats per map, and an approximation of HLTV Rating 2.0 built from them.

HLTV never published Rating 2.0's formula and now shows Rating 3.0, so the paper's baseline is rebuilt from the
community regression: 0.0073·KAST + 0.3591·KPR − 0.5329·DPR + 0.2372·Impact + 0.0032·ADR + 0.1587,
with Impact = 2.13·KPR + 0.42·APR − 0.41.
"""

import polars as pl

from .data import MapRef


def map_stats(ref: MapRef, roster: pl.DataFrame) -> pl.DataFrame:
    """One row per player: rounds, kills, deaths, assists, damage and KAST rounds on this map."""
    kills = ref.table("kills")
    damages = ref.table("damages")
    rounds = roster.group_by("steamid").agg(pl.len().alias("rounds"))
    enemy = pl.col("attacker_side") != pl.col("victim_side")
    k = kills.filter(enemy & (pl.col("attacker_steamid") > 0))
    kpr = k.group_by(pl.col("attacker_steamid").alias("steamid")).agg(pl.len().alias("kills"))
    deaths = kills.filter(pl.col("victim_steamid") > 0).group_by(pl.col("victim_steamid").alias("steamid")).agg(pl.len().alias("deaths"))
    assists = (
        k.filter(pl.col("assister_steamid").is_not_null() & ~pl.col("assist_flash") & (pl.col("assister_side") == pl.col("attacker_side")))
        .group_by(pl.col("assister_steamid").alias("steamid"))
        .agg(pl.len().alias("assists"))
    )
    dealt = (
        damages.filter((pl.col("attacker_side") != pl.col("victim_side")) & (pl.col("attacker_steamid") > 0))
        .with_columns((pl.col("health_pre") - pl.col("health_post").clip(lower_bound=0)).alias("hp_dmg"))
        .group_by(pl.col("attacker_steamid").alias("steamid"))
        .agg(pl.col("hp_dmg").sum().alias("damage"))
    )
    # KAST: a kill, an assist, survival or being traded, per round.
    per_round = []
    for (rnd,), g in roster.group_by("round_num"):
        rk = kills.filter(pl.col("round_num") == rnd)
        killed = set(rk.filter(enemy & (pl.col("attacker_steamid") > 0))["attacker_steamid"].to_list())
        helped = set(rk.filter(enemy & pl.col("assister_steamid").is_not_null())["assister_steamid"].to_list())
        died = set(rk["victim_steamid"].to_list())
        traded = set(rk.filter(pl.col("victim_traded"))["victim_steamid"].to_list())
        for sid in g["steamid"]:
            per_round.append({"steamid": sid, "kast": sid in killed or sid in helped or sid not in died or sid in traded})
    kast = pl.DataFrame(per_round, schema={"steamid": pl.UInt64, "kast": pl.Boolean}).group_by("steamid").agg(
        pl.col("kast").sum().alias("kast_rounds")
    )
    out = rounds
    for t in (kpr, deaths, assists, dealt, kast):
        out = out.join(t, on="steamid", how="left")
    return out.fill_null(0).with_columns(pl.lit(ref.key).alias("key"), pl.lit(ref.date).alias("date"))


def rating2(stats: pl.DataFrame) -> pl.DataFrame:
    """Adds kpr, dpr, apr, adr, kast (percent) and the approximate Rating 2.0, from summed counts."""
    r = pl.col("rounds")
    s = stats.with_columns(
        (pl.col("kills") / r).alias("kpr"),
        (pl.col("deaths") / r).alias("dpr"),
        (pl.col("assists") / r).alias("apr"),
        (pl.col("damage") / r).alias("adr"),
        (100 * pl.col("kast_rounds") / r).alias("kast"),
    )
    impact = 2.13 * pl.col("kpr") + 0.42 * pl.col("apr") - 0.41
    return s.with_columns(
        (0.0073 * pl.col("kast") + 0.3591 * pl.col("kpr") - 0.5329 * pl.col("dpr") + 0.2372 * impact
         + 0.0032 * pl.col("adr") + 0.1587).alias("rating2_approx"),
        (pl.col("kills") / pl.max_horizontal(pl.col("deaths"), pl.lit(1))).alias("kd"),
    )
