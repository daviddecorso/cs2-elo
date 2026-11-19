import math

import polars as pl

from cs2wp.predictability import TIMINGS, rematch_flags, timing_bin, walk_forward


def test_timing_bins():
    assert [timing_bin(s) for s in (0.0, 19.9, 20.0, 45.0, 90.0)] == ["<20", "<20", "20-40", "40-60", "60+"]
    assert timing_bin(None) is None and timing_bin(math.nan) is None


def _rounds(days, sites, unit="u"):
    n = len(days)
    return pl.DataFrame({"date": days, "map": ["de_x"] * n, "buy": ["full"] * n, "site": sites,
                         "timing": [None if s == "none" else TIMINGS[0] for s in sites],
                         "exec": [None if s == "none" else "1" for s in sites], "stint": [unit] * n})


def test_walk_forward_uses_only_earlier_dates():
    r = _rounds(["2025-01-01", "2025-01-01", "2025-01-02"], ["A", "A", "A"])
    out = walk_forward(r, "stint", m=20, min_prior=2)
    assert out["eligible"].to_list() == [False, False, True]
    # Same-day rounds aren't history for each other: with min_prior 1 the second round is still ineligible.
    assert walk_forward(r, "stint", m=20, min_prior=1)["eligible"].to_list() == [False, False, True]


def test_scout_matches_league_when_unit_history_equals_league():
    r = _rounds(["2025-01-01"] * 3 + ["2025-01-02"], ["A", "B", "none", "A"])
    out = walk_forward(r, "stint", m=20, min_prior=3)
    # The only unit is the whole league, so the scout's smoothed P differs only by add-one; the gain is small.
    assert out["eligible"].to_list()[-1]
    assert abs(out["gain_site"][-1]) < 0.1


def test_predictable_team_gains_over_the_league():
    days = ["2025-01-01"] * 40 + ["2025-01-02"]
    r = pl.concat([_rounds(days, ["A"] * 41, "pred"), _rounds(days, ["B"] * 41, "other")])
    out = walk_forward(r, "stint", m=5, min_prior=30)
    last = out.filter(pl.col("eligible"))
    assert last.height == 2 and (last["gain_site"] > 0.4).all()


def test_rematch_window_excludes_the_same_series_and_old_meetings():
    pairs = pl.DataFrame({"team_a": ["A"] * 4, "team_b": ["B"] * 4, "series": ["s1", "s1", "s2", "s3"],
                          "date": ["2025-01-01", "2025-01-01", "2025-02-15", "2025-06-01"]})
    assert rematch_flags(pairs, days=60) == [False, False, True, False]
