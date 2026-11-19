"""Luck-adjusted map results (Phase 7): the round margin had every duel gone at its expected rate, a hot-hand check
on whether duel residuals carry over from one map to the next, and a test of whether Elo carries past luck forward."""

import json
import math

import numpy as np
import polars as pl
from sklearn.linear_model import LogisticRegression

from . import credit, data, warcheck
from .duels import FOLDS, event_folds
from .duelstats import _mults, _z_ci, duel_values
from .paths import (CREDITS, DUEL_PLAYERS, DUEL_TEAM_MAPS, DUELS, ELO_LUCK, LUCK_MAPS, PLAYER_SKILL, ROLE_ROUNDS,
                    STATES, TEAM_MAP_RESIDUALS, TEAM_STAT_MAPS, WAR_REPORTS)
from .states import CT, T

RESAMPLES = 1000
MIN_MAP_DUELS = 8
# Duels a player (or stint) needs outside the event for its baseline to count.
MIN_OTHER_DUELS = 150
# The treated rule of `backtest-elo --luck`: both teams need this many maps in the window before the series.
MIN_TRAILING_MAPS = 5
TRAILING_SECONDS = 120 * 86400
# Trailing per-map means in rounds of margin, team minus opponent.
CARRY = {"exec": "Execution (skill + luck)", "exec_skill": "Skill part", "exec_luck": "Luck part",
         "exec_luck_value": "Luck part, value-weighted", "conv": "Round conversion over duels",
         "luck_full": "Value-weighted luck + round conversion"}


def kill_stakes(states: pl.DataFrame, tables: dict[str, pl.DataFrame]) -> pl.DataFrame:
    """Adds `stake`, the round win probability riding on a duel: the man-count value of the attacker's kill plus that
    of the victim's had it gone the other way. `states` has attacker_side, pre_bomb_planted, pre_ct_alive, pre_t_alive."""
    def value(side: pl.Expr, name: str) -> pl.DataFrame:
        events = states.with_row_index("_i").select("_i", "pre_bomb_planted", "pre_ct_alive", "pre_t_alive",
                                                    side.cast(pl.Int64).alias("actor_side"), pl.lit("kill").alias("event"),
                                                    pl.lit(None, dtype=pl.Float64).alias("v"))
        return credit.neutral_values(events, tables).sort("_i").select(pl.col("v_mancount").alias(name))

    a_side = pl.col("attacker_side")
    return pl.concat([states, value(a_side, "_a"), value(pl.when(a_side == CT).then(T).otherwise(CT), "_v")],
                     how="horizontal").with_columns((pl.col("_a") + pl.col("_v")).alias("stake")).drop("_a", "_v")


def duel_stakes(duels: pl.DataFrame) -> pl.DataFrame:
    """(key, kill, stake) for every duel whose kill is in its map's state events."""
    tables = {n: pl.read_parquet(CREDITS / f"neutral-{n}.parquet") for n in ("coarse", "fine", "base")}
    cols = ["key", "round_num", "tick", "victim", "pre_bomb_planted", "pre_ct_alive", "pre_t_alive"]
    frames = []
    for (key,) in duels.select("key").unique().iter_rows():
        path = STATES / key.replace("/", "-") / "events.parquet"
        if path.exists():
            frames.append(pl.read_parquet(path, columns=[*cols, "kind", "lethal"])
                          .filter((pl.col("kind") == "damage") & pl.col("lethal")).select(cols))
    states = pl.concat(frames).with_columns(pl.col("round_num").cast(pl.Int32), pl.col("victim").cast(pl.UInt64))
    joined = (duels.select("key", "kill", "round_num", "tick", "victim", "attacker_side")
              .join(states.unique(["key", "round_num", "tick", "victim"]), on=["key", "round_num", "tick", "victim"]))
    return kill_stakes(joined, tables).select("key", "kill", "stake")


def map_rows(team_maps: pl.DataFrame, residuals: pl.DataFrame, elo: list[tuple[str, dict, dict]]) -> pl.DataFrame:
    """One row per demo map, from the Elo feed's teams[0] view: signed round margin, result, execution and duels."""
    keys = pl.DataFrame({"key": [k for k, _, _ in elo], "match2id": [r["match2id"] for _, _, r in elo],
                         "index": [r["index"] for _, _, r in elo], "team0": [r["teams"][0] for _, _, r in elo],
                         "t": [r["t"] for _, _, r in elo]})
    score = residuals.select("key", "lp_team", "rounds", "rounds_won", "elo")
    opp = residuals.select("key", pl.col("lp_team").alias("opponent"), pl.col("elo").alias("elo_opp"))
    return (team_maps.select("key", "series", "event", "date", "lp_team", "opponent", "exec", "exec_skill", "exec_luck",
                             "exec_value", "exec_skill_value", "exec_luck_value", pl.col("conv").fill_null(0.0), "duels")
            .join(score, on=["key", "lp_team"])
            .join(opp, on=["key", "opponent"])
            .join(keys, left_on=["key", "lp_team"], right_on=["key", "team0"])
            .with_columns((2 * pl.col("rounds_won") - pl.col("rounds")).alias("margin"),
                          ((pl.col("elo") - pl.col("elo_opp")) * math.log(10) / 400).alias("elo_logit"))
            .with_columns((pl.col("margin") > 0).cast(pl.Int64).alias("y"))
            .drop("elo", "elo_opp")
            .sort("t", "key"))


def skill_k() -> float:
    """The player split-half `k` in duels that `cs2wp duel-stats` used, recovered from `reliability = n / (n + k)`."""
    players = pl.read_parquet(DUEL_PLAYERS).filter(pl.col("reliability") > 0)
    if players.height == 0:
        raise ValueError(f"{DUEL_PLAYERS} has no finite split-half k; rerun `cs2wp duel-stats`")
    first = players.row(0, named=True)
    return first["duels"] * (1 - first["reliability"]) / first["reliability"]


def player_priors(values: pl.DataFrame, k: float) -> pl.DataFrame:
    """Per (steamid, event): θ, execution per duel shrunk by `k` duels, from duels dated before the event's first day."""
    day = pl.col("date").str.to_date().alias("day")
    daily = (values.group_by("steamid", day).agg(pl.col("exec").sum().alias("e"), pl.len().cast(pl.Float64).alias("d"))
             .sort("steamid", "day")
             .with_columns(pl.col("e", "d").cum_sum().over("steamid")).sort("day"))
    starts = values.group_by("event").agg(day.min())
    units = values.select("steamid", "event").unique().join(starts, on="event").sort("day")
    return (units.join_asof(daily, on="day", by="steamid", strategy="backward", allow_exact_matches=False,
                            check_sortedness=False)
            .with_columns((pl.col("e").fill_null(0.0) / (pl.col("d").fill_null(0.0) + k)).alias("theta"))
            .select("steamid", "event", "theta"))


def player_skill(values: pl.DataFrame, players: pl.DataFrame, times: pl.DataFrame) -> tuple[dict[str, list], dict]:
    """Per Liquipedia player page, `[t, exec, duels]` for each demo series sorted by `t`, the Elo feed's series time.
    `players` maps (key, steamid) to `lp_player`, `times` maps key to `t`. Also returns the share of duels dropped for
    having no page, and of the rest, for having no Elo row."""
    per = (values.select("key", "steamid", "exec").join(players, on=["key", "steamid"], how="left")
           .join(times, on="key", how="left"))
    paged = per.filter(pl.col("lp_player").is_not_null())
    timed = paged.filter(pl.col("t").is_not_null())
    series = (timed.group_by("lp_player", "t").agg(pl.col("exec").sum(), pl.len().alias("duels"))
              .sort("lp_player", "t"))
    out: dict[str, list] = {}
    for player, t, e, d in series.iter_rows():
        out.setdefault(player, []).append([t, round(e, 4), d])
    return out, {"unmapped": 1 - paged.height / max(1, per.height), "untimed": 1 - timed.height / max(1, paged.height)}


def with_skill(team_maps: pl.DataFrame, values: pl.DataFrame, teams: pl.DataFrame, priors: pl.DataFrame) -> pl.DataFrame:
    """Adds `exec_skill`, the execution a team's duels should yield given both players' θ, and
    `exec_luck = exec − exec_skill`. Halved differences as in `duelstats.pair_maps`, so the two teams sum to zero.

    `exec_value`, `exec_skill_value` and `exec_luck_value` are the same sums with each duel weighted by `stake` (1 where
    `values` has none), so they are in rounds."""
    if "stake" not in values.columns:
        values = values.with_columns(pl.lit(1.0).alias("stake"))
    skill = pl.col("theta_self") - pl.col("theta_opp")
    sums = ["s", "ev", "sv"]
    per = (values.join(priors.rename({"theta": "theta_self"}), on=["steamid", "event"])
           .join(priors.rename({"steamid": "opponent", "theta": "theta_opp"}), on=["opponent", "event"])
           .join(teams, on=["key", "steamid"])
           .group_by("key", "lp_team").agg(skill.sum().alias("s"), (pl.col("exec") * pl.col("stake")).sum().alias("ev"),
                                           (skill * pl.col("stake")).sum().alias("sv")))

    def halved(c: str) -> pl.Expr:
        return (pl.col(c).fill_null(0.0) - pl.col(f"{c}_opp").fill_null(0.0)) / 2

    return (team_maps.join(per, on=["key", "lp_team"], how="left")
            .join(per.rename({"lp_team": "opponent", **{c: f"{c}_opp" for c in sums}}), on=["key", "opponent"], how="left")
            .with_columns(halved("s").alias("exec_skill"), halved("ev").alias("exec_value"),
                          halved("sv").alias("exec_skill_value"), (halved("ev") - halved("sv")).alias("exec_luck_value"))
            .with_columns((pl.col("exec") - pl.col("exec_skill")).alias("exec_luck"))
            .drop(*sums, *(f"{c}_opp" for c in sums)))


def win_prob(x_margin: np.ndarray, y: np.ndarray, folds: np.ndarray) -> np.ndarray:
    """Out-of-fold P(win | x_margin), with no intercept: every row is one team's view and the other's is its negative."""
    y_hat = np.empty(len(y))
    for f in range(folds.max() + 1):
        test = folds == f
        fit = LogisticRegression(fit_intercept=False, C=1e4).fit(x_margin[~test, None], y[~test])
        y_hat[test] = fit.predict_proba(x_margin[test, None])[:, 1]
    return y_hat


def cross_fit(rows: pl.DataFrame, folds: np.ndarray,
              col: str | list[str] = "exec") -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Out-of-fold β (rounds of margin per unit of `col`), x_margin and P(win | x_margin). A list of columns is fit
    jointly and returns one β column each. No intercept, as in `win_prob`."""
    margin, y = rows["margin"].to_numpy().astype(float), rows["y"].to_numpy()
    X = rows.select([col] if isinstance(col, str) else col).to_numpy().astype(float)
    beta = np.empty(X.shape)
    for f in range(folds.max() + 1):
        test = folds == f
        beta[test] = np.linalg.lstsq(X[~test], margin[~test], rcond=None)[0]
    x_margin = margin - (beta * X).sum(axis=1)
    return (beta[:, 0] if isinstance(col, str) else beta), x_margin, win_prob(x_margin, y, folds)


def other_event_residuals(per_map: pl.DataFrame, unit: str) -> pl.DataFrame:
    """Execution per duel on each map minus the unit's rate on every other event.

    Removing the mean of the same event would make a map's residual and its neighbour's negatively correlated."""
    totals = per_map.group_by(unit).agg(pl.col("exec").sum().alias("e_all"), pl.col("duels").sum().alias("d_all"))
    by_event = per_map.group_by(unit, "event").agg(pl.col("exec").sum().alias("e_ev"), pl.col("duels").sum().alias("d_ev"))
    other_d = pl.col("d_all") - pl.col("d_ev")
    return (per_map.join(totals, on=unit).join(by_event, on=[unit, "event"])
            .filter((other_d >= MIN_OTHER_DUELS) & (pl.col("duels") >= MIN_MAP_DUELS))
            .with_columns((pl.col("exec") / pl.col("duels") - (pl.col("e_all") - pl.col("e_ev")) / other_d).alias("resid")))


def consecutive_pairs(resid: pl.DataFrame, unit: str) -> pl.DataFrame:
    """Each map paired with the unit's next map in the same event, flagged when both are in one series."""
    ordered = resid.with_columns(pl.col("key").str.split("/m").list.get(1).cast(pl.Int64).alias("map_number"),
                                 pl.col("series").cast(pl.Int64).alias("series_n")).sort(unit, "date", "series_n", "map_number")
    nxt = [pl.col(c).shift(-1).over(unit, "event").alias(f"{c}_next") for c in ("resid", "series", "duels")]
    return (ordered.with_columns(*nxt).filter(pl.col("resid_next").is_not_null())
            .with_columns((pl.col("series") == pl.col("series_next")).alias("same_series")))


def pair_corr(pairs: pl.DataFrame, resamples: int, seed: int = 0) -> dict:
    """Pearson r of a map's residual with the next one's, with a 90% interval from resampling events."""
    if pairs.height < 20:
        return {"pairs": pairs.height, "events": pairs["event"].n_unique(), "r": None, "r_ci": (None, None)}
    a, b = pairs["resid"].to_numpy(), pairs["resid_next"].to_numpy()
    _, ev = np.unique(pairs["event"].to_numpy(), return_inverse=True)
    r = float(np.corrcoef(a, b)[0, 1])

    def weighted(w: np.ndarray) -> float | None:
        if w.sum() < 3:
            return None
        ma, mb = (w @ a) / w.sum(), (w @ b) / w.sum()
        va, vb = w @ (a - ma) ** 2, w @ (b - mb) ** 2
        return None if va <= 0 or vb <= 0 else float((w @ ((a - ma) * (b - mb))) / np.sqrt(va * vb))

    boot = [weighted(m[ev]) for m in _mults(int(ev.max()) + 1, resamples, seed)]
    return {"pairs": pairs.height, "events": int(ev.max()) + 1, "r": r, "r_ci": _z_ci(r, boot)}


def hot_hand(values: pl.DataFrame, team_maps: pl.DataFrame, resamples: int) -> dict:
    per_player = (values.group_by("key", "steamid").agg(pl.col("exec").sum(), pl.len().cast(pl.Float64).alias("duels"),
                                                        pl.col("event", "date").first())
                  .with_columns(pl.col("key").str.split("/").list.first().alias("series")))
    per_team = team_maps.select("key", "series", "event", "date", "lp_team", "stint_id", "exec", "duels")
    out = {}
    for level, frame, unit, pair_unit in (("player", per_player, "steamid", "steamid"),
                                         ("team", per_team, "stint_id", "lp_team")):
        pairs = consecutive_pairs(other_event_residuals(frame, unit), pair_unit)
        out[level] = {name: pair_corr(pairs.filter(sel), resamples)
                      for name, sel in (("same_series", pl.col("same_series")), ("next_series", ~pl.col("same_series")))}
    return out


def trailing_rows(rows: pl.DataFrame, long: pl.DataFrame, stats: list[str]) -> pl.DataFrame:
    """`rows` restricted to maps where both teams have `MIN_TRAILING_MAPS` maps in the window before the series, with
    each stat's trailing per-map mean as team minus opponent. `long` has one row per (key, lp_team) with `t`."""
    history: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for (team,), g in long.sort("t").group_by("lp_team", maintain_order=True):
        history[team] = (g["t"].to_numpy(), g.select(stats).to_numpy().astype(float))

    def mean_before(team: str, t: int) -> np.ndarray | None:
        ts, x = history[team]
        # Maps of one series share `t`, so a series is never in its own window.
        lo, hi = np.searchsorted(ts, t - TRAILING_SECONDS, side="left"), np.searchsorted(ts, t, side="left")
        return x[lo:hi].mean(axis=0) if hi - lo >= MIN_TRAILING_MAPS else None

    keep, diffs = [], []
    for team, opponent, t in rows.select("lp_team", "opponent", "t").iter_rows():
        a, b = mean_before(team, t), mean_before(opponent, t)
        keep.append(a is not None and b is not None)
        if keep[-1]:
            diffs.append(a - b)
    d = np.array(diffs).reshape(-1, len(stats))
    return rows.filter(pl.Series(keep)).with_columns(*(pl.Series(f"trail_{s}", d[:, i]) for i, s in enumerate(stats)))


def margin_coef(rows: pl.DataFrame, feature: str, resamples: int, seed: int = 0) -> dict:
    """No-intercept OLS of the round margin on Elo and the trailing feature: the feature's coefficient, in rounds of
    margin per round of trailing per-map mean, with a 90% interval from resampling events."""
    X = rows.select("elo_logit", feature).to_numpy().astype(float)
    y = rows["margin"].to_numpy().astype(float)
    _, ev = np.unique(rows["event"].to_numpy(), return_inverse=True)

    def coef(w: np.ndarray) -> float:
        return float(np.linalg.solve(X.T @ (X * w[:, None]), X.T @ (w * y))[1])

    boot = np.array([coef(m[ev]) for m in _mults(int(ev.max()) + 1, resamples, seed)])
    return {"coef": coef(np.ones(len(y))), "ci": (float(np.quantile(boot, 0.05)), float(np.quantile(boot, 0.95)))}


def carryover(rows: pl.DataFrame, long: pl.DataFrame, resamples: int, year: str | None = None) -> dict:
    """Does a team's recent luck predict its next map once Elo is in the model? If Elo has absorbed luck, the luck
    part's coefficient is negative. `year` keeps only that year's maps as outcomes; windows still reach back before it."""
    treated = trailing_rows(rows, long, list(CARRY))
    if year:
        treated = treated.filter(pl.col("date").str.starts_with(year))
    base = warcheck.cv_losses(treated, ["elo_logit"])
    events = treated["event"].to_numpy()
    out = {"maps": treated.height, "events": int(treated["event"].n_unique()), "elo_loss": float(base.mean()), "stats": {}}
    for stat in CARRY:
        feature = f"trail_{stat}"
        gain = base - warcheck.cv_losses(treated, ["elo_logit", feature])
        out["stats"][stat] = {**margin_coef(treated, feature, resamples), "sd": float(treated[feature].std()),
                              "gain": float(gain.mean()), "gain_ci": warcheck.paired_ci(gain, events)}
    return out


def carry_verdict(carry: dict) -> str:
    lo, hi = carry["stats"]["exec_luck"]["ci"]
    if hi < 0:
        return ("the luck part's coefficient is negative with its interval below 0, so Elo carries past duel luck "
                "forward. The engine test with the skill variant decides whether `luckWeight` ships.")
    if lo > 0:
        return ("the luck part's coefficient is positive, so what θ leaves behind still predicts winning: Elo "
                "under-reacts to it, and discounting it would hurt.")
    return ("the luck part's interval includes 0, so Elo isn't measurably misled by past duel luck. An engine gain "
            "from discounting it would be too small to detect.")


def _f(v, d=3):
    return "n/a" if v is None else f"{v:+.{d}f}"


def _ci(ci, d=3):
    return "n/a" if ci[0] is None else f"({ci[0]:+.{d}f}, {ci[1]:+.{d}f})"


def carry_table(carry: dict) -> list[str]:
    lines = ["| Trailing feature | SD (rounds) | Margin coefficient | 90% CI | Log-loss gain | 90% CI |",
             "| --- | --- | --- | --- | --- | --- |"]
    for stat, name in CARRY.items():
        s = carry["stats"][stat]
        lines.append(f"| {name} | {s['sd']:.2f} | {_f(s['coef'], 2)} | {_ci(s['ci'], 2)} | {_f(s['gain'], 4)} | "
                     f"{_ci(s['gain_ci'], 4)} |")
    return lines


def report_lines(rows: pl.DataFrame, beta_full: float, r2: float, ll: dict, hh: dict, verdict: dict, skill: dict,
                 carry: dict, value: dict, full: dict, carry_2025: dict) -> list[str]:
    lines = [
        "# Luck-adjusted map results", "",
        f"{rows.height:,} demo maps on {rows['event'].n_unique()} events with duel expectations, Elo rows and scores. "
        "`exec` is the teams[0] view of duels won minus expected; `x_margin = margin − β · exec` is the round margin had "
        f"every duel gone at its expected rate. β and `P(win | x_margin)` are cross-fit over {FOLDS} event folds.", "",
        f"- β (full fit): {beta_full:.3f} rounds of margin per duel won above expectation; exec explains "
        f"{100 * r2:.1f}% of the margin's variance.",
        f"- Log loss of the map result from `x_margin` (cross-fit): {ll['x_margin']:.4f}; a coin flip scores 0.6931.",
        f"- Maps whose `x_margin` points the other way from the real result: {ll['flipped']:,} "
        f"({100 * ll['flipped'] / rows.height:.1f}%).", "",
        "## Skill-adjusted luck", "",
        "The duel model has no player identity, so `exec` holds duel skill as well as luck. Each player's θ is their "
        f"execution per duel before the event's first day, shrunk by k = {skill['k']:,.0f} duels (the split-half k of "
        "`cs2wp duel-stats`). `exec_skill` sums `θ_self − θ_opponent` over a team's duels, `exec_luck = exec − "
        "exec_skill`, and `x_margin_skill = margin − β · exec_luck`.", "",
        f"- Slope of `exec` on `exec_skill` per map: {skill['slope']:.2f} (1 means θ is a calibrated forecast).",
        f"- `exec_skill` SD {skill['sd_skill']:.2f} duels per map against {skill['sd_exec']:.2f} for `exec`; it explains "
        f"{100 * skill['r2']:.1f}% of `exec`'s variance.",
        f"- β on `exec_luck`: {skill['beta']:.3f}. Log loss of the map result from `x_margin_skill`: "
        f"{ll['x_margin_skill']:.4f}; it points the other way from the real result on {ll['flipped_skill']:,} maps "
        f"({100 * ll['flipped_skill'] / rows.height:.1f}%).", "",
        "## Value-weighted luck", "",
        "Each duel's luck is weighted by its stake: the man-count value of the attacker's kill plus the value of the "
        "victim's had it gone the other way (`neutral-fine.parquet`, by side, bomb planted and both alive counts). "
        "`exec_luck_value = Σ (win − p − (θ_self − θ_opponent)) · stake` is in rounds, and `x_margin_value = margin − β · "
        "exec_luck_value`.", "",
        f"- Stakes found for {100 * value['matched']:.1f}% of duels; the rest get the mean stake. Mean {value['mean']:.3f}, "
        f"quartiles {value['q25']:.3f} / {value['q50']:.3f} / {value['q75']:.3f}, top 1% above {value['q99']:.3f}.",
        f"- β on `exec_luck_value`: {value['beta']:.3f} rounds of margin per round of luck.",
        f"- Margin variance explained out of fold: {100 * value['r2_value']:.1f}% by `exec_luck_value` against "
        f"{100 * value['r2_luck']:.1f}% by `exec_luck`.",
        f"- Log loss of the map result from `x_margin_value`: {ll['x_margin_value']:.4f}; it points the other way from "
        f"the real result on {ll['flipped_value']:,} maps ({100 * ll['flipped_value'] / rows.height:.1f}%).", "",
        "## Non-duel luck and the skill control", "",
        "`conv` is rounds won minus the rounds expected from each round's buys, gun kills and opening duel (`cs2wp "
        "team-stats`). `x_margin_full = margin − β_v · exec_luck_value − β_c · conv`, with both βs fit jointly. "
        "`x_margin_skillonly = margin + β · exec_skill_value` is the value variant with the luck removal left out.", "",
        f"- `conv` found for {100 * full['covered']:.1f}% of maps; the rest get 0. Its correlation with "
        f"`exec_luck_value` per map is {full['corr']:.2f}.",
        f"- Joint β: {full['beta_value']:.3f} on `exec_luck_value`, {full['beta_conv']:.3f} on `conv`.",
        f"- Margin variance explained out of fold: {100 * full['r2']:.1f}% against {100 * value['r2_value']:.1f}% for "
        "`exec_luck_value` alone.",
        f"- Log loss of the map result from `x_margin_full`: {ll['x_margin_full']:.4f} ({ll['flipped_full']:,} maps "
        f"flipped). `x_margin_skillonly` keeps the real margin, so it flips only {ll['flipped_skillonly']:,}.", "",
        f"Carryover on 2025 maps only ({carry_2025['maps']:,} maps on {carry_2025['events']} events, Elo alone "
        f"{carry_2025['elo_loss']:.4f}), which is the table the full variant is judged on:", "",
        *carry_table(carry_2025), "",
        "## Carryover: does Elo carry luck forward?", "",
        f"{carry['maps']:,} maps on {carry['events']} events where both teams have {MIN_TRAILING_MAPS}+ demo maps in the "
        f"{TRAILING_SECONDS // 86400} days before the series. Each feature is a trailing per-map mean in rounds of margin "
        "(duel stats × β), team minus opponent. The coefficient is from a no-intercept OLS of the map's round margin on "
        "the Elo logit and the feature; the gain is the leave-one-event-out log-loss change from adding the feature to "
        f"Elo (Elo alone: {carry['elo_loss']:.4f}). Intervals are 90%, resampling events. If Elo has absorbed luck, the "
        "luck part's coefficient is negative.", "",
        *carry_table(carry),
    ]
    lines += [
        "", f"**Reading:** {carry_verdict(carry)}", "",
        "## Hot-hand check", "",
        "Execution per duel on each map minus the unit's rate on every other event (players: steamid; teams: IGL stint), "
        f"for maps with {MIN_MAP_DUELS}+ duels and units with {MIN_OTHER_DUELS}+ duels elsewhere. Each map is paired with "
        "the unit's next map in the same event. Same-series pairs share an opponent, whose strength the duel model "
        "doesn't see, so they can correlate without any form; next-series pairs are the test. Intervals are 90%, "
        "resampling events.", "",
        "| Level | Pairs | Events | r | 90% CI |", "| --- | --- | --- | --- | --- |",
    ]
    for level in ("player", "team"):
        for name in ("next_series", "same_series"):
            r = hh[level][name]
            lines.append(f"| {level}, {name.replace('_', ' ')} | {r['pairs']:,} | {r['events']} | {_f(r['r'])} | "
                         f"{_ci(r['r_ci'])} |")
    lines += ["", f"**Reading:** {verdict['text']}"]
    return lines


def verdict_of(hh: dict) -> dict:
    """Next-series r at the player level decides it: a positive interval means part of the residual is form."""
    r = hh["player"]["next_series"]
    lo = r["r_ci"][0]
    if lo is not None and lo > 0:
        return {"form": True, "form_share": r["r"],
                "text": f"next-map player residuals correlate at r = {r['r']:.3f}, so about {100 * r['r']:.0f}% of a "
                        "map's duel residual is form that carries over. Treat the tuned `luckWeight` as an upper bound."}
    return {"form": False, "form_share": 0.0,
            "text": "the next-series interval includes 0, so duel residuals behave like luck and the tuned "
                    "`luckWeight` stands."}


def _log_loss(y: np.ndarray, y_hat: np.ndarray) -> float:
    return float(warcheck._log_loss(y, y_hat).mean())


def build(resamples: int = RESAMPLES) -> int:
    for path, cmd in ((DUELS, "cs2wp duels"), (DUEL_TEAM_MAPS, "cs2wp duel-stats"), (DUEL_PLAYERS, "cs2wp duel-stats"),
                      (TEAM_MAP_RESIDUALS, "cs2wp team-factor"), (TEAM_STAT_MAPS, "cs2wp team-stats"),
                      (ROLE_ROUNDS, "cs2wp baselines")):
        if not path.exists():
            raise FileNotFoundError(f"{path} not found; run `{cmd}` first")
    duels = pl.read_parquet(DUELS)
    stakes = duel_stakes(duels)
    values = duel_values(duels).join(stakes, on=["key", "kill"], how="left")
    matched = 1 - values["stake"].null_count() / values.height
    values = values.with_columns(pl.col("stake").fill_null(pl.col("stake").mean()))
    roles = pl.read_parquet(ROLE_ROUNDS).select("key", "steamid", "lp_team", "lp_player").unique(["key", "steamid"])
    teams = roles.select("key", "steamid", "lp_team")
    k = skill_k()
    conv = pl.read_parquet(TEAM_STAT_MAPS).select("key", "lp_team", "conv")
    team_maps = (with_skill(pl.read_parquet(DUEL_TEAM_MAPS), values, teams, player_priors(values, k))
                 .join(conv, on=["key", "lp_team"], how="left"))
    elo = data.elo_rows()
    times = pl.DataFrame({"key": [key for key, _, _ in elo], "t": [r["t"] for _, _, r in elo]}).unique("key")
    timeline, dropped = player_skill(values, roles.select("key", "steamid", "lp_player"), times)
    rows = map_rows(team_maps, pl.read_parquet(TEAM_MAP_RESIDUALS), elo)
    folds = event_folds(rows)
    ex, margin = rows["exec"].to_numpy(), rows["margin"].to_numpy().astype(float)
    beta, x_margin, y_hat = cross_fit(rows, folds)
    beta_skill, x_margin_skill, y_hat_skill = cross_fit(rows, folds, "exec_luck")
    beta_value, x_margin_value, y_hat_value = cross_fit(rows, folds, "exec_luck_value")
    full_cols = ["exec_luck_value", "conv"]
    _, x_margin_full, y_hat_full = cross_fit(rows, folds, full_cols)
    x_margin_skillonly = margin + beta_value * rows["exec_skill_value"].to_numpy()
    y_hat_skillonly = win_prob(x_margin_skillonly, rows["y"].to_numpy(), folds)
    rows = rows.with_columns(pl.Series("beta", beta), pl.Series("x_margin", x_margin), pl.Series("y_hat", y_hat),
                             pl.Series("beta_skill", beta_skill), pl.Series("x_margin_skill", x_margin_skill),
                             pl.Series("y_hat_skill", y_hat_skill), pl.Series("beta_value", beta_value),
                             pl.Series("x_margin_value", x_margin_value), pl.Series("y_hat_value", y_hat_value),
                             pl.Series("x_margin_full", x_margin_full), pl.Series("y_hat_full", y_hat_full),
                             pl.Series("x_margin_skillonly", x_margin_skillonly),
                             pl.Series("y_hat_skillonly", y_hat_skillonly))

    sk, lu, lv = rows["exec_skill"].to_numpy(), rows["exec_luck"].to_numpy(), rows["exec_luck_value"].to_numpy()
    beta_full = float(ex @ margin / (ex @ ex))
    r2 = 1 - float(((margin - beta_full * ex) ** 2).sum() / (margin ** 2).sum())
    y = rows["y"].to_numpy()
    ll = {"x_margin": _log_loss(y, y_hat), "flipped": int(((x_margin > 0) != (y == 1)).sum()),
          "x_margin_skill": _log_loss(y, y_hat_skill), "flipped_skill": int(((x_margin_skill > 0) != (y == 1)).sum()),
          "x_margin_value": _log_loss(y, y_hat_value), "flipped_value": int(((x_margin_value > 0) != (y == 1)).sum()),
          "x_margin_full": _log_loss(y, y_hat_full), "flipped_full": int(((x_margin_full > 0) != (y == 1)).sum()),
          "x_margin_skillonly": _log_loss(y, y_hat_skillonly),
          "flipped_skillonly": int(((x_margin_skillonly > 0) != (y == 1)).sum())}
    slope = float(sk @ ex / (sk @ sk))
    skill = {"k": k, "slope": slope, "sd_skill": float(sk.std()), "sd_exec": float(ex.std()),
             "r2": 1 - float(((ex - slope * sk) ** 2).sum() / (ex ** 2).sum()), "beta": float(lu @ margin / (lu @ lu))}
    beta_value_full = float(lv @ margin / (lv @ lv))
    quantile = stakes["stake"].quantile
    value = {"matched": matched, "mean": float(stakes["stake"].mean()), "q25": quantile(0.25), "q50": quantile(0.5),
             "q75": quantile(0.75), "q99": quantile(0.99), "beta": beta_value_full,
             "r2_value": 1 - float((x_margin_value ** 2).sum() / (margin ** 2).sum()),
             "r2_luck": 1 - float((x_margin_skill ** 2).sum() / (margin ** 2).sum())}

    in_rounds = [(beta_full * pl.col(c)).alias(c) for c in ("exec", "exec_skill", "exec_luck")]
    in_rounds.append((beta_value_full * pl.col("exec_luck_value")).alias("exec_luck_value"))
    pair = rows.select(full_cols).to_numpy()
    b_value, b_conv = (float(b) for b in np.linalg.lstsq(pair, margin, rcond=None)[0])
    full = {"beta_value": b_value, "beta_conv": b_conv, "corr": float(np.corrcoef(pair.T)[0, 1]),
            "covered": float(rows["key"].is_in(conv["key"].implode()).mean()),
            "r2": 1 - float((x_margin_full ** 2).sum() / (margin ** 2).sum())}
    in_rounds.append((b_value * pl.col("exec_luck_value") + b_conv * pl.col("conv")).alias("luck_full"))
    long = (team_maps.filter(pl.col("conv").is_not_null()).select("key", "lp_team", *in_rounds, "conv")
            .join(rows.select("key", "t"), on="key"))
    carry = carryover(rows, long, resamples)
    carry_2025 = carryover(rows, long, resamples, "2025")

    hh = hot_hand(values, team_maps, resamples)
    verdict = verdict_of(hh)

    LUCK_MAPS.parent.mkdir(parents=True, exist_ok=True)
    rows.write_parquet(LUCK_MAPS)
    ELO_LUCK.parent.mkdir(parents=True, exist_ok=True)
    with ELO_LUCK.open("w") as f:
        for r in rows.iter_rows(named=True):
            f.write(json.dumps({"match2id": r["match2id"], "index": r["index"], "xMargin": round(r["x_margin"], 3),
                                "yHat": round(r["y_hat"], 4), "xMarginSkill": round(r["x_margin_skill"], 3),
                                "yHatSkill": round(r["y_hat_skill"], 4), "xMarginValue": round(r["x_margin_value"], 3),
                                "yHatValue": round(r["y_hat_value"], 4), "xMarginFull": round(r["x_margin_full"], 3),
                                "yHatFull": round(r["y_hat_full"], 4),
                                "xMarginSkillOnly": round(r["x_margin_skillonly"], 3),
                                "yHatSkillOnly": round(r["y_hat_skillonly"], 4)}) + "\n")
    PLAYER_SKILL.write_text(json.dumps({"k": k, "players": timeline}, separators=(",", ":")))

    lines = report_lines(rows, beta_full, r2, ll, hh, verdict, skill, carry, value, full, carry_2025)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "luck.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nPlayer skill: {len(timeline):,} players; {100 * dropped['unmapped']:.1f}% of duel views have no Liquipedia "
          f"page (θ = 0 in Elo), {100 * dropped['untimed']:.1f}% of the rest have no Elo row.")
    print(f"wrote {LUCK_MAPS}, {ELO_LUCK}, {PLAYER_SKILL}")
    return 0
