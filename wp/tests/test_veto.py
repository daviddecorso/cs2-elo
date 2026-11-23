import math

import numpy as np
import polars as pl
import pytest

from cs2wp.simveto import Play, fit_choice, series_veto_prob, veto_distribution
from cs2wp.veto import DAY, State, feature_row, series_prob, value_lost, veto_series_probs

POOL = [f"m{i}" for i in range(7)]
FIXTURE_A = dict(u=[0.05, -0.02, 0.1, 0, -0.08, 0.03, 0.01], play=[0.3, -0.2, 0.1, -0.4, 0.2, 0, 0.05],
                 ban=[-0.1, 0.3, -0.05, 0.4, -0.2, 0, 0.02], pick=[0.2, -0.1, 0.3, -0.2, 0, 0.05, -0.1])
FIXTURE_B = dict(u=[-0.03, 0.06, -0.04, 0.02, 0.07, -0.01, 0], play=[-0.1, 0.25, 0, 0.3, -0.3, 0.1, 0],
                 ban=[0.25, -0.1, 0.2, -0.15, 0, 0.05, -0.05], pick=[-0.1, 0.2, -0.2, 0.25, 0.1, 0, 0])


def _snap():
    as_maps = lambda d: {m: {k: d[k][i] for k in d} for i, m in enumerate(POOL)}
    return {"pool": POOL, "teams": (as_maps(FIXTURE_A), as_maps(FIXTURE_B))}


def test_matches_the_simulator_fixture():
    # scripts/lib/sim/veto.test.ts asserts the same two numbers.
    coef = {"du": 2.0, "pick": 0.1, "ban_rate": -0.4, "pick_rate": 0.3}
    bo3 = [(2, "ban"), (1, "ban"), (2, "pick"), (1, "pick"), (1, "ban"), (2, "ban")]
    assert series_veto_prob("hltv", coef, np.array([1.5, 0.8, 1.2] * 2), _snap(), 0.2, 3, bo3, 0.8) == pytest.approx(
        0.5596216069460083, abs=1e-12)
    bo1 = [(2, "ban"), (2, "ban"), (1, "ban"), (1, "ban"), (1, "ban"), (2, "ban")]
    assert series_veto_prob("liquipedia", {"du": 2.0}, np.array([0.8, 1.2] * 2), _snap(), -0.1, 1, bo1, 0.8) == pytest.approx(
        0.47812098580749307, abs=1e-12)


def test_separate_ban_and_pick_weights_match_the_simulator_fixture():
    beta = np.array([0.9, 0.4, 1.6, 1.1])
    bo3 = [(2, "ban"), (1, "ban"), (2, "pick"), (1, "pick"), (2, "ban"), (1, "ban")]
    assert series_veto_prob("liquipedia", {"du": 2.0}, beta, _snap(), 0.2, 3, bo3, 0.8) == pytest.approx(
        0.5643720223043276, abs=1e-12)
    m0 = veto_distribution("liquipedia", {"du": 2.0}, beta, _snap(), 3, 0.7)["m0"]
    assert [*m0["ban"], *m0["pick"], m0["decider"]] == pytest.approx(
        [0.19758813094763902, 0.3238315488697666, 0.24518404907363311, 0.09218141966933549, 0.14121485143962584], abs=1e-12)


def test_fit_choice_recovers_the_weights():
    rng = np.random.default_rng(0)
    beta = np.array([1.2, -0.7])
    groups = []
    for _ in range(4000):
        X = rng.normal(size=(int(rng.integers(2, 8)), 2))
        p = np.exp(X @ beta)
        groups.append((X, int(rng.choice(len(X), p=p / p.sum()))))
    assert fit_choice(groups) == pytest.approx(beta, abs=0.1)


def test_play_preference_is_centred_and_shrunk():
    play = Play(prior=5.0)
    for _ in range(5):
        play.add(0, ["a", "b"], list("abcdefz"), 0.0)
    # 10 plays over 7 maps → 10/7 expected per map; "a" played 5 times, over 5 series + 5 prior.
    assert play.get(0, "a", 0.0) == pytest.approx((5 - 10 / 7) / 10)
    assert play.get(0, "z", 0.0) == pytest.approx(-(10 / 7) / 10)
    assert play.get(1, "a", 0.0) == 0.0


def test_play_decays_and_a_new_map_starts_neutral():
    # scripts/lib/sim/vetoInputs.test.ts asserts the same values.
    play = Play(prior=10.0, tau=90.0)
    play.add(0, ["a", "b"], list("abcdefg"), 0.0)
    assert play.get(0, "h", 30 * DAY) == 0.0
    play.add(0, ["h"], list("abcdefh"), 90 * DAY)
    d = math.exp(-1)
    assert play.get(0, "a", 90 * DAY) == pytest.approx((d - 2 / 7 * d - 1 / 7) / (d + 1 + 10))
    assert play.get(0, "h", 90 * DAY) == pytest.approx((1 - 1 / 7) / (1 + 10))
    assert play.get(0, "g", 180 * DAY) == pytest.approx(-(2 / 7) * d * d / (d * d + 10))


def test_veto_distribution_places_every_map_once():
    out = veto_distribution("liquipedia", {"du": 2.0}, np.array([0.9, 0.4, 1.6, 1.1]), _snap(), 3, 0.7)
    for d in out.values():
        assert sum(d["ban"]) + sum(d["pick"]) + d["decider"] == pytest.approx(1.0)
    assert sum(sum(d["pick"]) + d["decider"] for d in out.values()) == pytest.approx(3.0)
    assert sum(d["pick"][0] for d in out.values()) == pytest.approx(1.0)


def test_centred_u_sums_to_zero_over_the_pool():
    state = State(5.0, math.inf)
    for m, r in (("a", 0.4), ("b", -0.1), ("a", 0.2), ("c", 0.3)):
        state.add_residual(0, m, r, 0.0)
    pool = ["a", "b", "c", "d"]
    assert sum(state.centred_u(0, m, 0.0, pool) for m in pool) == pytest.approx(0.0, abs=1e-12)
    assert state.centred_u(0, "a", 0.0, []) == state.u(0, "a", 0.0)


def test_uniform_residual_gives_no_edge():
    state = State(5.0, math.inf)
    pool = ["a", "b", "c"]
    for _ in range(4):
        for m in pool:
            state.add_residual(0, m, 0.3, 0.0)
            state.add_residual(1, m, -0.3, 0.0)
    s = {"lineages": (0, 1), "t": 0.0}
    assert all(feature_row(state, s, m, pool)[0] == pytest.approx(0.0, abs=1e-12) for m in pool)


def test_series_prob_matches_bo3_by_hand():
    p = [0.6, 0.7, 0.4]
    logits = [math.log(q / (1 - q)) for q in p]
    by_hand = p[0] * p[1] + p[0] * (1 - p[1]) * p[2] + (1 - p[0]) * p[1] * p[2]
    assert series_prob(logits, 1.0) == pytest.approx(by_hand)


def test_bo1_ban_removes_the_opponents_best_map():
    # Three maps, A bans, B bans, the last is played. A is strong on x, weak on z.
    logits = {"x": 1.0, "y": 0.0, "z": -1.0}
    # A's best: ban z; then B bans x; y is played.
    rows = value_lost(logits, 0.0, [(1, "ban", "z"), (2, "ban", "x")], 1.0)
    assert [r["lost"] for r in rows] == [pytest.approx(0.0), pytest.approx(0.0)]
    assert rows[0]["best"] == "z" and rows[1]["best"] == "x"

    bad = value_lost(logits, 0.0, [(1, "ban", "x"), (2, "ban", "y")], 1.0)
    p = lambda l: 1 / (1 + math.exp(-l))
    # Banning x leaves {y, z}; B bans y and z is played, against y had A banned z.
    assert bad[0]["lost"] == pytest.approx(p(0.0) - p(-1.0))
    # B's ban of y is its best reply, so it loses nothing.
    assert bad[1]["lost"] == pytest.approx(0.0)


def test_lost_is_never_negative_and_counts_the_pick_advantage():
    logits = {m: 0.1 * i for i, m in enumerate("abcdefg")}
    veto = [(1, "ban", "a"), (2, "ban", "b"), (1, "pick", "c"), (2, "pick", "d"), (1, "ban", "e"), (2, "ban", "f")]
    rows = value_lost(logits, 0.3, veto, 0.8)
    assert all(r["lost"] >= 0 for r in rows)
    assert len(rows) == 6
    assert any(r["lost"] > 0 for r in rows)


def test_veto_series_probs_play_picks_and_decider():
    maps = [f"de_m{i}" for i in range(7)]
    veto = pl.DataFrame({"step": range(1, 8), "opponent": [1, 2, 1, 2, 1, 2, None],
                         "action": ["ban", "ban", "pick", "pick", "ban", "ban", "decider"], "map": maps})
    feats = {m: (0.1 * i, 0.0, 0.0) for i, m in enumerate(maps)}
    s = {"base": 0.2, "offsets": [{"de_m2": 0.3}, {"de_m6": 0.1}]}
    got = veto_series_probs(s, veto, feats, np.array([2.0, 0.05, 0.0, 0.0]), 0.8)
    # Picks: de_m2 by A (+γ), de_m3 by B (−γ); decider de_m6.
    assert got["model_veto"] == pytest.approx(series_prob([0.2 + 0.4 + 0.05, 0.2 + 0.6 - 0.05, 0.2 + 1.2], 0.8))
    assert got["elo_veto"] == pytest.approx(series_prob([0.5, 0.2, 0.1], 0.8))
