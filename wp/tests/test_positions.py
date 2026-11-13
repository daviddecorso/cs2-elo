import polars as pl
import pytest

from cs2wp.positions import assign, unmapped, window_samples
from cs2wp.states import CT, T, TICK_RATE

FREEZE_END = 1000
CALLOUTS = {"Jungle": "Connector", "Connector": "Connector", "BombsiteA": "A", "Catwalk": "Mid", "CTSpawn": None}


def at(seconds: float) -> int:
    return FREEZE_END + int(seconds * TICK_RATE)


def ticks(rows):
    return pl.DataFrame(rows, schema={"tick": pl.Int64, "round_num": pl.Int64, "steamid": pl.UInt64, "side": pl.Int64,
                                      "health": pl.Int64, "last_place_name": pl.String, "x": pl.Float64,
                                      "y": pl.Float64, "z": pl.Float64}, orient="row")


def samples(rows):
    return pl.DataFrame(rows, schema={"round_num": pl.Int64, "steamid": pl.UInt64, "callout": pl.String}, orient="row")


ROUNDS = pl.DataFrame({"round_num": [1], "start_tick": [0], "freeze_end_tick": [FREEZE_END]})


def test_window_keeps_alive_cts_between_15_and_25_seconds():
    t = ticks([
        (at(14.9), 1, 1, CT, 100, "CTSpawn", 0, 0, 0),
        (at(15), 1, 1, CT, 100, "Jungle", 0, 0, 0),
        (at(25), 1, 1, CT, 100, "Jungle", 0, 0, 0),
        (at(25.1), 1, 1, CT, 100, "BombsiteA", 0, 0, 0),
        (at(20), 1, 2, CT, 0, "Catwalk", 0, 0, 0),
        (at(20), 1, 3, T, 100, "Catwalk", 0, 0, 0),
        (at(20), 1, 0, CT, 100, "Catwalk", 0, 0, 0),
    ])
    s = window_samples(ROUNDS, t)
    assert s["steamid"].to_list() == [1, 1] and s["callout"].to_list() == ["Jungle", "Jungle"]


def test_window_falls_back_to_round_start_without_freeze_end():
    rounds = pl.DataFrame({"round_num": [1], "start_tick": [0], "freeze_end_tick": [None]},
                          schema={"round_num": pl.Int64, "start_tick": pl.Int64, "freeze_end_tick": pl.Int64})
    s = window_samples(rounds, ticks([(20 * TICK_RATE, 1, 1, CT, 100, "Jungle", 0, 0, 0)]))
    assert s.height == 1


def test_each_round_votes_once_and_callouts_merge_into_positions():
    # Round 1 is mostly Connector across two callouts; round 2 is A; round 3 is Connector.
    s = samples([(1, 1, "Jungle"), (1, 1, "Connector"), (1, 1, "BombsiteA"),
                 (2, 1, "BombsiteA"), (3, 1, "Jungle")])
    out = assign(s, CALLOUTS).row(0, named=True)
    assert out["position"] == "Connector" and out["rounds_voted"] == 3
    assert out["share"] == pytest.approx(2 / 3)
    assert sorted((v["position"], v["rounds"]) for v in out["votes"]) == [("A", 1), ("Connector", 2)]


def test_null_callouts_and_empty_rounds_dont_vote():
    s = samples([(1, 1, "CTSpawn"), (1, 1, None), (2, 1, "Catwalk")])
    out = assign(s, CALLOUTS).row(0, named=True)
    assert out["position"] == "Mid" and out["rounds_voted"] == 1 and out["share"] == 1


def test_tied_rounds_go_to_the_position_with_more_samples():
    s = samples([(1, 1, "BombsiteA"), (2, 1, "Catwalk"), (2, 1, "Catwalk"), (3, 1, "BombsiteA"), (4, 1, "Catwalk")])
    assert assign(s, CALLOUTS)["position"].to_list() == ["Mid"]


def test_unmapped_callouts_are_reported_but_empty_ones_are_not():
    s = samples([(1, 1, "Jungle"), (1, 1, "Window"), (1, 1, "Window"), (1, 1, ""), (1, 1, None)])
    assert unmapped(s, CALLOUTS) == {"Window": 2}


def test_no_votes_gives_an_empty_frame():
    assert assign(samples([(1, 1, "CTSpawn")]), CALLOUTS).is_empty()
