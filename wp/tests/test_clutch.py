import math

import polars as pl

from cs2wp.clutch import centred, entries
from cs2wp.states import CT, T

NAN = math.nan


def _events(rows):
    cols = ["round_num", "seq", "lethal", "victim", "post_ct_alive", "post_t_alive", "alive_ct", "alive_t", "terminal",
            "ct_win"]
    return pl.DataFrame([dict(zip(cols, r)) for r in rows],
                        schema={"round_num": pl.Int64, "seq": pl.Int64, "lethal": pl.Boolean, "victim": pl.UInt64,
                                "post_ct_alive": pl.Float32, "post_t_alive": pl.Float32,
                                "alive_ct": pl.List(pl.UInt64), "alive_t": pl.List(pl.UInt64),
                                "terminal": pl.Float64, "ct_win": pl.Boolean})


def test_first_entry_per_class_and_survivor():
    cts, ts = [1, 2], [11, 12]
    ev = _events([
        (1, 0, True, 2, 1, 2, cts, ts, NAN, True),       # CT 1v2: clutch and disadv for CT, adv for T
        (1, 1, True, 12, 1, 1, [1], ts, NAN, True),      # 1v1: a later clutch entry for CT is ignored
        (1, 2, True, 11, 1, 0, [1], [11], 1.0, True),    # ends the round
    ])
    out = entries(ev)
    ct = {r["cls"]: r for r in out.filter(pl.col("side") == CT).iter_rows(named=True)}
    t = {r["cls"]: r for r in out.filter(pl.col("side") == T).iter_rows(named=True)}
    assert set(ct) == {"clutch", "disadv"}
    assert ct["clutch"]["seq"] == 0 and ct["clutch"]["survivor"] == 1 and ct["clutch"]["won"]
    assert (ct["clutch"]["own"], ct["clutch"]["opp"]) == (1, 2)
    assert set(t) == {"adv", "clutch"}
    assert t["clutch"]["seq"] == 1 and t["clutch"]["survivor"] == 11 and not t["clutch"]["won"]


def test_terminal_events_are_skipped():
    ev = _events([(1, 0, True, 2, 1, 0, [1, 2], [11], 0.0, False)])
    assert entries(ev).is_empty()


def test_centring_zeroes_each_bucket():
    rows = pl.DataFrame({"cls": ["clutch"] * 4, "own": [1] * 4, "opp": [2, 2, 3, 3], "side": [CT] * 4,
                         "won": [True, False, False, False], "p": [0.3, 0.3, 0.1, 0.2]})
    out = centred(rows)
    sums = out.group_by("opp").agg(pl.col("conv").sum())
    assert all(abs(v) < 1e-12 for v in sums["conv"])
