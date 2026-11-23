import polars as pl
import pytest

from cs2wp.states import CT, T
from cs2wp.style import ARCHETYPES, BY_KEY, ISOLATION_AT, assign, comps, isolation, percentiles


def test_archetypes_only_use_own_metrics():
    for a in ARCHETYPES:
        assert all(BY_KEY[k].own for k in a.targets), a.key


def test_percentiles_rank_within_pools_and_flip_lower_first():
    wide = pl.DataFrame({
        "steamid": ["a", "b", "c", "d", "e"],
        "awper": [False, False, False, True, True],
        "firepower": [1.0, 2.0, 3.0, 10.0, 0.0],
        "pace": [30.0, 40.0, 50.0, 60.0, 20.0],
    })
    out = {r["steamid"]: r for r in percentiles(wide, ["firepower", "pace"]).iter_rows(named=True)}
    # Production ranks everyone together.
    assert out["d"]["firepower_pct"] == 100 and out["e"]["firepower_pct"] == 0
    assert out["b"]["firepower_pct"] == 50
    # Style ranks AWPers apart, and a lower pace (earlier fights) ranks higher.
    assert out["a"]["pace_pct"] == 100 and out["c"]["pace_pct"] == 0
    assert out["e"]["pace_pct"] == 100 and out["d"]["pace_pct"] == 0


def test_assign_picks_nearest_for_role_and_skips_thin_profiles():
    keys = {"isolation", "pace", "opening", "traded", "utilityThrown", "flashing", "flashAssists", "resourceShare",
            "survival", "firepower", "tradeKills"}
    lurk = {"isolation": 90, "pace": 15, "opening": 25, "traded": 20}
    best, runner, fit = assign(lurk, "Rifler", keys)
    assert best == "lurker" and runner is not None and fit == pytest.approx(5.0)
    # Same numbers on an AWPer only consider AWP archetypes.
    assert assign(lurk, "AWPer", keys)[0] in {"aggressiveAwp", "anchorAwp", "hybridAwp"}
    assert assign({"isolation": 90}, "Rifler", keys) == (None, None, None)
    assert assign(lurk, None, keys) == (None, None, None)


def test_isolation_is_nearest_living_teammate_after_freeze_end():
    at = 1000 + ISOLATION_AT
    ticks = pl.DataFrame({
        "tick": [at - 16, at, at, at, at, at],
        "round_num": [1, 1, 1, 1, 1, 1],
        "steamid": [1, 1, 2, 3, 4, 5],
        "side": [T, T, T, T, T, CT],
        "x": [0.0, 0.0, 300.0, 0.0, 50.0, 1.0],
        "y": [0.0, 0.0, 400.0, 1000.0, 0.0, 1.0],
        "health": [100, 100, 100, 100, 0, 100],
    }, schema_overrides={"steamid": pl.UInt64})
    rounds = pl.DataFrame({"round_num": [1], "freeze_end_tick": [1000]})
    got = dict(isolation(ticks, rounds).sort("steamid").select("steamid", "isolation").iter_rows())
    # Player 4 is dead and the CT doesn't count, so 1's nearest is 2 at 500 units.
    assert got == {1: 500.0, 2: 500.0, 3: pytest.approx(670.8, abs=0.1)}


def test_comps_ranks_by_rms_respects_pool_and_min_shared_axes():
    table = pl.DataFrame({
        "steamid": ["a", "b", "c", "d", "e"],
        "awper": [False, False, False, True, False],
        "k1_pct": [80.0, 83.0, 10.0, 80.0, 80.0],
        "k2_pct": [60.0, 56.0, 10.0, 60.0, 60.0],
        "k3_pct": [40.0, 40.0, 90.0, 40.0, None],
        "k4_pct": [20.0, 20.0, 90.0, 20.0, None],
    })
    keys = ["k1", "k2", "k3", "k4"]
    # Unpooled: d is an exact match (0 RMS), b is at sqrt((9+16)/4) = 2.5 RMS; e shares only 2/4 < 70% so is skipped.
    all_comps = comps(table, keys, pool_col=None, n=5)
    assert [c["steamid"] for c in all_comps["a"]] == ["d", "b", "c"]
    assert all_comps["a"][0]["similarity"] == pytest.approx(100.0)
    assert all_comps["a"][1]["similarity"] == pytest.approx(97.5)
    assert all(c["steamid"] != "a" for c in all_comps["a"])

    # Pooled by awper: a never matches AWPer d, and d has no other AWPers.
    pooled = comps(table, keys, pool_col="awper", n=5)
    assert [c["steamid"] for c in pooled["a"]] == ["b", "c"]
    assert pooled["a"][0]["similarity"] == pytest.approx(97.5)
    assert pooled["d"] == []
