"""Veto model for the bracket simulator (`scripts/lib/sim/veto.ts`): each team's map strength and ban/pick habits, a
conditional logit for which map a team bans or picks, a series gate against pool-averaged Elo, and the export."""

import json
import math
from collections import Counter, deque
from datetime import datetime, timezone
from functools import lru_cache

import numpy as np
import polars as pl

from . import warcheck
from .paths import DATA, WAR_REPORTS
from .veto import (DAY, PATTERNS, TEST_FROM, State, _ll, elo_params, fit_coefs, load_series, load_vetoes, pattern,
                   series_prob, walk)

# `cs2wp veto`'s tuned shrinkage (maps) and decay (days).
K, TAU = 40.0, 365.0
# Played-map preference: shrinkage (series) and decay (days), chosen on pre-2026 choice log-likelihood.
PLAY_PRIOR, PLAY_TAU = 10.0, 90.0
POOL_SIZE = 7
BASELINE_DAYS = 90
# Multiplier on choice scores when forecasting a whole veto, which is overconfident without it; fit before TEST_FROM.
SHRINK_GRID = (1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7)
# Lower bounds on P(picked or decider) for the site's labels. Chosen on 2026, so their held-out rates are optimistic.
BANDS = {"likely": 0.7, "possible": 0.3}
BO1_SHOWN = 3
ACTIONS = {1: "bbbbbb", 3: "bbppbb", 5: "bbpppp"}
# Actors before the decider, F = the team that bans first: each format's most common order in the HLTV vetoes.
ORDERS = {1: "FFSSSF", 3: "FSFSFS", 5: "FSFSFS"}
MAP_FEATURES = {"hltv": ("du", "pick", "ban_rate", "pick_rate"), "liquipedia": ("du",)}
CHOICE_FEATURES = {"hltv": ("rate", "play", "edge"), "liquipedia": ("play", "edge")}
CHOICE_ACTIONS = ("ban", "pick")
MODES = tuple(MAP_FEATURES)
OUT = DATA / "sim" / "veto-model.json"
# Committed, so it holds fitted weights only: no team values and no HLTV ban or pick rates.
WEIGHTS_OUT = DATA / "sim" / "veto-weights.json"


class Play:
    """Per-lineage decayed played-map counts from Liquipedia, against a uniform share that accrues only while each map
    is in the pool, so a map that just entered starts neutral."""

    def __init__(self, prior: float = PLAY_PRIOR, tau: float = PLAY_TAU):
        self.prior, self.tau = prior, tau
        self.v: dict[int, dict[str, list[float]]] = {}
        self.last: dict[int, float] = {}

    def _decay(self, lineage: int, t: float) -> float:
        return math.exp(-(t - self.last[lineage]) / (self.tau * DAY))

    def get(self, lineage: int, m: str, t: float) -> float:
        """Plays of `m` over the uniform share, per series with `m` in the pool, shrunk by `prior` series."""
        v = self.v.get(lineage, {}).get(m)
        if v is None:
            return 0.0
        plays, uniform, n = v
        d = self._decay(lineage, t)
        return (plays - uniform) * d / (n * d + self.prior)

    def add(self, lineage: int, maps: list[str], pool, t: float) -> None:
        by_map = self.v.setdefault(lineage, {})
        d = self._decay(lineage, t) if lineage in self.last else 1.0
        self.last[lineage] = t
        for v in by_map.values():
            v[:] = [x * d for x in v]
        for m in {*pool, *maps}:
            v = by_map.setdefault(m, [0.0, 0.0, 0.0])
            v[0] += maps.count(m)
            v[1] += len(maps) / POOL_SIZE
            v[2] += 1


def team_maps(state: State, play: Play, lineage: int, pool: list[str], t: float) -> dict[str, dict[str, float]]:
    out = {}
    for m in pool:
        ban, pick = state.rates(lineage, m)
        out[m] = {"u": state.centred_u(lineage, m, t, pool), "ban": ban, "pick": pick, "play": play.get(lineage, m, t)}
    return out


def standard_veto(veto: pl.DataFrame | None) -> list[tuple[int, str, str]] | None:
    """(actor, action, map) before the decider, for a 7-map veto in a known pattern."""
    if veto is None or pattern(veto) not in PATTERNS or veto["map"].n_unique() != POOL_SIZE:
        return None
    if veto["opponent"].drop_nulls().n_unique() != 2:
        return None
    return [(int(r["opponent"]), r["action"], r["map"]) for r in veto.iter_rows(named=True) if r["action"] != "decider"]


def walk_snaps(series: list[dict], vetoes: dict[str, pl.DataFrame], keep) -> tuple[dict[str, dict], State, Play]:
    """Both teams' per-map values before each kept series, from earlier series only; mirrors `veto.walk`'s updates."""
    state, play = State(K, TAU), Play()
    snaps = {}
    for s in series:
        veto = vetoes.get(s["match2id"])
        la, lb = s["lineages"]
        if keep(s):
            pool = sorted(veto["map"].unique().to_list()) if veto is not None else sorted(s["offsets"][0])
            snaps[s["match2id"]] = {"pool": pool, "teams": (team_maps(state, play, la, pool, s["t"]),
                                                             team_maps(state, play, lb, pool, s["t"]))}
        p_base = 1 / (1 + math.exp(-s["base"]))
        for pm in s["played"]:
            r = pm["y"] - p_base
            state.add_residual(la, pm["map"], r, s["t"])
            state.add_residual(lb, pm["map"], -r, s["t"])
        if veto is not None:
            n_pool = veto["map"].n_unique()
            for opp, lineage in ((1, la), (2, lb)):
                state.add_veto(lineage, veto.filter(pl.col("opponent") == opp).select("action", "map").rows(), n_pool)
        played = [pm["map"] for pm in s["played"]]
        for lineage in (la, lb):
            play.add(lineage, played, s["offsets"][0], s["t"])
    return snaps, state, play


def edge_a(mode: str, coef: dict[str, float], ta: dict, tb: dict, pool: list[str]) -> dict[str, float]:
    """A's map logit on each map from the map model, without the Elo base and the pick term."""
    out = {}
    for m in pool:
        a, b = ta[m], tb[m]
        x = coef["du"] * (a["u"] - b["u"])
        if mode == "hltv":
            x += coef["ban_rate"] * (a["ban"] - b["ban"]) + coef["pick_rate"] * (a["pick"] - b["pick"])
        out[m] = x
    return out


def choice_names(mode: str) -> list[tuple[str, str]]:
    return [(action, f) for action in CHOICE_ACTIONS for f in CHOICE_FEATURES[mode]]


def choice_row(mode: str, tx: dict, edge: dict[str, float], actor: int, action: str, m: str) -> list[float]:
    """Features of `m` for the acting team, in `choice_names` order, so bans and picks get their own weights. Positive
    means more likely to be chosen."""
    sign = -1.0 if action == "ban" else 1.0
    side = 1.0 if actor == 1 else -1.0
    feats = {"rate": tx[m]["ban" if action == "ban" else "pick"], "play": sign * tx[m]["play"],
             "edge": sign * side * edge[m]}
    return [feats[f] if a == action else 0.0 for a, f in choice_names(mode)]


def choice_steps(mode: str, coef: dict, series: list[dict], vetoes: dict, snaps: dict, before: str | None = None,
                 since: str | None = None):
    """One (alternatives × features, chosen index, action, maps left) per real ban or pick."""
    for s in series:
        if (before and s["date"] >= before) or (since and s["date"] < since):
            continue
        steps = standard_veto(vetoes.get(s["match2id"]))
        snap = snaps.get(s["match2id"])
        if steps is None or snap is None:
            continue
        ta, tb = snap["teams"]
        edge = edge_a(mode, coef, ta, tb, snap["pool"])
        remaining = list(snap["pool"])
        for actor, action, chosen in steps:
            tx = ta if actor == 1 else tb
            X = np.array([choice_row(mode, tx, edge, actor, action, m) for m in remaining])
            yield X, remaining.index(chosen), action, list(remaining)
            remaining.remove(chosen)


def choice_groups(mode: str, coef: dict, series: list[dict], vetoes: dict, snaps: dict, before: str | None = None,
                  since: str | None = None) -> list:
    return [(X, c) for X, c, _, _ in choice_steps(mode, coef, series, vetoes, snaps, before, since)]


def fit_choice(groups: list, cols: list[int] | None = None) -> np.ndarray:
    """Conditional logit by Newton's method; `cols` restricts to a subset of features, the rest held at 0."""
    d = groups[0][0].shape[1]
    cols = list(range(d)) if cols is None else cols
    b = np.zeros(len(cols))
    for _ in range(100):
        g, H = np.zeros(len(cols)), 1e-6 * np.eye(len(cols))
        for X, c in groups:
            Xc = X[:, cols]
            s = Xc @ b
            p = np.exp(s - s.max())
            p /= p.sum()
            mu = p @ Xc
            g += Xc[c] - mu
            H += (Xc * p[:, None]).T @ Xc - np.outer(mu, mu)
        step = np.linalg.solve(H, g)
        b += step
        if np.abs(step).max() < 1e-10:
            break
    full = np.zeros(d)
    full[cols] = b
    return full


def choice_ll(groups: list, b: np.ndarray) -> float:
    total = 0.0
    for X, c in groups:
        s = X @ b
        total += s[c] - s.max() - math.log(np.exp(s - s.max()).sum())
    return total


def veto_series_prob(pool: list[str], base: float, edge: dict[str, float], gamma: float, temp: float,
                     steps: list[tuple[int, str]], score: dict[tuple[int, str, str], float]) -> float:
    """A's exact series probability over every veto path, each choice a softmax over `score`."""

    @lru_cache(maxsize=None)
    def value(i: int, remaining: frozenset, picks: frozenset) -> float:
        if i == len(steps):
            (decider,) = remaining
            logits = [base + edge[m] + (gamma if who == 1 else -gamma) for m, who in picks] + [base + edge[decider]]
            return series_prob(logits, temp)
        actor, action = steps[i]
        options = sorted(remaining)
        s = np.array([score[(actor, action, m)] for m in options])
        p = np.exp(s - s.max())
        p /= p.sum()
        return sum(float(pj) * value(i + 1, remaining - {m}, picks | {(m, actor)} if action == "pick" else picks)
                   for pj, m in zip(p, options))

    return value(0, frozenset(pool), frozenset())


def default_steps(best_of: int, first: int) -> list[tuple[int, str]]:
    return [(first if who == "F" else 3 - first, "ban" if a == "b" else "pick")
            for who, a in zip(ORDERS[best_of], ACTIONS[best_of])]


def choice_scores(mode: str, beta: np.ndarray, snap: dict,
                  edge: dict[str, float]) -> dict[tuple[int, str, str], float]:
    return {(actor, action, m): float(np.dot(beta, choice_row(mode, snap["teams"][actor - 1], edge, actor, action, m)))
            for actor in (1, 2) for action in CHOICE_ACTIONS for m in snap["pool"]}


def series_veto_prob(mode: str, map_coef: dict, beta: np.ndarray, snap: dict, base: float, best_of: int,
                     steps: list[tuple[int, str]], temp: float) -> float:
    pool = snap["pool"]
    edge = edge_a(mode, map_coef, *snap["teams"], pool)
    score = choice_scores(mode, beta, snap, edge)
    gamma = map_coef.get("pick", 0.0)
    return veto_series_prob(pool, base, edge, gamma, temp if best_of > 1 else 1.0, steps, score)


def veto_distribution(mode: str, map_coef: dict, beta: np.ndarray, snap: dict, best_of: int,
                      a_second: float) -> dict[str, dict]:
    """Where each map ends up, exactly, mixing who bans first; a choice depends only on the maps left."""
    pool = snap["pool"]
    score = choice_scores(mode, beta, snap, edge_a(mode, map_coef, *snap["teams"], pool))
    out = {m: {"ban": [0.0, 0.0], "pick": [0.0, 0.0], "decider": 0.0} for m in pool}
    for first, weight in ((2, a_second), (1, 1 - a_second)):
        layer = {frozenset(pool): weight}
        for actor, action in default_steps(best_of, first):
            after: dict[frozenset, float] = {}
            for remaining, reach in layer.items():
                options = sorted(remaining)
                x = np.array([score[(actor, action, m)] for m in options])
                p = np.exp(x - x.max())
                p /= p.sum()
                for m, q in zip(options, p):
                    out[m][action][actor - 1] += reach * q
                    after[remaining - {m}] = after.get(remaining - {m}, 0.0) + reach * q
            layer = after
        for (decider,), reach in layer.items():
            out[decider]["decider"] += reach
    return out


def favourite_second(series: list[dict], vetoes: dict, before: str | None) -> float:
    """Share of standard vetoes in which the higher-rated team bans second."""
    seen = []
    for s in series:
        if before and s["date"] >= before:
            continue
        steps = standard_veto(vetoes.get(s["match2id"]))
        if steps and s["base"] != 0:
            seen.append(steps[0][0] == (2 if s["base"] > 0 else 1))
    return float(np.mean(seen))


def a_second_share(base: float, share: float) -> float:
    return 0.5 if base == 0 else share if base > 0 else 1 - share


def selection_forecasts(series: list[dict], vetoes: dict, snaps: dict, coef: dict, beta: np.ndarray,
                        share: float, since: str = "", before: str = "9999") -> pl.DataFrame:
    """Per series from `since` until `before` and pool map: P(picked or decider) beside baselines that know the pool but not the teams,
    from the previous 90 days of played maps and of vetoes."""
    played: deque = deque()
    chosen: deque = deque()
    rows = []
    for s in series:
        for window in (played, chosen):
            while window and window[0][0] < s["t"] - BASELINE_DAYS * DAY:
                window.popleft()
        veto, snap = vetoes.get(s["match2id"]), snaps.get(s["match2id"])
        steps = standard_veto(veto)
        if steps and snap:
            best_of = PATTERNS[pattern(veto)]
            picker = {m: a for a, act, m in steps if act == "pick"}
            decider = set(snap["pool"]) - {m for *_, m in steps}
            selected = set(picker) | decider
            if since <= s["date"] < before:
                dist = veto_distribution("liquipedia", coef, beta, snap, best_of, a_second_share(s["base"], share))
                freq = {}
                for name, window in (("played_freq", played), ("veto_freq", chosen)):
                    counts = Counter(m for _, ms in window for m in ms if m in dist)
                    total = sum(counts.values()) + POOL_SIZE
                    freq[name] = {m: min(1.0, best_of * (counts[m] + 1) / total) for m in dist}
                for m, d in dist.items():
                    rows.append({"match2id": s["match2id"], "event": s["pagename"], "best_of": best_of, "map": m,
                                 "y": float(m in selected), "model": sum(d["pick"]) + d["decider"],
                                 "uniform": best_of / POOL_SIZE, **{k: v[m] for k, v in freq.items()},
                                 "pick_a": d["pick"][0], "pick_b": d["pick"][1], "decider": d["decider"],
                                 "is_pick_a": float(picker.get(m) == 1), "is_pick_b": float(picker.get(m) == 2),
                                 "is_decider": float(m in decider)})
            chosen.append((s["t"], selected))
        played.append((s["t"], [pm["map"] for pm in s["played"]]))
    return pl.DataFrame(rows)


def fit_shrink(series: list[dict], vetoes: dict, snaps: dict, coef: dict, beta: np.ndarray, share: float) -> float:
    def loss(scale: float) -> float:
        f = selection_forecasts(series, vetoes, snaps, coef, beta * scale, share, before=TEST_FROM)
        return float(_ll(f["y"].to_numpy(), f["model"].to_numpy()).mean())

    return min(SHRINK_GRID, key=loss)


def label_lines(fit: pl.DataFrame, held_out: pl.DataFrame) -> list[str]:
    lines = ["## What the site shows", "", "| Period | Series | Label | Maps | Mean predicted | Selected | Pool frequency |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    periods = ((f"before {TEST_FROM}", fit), ("held out", held_out))
    for period, f in periods:
        for best_of in (3, 5):
            top = 1.01
            for label, low in (*BANDS.items(), ("unlikely", 0.0)):
                d = f.filter((pl.col("best_of") == best_of) & (pl.col("model") >= low) & (pl.col("model") < top))
                if d.height:
                    lines.append(f"| {period} | Bo{best_of} | {label} | {d.height:,} | {d['model'].mean():.3f} | "
                                 f"{d['y'].mean():.3f} | {d['veto_freq'].mean():.3f} |")
                top = low
    lines += ["", "How often the named map is right:", "",
              "| Period | Series | Claim | n | Model | Pool frequency |", "| --- | --- | --- | --- | --- | --- |"]
    claims = ((1, f"one of the top {BO1_SHOWN} is played", "model", "y", BO1_SHOWN), (1, "top map is played", "model", "y", 1),
              (3, "A's likeliest pick", "pick_a", "is_pick_a", 1), (3, "B's likeliest pick", "pick_b", "is_pick_b", 1),
              (3, "likeliest decider", "decider", "is_decider", 1))
    for period, f in periods:
        for best_of, claim, col, target, k in claims:
            d = f.filter(pl.col("best_of") == best_of).with_columns(
                pl.col(col).rank("ordinal", descending=True).over("match2id").alias("by_model"),
                pl.col("veto_freq").rank("ordinal", descending=True).over("match2id").alias("by_freq"))
            if d.height:
                n = d["match2id"].n_unique()
                hit = lambda r: d.filter(pl.col(r) <= k)[target].sum() / n
                lines.append(f"| {period} | Bo{best_of} | {claim} | {n:,} | {hit('by_model'):.1%} | {hit('by_freq'):.1%} |")
    return lines + [""]


def selection_lines(f: pl.DataFrame) -> list[str]:
    brier = lambda d, col: (d[col].to_numpy() - d["y"].to_numpy()) ** 2
    lines = ["## Map selection forecast: liquipedia, held out", "",
             "Brier score of P(picked or decider) per map on vetoed series from " + TEST_FROM + ", who bans first "
             "unknown. Baselines: every map equally likely, and the pool's frequency over the previous "
             f"{BASELINE_DAYS} days of played maps or of vetoes. Gain is over the better frequency baseline; 90% "
             "interval resamples events.", "",
             "| Series | n | Model | Uniform | Played frequency | Veto frequency | Gain | 90% CI |",
             "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for name, d in [("all", f), *((f"Bo{b}", f.filter(pl.col("best_of") == b)) for b in sorted(ACTIONS))]:
        if d.height == 0:
            continue
        scores = {c: brier(d, c) for c in ("model", "uniform", "played_freq", "veto_freq")}
        rival = min(("played_freq", "veto_freq"), key=lambda c: scores[c].mean())
        diff = scores[rival] - scores["model"]
        lo, hi = warcheck.paired_ci(diff, d["event"].to_numpy())
        lines.append(f"| {name} | {d['match2id'].n_unique():,} | "
                     + " | ".join(_f(float(x.mean())) for x in scores.values())
                     + f" | {_f(float(diff.mean()), True)} | ({_f(lo, True)}, {_f(hi, True)}) |")
    lines += ["", "| Predicted | Maps | Mean predicted | Selected |", "| --- | --- | --- | --- |"]
    for i in range(10):
        d = f.filter((pl.col("model") >= i / 10) & (pl.col("model") < (i + 1) / 10 if i < 9 else pl.lit(True)))
        if d.height:
            lines.append(f"| {i * 10}–{i * 10 + 10}% | {d.height:,} | {d['model'].mean():.3f} | {d['y'].mean():.3f} |")
    return lines + [""]


def averaged_logit(s: dict) -> float:
    """Today's simulator: Elo's map probability averaged over the active pool, as a logit used for every map."""
    off_a, off_b = s["offsets"]
    pool = list(off_a)
    p = (np.mean([1 / (1 + math.exp(-(s["base"] + off_a[m] - off_b.get(m, 0.0)))) for m in pool])
         if pool else 1 / (1 + math.exp(-s["base"])))
    return math.log(p / (1 - p))


def averaged_prob(s: dict, best_of: int, temp: float) -> float:
    return series_prob([averaged_logit(s)] * best_of, temp)


def pool_mean_prob(s: dict, edge: dict[str, float], best_of: int, temp: float) -> float:
    """No veto: the current simulator with every map shifted by the mean map-model edge over the pool."""
    shift = sum(edge.values()) / len(edge)
    return series_prob([averaged_logit(s) + shift] * best_of, temp if best_of > 1 else 1.0)


def known_maps_prob(s: dict, edge: dict[str, float], gamma: float, real: list | None, best_of: int,
                    temp: float) -> float | None:
    """The ceiling for veto prediction: a Bo1's real map, or a longer series' real picked maps with the decider
    averaged over the rest of the pool. Uses map identities only, never results. None if the played maps don't fit."""
    n_known = 1 if best_of == 1 else best_of - 1
    known = [pm["map"] for pm in s["played"][:n_known]]
    if len(known) < n_known or len(set(known)) < n_known or any(m not in edge for m in known):
        return None
    picker = {m: (gamma if a == 1 else -gamma) for a, act, m in real or [] if act == "pick"}
    logits = [s["base"] + edge[m] + picker.get(m, 0.0) for m in known]
    if best_of == 1:
        return series_prob(logits, 1.0)
    rest = [m for m in edge if m not in known]
    return float(np.mean([series_prob(logits + [s["base"] + edge[m]], temp) for m in rest]))


def map_coefs(df: pl.DataFrame, before: str | None) -> dict[str, dict[str, float]]:
    train = df.filter(pl.col("date") < before) if before else df
    return {mode: dict(zip(MAP_FEATURES[mode], fit_coefs(train, MAP_FEATURES[mode]).tolist())) for mode in MODES}


def gate(series, vetoes, snaps, coefs, betas, temp) -> pl.DataFrame:
    rows = []
    for s in series:
        snap = snaps.get(s["match2id"])
        best_of = s["bestOf"]
        if s["date"] < TEST_FROM or snap is None or best_of not in ACTIONS or len(snap["pool"]) != POOL_SIZE:
            continue
        real = standard_veto(vetoes.get(s["match2id"]))
        steps = [(a, act) for a, act, _ in real] if real else default_steps(best_of, 2 if s["base"] >= 0 else 1)
        row = {"event": s["pagename"], "best_of": best_of, "tier": s.get("tier"), "vetoed": real is not None,
               "y": s["y"], "current": averaged_prob(s, best_of, temp)}
        for mode in MODES:
            row[mode] = series_veto_prob(mode, coefs[mode], betas[mode], snap, s["base"], best_of, steps, temp)
            row[f"{mode}:uniform"] = series_veto_prob(mode, coefs[mode], np.zeros_like(betas[mode]), snap, s["base"],
                                                      best_of, steps, temp)
            edge = edge_a(mode, coefs[mode], *snap["teams"], snap["pool"])
            row[f"{mode}:poolmean"] = pool_mean_prob(s, edge, best_of, temp)
            row[f"{mode}:known"] = known_maps_prob(s, edge, coefs[mode].get("pick", 0.0), real, best_of, temp)
        rows.append(row)
    return pl.DataFrame(rows)


VARIANTS = {"": "Veto model", ":uniform": "Uniform choices", ":poolmean": "Pool-mean only",
            ":known": "Played maps known"}
SETS = (("all", pl.lit(True)), ("vetoed", pl.col("vetoed")), ("tier 1–2", pl.col("tier").is_in([1, 2])),
        ("Bo1", pl.col("best_of") == 1), ("Bo3", pl.col("best_of") == 3))


def gate_table(g: pl.DataFrame, sets=SETS, variant: str = "") -> list[dict]:
    """Per set: series log loss of the current simulator and each mode's `variant`, on series where it's defined."""
    out = []
    for name, sel in sets:
        d = g.filter(sel)
        if d.height == 0:
            continue
        row = {"set": name, "variant": VARIANTS[variant]}
        for mode in MODES:
            dm = d.filter(pl.col(mode + variant).is_not_null())
            y = dm["y"].to_numpy()
            cur = _ll(y, dm["current"].to_numpy())
            ll = _ll(y, dm[mode + variant].to_numpy())
            row.update({"series": dm.height, "current": float(cur.mean()), mode: float(ll.mean()),
                        f"{mode}_n": dm.height, f"{mode}_gain": float((cur - ll).mean()),
                        f"{mode}_ci": warcheck.paired_ci(cur - ll, dm["event"].to_numpy())})
        out.append(row)
    return out


def named_weights(mode: str, beta: np.ndarray) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {action: {} for action in CHOICE_ACTIONS}
    for (action, f), b in zip(choice_names(mode), beta):
        out[action][f] = round(float(b), 5)
    return out


def export(series, state: State, play: Play, coefs, betas, lp_of: dict[str, str], temp: float, share: float,
           shrink: float) -> None:
    last = series[-1]
    pool = next(sorted(s["offsets"][0]) for s in reversed(series) if len(s["offsets"][0]) == POOL_SIZE)
    now = last["t"]
    latest: dict[str, tuple[int, float]] = {}
    for s in series:
        for team, lineage in zip(s["teams"], s["lineages"]):
            latest[team] = (lineage, s["t"])
    teams = {}
    for team, (lineage, t) in sorted(latest.items()):
        if now - t > 365 * 86400:
            continue
        vals = team_maps(state, play, lineage, pool, now)
        entry = {"u": [round(vals[m]["u"], 5) for m in pool], "play": [round(vals[m]["play"], 5) for m in pool]}
        if lineage in state.vetoes:
            entry["ban"] = [round(vals[m]["ban"], 5) for m in pool]
            entry["pick"] = [round(vals[m]["pick"], 5) for m in pool]
        teams[team] = entry
    shared = {"asOf": last["date"], "actions": {str(k): v for k, v in ACTIONS.items()},
              "orders": {str(k): v for k, v in ORDERS.items()}}
    modes = {mode: {"map": {k: round(v, 5) for k, v in coefs[mode].items()}, "choice": named_weights(mode, betas[mode])}
             for mode in MODES}
    payload = {
        **shared,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Ban and pick rates from HLTV.org veto boxes; played maps from Liquipedia (CC-BY-SA 3.0)",
        "pool": [lp_of[m] for m in pool],
        "temp": temp,
        "modes": modes,
        "teams": teams,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"wrote {len(teams):,} teams to {OUT}")
    weights = {**shared, "inputs": {"k": K, "tau": TAU, "playPrior": PLAY_PRIOR, "playTau": PLAY_TAU},
               "favouriteSecond": round(share, 5), "forecast": {"shrink": shrink, "bands": BANDS, "bo1Shown": BO1_SHOWN},
               **modes["liquipedia"]}
    WEIGHTS_OUT.write_text(json.dumps(weights, indent=4) + "\n")
    print(f"wrote weights to {WEIGHTS_OUT}")


def _f(v, signed=False):
    return f"{v:+.4f}" if signed else f"{v:.4f}"


def build(write: bool = False) -> int:
    temp = elo_params()["seriesMapTemp"]
    series = load_series()
    vetoes = load_vetoes()
    from cs2demos.liquipedia import demo_map_name

    lp_of = {demo_map_name(m): m for s in series for m in s["maps"]}
    print(f"{len(series):,} series, {sum(s['match2id'] in vetoes for s in series):,} with a veto")
    df, _ = walk(series, vetoes, K, TAU)
    keep = lambda s: s["match2id"] in vetoes or s["date"] >= TEST_FROM
    snaps, state, play = walk_snaps(series, vetoes, keep)

    lines = ["# Simulator veto model", "",
             "Which map a team bans or picks: a conditional logit over the remaining maps, with separate ban and pick "
             "weights, on the team's own ban or pick rate (HLTV), its recent played-map preference (Liquipedia), and "
             f"the map model's edge for it. Map coefficients and choice weights are fit before {TEST_FROM}; everything "
             f"marked held out, and the gate, scores series from {TEST_FROM} on.", ""]
    coefs = map_coefs(df, TEST_FROM)
    betas = {}
    for mode in MODES:
        groups = choice_groups(mode, coefs[mode], series, vetoes, snaps, before=TEST_FROM)
        test = list(choice_steps(mode, coefs[mode], series, vetoes, snaps, since=TEST_FROM))
        held_out = [(X, c) for X, c, _, _ in test]
        names = choice_names(mode)
        betas[mode] = fit_choice(groups)
        variants = {"Uniform": np.zeros(len(names)),
                    "Habits only": fit_choice(groups, [i for i, (_, f) in enumerate(names) if f != "edge"]),
                    "Edge only": fit_choice(groups, [i for i, (_, f) in enumerate(names) if f == "edge"]),
                    "Blend": betas[mode]}
        lines += [f"## Choice model: {mode}", "",
                  f"{len(groups):,} steps fit, {len(test):,} held out. Weights: "
                  + ", ".join(f"{a} {f} {b:+.3f}" for (a, f), b in zip(names, betas[mode])) + ".",
                  "", "| Model | In-sample log-likelihood per step | Held out | Held-out top choice |",
                  "| --- | --- | --- | --- |"]
        for name, b in variants.items():
            top = (np.mean([1 / len(X) for X, _ in held_out]) if name == "Uniform"
                   else np.mean([(X @ b).argmax() == c for X, c in held_out]))
            lines.append(f"| {name} | {choice_ll(groups, b) / len(groups):.4f} | "
                         f"{choice_ll(held_out, b) / len(held_out):.4f} | {top:.1%} |")
        expected, actual = Counter(), Counter()
        for X, c, action, options in test:
            x = X @ betas[mode]
            p = np.exp(x - x.max())
            for m, q in zip(options, p / p.sum()):
                expected[action, m] += q
            actual[action, options[c]] += 1
        lines += ["", "Held out, predicted vs actual:", "", "| Map | Bans predicted | Bans | Picks predicted | Picks |",
                  "| --- | --- | --- | --- | --- |"]
        for m in sorted({m for _, m in expected}):
            lines.append(f"| {lp_of.get(m, m)} | {expected['ban', m]:.0f} | {actual['ban', m]} | "
                         f"{expected['pick', m]:.0f} | {actual['pick', m]} |")
        lines.append("")
    share = favourite_second(series, vetoes, TEST_FROM)
    coef, beta = coefs["liquipedia"], betas["liquipedia"]
    shrink = fit_shrink(series, vetoes, snaps, coef, beta, share)
    held = selection_forecasts(series, vetoes, snaps, coef, beta * shrink, share, since=TEST_FROM)
    lines += [f"Forecast shrink on choice scores, fit before {TEST_FROM}: {shrink:g}.", ""]
    lines += selection_lines(held)
    lines += label_lines(selection_forecasts(series, vetoes, snaps, coef, beta * shrink, share, before=TEST_FROM), held)

    g = gate(series, vetoes, snaps, coefs, betas, temp)
    table = gate_table(g)
    lines += ["## Series gate", "",
              "Series log loss: the current simulator (pool-averaged Elo map probability) against the veto model, "
              "positive gain = veto model better. 90% interval resamples events.", "",
              "| Series | n | Current | HLTV | Gain | 90% CI | Liquipedia | Gain | 90% CI |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    def cells(r: dict) -> str:
        return " | ".join(f"{_f(r[m])} | {_f(r[f'{m}_gain'], True)} | ({_f(r[f'{m}_ci'][0], True)}, "
                          f"{_f(r[f'{m}_ci'][1], True)})" for m in MODES)

    for r in table:
        lines.append(f"| {r['set']} | {r['series']:,} | {_f(r['current'])} | {cells(r)} |")
    passed = {mode: table[0][f"{mode}_gain"] >= 0 for mode in MODES}
    lines += ["", "Gate (no worse on all series): " + ", ".join(f"{m} **{'PASS' if p else 'FAIL'}**"
                                                             for m, p in passed.items()) + "."]
    lines += ["", "### What the gain is made of", "",
              "All series. Uniform choices: the veto played with every choice equally likely, isolating the map model "
              "from veto prediction. Pool-mean only: no veto, the current simulator shifted by the mean map-model edge "
              "over the pool; with `u` centred it equals the current simulator. Played maps known: a Bo1's real map, or "
              "a longer series' real picked maps with the decider averaged over the rest of the pool, the ceiling a "
              "perfect veto predictor could reach (map identities only, no results; series whose played maps don't fit "
              "the pool are left out).", "",
              "| Variant | Series | n | Current | HLTV | Gain | 90% CI | Liquipedia | Gain | 90% CI |",
              "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for variant in VARIANTS:
        for r in gate_table(g, [s for s in SETS if s[0] in ("all", "Bo3")], variant):
            lines.append(f"| {r['variant']} | {r['set']} | {r['series']:,} | {_f(r['current'])} | {cells(r)} |")

    if write:
        all_coefs = map_coefs(df, None)
        all_betas = {mode: fit_choice(choice_groups(mode, all_coefs[mode], series, vetoes, snaps, None))
                     for mode in MODES}
        export(series, state, play, all_coefs, all_betas, lp_of, temp, favourite_second(series, vetoes, None),
               shrink)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    (WAR_REPORTS / "sim-veto.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0
