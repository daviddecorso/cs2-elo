"""Check pooled T roles and CT positions against NER0cs's role labels (via the CS2 Playstyle Dataset, 2024)."""

import polars as pl

from .paths import CT_POSITIONS, PLAYSTYLE_2024, T_ROLES, WAR_REPORTS

MIN_MAPS = 10
AWPER_MAP_SHARE = 0.5
SITE_POSITIONS = ("A", "B")
T_LABELS = ("AWPer", "Spacetaker", "Half-Lurker", "Lurker")
CT_LABELS = ("AWPer", "Anchor", "Mixed", "Rotator")


def load_labels(path=PLAYSTYLE_2024) -> pl.DataFrame:
    return (pl.read_csv(path).select(pl.col("steamid").cast(pl.UInt64), "player_name", "team_clan_name",
                                     pl.col("map_count").alias("their_maps"), "oap_t", "role_t", "role_ct"))


def pool_t(roles: pl.DataFrame) -> pl.DataFrame:
    return (roles.group_by("steamid")
            .agg(pl.len().alias("maps"), pl.col("lp_player").sort_by("date").last(),
                 ((pl.col("opening_kills") + pl.col("opening_deaths")).sum() / pl.col("t_rounds").sum()).alias("entry"),
                 ((pl.col("t_awp_rounds") + pl.col("ct_awp_rounds")).sum()
                  / (pl.col("t_buy_rounds") + pl.col("ct_buy_rounds")).sum()).alias("awp"),
                 (pl.col("t_role") == "AWPer").mean().alias("awper_maps"),
                 (pl.col("t_role") == "Entry").mean().alias("entry_maps"))
            .filter(pl.col("maps") >= MIN_MAPS)
            .with_columns((pl.col("awper_maps") > AWPER_MAP_SHARE).alias("awper")))


def pool_ct(positions: pl.DataFrame) -> pl.DataFrame:
    return (positions.group_by("steamid")
            .agg(pl.len().alias("ct_maps"), pl.col("position").is_in(SITE_POSITIONS).mean().alias("site_share"))
            .filter(pl.col("ct_maps") >= MIN_MAPS))


def auc(pos: list[float], neg: list[float]) -> float:
    """Probability a random `pos` value beats a random `neg` value, ties counting half."""
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def _side(df: pl.DataFrame, label: str, order: tuple[str, ...], cols: dict[str, str]) -> list[str]:
    head = "| NER0cs role | Players | " + " | ".join(cols) + " |"
    lines = [head, "|" + " --- |" * (2 + len(cols))]
    for role in order:
        d = df.filter(pl.col(label) == role)
        lines.append(f"| {role} | {d.height} | " + " | ".join(f"{d[c].median():.2f}" for c in cols.values()) + " |")
    return lines


def report(roles: pl.DataFrame, positions: pl.DataFrame, labels: pl.DataFrame) -> list[str]:
    t = pool_t(roles).join(labels.filter(pl.col("role_t").is_not_null()), on="steamid")
    ct = pool_ct(positions).join(labels.filter(pl.col("role_ct").is_not_null()), on="steamid")
    theirs = pl.col("role_t") == "AWPer"
    agree = t.filter(pl.col("awper") == theirs).height
    rifle = t.filter(~theirs)
    ent = {r: rifle.filter(pl.col("role_t") == r)["entry"].to_list() for r in T_LABELS[1:]}
    site = {r: ct.filter(pl.col("role_ct") == r)["site_share"].to_list() for r in CT_LABELS[1:]}
    misses = t.filter(pl.col("awper") != theirs).sort("maps", descending=True)

    return [
        "# Role validation", "",
        f"Our pooled roles (players with {MIN_MAPS}+ maps) against NER0cs's 2024 role labels.", "",
        "## T side", "",
        *_side(t, "role_t", T_LABELS, {"Entry share": "entry", "Maps as Entry": "entry_maps",
                                       "AWP share": "awp", "Maps as AWPer": "awper_maps",
                                       "Their opening attempts": "oap_t"}), "",
        f"- AWPer (AWPer on over half their maps) agrees on {agree}/{t.height} players.",
        f"- Entry share, Spacetaker over Lurker: AUC {auc(ent['Spacetaker'], ent['Lurker']):.2f}. "
        f"Spacetaker over Half-Lurker {auc(ent['Spacetaker'], ent['Half-Lurker']):.2f}, "
        f"Half-Lurker over Lurker {auc(ent['Half-Lurker'], ent['Lurker']):.2f}.",
        f"- Entry share against their 2024 opening-attempt rate: r = {t.select(pl.corr('entry', 'oap_t')).item():.2f}.",
        "", "AWPer disagreements:", "",
        *[f"- {r['lp_player'] or r['player_name']} ({r['team_clan_name']} in 2024, {r['role_t']}): "
          f"AWP share {r['awp']:.2f}, AWPer on {r['awper_maps']:.0%} of {r['maps']} maps"
          for r in misses.iter_rows(named=True)],
        "", "## CT side", "",
        *_side(ct, "role_ct", CT_LABELS, {"Share of maps at A or B": "site_share"}), "",
        f"- Site share, Anchor over Rotator: AUC {auc(site['Anchor'], site['Rotator']):.2f}. "
        f"Mixed over Rotator {auc(site['Mixed'], site['Rotator']):.2f}, "
        f"Anchor over Mixed {auc(site['Anchor'], site['Mixed']):.2f}.",
        "", "Role labels: Harry Richards (NER0cs) Positions Database, via the CS2 Playstyle & Roles Dataset (2024) "
        "by Jamie Packer, CC BY 4.0.",
    ]


def build() -> int:
    lines = report(pl.read_parquet(T_ROLES), pl.read_parquet(CT_POSITIONS), load_labels())
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "role-validation.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0
