"""Usage and conversion: each player-round's credit above the role baseline, split into team context, the player's
resources, and what they made of them (Phase 6, resources).

    above = context + usage + conversion        (exact, per player-round)
    context    = g(map, side, role, both teams' economy) − role baseline
    usage      = f(g's inputs + the player's own resources) − g
    conversion = credit − f
"""

import math

import numpy as np
import polars as pl

from .baselines import VERSIONS
from .data import MapRef, catalog
from .paths import CREDITS, RESOURCE_ROUNDS, ROLE_ROUNDS, STATES, USAGE, USAGE_ROUNDS, WAR_REPORTS
from .resources import DROP_MIN, GUN_RANK
from .states import CT, UTILITY

TEAM = ["map", "side", "role", "team_equip", "opp_equip", "team_buy", "opp_buy", "pistol"]
OWN = ["equip", "equip_share", "gun", "awp", "armor", "helmet", "has_defuser", *UTILITY]
DROP = ["net_transfer", "drop_received"]
CATEGORIES = {"team_buy": ["eco", "force", "full"], "opp_buy": ["eco", "force", "full"], "gun": GUN_RANK}
TERMS = ("context", "usage", "conversion")
PARAMS = dict(max_depth=4, learning_rate=0.1, subsample=0.8, colsample_bytree=0.8, min_child_weight=200)
MAX_TREES = 1000
FOLDS = 5
# Below this share of drop receivers with a matching giver, drops stay out of f and are reported as unverified.
MIN_DROP_MATCH = 0.8
MIN_PLAYER_ROUNDS = 300
TOP_N = 10


def load_rounds(refs: list[MapRef], resources: pl.DataFrame, rr: pl.DataFrame) -> pl.DataFrame:
    """One row per (key, round_num, steamid) with a role: credit and trade-return credit per version, the role
    baseline, and the round's resources. Rounds without credit count as zero, as in `baselines.side_rows`."""
    frames = []
    for ref in refs:
        cpath, rpath = CREDITS / f"{ref.slug}.parquet", STATES / ref.slug / "roster.parquet"
        if not cpath.exists() or not rpath.exists():
            continue
        roster = pl.read_parquet(rpath).select("key", pl.col("round_num").cast(pl.Int64), "steamid", "side")
        cred = (pl.read_parquet(cpath).with_columns(pl.col("round_num").cast(pl.Int64))
                .group_by("round_num", "steamid")
                .agg(*(pl.col(v).sum() for v in VERSIONS),
                     *(pl.col(v).filter(pl.col("role") == "trade_return").sum().alias(f"{v}_trade_return")
                       for v in VERSIONS)))
        frames.append(roster.join(cred, on=["round_num", "steamid"], how="left"))
    cols = [*VERSIONS, *(f"{v}_trade_return" for v in VERSIONS)]
    base = [f"{v}_baseline" for v in VERSIONS]
    roles = rr.filter(pl.col("role").is_not_null()).select("key", "steamid", "side", "map", "role", "date", "event",
                                                           "lp_team", "lp_player", *base)
    return (pl.concat(frames, how="vertical_relaxed").with_columns(pl.col(cols).fill_null(0.0))
            .join(roles, on=["key", "steamid", "side"])
            .join(resources.drop("side"), on=["key", "round_num", "steamid"], how="left")
            .sort("key", "round_num", "steamid"))


def drop_check(df: pl.DataFrame) -> dict:
    """Share of DROP_MIN+ receivers with a matching giver, and how far each team's summed transfer is from zero."""
    received = df.filter(pl.col("net_transfer") >= DROP_MIN)
    given = df.filter(pl.col("net_transfer") <= -DROP_MIN)
    team = (df.group_by("key", "round_num", "side").agg(pl.col("net_transfer").sum().alias("net"))
            .filter(pl.col("net").is_not_null()))
    net = df["net_transfer"].drop_nulls()
    return {
        "player_rounds": df.height,
        "zero": float((net == 0).mean()), "plus": float((net >= DROP_MIN).mean()),
        "minus": float((net <= -DROP_MIN).mean()), "p25": float(net.quantile(0.25)),
        "receivers": received.height, "matched": float(received["drop_received"].mean()) if received.height else math.nan,
        "givers": given.height, "given_matched": float(given["drop_given"].mean()) if given.height else math.nan,
        "team_mean": float(team["net"].mean()), "team_median": float(team["net"].median()),
        "team_small": float((team["net"].abs() < 500).mean()),
    }


def player_folds(df: pl.DataFrame, k: int = FOLDS) -> np.ndarray:
    """Fold per row, whole players per fold, largest players first onto the emptiest fold."""
    sizes = df.group_by("steamid").len().sort("len", "steamid", descending=True)
    load, fold_of = [0] * k, {}
    for sid, n in sizes.iter_rows():
        f = load.index(min(load))
        fold_of[sid], load[f] = f, load[f] + n
    return df["steamid"].replace_strict(fold_of, return_dtype=pl.Int64).to_numpy()


def _design(df: pl.DataFrame, cols: list[str], maps: list[str], roles: list[str]):
    import pandas as pd

    cats = {**CATEGORIES, "map": maps, "role": roles}
    x = df.select(pl.col(c) if c in cats else pl.col(c).cast(pl.Float32) for c in cols).to_pandas()
    for c in cols:
        if c in cats:
            x[c] = pd.Categorical(x[c], categories=cats[c])
    return x


class Expectation:
    """Expected credit per round from `cols`, cross-fit with whole players held out."""

    def __init__(self, df: pl.DataFrame, cols: list[str], device: str = "cpu"):
        self.cols, self.device = cols, device
        self.maps, self.roles = sorted(df["map"].unique().to_list()), sorted(df["role"].unique().to_list())
        self.monotone = tuple(1 if c == "equip" else 0 for c in cols)

    def x(self, df: pl.DataFrame):
        return _design(df, self.cols, self.maps, self.roles)

    def fit(self, df: pl.DataFrame, y: np.ndarray, n: int, val: tuple | None = None):
        from .pipeline import _fit_xgb

        kw = dict(eval_set=[val], early_stopping_rounds=50) if val is not None else {}
        return _fit_xgb(self.x(df), y, PARAMS, n_estimators=n, monotone_constraints=self.monotone,
                        device=self.device, objective="reg:squarederror", **kw)

    def cross_fit(self, df: pl.DataFrame, y: np.ndarray, folds: np.ndarray) -> tuple[np.ndarray, int]:
        hold = folds == 0
        probe = self.fit(df.filter(~hold), y[~hold], MAX_TREES, (self.x(df.filter(hold)), y[hold]))
        n = probe.best_iteration + 1
        out = np.empty(df.height)
        for f in range(folds.max() + 1):
            test = folds == f
            out[test] = self.fit(df.filter(~test), y[~test], n).predict(self.x(df.filter(test)))
        return out, n


def split(df: pl.DataFrame, own: list[str], device: str = "cpu") -> tuple[pl.DataFrame, dict]:
    """Adds `<v>_g`, `<v>_f` and the three terms per version. Returns the frame and tree counts per model."""
    folds = player_folds(df)
    g_model, f_model = Expectation(df, TEAM, device), Expectation(df, TEAM + own, device)
    trees, cols = {}, []
    for v in VERSIONS:
        y = df[v].to_numpy()
        g, trees[f"{v}_g"] = g_model.cross_fit(df, y, folds)
        f, trees[f"{v}_f"] = f_model.cross_fit(df, y, folds)
        cols += [pl.Series(f"{v}_g", g), pl.Series(f"{v}_f", f)]
    df = df.with_columns(*cols, pl.Series("fold", folds))
    return df.with_columns(
        expr for v in VERSIONS for expr in (
            (pl.col(f"{v}_g") - pl.col(f"{v}_baseline")).alias(f"{v}_context"),
            (pl.col(f"{v}_f") - pl.col(f"{v}_g")).alias(f"{v}_usage"),
            (pl.col(v) - pl.col(f"{v}_f")).alias(f"{v}_conversion"))), trees


def side_totals(df: pl.DataFrame) -> pl.DataFrame:
    """Per (key, steamid, side): the three terms summed per version, plus resource counts for the detail panel."""
    buy = {b: pl.col("team_buy") == b for b in ("eco", "force", "full")}
    return df.group_by("key", "steamid", "side").agg(
        pl.len().alias("rounds"),
        *(pl.col(f"{v}_{t}").sum() for v in VERSIONS for t in TERMS),
        *(pl.col(f"{v}_trade_return").sum() for v in VERSIONS),
        *(buy[b].sum().alias(f"{b}_rounds") for b in buy),
        *(pl.col("equip_share").filter(buy[b]).sum().alias(f"{b}_equip_share_sum") for b in buy),
        pl.col("awp").fill_null(False).sum().alias("awp_rounds"),
        pl.col("drop_received", "drop_given").fill_null(False).sum(),
        pl.col("duels", "flash_support", "self_flash", "smoke_support", "deaths", "deaths_traded").fill_null(0).sum(),
    )


def _rmse(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.sqrt(np.mean((y - p) ** 2)))


def _worth(df: pl.DataFrame, own: list[str], n: int, device: str, v: str = "wpa_opp") -> list[str]:
    """Average change in f when one resource is switched for every round in a subset, per 100 rounds."""
    model = Expectation(df, TEAM + own, device)
    fitted = model.fit(df, df[v].to_numpy(), n)
    full = df.filter((pl.col("team_buy") == "full") & ~pl.col("pistol"))
    rifle = full.filter(pl.col("gun") == "Rifle")
    cases = [
        ("AWP instead of rifle (full-buy rifle rounds)", rifle,
         {"gun": "AWP", "awp": True, "equip": pl.col("equip") + 1_900}, {}),
        ("+$1,000 own equipment (full-buy rounds)", full, {"equip": pl.col("equip") + 1_000}, {}),
        ("Rifle instead of SMG (force-buy SMG rounds)",
         df.filter((pl.col("team_buy") == "force") & (pl.col("gun") == "SMG")), {"gun": "Rifle"}, {}),
        ("Kit instead of none (CT full buys)", full.filter(pl.col("side") == CT), {"has_defuser": True},
         {"has_defuser": False}),
        ("Two more flashes (full-buy rounds)", full, {"flashes": pl.col("flashes") + 2}, {}),
    ]
    if "drop_received" in own:
        cases.append(("Drop received (+$1,500) instead of none (force/full rounds)",
                      df.filter(pl.col("team_buy") != "eco"),
                      {"drop_received": True, "net_transfer": pl.lit(1_500)},
                      {"drop_received": False, "net_transfer": pl.lit(0)}))
    lines = [f"| Switch ({v}) | Rounds | Change in expected credit / 100 rounds |", "| --- | --- | --- |"]
    for label, sub, hi, lo in cases:
        if sub.height == 0:
            continue
        a = fitted.predict(model.x(sub.with_columns(_lit(sub, c, e).alias(c) for c, e in hi.items())))
        b = fitted.predict(model.x(sub.with_columns(_lit(sub, c, e).alias(c) for c, e in lo.items()))) if lo else \
            fitted.predict(model.x(sub))
        lines.append(f"| {label} | {sub.height:,} | {100 * float(np.mean(a - b)):+.2f} |")
    return lines


def _lit(df: pl.DataFrame, col: str, value) -> pl.Expr:
    return (value if isinstance(value, pl.Expr) else pl.lit(value)).cast(df.schema[col])


def _calibration(df: pl.DataFrame, by: pl.Expr, label: str, v: str = "wpa_opp") -> list[str]:
    g = (df.with_columns(by.alias("_by")).group_by("_by")
         .agg(pl.len().alias("n"), *(pl.col(c).mean().alias(c) for c in (v, f"{v}_baseline", f"{v}_g", f"{v}_f")))
         .sort("_by"))
    lines = [f"| {label} | Rounds | Actual | Role baseline | g | f |", "| --- | --- | --- | --- | --- | --- |"]
    for r in g.iter_rows(named=True):
        lines.append(f"| {r['_by']} | {r['n']:,} | " + " | ".join(f"{100 * r[c]:+.2f}" for c in
                                                                  (v, f"{v}_baseline", f"{v}_g", f"{v}_f")) + " |")
    return lines


def player_totals(df: pl.DataFrame) -> pl.DataFrame:
    """Per player: rounds, the three terms and credit above baseline per 100 rounds (wpa_opp, no IGL adjustment)."""
    v = "wpa_opp"
    return (df.group_by("steamid").agg(
        pl.col("lp_player").drop_nulls().last(), pl.col("lp_team").drop_nulls().last(), pl.len().alias("rounds"),
        pl.col("role").filter(pl.col("side") != CT).mode().first().alias("t_role"),
        *(pl.col(f"{v}_{t}").sum().alias(t) for t in TERMS),
        (pl.col(v) - pl.col(f"{v}_baseline")).sum().alias("above"),
        pl.col("awp").fill_null(False).mean().alias("awp_rate"))
        .with_columns(*((100 * pl.col(c) / pl.col("rounds")).alias(c) for c in (*TERMS, "above"))))


def split_half_terms(df: pl.DataFrame, min_rounds: int = MIN_PLAYER_ROUNDS) -> dict[str, dict]:
    """Alternating-series split-half `k` for each term and for credit above baseline (wpa_opp, no IGL adjustment)."""
    from .warcheck import _alternating, _paired_halves

    v = "wpa_opp"
    pm = (df.group_by("key", "steamid")
          .agg(pl.col("date").first(), pl.len().alias("rounds"), *(pl.col(f"{v}_{t}").sum().alias(t) for t in TERMS),
               (pl.col(v) - pl.col(f"{v}_baseline")).sum().alias("above"))
          .with_columns(pl.col("key").str.split("/").list.first().alias("series")))
    elig = pm.group_by("steamid").agg(pl.col("rounds").sum()).filter(pl.col("rounds") >= min_rounds)["steamid"]
    sub = _alternating(pm.filter(pl.col("steamid").is_in(elig.implode())), ["steamid"])
    return {c: _paired_halves(sub, ["steamid"], c) for c in ("above", *TERMS)}


def _names(df: pl.DataFrame, col: str) -> str:
    return ", ".join(f"{p or s} {v:+.2f}" for p, s, v in zip(df["lp_player"], df["steamid"], df[col]))


def report(df: pl.DataFrame, drops: dict, use_drops: bool, trees: dict, worth: list[str], smokes: dict) -> list[str]:
    kf = lambda k: "n/a" if k is None else ("∞" if not math.isfinite(k) else f"{k:,.0f}")
    lines = ["# Resources: usage and conversion", "",
             f"{df.height:,} player-rounds on {df['key'].n_unique():,} maps. Expectations are cross-fit in {FOLDS} "
             "folds of whole players, so no player's expectation is fit on their own rounds. Per 100 rounds throughout.",
             "", "## 1. Drop inference", "",
             f"- Net transfer (equipment gained − money spent, round start to freeze end): exactly 0 on "
             f"{drops['zero']:.0%} of player-rounds, ≥ +${DROP_MIN:,} on {drops['plus']:.1%}, ≤ −${DROP_MIN:,} on "
             f"{drops['minus']:.1%}; 25th percentile {drops['p25']:+,.0f}.",
             f"- Receivers (≥ +${DROP_MIN:,}) with a teammate giving ≥ ${DROP_MIN:,} the same round: "
             f"{drops['matched']:.1%} of {drops['receivers']:,}. Givers with a matching receiver: "
             f"{drops['given_matched']:.1%} of {drops['givers']:,}.",
             f"- Team net transfer per round: mean {drops['team_mean']:+,.0f}, median {drops['team_median']:+,.0f}; "
             f"within ±$500 on {drops['team_small']:.0%} of team-rounds.",
             f"- Drops in f: **{'yes' if use_drops else 'no, unverified'}** (needs {MIN_DROP_MATCH:.0%} matched).",
             f"- Smokes with an inferred thrower: {smokes['attributed']:,} of {smokes['smokes']:,} "
             f"({smokes['attributed'] / max(smokes['smokes'], 1):.1%}).",
             "", "## 2. Model", "",
             "| Version | Trees g / f | RMSE role baseline | RMSE g | RMSE f |", "| --- | --- | --- | --- | --- |"]
    for v in VERSIONS:
        y = df[v].to_numpy()
        lines.append(f"| {v} | {trees[f'{v}_g']} / {trees[f'{v}_f']} | {_rmse(y, df[f'{v}_baseline'].to_numpy()):.5f} | "
                     f"{_rmse(y, df[f'{v}_g'].to_numpy()):.5f} | {_rmse(y, df[f'{v}_f'].to_numpy()):.5f} |")
    decile = (pl.col("equip").rank("ordinal") * 10 / pl.len()).floor().clip(0, 9).cast(pl.Int8) + 1
    lines += ["", "Mean credit per 100 rounds by the player's equipment decile and gun class (wpa_opp, out of fold):", "",
              *_calibration(df, decile, "Equip decile"), "", *_calibration(df, pl.col("gun").fill_null("None"), "Gun"),
              "", *worth, "", "## 3. Identity", ""]
    for v in VERSIONS:
        err = df.select((pl.col(f"{v}_context") + pl.col(f"{v}_usage") + pl.col(f"{v}_conversion")
                         - (pl.col(v) - pl.col(f"{v}_baseline"))).abs().max()).item()
        lines.append(f"- {v}: largest |context + usage + conversion − above| per round {err:.2e}.")
    ms = (df.group_by("map", "side").agg(pl.len().alias("n"), *(pl.col(f"wpa_opp_{t}").sum() for t in TERMS))
          .with_columns(*((100 * pl.col(f"wpa_opp_{t}") / pl.col("n")).alias(t) for t in TERMS)))
    lines += ["- Largest |sum per 100 rounds| over map × side (wpa_opp): "
              + ", ".join(f"{t} {ms[t].abs().max():.3f}" for t in TERMS) + "."]

    rel = split_half_terms(df)
    lines += ["", f"## 4. Split-half ({MIN_PLAYER_ROUNDS}+ rounds, alternating series, wpa_opp, before the IGL adjustment)",
              "", "| Term | Players | Half r | k |", "| --- | --- | --- | --- |"]
    for c, r in rel.items():
        half_r = "n/a" if r["r"] is None else f"{r['r']:.3f}"
        lines.append(f"| {c} | {r['players']} | {half_r} | {kf(r['k'])} |")
    k_above, k_conv = rel["above"]["k"], rel["conversion"]["k"]
    lines += ["", f"Preliminary site gate (conversion k ≤ 2 × above-baseline k): "
              f"{'pass' if k_conv is not None and k_above is not None and k_conv <= 2 * k_above else 'fail'} "
              f"({kf(k_conv)} vs {kf(k_above)}). `cs2wp validate-war` runs the final check with the IGL adjustment."]

    pt = player_totals(df).filter(pl.col("rounds") >= MIN_PLAYER_ROUNDS)
    lines += ["", f"## 6. Usage vs conversion within role ({MIN_PLAYER_ROUNDS}+ rounds, modal T role)", "",
              "Means are unweighted across players, so they sit below the rounds-weighted 0: players with fewer "
              "rounds tend to be below average.", "",
              "| T role | Players | r(usage, conversion) | Mean usage | Mean conversion |", "| --- | --- | --- | --- | --- |"]
    for role in sorted(pt["t_role"].drop_nulls().unique().to_list()):
        s = pt.filter(pl.col("t_role") == role)
        r = s.select(pl.corr("usage", "conversion")).item() if s.height > 2 else None
        lines.append(f"| {role} | {s.height} | {'n/a' if r is None else f'{r:+.2f}'} | {s['usage'].mean():+.2f} | "
                     f"{s['conversion'].mean():+.2f} |")
    ranked = pt.with_columns(pl.col("above").rank("ordinal", descending=True).alias("rank_above"),
                             pl.col("conversion").rank("ordinal", descending=True).alias("rank_conv"))
    moved = ranked.with_columns((pl.col("rank_above").cast(pl.Float64) - pl.col("rank_conv")).alias("rise"))
    lines += ["", "## 7. Sense checks", "",
              f"- Top usage: {_names(pt.sort('usage', descending=True).head(TOP_N), 'usage')}",
              f"- Bottom usage: {_names(pt.sort('usage').head(TOP_N), 'usage')}",
              f"- Top conversion: {_names(pt.sort('conversion', descending=True).head(TOP_N), 'conversion')}",
              f"- Rise most, conversion rank vs above-baseline rank (places): "
              f"{_names(moved.sort('rise', descending=True).head(TOP_N), 'rise')}",
              f"- Fall most: {_names(moved.sort('rise').head(TOP_N), 'rise')}",
              f"- High usage (top quarter), negative conversion: "
              f"{_names(pt.filter((pl.col('usage') >= pt['usage'].quantile(0.75)) & (pl.col('conversion') < 0)).sort('conversion').head(TOP_N), 'conversion')}",
              f"- AWPers' mean usage {pt.filter(pl.col('awp_rate') >= 0.3)['usage'].mean():+.2f} vs others "
              f"{pt.filter(pl.col('awp_rate') < 0.3)['usage'].mean():+.2f}."]
    return lines


def build(only: str | None = None, device: str = "cpu") -> int:
    import warnings

    from . import resources
    from .pipeline import resolve_device

    warnings.filterwarnings("ignore", message="Sortedness of columns cannot be checked")
    if only:
        df = resources.build(only)
        with pl.Config(tbl_rows=30, tbl_cols=40, tbl_width_chars=250):
            print(df.sort("round_num", "side", "steamid"))
            print(df.select(pl.col("net_transfer", "duels", "flash_support", "self_flash", "smoke_support")).describe())
        return 0
    refs = catalog()
    res = resources.build()
    print(f"wrote {RESOURCE_ROUNDS} ({res.height} player-rounds)")
    df = load_rounds(refs, res, pl.read_parquet(ROLE_ROUNDS))
    if missing := df["equip"].null_count():
        print(f"{missing} player-rounds have no resources; their inputs stay missing so WAA still splits exactly")
    drops = drop_check(df)
    use_drops = drops["matched"] >= MIN_DROP_MATCH
    own = OWN + (DROP if use_drops else [])
    resolved = resolve_device(device)
    df, trees = split(df, own, resolved)
    worth = _worth(df, own, trees["wpa_opp_f"], resolved)
    smokes = resources.smoke_attribution(refs)

    USAGE.parent.mkdir(parents=True, exist_ok=True)
    df.select("key", "round_num", "steamid", "side",
              *(f"{v}_{c}" for v in VERSIONS for c in ("g", "f", *TERMS))).write_parquet(USAGE_ROUNDS)
    side_totals(df).write_parquet(USAGE)
    lines = report(df, drops, use_drops, trees, worth, smokes)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "usage.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {USAGE_ROUNDS} ({df.height} player-rounds) and {USAGE}")
    return 0
