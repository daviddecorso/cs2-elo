"""Features derived from stored state columns, so adding one needs no state rebuild."""

import polars as pl


def _at_site(prefix: str, a: str, b: str) -> pl.Expr:
    site = pl.col(f"{prefix}bomb_site")
    return (pl.when(site == "A").then(pl.col(f"{prefix}{a}")).when(site == "B").then(pl.col(f"{prefix}{b}"))
            .otherwise(None).fill_nan(None))


def with_derived(df: pl.DataFrame, prefix: str = "") -> pl.DataFrame:
    """Adds `ct_bomb_graph`, the nearest alive CT's nav distance to the planted site (null before the plant), when its
    inputs are present."""
    if {f"{prefix}{c}" for c in ("bomb_site", "ct_graph_a", "ct_graph_b")} <= set(df.columns):
        return df.with_columns(_at_site(prefix, "ct_graph_a", "ct_graph_b").alias(f"{prefix}ct_bomb_graph"))
    return df
