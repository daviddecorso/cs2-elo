"""Features derived from stored state columns, so adding one needs no state rebuild."""

import polars as pl

# CS2 competitive: mp_c4timer 40 s; defuse takes 10 s, 5 s with a kit.
BOMB_SECONDS = 40.0
DEFUSE_SECONDS, KIT_DEFUSE_SECONDS = 10.0, 5.0
# Knife run speed in units/s, the fastest a retaking CT closes distance.
RUN_SPEED = 250.0


def _at_site(prefix: str, a: str, b: str) -> pl.Expr:
    site = pl.col(f"{prefix}bomb_site")
    return (pl.when(site == "A").then(pl.col(f"{prefix}{a}")).when(site == "B").then(pl.col(f"{prefix}{b}"))
            .otherwise(None).fill_nan(None))


def with_derived(df: pl.DataFrame, prefix: str = "") -> pl.DataFrame:
    """Adds, after the plant (null before):

    - `<prefix>ct_bomb_graph`: the nearest alive CT's nav distance to the planted site.
    - `<prefix>defuse_margin`: bomb time left minus the fastest defuse any alive CT could finish, in seconds: the
      minimum over CTs of travel at RUN_SPEED plus defuse time, 5 s with a kit and 10 s without. Needs
      `ct_kit_graph_a/b` (states built after 2026-11-12); null where they're missing or no CT is alive.
    """
    out = df.with_columns(_at_site(prefix, "ct_graph_a", "ct_graph_b").alias(f"{prefix}ct_bomb_graph"))
    if f"{prefix}ct_kit_graph_a" not in df.columns:
        return out
    any_ct = pl.col(f"{prefix}ct_bomb_graph") / RUN_SPEED + DEFUSE_SECONDS
    kit_ct = _at_site(prefix, "ct_kit_graph_a", "ct_kit_graph_b") / RUN_SPEED + KIT_DEFUSE_SECONDS
    left = BOMB_SECONDS - pl.col(f"{prefix}since_plant").fill_nan(None)
    return out.with_columns((left - pl.min_horizontal(any_ct, kit_ct)).alias(f"{prefix}defuse_margin"))
