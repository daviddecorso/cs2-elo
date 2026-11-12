import numpy as np
import polars as pl

from cs2wp.credit import conservation

CT, T = 3, 2


def _round(p_pre, p_post, credits, p0=0.5, ct_win=True):
    """One round: events with CT win probability before/after, and (steamid, role, wpa) credit rows."""
    n = len(p_pre)
    events = pl.DataFrame({"round_num": [1] * n, "seq": list(range(n)), "p_pre": p_pre, "p_post": p_post,
                           "v": [b - a for a, b in zip(p_pre, p_post)]})
    cred = pl.DataFrame({"round_num": [1] * len(credits), "steamid": [c[0] for c in credits],
                         "role": [c[1] for c in credits], "wpa": [c[2] for c in credits]},
                        schema={"round_num": pl.Int64, "steamid": pl.UInt64, "role": pl.Utf8, "wpa": pl.Float64})
    roster = pl.DataFrame({"round_num": [1] * 4, "steamid": [1, 2, 3, 4], "side": [CT, CT, T, T]},
                          schema={"round_num": pl.Int64, "steamid": pl.UInt64, "side": pl.Int32})
    p0f = pl.DataFrame({"round_num": [1], "ct_win": [ct_win], "p0": [p0]})
    return conservation(events, cred, roster, p0f).row(0, named=True)


def test_holds_when_events_chain_and_shares_are_zero_sum():
    # A CT kill (+0.2), then the round-deciding CT kill (+0.3 to 1.0).
    r = _round([0.5, 0.7], [0.7, 1.0], [(1, "kill", 0.2), (3, "death", -0.2), (2, "kill", 0.3), (4, "death", -0.3)])
    assert r["passed"] and r["reasons"] == []
    assert abs(r["identity_error"]) < 1e-12


def test_names_drift_end_and_trade_returns():
    # Probability falls 0.1 between the events, the round ends on time after the last event, and a T death is traded.
    r = _round([0.5, 0.6], [0.7, 0.8], [(1, "kill", 0.2), (3, "death", -0.2), (3, "trade_return", 0.1),
                                        (2, "kill", 0.2), (4, "death", -0.2)], ct_win=False)
    assert not r["passed"]
    assert set(r["reasons"]) == {"drift between events", "round ended without a deciding event", "trade return"}
    assert np.isclose(r["drift"], -0.1) and np.isclose(r["end"], -0.8) and np.isclose(r["leak_t"], 0.1)
    assert abs(r["identity_error"]) < 1e-12
