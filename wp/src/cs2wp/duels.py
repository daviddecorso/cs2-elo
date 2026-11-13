"""Expected duels: each kill's win probability from weapons, peeker vs holder, flashes, HP and distance (Phase 6, item 5)."""

import numpy as np
import polars as pl

from . import evaluate as ev
from .data import MapRef, catalog
from .paths import DUEL_SIDES, DUELS, ROLE_ROUNDS, WAR_REPORTS
from .states import CT, SIDE_CODE, TICK_RATE, T

GUN_CLASS = {
    "awp": "AWP", "ssg08": "Scout", "g3sg1": "Auto", "scar20": "Auto",
    **dict.fromkeys(("ak47", "m4a1", "m4a1_silencer", "aug", "sg556"), "Rifle"),
    **dict.fromkeys(("galilar", "famas"), "Cheap rifle"),
    **dict.fromkeys(("mp9", "mac10", "mp7", "mp5sd", "ump45", "p90", "bizon"), "SMG"),
    **dict.fromkeys(("deagle", "revolver"), "Deagle"),
    **dict.fromkeys(("glock", "usp_silencer", "hkp2000", "p250", "fiveseven", "tec9", "cz75a", "elite"), "Pistol"),
    **dict.fromkeys(("nova", "xm1014", "mag7", "sawedoff", "m249", "negev"), "Heavy"),
}
GUNS = sorted(set(GUN_CLASS.values()))
# The first damage between the two players within this many ticks before the kill starts the duel.
DUEL_WINDOW = 3 * TICK_RATE
# Speed is the fastest 4 Hz sample in the second before the duel starts: peekers counter-strafe before they shoot.
PEEK_WINDOW = TICK_RATE
PLAYER = ["gun", "hp", "armor", "helmet", "speed", "blind"]
GROUPS = {"weapons": ["x_gun", "y_gun"], "peeker vs holder": ["x_speed", "y_speed"], "flashed": ["x_blind", "y_blind"],
          "HP and armor": ["x_hp", "y_hp", "x_armor", "y_armor", "x_helmet", "y_helmet"], "distance": ["distance"],
          "side": ["x_ct"]}
FEATURES = [c for cols in GROUPS.values() for c in cols]
MONOTONE = {"x_hp": 1, "y_hp": -1, "x_blind": -1, "y_blind": 1}
PARAMS = dict(max_depth=4, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8, min_child_weight=50)
MAX_TREES = 2000
FOLDS = 5
MIN_MONTH_DUELS = 40
MIN_PLAYER_DUELS = 300
CAL_BINS = 20


def _guns(col: str) -> pl.Expr:
    return pl.col(col).replace_strict(GUN_CLASS, default=None)


def _player_state(ticks: pl.DataFrame) -> pl.DataFrame:
    """Per 4 Hz tick and player: the last gun held this round, HP, armor and the top speed over the past second."""
    window = PEEK_WINDOW // 16 + 1
    return (ticks.filter(pl.col("steamid") > 0).sort("steamid", "tick")
            .with_columns(_guns("active_weapon").forward_fill().over("steamid", "round_num").alias("gun"),
                          pl.col("velocity").rolling_max(window, min_samples=1).over("steamid", "round_num")
                          .alias("speed"))
            .select("tick", "steamid", pl.col("round_num").alias("tick_round"), "gun",
                    pl.col("health").alias("hp"), "armor", pl.col("has_helmet").alias("helmet"), "speed"))


def duels(kills: pl.DataFrame, damages: pl.DataFrame, flashes: pl.DataFrame, ticks: pl.DataFrame) -> pl.DataFrame:
    """One row per gun kill between opponents, with each player's state just before the duel started.

    Columns: round_num, tick, start, attacker, victim, attacker_side, kill_gun, distance, and a_/v_ copies of PLAYER
    for the attacker and the victim.
    """
    k = (kills.filter(pl.col("attacker_steamid").is_not_null() & (pl.col("attacker_steamid") > 0)
                      & pl.col("attacker_side").is_in(list(SIDE_CODE)) & pl.col("victim_side").is_in(list(SIDE_CODE))
                      & (pl.col("attacker_side") != pl.col("victim_side")) & _guns("weapon").is_not_null())
         .with_row_index("kill")
         .select("kill", "round_num", "tick", pl.col("attacker_steamid").alias("attacker"),
                 pl.col("victim_steamid").alias("victim"),
                 pl.col("attacker_side").replace_strict(SIDE_CODE).alias("attacker_side"),
                 _guns("weapon").alias("kill_gun"),
                 ((pl.col("attacker_x") - pl.col("victim_x")) ** 2 + (pl.col("attacker_y") - pl.col("victim_y")) ** 2
                  + (pl.col("attacker_z") - pl.col("victim_z")) ** 2).sqrt().alias("distance")))
    d = damages.select("round_num", pl.col("tick").alias("dtick"), pl.col("attacker_steamid").alias("p"),
                       pl.col("victim_steamid").alias("q"))
    pair = pl.concat([k.join(d, left_on=["round_num", "attacker", "victim"], right_on=["round_num", "p", "q"]),
                      k.join(d, left_on=["round_num", "victim", "attacker"], right_on=["round_num", "p", "q"])])
    first = (pair.filter(pl.col("dtick").is_between(pl.col("tick") - DUEL_WINDOW, pl.col("tick")))
             .group_by("kill").agg(pl.col("dtick").min()))
    k = (k.join(first, on="kill", how="left").with_columns(pl.coalesce("dtick", "tick").alias("start")).drop("dtick")
         .with_columns((pl.col("start") - 1).alias("_at")).sort("_at"))

    state = _player_state(ticks)
    blind = flashes.filter(pl.col("victim_steamid") > 0).select(
        "round_num", pl.col("victim_steamid").alias("steamid"), pl.col("tick").alias("bfrom"),
        (pl.col("tick") + pl.col("duration") * TICK_RATE).alias("bto"))
    for who, p in (("attacker", "a_"), ("victim", "v_")):
        k = (k.join_asof(state, left_on="_at", right_on="tick", by_left=who, by_right="steamid", strategy="backward",
                         tolerance=PEEK_WINDOW, suffix="_s")
             .with_columns(pl.when(pl.col("tick_round") == pl.col("round_num")).then(pl.col(c)).alias(c)
                           for c in ("gun", "hp", "armor", "helmet", "speed"))
             .drop("tick_s", "tick_round"))
        flashed = (k.select("kill", "round_num", who, "start", "tick")
                   .join(blind, left_on=["round_num", who], right_on=["round_num", "steamid"])
                   .filter((pl.col("bfrom") <= pl.col("tick")) & (pl.col("bto") >= pl.col("start")))
                   .select("kill").unique().with_columns(pl.lit(True).alias("blind")))
        k = (k.join(flashed, on="kill", how="left").with_columns(pl.col("blind").fill_null(False))
             .rename({c: p + c for c in PLAYER}))
    return k.drop("_at").sort("kill")


def oriented(d: pl.DataFrame) -> pl.DataFrame:
    """Each duel twice: x = attacker (win 1), then x = victim (win 0), so the model never sees which side won."""
    def side(x: str, y: str, win: int) -> pl.DataFrame:
        x_ct = (pl.col("attacker_side") == CT) if x == "a_" else (pl.col("attacker_side") != CT)
        return d.select(*[pl.col(x + c).alias("x_" + c) for c in PLAYER], *[pl.col(y + c).alias("y_" + c) for c in PLAYER],
                        "distance", x_ct.alias("x_ct"), pl.lit(win).alias("win"))
    return pl.concat([side("a_", "v_", 1), side("v_", "a_", 0)])


def _design(o: pl.DataFrame, cols: list[str]):
    import pandas as pd

    x = o.select(pl.col(c) if c.endswith("_gun") else pl.col(c).cast(pl.Float32) for c in cols).to_pandas()
    for c in cols:
        if c.endswith("_gun"):
            x[c] = pd.Categorical(x[c], categories=GUNS)
    return x


def fit(o: pl.DataFrame, cols: list[str], n_estimators: int, val: pl.DataFrame | None = None, device: str = "auto"):
    from .pipeline import _fit_xgb

    kw = {}
    if val is not None:
        kw = dict(eval_set=[(_design(val, cols), val["win"].to_numpy())], early_stopping_rounds=50)
    return _fit_xgb(_design(o, cols), o["win"].to_numpy(), PARAMS, n_estimators=n_estimators,
                    monotone_constraints=tuple(MONOTONE.get(c, 0) for c in cols), device=device, **kw)


def predict(model, d: pl.DataFrame, cols: list[str]) -> np.ndarray:
    """P(attacker wins), averaged over both orientations so P(a beats b) = 1 - P(b beats a) exactly."""
    f = model.predict_proba(_design(oriented(d), cols))[:, 1].astype(np.float64)
    return (f[:d.height] + 1 - f[d.height:]) / 2


def event_folds(d: pl.DataFrame, k: int = FOLDS) -> np.ndarray:
    """Fold per duel, whole events per fold, largest events first onto the emptiest fold."""
    sizes = d.group_by("event").len().sort("len", "event", descending=True)
    load, fold_of = [0] * k, {}
    for event, n in sizes.iter_rows():
        f = load.index(min(load))
        fold_of[event], load[f] = f, load[f] + n
    return d["event"].replace_strict(fold_of).to_numpy()


def cross_fit(d: pl.DataFrame, cols: list[str], folds: np.ndarray, device: str = "auto") -> tuple[np.ndarray, int]:
    """Out-of-fold P(attacker wins) for every duel. The tree count is early-stopped once, holding out fold 0."""
    probe = fit(oriented(d.filter(folds != 0)), cols, MAX_TREES, oriented(d.filter(folds == 0)), device=device)
    n = probe.best_iteration + 1
    p = np.empty(d.height)
    for f in range(folds.max() + 1):
        m = fit(oriented(d.filter(folds != f)), cols, n, device=device)
        p[folds == f] = predict(m, d.filter(folds == f), cols)
    return p, n


def side_totals(d: pl.DataFrame, p: np.ndarray) -> pl.DataFrame:
    """Per (key, steamid, side): duels, wins and expected wins, counting each duel once for each player."""
    side = pl.col("attacker_side").cast(pl.Int32)
    per = pl.concat([
        d.select("key", pl.col("attacker").alias("steamid"), side.alias("side"), pl.lit(1.0).alias("win"),
                 pl.Series("expected", p)),
        d.select("key", pl.col("victim").alias("steamid"), pl.when(side == CT).then(T).otherwise(CT).cast(pl.Int32)
                 .alias("side"), pl.lit(0.0).alias("win"), pl.Series("expected", 1 - p)),
    ])
    return per.group_by("key", "steamid", "side").agg(pl.len().cast(pl.Int64).alias("duels"),
                                                      pl.col("win").sum().alias("wins"), pl.col("expected").sum())


def _scores(p: np.ndarray) -> dict:
    y, pp = np.r_[np.ones(len(p)), np.zeros(len(p))], np.r_[p, 1 - p]
    return {**ev.scores(y, pp), **{k: ev.calibration(y, pp, CAL_BINS)[k] for k in ("max_gap", "slope")}}


def _worth(d: pl.DataFrame, cols: list[str], n: int, device: str = "auto") -> list[str]:
    """Average change in the attacker's P(win) when one input is switched for every duel, from a model fit on all."""
    model = fit(oriented(d), cols, n, device=device)
    still = {"a_speed": 0.0}
    cases = [("Holding (speed 0) instead of moving at 250", {"a_speed": 0.0}, {"a_speed": 250.0}),
             ("Not flashed instead of flashed", {"a_blind": False}, {"a_blind": True}),
             ("100 HP instead of 50", {"a_hp": 100}, {"a_hp": 50}),
             ("Rifle instead of Pistol", {"a_gun": "Rifle"}, {"a_gun": "Pistol"}),
             ("AWP instead of Rifle", {"a_gun": "AWP"}, {"a_gun": "Rifle"}),
             ("AWP instead of Rifle, holding", {"a_gun": "AWP", **still}, {"a_gun": "Rifle", **still}),
             ("AWP instead of Rifle, holding, duels at 1,500+ units", {"a_gun": "AWP", **still, "distance": 1500.0},
              {"a_gun": "Rifle", **still, "distance": 1500.0})]
    lines = ["| Switch, for the attacker in every duel | Change in P(win) |", "| --- | --- |"]
    for label, good, bad in cases:
        sub = d.filter(pl.col("distance") >= 1500) if "distance" in good else d
        hi, lo = (predict(model, sub.with_columns(pl.lit(v, dtype=d.schema[c]).alias(c) for c, v in case.items()
                                                  if c != "distance"), cols) for case in (good, bad))
        lines.append(f"| {label} | {np.mean(hi - lo):+.3f} |")
    return lines


def _by_role(sides: pl.DataFrame) -> list[str]:
    lines = ["| Side | Role | Player-map-sides | Duels per round | Win rate | Expected | Above per 100 duels | "
             "Above per 100 rounds |", "|" + " --- |" * 8]
    role = pl.when((pl.col("side") == CT) & (pl.col("role") != "AWPer")).then(pl.lit("Position")).otherwise("role")
    g = (sides.filter(pl.col("role").is_not_null()).with_columns(role.alias("group"))
         .group_by("side", "group").agg(pl.len().alias("n"), pl.col("duels", "wins", "expected", "rounds").sum())
         .sort(pl.col("side").neg(), "group"))
    for r in g.iter_rows(named=True):
        above = r["wins"] - r["expected"]
        lines.append(f"| {'CT' if r['side'] == CT else 'T'} | {r['group']} | {r['n']:,} | "
                     f"{r['duels'] / r['rounds']:.2f} | {r['wins'] / r['duels']:.3f} | {r['expected'] / r['duels']:.3f} | "
                     f"{100 * above / r['duels']:+.2f} | {100 * above / r['rounds']:+.2f} |")
    return lines


def stability(sides: pl.DataFrame) -> dict:
    """Month-to-month correlation of each player's win rate, expected rate and kills above expected per duel."""
    pm = (sides.filter(pl.col("lp_player").is_not_null())
          .group_by("lp_player", pl.col("date").str.slice(0, 7).alias("month")).agg(pl.col("duels", "wins", "expected").sum())
          .filter(pl.col("duels") >= MIN_MONTH_DUELS)
          .with_columns((pl.col("wins") / pl.col("duels")).alias("win_rate"),
                        (pl.col("expected") / pl.col("duels")).alias("expected_rate"),
                        ((pl.col("wins") - pl.col("expected")) / pl.col("duels")).alias("above")))
    months = sorted(pm["month"].unique().to_list())
    prev = dict(zip(months[1:], months))
    pairs = pm.join(pm.with_columns(pl.col("month").replace_strict(prev, default=None)), on=["lp_player", "month"],
                    suffix="_next")
    return {"pairs": pairs.height,
            **{c: pairs.select(pl.corr(c, c + "_next")).item() for c in ("win_rate", "expected_rate", "above")}}


def report(d: pl.DataFrame, rows: list[tuple[str, dict, int]], worth: list[str], sides: pl.DataFrame) -> list[str]:
    st = stability(sides)
    players = (sides.filter(pl.col("lp_player").is_not_null()).group_by("lp_player")
               .agg(pl.col("duels", "wins", "expected").sum()).filter(pl.col("duels") >= MIN_PLAYER_DUELS)
               .with_columns((pl.col("wins") / pl.col("duels")).alias("wr"), (pl.col("expected") / pl.col("duels")).alias("er")))
    lines = ["# Expected duels", "",
             f"{d.height:,} gun kills between opponents on {d['key'].n_unique():,} maps from {d['event'].n_unique()} events. "
             f"Predictions are out of fold: {FOLDS} folds of whole events. Scores count each duel from both players' side.",
             "", "| Inputs | Trees | Log loss | AUC | Max bin gap | Slope |", "|" + " --- |" * 6,
             "| None (0.5) | - | 0.6931 | 0.500 | - | - |"]
    lines += [f"| {label} | {n} | {s['log_loss']:.4f} | {s['auc']:.3f} | {s['max_gap']:.3f} | {s['slope']:.3f} |"
              for label, s, n in rows]
    lines += ["", *worth, "", *_by_role(sides), "",
              f"- Players with {MIN_PLAYER_DUELS}+ duels: {players.height}. Correlation of win rate with expected rate: "
              f"{players.select(pl.corr('wr', 'er')).item():.2f}. SD of win rate {players['wr'].std():.3f}, "
              f"of kills above expected per duel {(players['wr'] - players['er']).std():.3f}.",
              f"- Month to month ({st['pairs']} player-month pairs, {MIN_MONTH_DUELS}+ duels each): win rate "
              f"{st['win_rate']:.2f}, expected rate {st['expected_rate']:.2f}, kills above expected per duel "
              f"{st['above']:.2f}."]
    return lines


def build(ablations: bool = False, device: str = "auto") -> int:
    import warnings

    from .pipeline import resolve_device

    resolved = resolve_device(device)
    warnings.filterwarnings("ignore", message="Sortedness of columns cannot be checked")
    d = pl.concat([map_duels(r) for r in catalog() if (r.dir / "kills.parquet").exists()])
    folds = event_folds(d)
    p, n = cross_fit(d, FEATURES, folds, device=resolved)
    rows = [("All", _scores(p), n)]
    variants = [("Weapons only", GROUPS["weapons"])]
    if ablations:
        variants += [(f"All but {g}", [c for c in FEATURES if c not in cols]) for g, cols in GROUPS.items()]
    for label, cols in variants:
        pv, nv = cross_fit(d, cols, folds, device=resolved)
        rows.append((label, _scores(pv), nv))

    d = d.with_columns(pl.Series("p", p), pl.Series("fold", folds))
    rr = pl.read_parquet(ROLE_ROUNDS).select("key", "date", "map", "event", "lp_team", "lp_player", "steamid", "side",
                                            "role", "rounds")
    sides = (rr.join(side_totals(d, p), on=["key", "steamid", "side"], how="left")
             .with_columns(pl.col("duels").fill_null(0), pl.col("wins", "expected").fill_null(0.0))
             .with_columns((pl.col("wins") - pl.col("expected")).alias("kills_above")))
    DUELS.parent.mkdir(parents=True, exist_ok=True)
    d.write_parquet(DUELS)
    sides.write_parquet(DUEL_SIDES)
    lines = report(d, rows, _worth(d, FEATURES, n, device=resolved), sides)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "duels.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {DUELS} ({d.height} duels) and {DUEL_SIDES} ({sides.height} player-map-sides)")
    return 0


def map_duels(ref: MapRef) -> pl.DataFrame:
    kills = ref.table("kills", ["tick", "round_num", "attacker_steamid", "attacker_side", "victim_steamid",
                                "victim_side", "weapon", "attacker_x", "attacker_y", "attacker_z", "victim_x",
                                "victim_y", "victim_z"])
    damages = ref.table("damages", ["tick", "round_num", "attacker_steamid", "victim_steamid"])
    flashes = ref.table("flashes", ["tick", "round_num", "victim_steamid", "duration"])
    ticks = ref.table("ticks", ["tick", "round_num", "steamid", "health", "armor", "has_helmet", "velocity",
                                "active_weapon"])
    return duels(kills, damages, flashes, ticks).with_columns(
        pl.lit(ref.key).alias("key"), pl.lit(ref.date).alias("date"), pl.lit(ref.map).alias("map"),
        pl.lit(ref.lp_pagename).alias("event"))
