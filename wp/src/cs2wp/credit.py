"""Credit for each action: the change in round win probability it causes, given to the players involved."""

import numpy as np
import polars as pl

from .states import CT

# Share of a flash-assisted kill's value that goes to the flasher.
FLASH_SHARE = 0.5
# Share of a traded death's cost given back to the player who died.
TRADE_RETURN = 0.5
# Neutral buckets with fewer training events than this fall back to a coarser bucket.
MIN_BUCKET = 200


def event_kind(events: pl.DataFrame) -> pl.Expr:
    """`kill`, `damage_<band>`, `team_damage`, `self_damage`, `plant` or `defuse`."""
    band = (
        pl.when(pl.col("dmg") < 25).then(pl.lit("damage_1-24"))
        .when(pl.col("dmg") < 50).then(pl.lit("damage_25-49"))
        .when(pl.col("dmg") < 100).then(pl.lit("damage_50-99"))
        .otherwise(pl.lit("damage_100+"))
    )
    return (
        pl.when(pl.col("kind") != "damage").then(pl.col("kind"))
        .when(pl.col("actor").is_null() | (pl.col("actor") == pl.col("victim"))).then(pl.lit("self_damage"))
        .when(pl.col("actor_side") == pl.col("victim_side")).then(pl.lit("team_damage"))
        .when(pl.col("lethal")).then(pl.lit("kill"))
        .otherwise(band)
    )


def with_values(events: pl.DataFrame, p_pre: np.ndarray, p_post: np.ndarray) -> pl.DataFrame:
    """Adds `v`: the change in the actor's side's win probability (the victim's, for self damage)."""
    post = np.where(np.isnan(events["terminal"].to_numpy()), p_post, events["terminal"].to_numpy())
    events = events.with_columns(pl.Series("p_pre", p_pre), pl.Series("p_post", post), event_kind(events).alias("event"))
    ct_delta = pl.col("p_post") - pl.col("p_pre")
    side = pl.when(pl.col("event") == "self_damage").then(pl.col("victim_side")).otherwise(pl.col("actor_side"))
    return events.with_columns(pl.when(side == CT).then(ct_delta).otherwise(-ct_delta).alias("v"))


def neutral_tables(train_events: pl.DataFrame) -> dict[str, pl.DataFrame]:
    """Mean V per bucket, fit on training maps only, coarse (event, side, planted) and with man counts."""
    ev = _bucket_columns(train_events)
    coarse = ev.group_by("event", "actor_side", "pre_bomb_planted").agg(pl.col("v").mean().alias("v_event"), pl.len().alias("n_event"))
    fine = ev.group_by("event", "actor_side", "pre_bomb_planted", "own_alive", "opp_alive").agg(
        pl.col("v").mean().alias("v_mancount"), pl.len().alias("n_mancount")
    )
    base = ev.group_by("event", "actor_side").agg(pl.col("v").mean().alias("v_base"), pl.len().alias("n_base"))
    return {"coarse": coarse, "fine": fine, "base": base}


def _bucket_columns(events: pl.DataFrame) -> pl.DataFrame:
    own = pl.when(pl.col("actor_side") == CT).then(pl.col("pre_ct_alive")).otherwise(pl.col("pre_t_alive"))
    opp = pl.when(pl.col("actor_side") == CT).then(pl.col("pre_t_alive")).otherwise(pl.col("pre_ct_alive"))
    return events.with_columns(own.alias("own_alive"), opp.alias("opp_alive"))


def neutral_values(events: pl.DataFrame, tables: dict[str, pl.DataFrame]) -> pl.DataFrame:
    """Adds `v_event` and `v_mancount`, falling back to coarser buckets where training had too few events."""
    ev = _bucket_columns(events)
    ev = ev.join(tables["coarse"], on=["event", "actor_side", "pre_bomb_planted"], how="left")
    ev = ev.join(tables["fine"], on=["event", "actor_side", "pre_bomb_planted", "own_alive", "opp_alive"], how="left")
    ev = ev.join(tables["base"], on=["event", "actor_side"], how="left")
    fallback = pl.coalesce(pl.col("v_base"), pl.col("v"))
    coarse = pl.when(pl.col("n_event") >= MIN_BUCKET).then(pl.col("v_event")).otherwise(fallback)
    return ev.with_columns(
        coarse.alias("v_event"),
        pl.when(pl.col("n_mancount") >= MIN_BUCKET).then(pl.col("v_mancount")).otherwise(coarse).alias("v_mancount"),
    )


def shares(e: dict) -> list[tuple[int, str, float]]:
    """(steamid, role, weight) for one event; a player's credit is weight × the event's value.

    The actor gets the value and the victim its negative. A flash-assisted kill splits the actor's part with the
    flasher. A traded death gets back TRADE_RETURN of its cost. A plant or defuse splits the negative evenly among
    the other side's alive players (a known simplification: which of them let it happen isn't modeled).
    """
    kind = e["event"]
    if kind in ("plant", "defuse"):
        others = (e["alive_ct"] if kind == "plant" else e["alive_t"]) or []
        return [(e["actor"], kind, 1.0)] + [(sid, f"{kind}_against", -1.0 / len(others)) for sid in others]
    if kind == "self_damage":
        return [(e["victim"], kind, 1.0)]
    if kind == "team_damage":
        return [(e["actor"], kind, 1.0)]
    out = []
    flasher = e["flash_assister"]
    if kind == "kill" and flasher and flasher != e["actor"]:
        out += [(e["actor"], kind, 1 - FLASH_SHARE), (flasher, "flash_assist", FLASH_SHARE)]
    else:
        out.append((e["actor"], kind, 1.0))
    out.append((e["victim"], "death" if kind == "kill" else "damaged", -1.0))
    if kind == "kill" and e["traded"]:
        out.append((e["victim"], "trade_return", TRADE_RETURN))
    return out


VALUES = {"wpa": "v", "nwpa_event": "v_event", "nwpa_mancount": "v_mancount"}


def attribute(events: pl.DataFrame) -> pl.DataFrame:
    """One row per (event, player, role) with that player's share of each version's value."""
    rows: list[dict] = []
    for e in events.iter_rows(named=True):
        if e["v"] is None or np.isnan(e["v"]):
            continue
        base = {"key": e["key"], "date": e["date"], "round_num": e["round_num"], "seq": e["seq"], "event": e["event"]}
        for sid, role, w in shares(e):
            if sid is None:
                continue
            rows.append({**base, "steamid": sid, "role": role, **{out: w * e[col] for out, col in VALUES.items()}})
    schema = {"key": pl.Utf8, "date": pl.Utf8, "round_num": pl.Int64, "seq": pl.Int64, "event": pl.Utf8,
              "steamid": pl.UInt64, "role": pl.Utf8, **{out: pl.Float64 for out in VALUES}}
    return pl.DataFrame(rows, schema=schema)
