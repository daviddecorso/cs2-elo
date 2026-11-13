import polars as pl

from cs2wp.duels import duels
from cs2wp.resources import COUNT_LAG, SMOKE_RADIUS, SMOKE_WINDOW, drops, economy, thrower_smokes
from cs2wp.states import CT, T

ROUND = {"round_num": [1], "start_tick": [0], "freeze_end_tick": [1280]}


def _tick(tick, sid, side, money, equip, weapon="glock", smokes=0, x=0.0, y=0.0):
    return {"tick": tick, "round_num": 1, "steamid": sid, "side": side, "health": 100, "active_weapon": weapon,
            "equipment_value": equip, "money": money, "armor": 0, "has_helmet": False, "has_defuser": False,
            "smoke_grenades": smokes, "flashbangs": 0, "he_grenades": 0, "fire_grenades": 0, "x": x, "y": y}


def _economy_ticks():
    # (start money, start equip, freeze-end money, freeze-end equip, gun held after freeze end)
    players = {
        1: (5000, 200, 2300, 200, "glock"),     # buys an AK and drops it: −2,700
        2: (1000, 200, 1000, 2900, "ak47"),     # picks the AK up: +2,700
        3: (1000, 200, 300, 700, "deagle"),     # replaces the glock with a deagle: −200
        4: (4000, 200, 1300, 2900, "ak47"),     # buys their own: 0
    }
    rows = []
    for sid, (m0, e0, m1, e1, gun) in players.items():
        rows.append(_tick(0, sid, T, m0, e0))
        rows.append(_tick(1280, sid, T, m1, e1, gun))
        rows.append(_tick(1600, sid, T, m1, e1, gun))
    rows.append(_tick(0, 9, CT, 800, 200))
    rows.append(_tick(1280, 9, CT, 800, 200))
    return pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64})


def test_net_transfer_is_equipment_gained_minus_money_spent():
    e = {r["steamid"]: r for r in economy(pl.DataFrame(ROUND), _economy_ticks()).iter_rows(named=True)}
    assert [e[s]["net_transfer"] for s in (1, 2, 3, 4)] == [-2700, 2700, -200, 0]
    assert e[2]["gun"] == "Rifle" and e[3]["gun"] == "Deagle"
    assert e[2]["team_equip"] == 200 + 2900 + 700 + 2900 and e[2]["opp_equip"] == 200
    assert e[2]["equip_share"] == 2900 / e[2]["team_equip"]


def test_drop_needs_a_teammate_on_the_other_side_of_the_transfer():
    d = {r["steamid"]: r for r in drops(economy(pl.DataFrame(ROUND), _economy_ticks())).iter_rows(named=True)}
    assert d[2]["drop_received"] and d[1]["drop_given"]
    assert not d[3]["drop_given"] and not d[3]["drop_received"] and not d[4]["drop_received"]


def test_drop_without_a_matching_giver_does_not_count():
    lone = pl.DataFrame({"round_num": [1, 1], "side": [T, T], "steamid": [1, 2], "net_transfer": [1500, -100]})
    assert not drops(lone)["drop_received"].any()


A, V, MATE, ENEMY = 1, 2, 3, 4


def _kill():
    return pl.DataFrame({"tick": [1000], "round_num": [1], "attacker_steamid": [A], "attacker_side": ["terrorist"],
                         "victim_steamid": [V], "victim_side": ["counter-terrorist"], "weapon": ["ak47"],
                         "attacker_x": [0.0], "attacker_y": [0.0], "attacker_z": [0.0], "victim_x": [1000.0],
                         "victim_y": [0.0], "victim_z": [0.0]},
                        schema_overrides={"attacker_steamid": pl.UInt64, "victim_steamid": pl.UInt64})


def _duel_ticks():
    rows = [{"tick": t, "round_num": 1, "steamid": s, "health": 100, "armor": 100, "has_helmet": True,
             "velocity": 0.0, "active_weapon": "ak47"} for t in range(0, 1001, 16) for s in (A, V)]
    return pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64})


def _damages():
    return pl.DataFrame({"tick": [900], "round_num": [1], "attacker_steamid": [V], "victim_steamid": [A]},
                        schema_overrides={"attacker_steamid": pl.UInt64, "victim_steamid": pl.UInt64})


def _flash(thrower, side, blinded=V):
    return pl.DataFrame({"tick": [850], "round_num": [1], "victim_steamid": [blinded], "duration": [3.0],
                         "attacker_steamid": [thrower], "attacker_side": [side]},
                        schema_overrides={"victim_steamid": pl.UInt64, "attacker_steamid": pl.UInt64})


def test_flash_support_counts_a_teammates_flash_only():
    mate = duels(_kill(), _damages(), _flash(MATE, "terrorist"), _duel_ticks()).row(0, named=True)
    assert mate["a_flash_support"] and not mate["a_self_flash"] and mate["v_blind"]
    own = duels(_kill(), _damages(), _flash(A, "terrorist"), _duel_ticks()).row(0, named=True)
    assert own["a_self_flash"] and not own["a_flash_support"]
    team_flash = duels(_kill(), _damages(), _flash(ENEMY, "counter-terrorist"), _duel_ticks()).row(0, named=True)
    assert team_flash["v_blind"] and not team_flash["a_flash_support"] and not team_flash["v_flash_support"]


def test_victim_gets_support_when_their_teammate_blinds_the_attacker():
    d = duels(_kill(), _damages(), _flash(ENEMY, "counter-terrorist", blinded=A), _duel_ticks()).row(0, named=True)
    assert d["v_flash_support"] and not d["a_flash_support"]


def _smoke(pop_tick, x, thrower=MATE, side=T):
    return pl.DataFrame({"round_num": [1], "thrower": [thrower], "side": [side], "pop_tick": [pop_tick], "x": [x],
                         "y": [0.0]}, schema_overrides={"thrower": pl.UInt64, "side": pl.Int32})


def _smoke_support(smoke):
    no_flash = _flash(MATE, "terrorist").clear()
    return duels(_kill(), _damages(), no_flash, _duel_ticks(), smoke).row(0, named=True)


def test_smoke_support_needs_window_and_distance():
    assert _smoke_support(_smoke(900 - SMOKE_WINDOW + 10, 100.0))["a_smoke_support"]
    assert _smoke_support(_smoke(900 - 10, 1000.0 + SMOKE_RADIUS - 10))["a_smoke_support"]
    assert not _smoke_support(_smoke(900 - SMOKE_WINDOW - 10, 100.0))["a_smoke_support"]
    assert not _smoke_support(_smoke(900 + 10, 100.0))["a_smoke_support"]
    assert not _smoke_support(_smoke(900 - 10, -SMOKE_RADIUS - 10))["a_smoke_support"]
    own = _smoke_support(_smoke(890, 100.0, thrower=A))
    assert not own["a_smoke_support"]
    enemy = _smoke_support(_smoke(890, 100.0, thrower=ENEMY, side=CT))
    assert enemy["v_smoke_support"] and not enemy["a_smoke_support"]


def test_smoke_thrower_is_the_nearby_player_whose_count_drops():
    t0 = 1000
    traj = pl.DataFrame({"tick": [t0, t0 + 64, t0 + 128], "round_num": [1] * 3, "type": ["smoke"] * 3,
                         "entity_id": [7] * 3, "entity_serial": [1] * 3, "x": [10.0, 300.0, 500.0],
                         "y": [0.0, 0.0, 50.0]})
    rows = []
    for t in range(t0 - 64, t0 + 2 * COUNT_LAG, 16):
        dropped = t >= t0 + 16
        rows.append(_tick(t, MATE, T, 0, 0, smokes=0 if dropped else 1, x=0.0))
        rows.append(_tick(t, A, T, 0, 0, smokes=1, x=20.0))
        rows.append(_tick(t, ENEMY, CT, 0, 0, smokes=0 if dropped else 1, x=3000.0))
    s = thrower_smokes(traj, pl.DataFrame(rows, schema_overrides={"steamid": pl.UInt64})).row(0, named=True)
    assert s["thrower"] == MATE and s["side"] == T
    assert (s["pop_tick"], s["x"], s["y"]) == (t0 + 128, 500.0, 50.0)
