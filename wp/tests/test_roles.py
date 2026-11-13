import polars as pl
import pytest

from cs2wp.roles import assign, label, openings, player_rounds
from cs2wp.states import BUY_WINDOW_TICKS, CT, T, TICK_RATE

FREEZE_END = 1000
ROUNDS = pl.DataFrame({"round_num": [1, 2], "start_tick": [0, 5000], "freeze_end_tick": [FREEZE_END, 6000]})


def at(seconds: float, round_start: int = FREEZE_END) -> int:
    return round_start + int(seconds * TICK_RATE)


def ticks(rows):
    return pl.DataFrame(rows, schema={"tick": pl.Int64, "round_num": pl.Int64, "steamid": pl.UInt64, "side": pl.Int64,
                                      "health": pl.Int64, "active_weapon": pl.String, "equipment_value": pl.Int64},
                        orient="row")


def kills(rows):
    return pl.DataFrame(rows, schema={"tick": pl.Int64, "round_num": pl.Int64, "attacker_steamid": pl.UInt64,
                                      "attacker_side": pl.String, "victim_steamid": pl.UInt64,
                                      "victim_side": pl.String}, orient="row")


def full_buy(steamid, side, weapon="ak47", tick=at(5), health=100):
    return (tick, 1, steamid, side, health, weapon, 4500)


def test_awp_counts_only_in_hand_while_alive_during_buy_time():
    t = ticks([
        full_buy(1, T, "awp"),
        full_buy(2, T, "awp", tick=FREEZE_END - 10),  # dropped during freeze time
        full_buy(3, T, "awp", tick=FREEZE_END + BUY_WINDOW_TICKS + 1),  # picked up later
        full_buy(4, T, "awp", health=0),
        full_buy(5, T),
    ])
    pr = player_rounds(ROUNDS, t).sort("steamid")
    assert pr["awp"].to_list() == [True, False, False, False, False]


def test_buy_needs_team_equipment_at_the_threshold():
    t = ticks([(at(5), 1, p, T, 100, "ak47", 3999) for p in range(1, 6)]
              + [(at(5), 1, p, CT, 100, "m4a1", 4000) for p in range(6, 11)])
    pr = player_rounds(ROUNDS, t)
    assert pr.filter(pl.col("side") == T)["buy"].any() is False
    assert pr.filter(pl.col("side") == CT)["buy"].all()


def test_openings_take_the_first_kill_between_opponents_after_freeze_end():
    k = kills([
        (FREEZE_END - 5, 1, 9, "terrorist", 8, "counter-terrorist"),  # before freeze end
        (at(10), 1, 1, "terrorist", 2, "terrorist"),  # team kill
        (at(11), 1, None, None, 3, "terrorist"),  # world
        (at(12), 1, 4, "counter-terrorist", 5, "terrorist"),
        (at(13), 1, 6, "terrorist", 7, "counter-terrorist"),
        (at(3, 6000), 2, 6, "terrorist", 7, "counter-terrorist"),
    ])
    o = openings(ROUNDS, k).sort("round_num")
    assert o.rows() == [(1, 4, 5, CT), (2, 6, 7, T)]


def test_entry_share_counts_opening_kills_and_deaths_on_t_side():
    pr = pl.DataFrame({"steamid": [1, 1, 2, 2, 1], "round_num": [1, 2, 1, 2, 3], "side": [T, T, T, T, CT],
                       "buy": [True, True, True, True, True], "awp": [False, False, True, True, True]},
                      schema_overrides={"steamid": pl.UInt64})
    # Round 1: player 1 opens with a kill. Round 2: player 1 dies first. Round 3 is CT side and doesn't count.
    o = pl.DataFrame({"round_num": [1, 2, 3], "attacker": [1, 9, 1], "victim": [9, 1, 9], "attacker_side": [T, CT, CT]},
                     schema_overrides={"attacker": pl.UInt64, "victim": pl.UInt64})
    out = {r["steamid"]: r for r in assign(pr, o).iter_rows(named=True)}
    assert (out[1]["opening_kills"], out[1]["opening_deaths"], out[1]["t_rounds"]) == (1, 1, 2)
    assert out[1]["entry_share"] == 1 and out[2]["entry_share"] == 0
    assert out[1]["awp_share"] == pytest.approx(1 / 3) and out[1]["t_awp_share"] == 0
    assert (out[2]["t_awp_rounds"], out[2]["t_buy_rounds"], out[2]["awp_share"]) == (2, 2, 1)


def test_label_picks_one_awper_then_the_top_entry_among_the_rest():
    df = pl.DataFrame({"key": ["m"] * 4, "team": ["a"] * 4, "steamid": [1, 2, 3, 4],
                       "awp_share": [0.6, 0.4, 0.0, 0.0], "entry_share": [0.5, 0.1, 0.3, 0.2]},
                      schema_overrides={"steamid": pl.UInt64})
    assert label(df).sort("steamid")["t_role"].to_list() == ["AWPer", "Rifler", "Entry", "Rifler"]


def test_no_awper_below_the_threshold():
    df = pl.DataFrame({"key": ["m"] * 2, "team": ["a"] * 2, "steamid": [1, 2], "awp_share": [0.2, float("nan")],
                       "entry_share": [0.1, 0.3]}, schema_overrides={"steamid": pl.UInt64})
    assert label(df).sort("steamid")["t_role"].to_list() == ["Rifler", "Entry"]
