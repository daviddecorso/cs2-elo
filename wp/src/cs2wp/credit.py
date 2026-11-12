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


def with_values(
    events: pl.DataFrame, p_pre: np.ndarray, p_post: np.ndarray, own_average: dict[str, tuple[np.ndarray, np.ndarray]] | None = None
) -> pl.DataFrame:
    """Adds `v`: the change in the actor's side's win probability (the victim's, for self damage).

    `own_average` maps "ct" or "t" to (p_pre, p_post) from the model with that side's team at league-average Elo and
    the opponent at its own. Each becomes `v_opp_<side>`, on the same actor-side sign as `v`.
    """
    terminal = events["terminal"].to_numpy()
    side = pl.when(pl.col("event") == "self_damage").then(pl.col("victim_side")).otherwise(pl.col("actor_side"))
    sign = pl.when(side == CT).then(1.0).otherwise(-1.0)
    events = events.with_columns(pl.Series("p_pre", p_pre), pl.Series("p_post", np.where(np.isnan(terminal), p_post, terminal)),
                                 event_kind(events).alias("event"))
    events = events.with_columns((sign * (pl.col("p_post") - pl.col("p_pre"))).alias("v"))
    for s, (pre, post) in (own_average or {}).items():
        delta = np.where(np.isnan(terminal), post, terminal) - pre
        events = events.with_columns((sign * pl.Series(delta)).alias(f"v_opp_{s}"))
    return events


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
# Shares that go to the side opposite the one `v` is measured for.
OPPOSITE_ROLES = {"death", "damaged", "trade_return", "plant_against", "defuse_against"}


def _wpa_opp(e: dict, role: str, w: float) -> float | None:
    """The player's share valued with their own team at league-average Elo, so credit isn't discounted by their team's strength."""
    v_side = e["victim_side"] if e["event"] == "self_damage" else e["actor_side"]
    own_ct = (v_side == CT) != (role in OPPOSITE_ROLES)
    v = e.get("v_opp_ct" if own_ct else "v_opp_t")
    return None if v is None else w * v


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
            rows.append({**base, "steamid": sid, "role": role, **{out: w * e[col] for out, col in VALUES.items()},
                         "wpa_opp": _wpa_opp(e, role, w)})
    schema = {"key": pl.Utf8, "date": pl.Utf8, "round_num": pl.Int64, "seq": pl.Int64, "event": pl.Utf8,
              "steamid": pl.UInt64, "role": pl.Utf8, **{out: pl.Float64 for out in VALUES}, "wpa_opp": pl.Float64}
    return pl.DataFrame(rows, schema=schema)


# XGBoost predicts in float32, so sums over a round carry rounding near 1e-8.
CONSERVATION_TOL = 1e-6
# Roles whose credit has no counterpart on the other side, so a side's total drifts from its probability change.
LEAKY_ROLES = ("trade_return", "self_damage", "team_damage")


def conservation(events: pl.DataFrame, credits: pl.DataFrame, roster: pl.DataFrame, p0: pl.DataFrame) -> pl.DataFrame:
    """Per round, whether each side's summed WPA equals its outcome minus its win probability at the first state.

    In CT terms, ct_win − p0 = events + drift + end exactly, where `events` sums each event's p_post − p_pre,
    `drift` is probability that moved between events (time, movement, utility; credited to nobody) and `end` is
    ct_win minus the last event's p_post (nonzero when the bomb explodes or time runs out). Credit covers `events`,
    less `leak_ct`/`leak_t`: trade returns, self and team damage, world damage and players missing from the roster.

    `p0`: round_num, ct_win, p0. `events`: valued (with_values) events. Returns one row per round in `p0`.
    """
    e = events.filter(pl.col("v").is_not_null() & pl.col("v").is_not_nan()).sort("round_num", "seq")
    per = e.group_by("round_num").agg(
        (pl.col("p_post") - pl.col("p_pre")).sum().alias("events"),
        pl.col("p_pre").first().alias("first_pre"),
        (pl.col("p_pre").shift(-1) - pl.col("p_post")).sum().alias("between"),
        pl.col("p_post").last().alias("last_post"),
        pl.len().alias("n_events"),
    )
    sides = credits.join(roster.select("round_num", "steamid", "side"), on=["round_num", "steamid"], how="left")
    by_side = sides.group_by("round_num").agg(
        pl.col("wpa").filter(pl.col("side") == CT).sum().alias("credit_ct"),
        pl.col("wpa").filter(pl.col("side") != CT).sum().alias("credit_t"),
        pl.col("wpa").filter(pl.col("side").is_null()).sum().alias("unrostered"),
        pl.col("wpa").filter(pl.col("role") == "trade_return").sum().alias("trade_return"),
        pl.col("role").is_in(["self_damage", "team_damage"]).sum().alias("self_team_events"),
        ((pl.col("role") == "defuse").any() & ~(pl.col("role") == "defuse_against").any()).alias("lone_defuse"),
    )
    y = pl.col("ct_win").cast(pl.Float64)
    r = (
        p0.join(per, on="round_num", how="left").join(by_side, on="round_num", how="left")
        .with_columns(pl.col("events", "between", "credit_ct", "credit_t", "unrostered", "trade_return").fill_null(0.0),
                      pl.col("n_events", "self_team_events").fill_null(0), pl.col("lone_defuse").fill_null(False))
        .with_columns(
            (y - pl.col("p0")).alias("target"),
            pl.when(pl.col("n_events") > 0).then(pl.col("first_pre") - pl.col("p0") + pl.col("between"))
            .otherwise(0.0).alias("drift"),
            (y - pl.coalesce(pl.col("last_post"), pl.col("p0"))).alias("end"),
        )
        .with_columns(
            (pl.col("credit_ct") - pl.col("events")).alias("leak_ct"),
            (pl.col("credit_t") + pl.col("events")).alias("leak_t"),
            (pl.col("target") - pl.col("events") - pl.col("drift") - pl.col("end")).alias("identity_error"),
        )
    )
    def big(c: str) -> pl.Expr:
        return pl.col(c).abs() > CONSERVATION_TOL

    tol = CONSERVATION_TOL
    reasons = pl.concat_list(
        pl.when(pl.col("n_events") == 0).then(pl.lit("no events")),
        pl.when(big("drift")).then(pl.lit("drift between events")),
        pl.when(big("end")).then(pl.lit("round ended without a deciding event")),
        pl.when(big("trade_return")).then(pl.lit("trade return")),
        pl.when(pl.col("self_team_events") > 0).then(pl.lit("self or team damage")),
        pl.when(big("unrostered")).then(pl.lit("credit to a player off the roster")),
        pl.when(pl.col("lone_defuse")).then(pl.lit("defuse with no T alive")),
        pl.when((big("leak_ct") | big("leak_t")) & ~big("trade_return") & (pl.col("self_team_events") == 0)
                & ~big("unrostered") & ~pl.col("lone_defuse")).then(pl.lit("other attribution leak")),
    ).list.drop_nulls()
    passed = ((pl.col("credit_ct") - pl.col("target")).abs() <= tol) & ((pl.col("credit_t") + pl.col("target")).abs() <= tol)
    return r.with_columns(passed.alias("passed"), reasons.alias("reasons")).select(
        "round_num", "ct_win", "p0", "target", "events", "drift", "end", "credit_ct", "credit_t", "leak_ct", "leak_t",
        "trade_return", "self_team_events", "unrostered", "n_events", "identity_error", "passed", "reasons")
