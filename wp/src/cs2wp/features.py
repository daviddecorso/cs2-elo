"""Features derived from stored state columns, so adding one needs no state rebuild."""

import polars as pl

BOMB_SECONDS = 40.0


def _at_site(prefix: str, a: str, b: str) -> pl.Expr:
    site = pl.col(f"{prefix}bomb_site")
    return (pl.when(site == "A").then(pl.col(f"{prefix}{a}")).when(site == "B").then(pl.col(f"{prefix}{b}"))
            .otherwise(None).fill_nan(None))


def with_derived(df: pl.DataFrame, prefix: str = "") -> pl.DataFrame:
    """Adds each derived column whose inputs are present:

    - `ct_bomb_graph`: the nearest alive CT's nav distance to the planted site, null before the plant.
    - `alive_diff`: CT alive minus T alive.
    - `kit_frac`: share of alive CTs with a kit, null with no CT alive.
    - `kit_time`: CT kits × bomb seconds left, null before the plant.
    """
    have = set(df.columns)
    def col(c: str) -> pl.Expr:
        return pl.col(f"{prefix}{c}")

    out = []
    if {f"{prefix}{c}" for c in ("bomb_site", "ct_graph_a", "ct_graph_b")} <= have:
        out.append(_at_site(prefix, "ct_graph_a", "ct_graph_b").alias(f"{prefix}ct_bomb_graph"))
    if {f"{prefix}ct_alive", f"{prefix}t_alive"} <= have:
        out.append((col("ct_alive").cast(pl.Float32) - col("t_alive").cast(pl.Float32)).alias(f"{prefix}alive_diff"))
    if {f"{prefix}ct_kits", f"{prefix}ct_alive"} <= have:
        out.append(pl.when(col("ct_alive") > 0).then(col("ct_kits").cast(pl.Float32) / col("ct_alive").cast(pl.Float32))
                   .otherwise(None).alias(f"{prefix}kit_frac"))
    if {f"{prefix}ct_kits", f"{prefix}since_plant"} <= have:
        left = (BOMB_SECONDS - col("since_plant").cast(pl.Float32).fill_nan(None)).clip(lower_bound=0.0)
        out.append((col("ct_kits").cast(pl.Float32) * left).alias(f"{prefix}kit_time"))
    return df.with_columns(out) if out else df
