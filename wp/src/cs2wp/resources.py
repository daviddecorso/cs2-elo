"""Resources per player-round: economy, inferred drops, and flash, smoke and trade support (Phase 6, resources)."""

import polars as pl

from .data import MapRef, catalog
from .duels import FLASH_COLUMNS, KILL_COLUMNS, TICK_COLUMNS, _guns, duels
from .evaluate import PISTOL_ROUNDS, _buy
from .paths import RESOURCE_ROUNDS
from .roles import player_rounds
from .states import BUY_WINDOW_TICKS, CT, SIDE_CODE, TICK_RATE, T, UTILITY

# A drop moves at least this much equipment value with no money spent; a replaced pistol moves a few hundred.
DROP_MIN = 1_000
SMOKE_WINDOW = 5 * TICK_RATE
SMOKE_RADIUS = 800
# A smoke's first trajectory point is the thrower's hand: within a 4 Hz snapshot of running, plus the arm.
THROWER_RADIUS = 300
# The inventory count drops up to two 4 Hz snapshots after the projectile appears.
COUNT_LAG = TICK_RATE // 2
# Highest wins when a player held several guns during buy time.
GUN_RANK = ["Pistol", "Deagle", "Heavy", "SMG", "Cheap rifle", "Scout", "Auto", "Rifle", "AWP"]
ECONOMY = ["equip", "team_equip", "opp_equip", "equip_share", "gun", "awp", "armor", "helmet", "has_defuser",
           *UTILITY, "team_buy", "opp_buy", "pistol"]
GRENADE_COLUMNS = ["tick", "round_num", "type", "entity_id", "entity_serial", "x", "y"]


def economy(rounds: pl.DataFrame, ticks: pl.DataFrame) -> pl.DataFrame:
    """Per (steamid, round_num): what the player and both teams carried by the end of buy time, and `net_transfer`.

    `net_transfer` = equipment gained − money spent from round start to freeze end: positive when the player
    picked up more than they paid for, negative when they handed equipment to someone else.
    """
    base = player_rounds(rounds, ticks)
    start = pl.col("freeze_end_tick").fill_null(pl.col("start_tick"))
    held = pl.col("tick").is_between(start, start + BUY_WINDOW_TICKS) & (pl.col("health") > 0)
    rank = _guns("active_weapon").replace_strict(GUN_RANK, list(range(len(GUN_RANK))), default=None)
    in_round = pl.col("tick") >= pl.col("start_tick")
    by_freeze_end = in_round & (pl.col("tick") <= start)
    gear = (
        ticks.filter((pl.col("steamid") > 0) & pl.col("side").is_in([CT, T]))
        .join(rounds.select("round_num", "start_tick", "freeze_end_tick"), on="round_num")
        .sort("tick")
        .group_by("steamid", "round_num")
        .agg(rank.filter(held).max().alias("_gun"),
             pl.col("armor").filter(held).max().fill_null(0).alias("armor"),
             pl.col("has_helmet").filter(held).any().alias("helmet"),
             pl.col("has_defuser").filter(held).any().alias("has_defuser"),
             *(pl.col(c).filter(held).max().fill_null(0).alias(k) for k, c in UTILITY.items()),
             pl.col("money").filter(in_round).first().alias("_money0"),
             pl.col("equipment_value").filter(in_round).first().alias("_equip0"),
             pl.col("money").filter(by_freeze_end).last().alias("_money1"),
             pl.col("equipment_value").filter(by_freeze_end).last().alias("_equip1"))
        .with_columns(pl.col("_gun").replace_strict(list(range(len(GUN_RANK))), GUN_RANK, default=None).alias("gun"),
                      ((pl.col("_equip1") - pl.col("_equip0")) - (pl.col("_money0") - pl.col("_money1")))
                      .alias("net_transfer"))
        .drop("_gun", "_money0", "_equip0", "_money1", "_equip1")
    )
    opp = (base.select("round_num", "side", "team_equip").unique()
           .select("round_num", pl.when(pl.col("side") == CT).then(T).otherwise(CT).cast(base.schema["side"]).alias("side"),
                   pl.col("team_equip").alias("opp_equip")))
    return (base.join(gear, on=["steamid", "round_num"], how="left")
            .join(opp, on=["round_num", "side"], how="left")
            .with_columns((pl.col("equip") / pl.col("team_equip")).fill_nan(None).alias("equip_share"),
                          _buy("team_equip").alias("team_buy"), _buy("opp_equip").alias("opp_buy"),
                          pl.col("round_num").is_in(PISTOL_ROUNDS).alias("pistol"))
            .drop("buy"))


def drops(econ: pl.DataFrame) -> pl.DataFrame:
    """Adds `drop_received` and `drop_given`: a net transfer of DROP_MIN+ matched by a teammate's in the other
    direction in the same round."""
    team = ["round_num", "side"]
    net = econ.select(*team, "steamid", pl.col("net_transfer").fill_null(0).alias("_net"))
    mates = (net.join(net.rename({"steamid": "_mate", "_net": "_mate_net"}), on=team)
             .filter(pl.col("steamid") != pl.col("_mate"))
             .group_by(*team, "steamid").agg(pl.col("_mate_net").max().alias("_omax"),
                                             pl.col("_mate_net").min().alias("_omin")))
    n = pl.col("net_transfer")
    return (econ.join(mates, on=[*team, "steamid"], how="left")
            .with_columns(((n >= DROP_MIN) & (pl.col("_omin") <= -DROP_MIN)).fill_null(False).alias("drop_received"),
                          ((n <= -DROP_MIN) & (pl.col("_omax") >= DROP_MIN)).fill_null(False).alias("drop_given"))
            .drop("_omax", "_omin"))


def thrower_smokes(grenades: pl.DataFrame, ticks: pl.DataFrame) -> pl.DataFrame:
    """One row per smoke: round_num, thrower, side, pop_tick, x, y (where it popped).

    The parser leaves `thrower_steamid` empty, so the thrower is the player whose smoke count drops across the
    trajectory's first tick and who stood within THROWER_RADIUS of its first point. Unmatched smokes have a null
    thrower.
    """
    traj = (grenades.filter(pl.col("type") == "smoke").sort("tick")
            .group_by("round_num", "entity_id", "entity_serial")
            .agg(pl.col("tick").first().alias("t0"), pl.col("x").first().alias("x0"), pl.col("y").first().alias("y0"),
                 pl.col("tick").last().alias("pop_tick"), pl.col("x").last().alias("x"), pl.col("y").last().alias("y"))
            .with_row_index("smoke")
            .with_columns(pl.col("round_num").cast(pl.Int64)))
    snaps = (ticks.filter((pl.col("steamid") > 0) & pl.col("side").is_in([CT, T]))
             .select("tick", "steamid", "side", pl.col("round_num").cast(pl.Int64), pl.col("x").alias("px"),
                     pl.col("y").alias("py"), pl.col("smoke_grenades").alias("n")).sort("tick"))
    pairs = (traj.join(snaps.select("round_num", "steamid", "side").unique(), on="round_num")
             .with_columns((pl.col("t0") - 1).alias("_before")).sort("_before"))
    pairs = pairs.join_asof(snaps.drop("round_num", "side"), left_on="_before", right_on="tick", by="steamid",
                            strategy="backward", tolerance=TICK_RATE)
    pairs = (pairs.with_columns((pl.col("t0") + COUNT_LAG).alias("_after")).sort("_after")
             .join_asof(snaps.select("tick", "steamid", pl.col("n").alias("n_after")), left_on="_after", right_on="tick",
                        by="steamid", strategy="forward", tolerance=TICK_RATE, suffix="_after"))
    dist = ((pl.col("px") - pl.col("x0")) ** 2 + (pl.col("py") - pl.col("y0")) ** 2).sqrt()
    found = (pairs.filter((pl.col("n") > pl.col("n_after")) & (dist <= THROWER_RADIUS))
             .with_columns(dist.alias("_d")).sort("_d")
             .group_by("smoke").agg(pl.col("steamid").first().alias("thrower"), pl.col("side").first()))
    return (traj.join(found, on="smoke", how="left")
            .select("round_num", "thrower", "side", "pop_tick", "x", "y").sort("pop_tick"))


def thrown_smokes(ref: MapRef, ticks: pl.DataFrame) -> pl.DataFrame | None:
    path = ref.dir / "grenades.parquet"
    if not path.exists():
        return None
    return thrower_smokes(pl.read_parquet(path, columns=GRENADE_COLUMNS), ticks)


def support(d: pl.DataFrame, kills: pl.DataFrame) -> pl.DataFrame:
    """Per (round_num, steamid): duels, how many had flash, own-flash and smoke support, deaths and traded deaths."""
    per = pl.concat([
        d.select("round_num", pl.col(who).alias("steamid"),
                 *(pl.col(f"{p}{c}").alias(c) for c in ("flash_support", "self_flash", "smoke_support")))
        for who, p in (("attacker", "a_"), ("victim", "v_"))
    ]).group_by("round_num", "steamid").agg(pl.len().alias("duels"), pl.col("flash_support", "self_flash",
                                                                            "smoke_support").sum())
    deaths = (kills.filter(pl.col("victim_steamid") > 0)
              .group_by("round_num", pl.col("victim_steamid").alias("steamid"))
              .agg(pl.len().alias("deaths"), pl.col("victim_traded").fill_null(False).sum().alias("deaths_traded")))
    return per.join(deaths, on=["round_num", "steamid"], how="full", coalesce=True)


def map_resources(ref: MapRef) -> pl.DataFrame:
    import warnings

    # Each side of every as-of join is sorted on its key; polars can't verify that when `by` groups are given.
    warnings.filterwarnings("ignore", message="Sortedness of columns cannot be checked")
    rounds = ref.table("rounds", ["round_num", "start_tick", "freeze_end_tick"])
    cols = sorted({*TICK_COLUMNS, "equipment_value", "money", "has_defuser", *UTILITY.values()})
    ticks = ref.table("ticks", cols)
    kills = ref.table("kills", [*KILL_COLUMNS, "victim_traded"])
    d = duels(kills, ref.table("damages", ["tick", "round_num", "attacker_steamid", "victim_steamid"]),
              ref.table("flashes", FLASH_COLUMNS), ticks, thrown_smokes(ref, ticks))
    counts = ["duels", "flash_support", "self_flash", "smoke_support", "deaths", "deaths_traded"]
    sup = support(d, kills).with_columns(pl.col("round_num").cast(pl.Int64))
    return (drops(economy(rounds, ticks).with_columns(pl.col("round_num").cast(pl.Int64)))
            .join(sup, on=["round_num", "steamid"], how="left")
            .with_columns(pl.col(counts).fill_null(0).cast(pl.Int32), pl.lit(ref.key).alias("key"))
            .select("key", "round_num", "steamid", "side", *ECONOMY, "net_transfer", "drop_received", "drop_given",
                    *counts))


def smoke_attribution(refs: list[MapRef]) -> dict:
    """Share of smokes with a thrower found, over maps with grenades mirrored."""
    total = found = 0
    for ref in refs:
        ticks = ref.table("ticks", ["tick", "round_num", "steamid", "side", "x", "y", "smoke_grenades"])
        s = thrown_smokes(ref, ticks)
        if s is None:
            continue
        total += s.height
        found += s["thrower"].is_not_null().sum()
    return {"smokes": total, "attributed": found}


def build(only: str | None = None) -> pl.DataFrame:
    from concurrent.futures import ProcessPoolExecutor

    refs = [r for r in catalog() if r.key == only] if only else catalog()
    if len(refs) == 1:
        frames = [map_resources(refs[0])]
    else:
        with ProcessPoolExecutor(max_workers=6) as ex:
            frames = list(ex.map(map_resources, refs, chunksize=8))
    df = pl.concat(frames, how="vertical_relaxed")
    RESOURCE_ROUNDS.parent.mkdir(parents=True, exist_ok=True)
    if not only:
        df.write_parquet(RESOURCE_ROUNDS)
    return df
