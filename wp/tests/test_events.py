import math

import numpy as np
import polars as pl

from cs2wp.states import CT, T, _round_events


def bomb_state(t, planted):
    return {"seconds": t / 64, "bomb_planted": planted.astype(np.float32), "bomb_site": np.where(planted, "A", "none"),
            "since_plant": np.full(len(t), np.nan)}


def snaps(players, sides):
    rows = []
    for tick in (0, 16, 32):
        for p, s in zip(players, sides):
            rows.append({"tick": tick, "steamid": p, "side": s, "health": 100, "graph_A": 100.0, "graph_B": 200.0,
                         "euclid_A": 90.0, "euclid_B": 190.0, "util": 1.0, "kit": 0.0, "defusing": 0.0})
    return pl.DataFrame(rows)


def damage(tick, attacker, victim, pre, post, a_side="counter-terrorist", v_side="terrorist", weapon="ak47"):
    return {"tick": tick, "attacker_steamid": attacker, "attacker_side": a_side, "victim_steamid": victim,
            "victim_side": v_side, "weapon": weapon, "health_pre": pre, "health_post": post}


def events(dmg_rows, kills_rows=(), bomb_rows=()):
    players, sides = [1, 2], np.array([CT, T])
    dmg = pl.DataFrame(dmg_rows)
    kills = pl.DataFrame(list(kills_rows), schema={"tick": pl.Int64, "victim_steamid": pl.Int64, "assist_flash": pl.Boolean,
                                                   "assister_steamid": pl.Int64, "victim_traded": pl.Boolean})
    bomb = pl.DataFrame(list(bomb_rows), schema={"tick": pl.Int64, "event": pl.Utf8, "steamid": pl.Int64})
    base = {"key": "1/m1", "date": "2026-01-01", "map": "de_mirage", "round_num": 1, "ct_win": True}
    return _round_events(None, {}, base, 0, 100, players, sides, snaps(players, sides), dmg, kills, bomb, bomb_state)


def test_hp_and_alive_before_and_after_each_hit():
    out = events([damage(10, 1, 2, 100, 50), damage(20, 1, 2, 50, 0)],
                 [{"tick": 20, "victim_steamid": 2, "assist_flash": False, "assister_steamid": None, "victim_traded": False}])
    assert out["pre_t_hp"].to_list() == [100, 50]
    assert out["post_t_hp"].to_list() == [50, 0]
    assert out["lethal"].to_list() == [False, True]
    # The last T dying with no bomb planted ends the round for CT.
    assert math.isnan(out["terminal"][0]) and out["terminal"][1] == 1.0


def test_plant_changes_the_bomb_state_and_dead_ct_ends_it():
    out = events([damage(30, 2, 1, 100, 0, "terrorist", "counter-terrorist")], bomb_rows=[{"tick": 25, "event": "finish_plant", "steamid": 2}])
    assert out["kind"].to_list() == ["plant", "damage"]
    assert out["pre_bomb_planted"].to_list() == [0, 1] and out["post_bomb_planted"].to_list() == [1, 1]
    assert out["alive_ct"][0].to_list() == [1]
    assert out["terminal"][1] == 0.0


def test_bomb_explosion_damage_isnt_an_action():
    out = events([damage(10, 1, 2, 100, 90), damage(99, None, 1, 100, 0, None, "counter-terrorist", "planted_c4")])
    assert out.height == 1
