"""Game states per map: the 4 Hz grid the model trains on, and the state either side of every credited event."""

import math
from pathlib import Path

import numpy as np
import polars as pl

from .data import MapRef
from .nav import SITES, SiteDistance

# CS2 GOTV demos record 64 ticks per second (freeze time is 1,280 ticks).
TICK_RATE = 64
# Equipment is what each player holds by the end of buy time, so late buys count.
BUY_WINDOW_TICKS = 20 * TICK_RATE
CT, T = 3, 2
SIDE_CODE = {"counter-terrorist": CT, "terrorist": T}
UTILITY = {"smokes": "smoke_grenades", "flashes": "flashbangs", "hes": "he_grenades", "fires": "fire_grenades"}
# Bomb explosion damage lands as the round ends; it's the outcome, not an action.
OUTCOME_WEAPONS = {"planted_c4"}


def _plants(bomb: pl.DataFrame) -> pl.DataFrame:
    return bomb.filter(pl.col("event") == "finish_plant").select("x", "y", "z", "bombsite")


def map_plants(refs: list[MapRef]) -> dict[str, pl.DataFrame]:
    """Every finished plant per map name: they mark where each site's nav areas are."""
    out: dict[str, list[pl.DataFrame]] = {}
    for ref in refs:
        out.setdefault(ref.map, []).append(_plants(ref.table("bomb")))
    return {m: pl.concat(dfs) for m, dfs in out.items()}


def side_features(hp: np.ndarray, side: np.ndarray, f: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Per-side aggregates over alive players. `hp` and every `f` array are (states, players); `side` is (players,)."""
    out: dict[str, np.ndarray] = {}
    for prefix, code in (("ct", CT), ("t", T)):
        mask = (side == code)[None, :] & (hp > 0)
        out[f"{prefix}_alive"] = mask.sum(axis=1).astype(np.float32)
        out[f"{prefix}_hp"] = np.where(mask, hp, 0).sum(axis=1).astype(np.float32)
        for name in ("graph_A", "graph_B", "euclid_A", "euclid_B"):
            vals = np.where(mask, f[name], np.inf)
            best = vals.min(axis=1)
            out[f"{prefix}_{name.lower()}"] = np.where(np.isfinite(best), best, np.nan).astype(np.float32)
        for name in ("util", *UTILITY):
            vals = f.get(name)
            out[f"{prefix}_{name}"] = (
                np.where(mask, np.nan_to_num(vals), 0).sum(axis=1).astype(np.float32)
                if vals is not None and not np.isnan(vals).all()
                else np.full(hp.shape[0], np.nan, np.float32)
            )
    ct_mask = (side == CT)[None, :] & (hp > 0)
    out["ct_kits"] = np.where(ct_mask, f["kit"], 0).sum(axis=1).astype(np.float32)
    defusing = f.get("defusing")
    out["ct_defusing"] = (
        np.where(ct_mask, np.nan_to_num(defusing), 0).max(axis=1).astype(np.float32)
        if defusing is not None and not np.isnan(defusing).all()
        else np.full(hp.shape[0], np.nan, np.float32)
    )
    return out


def _snapshots(ref: MapRef, sites: SiteDistance) -> pl.DataFrame:
    ticks = ref.table("ticks").filter((pl.col("steamid") > 0) & pl.col("side").is_in([CT, T]))
    present = [c for c in UTILITY.values() if c in ticks.columns]
    ticks = ticks.with_columns(
        *(pl.col(c).cast(pl.Float32).alias(k) for k, c in UTILITY.items() if c in present),
        (pl.sum_horizontal(*present).cast(pl.Float32) if present else pl.lit(None, pl.Float32)).alias("util"),
        pl.col("has_defuser").cast(pl.Float32).alias("kit"),
        (pl.col("is_defusing").cast(pl.Float32) if "is_defusing" in ticks.columns else pl.lit(None, pl.Float32)).alias("defusing"),
    )
    d = sites.distances(ticks["x"].to_numpy(), ticks["y"].to_numpy(), ticks["z"].to_numpy())
    return ticks.with_columns(*(pl.Series(k, v.astype(np.float32)) for k, v in d.items()))


FIELDS = ("graph_A", "graph_B", "euclid_A", "euclid_B", "util", *UTILITY, "kit", "defusing")


def _matrix(snaps: pl.DataFrame, players: list[int], ticks: np.ndarray, col: str) -> np.ndarray:
    """(ticks, players) values of `col`, carrying each player's last snapshot forward."""
    out = np.full((len(ticks), len(players)), np.nan, np.float32)
    for j, sid in enumerate(players):
        rows = snaps.filter(pl.col("steamid") == sid)
        if rows.is_empty() or col not in rows.columns:
            continue
        t = rows["tick"].to_numpy()
        v = rows[col].cast(pl.Float32).fill_null(np.nan).to_numpy()
        idx = np.searchsorted(t, ticks, side="right") - 1
        out[:, j] = np.where(idx >= 0, v[np.clip(idx, 0, None)], v[0] if len(v) else np.nan)
    return out


def build(ref: MapRef, sites: SiteDistance) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    """Returns (grid, events, roster) for one map; the roster is who played each round, on which side."""
    rounds = ref.table("rounds")
    damages = ref.table("damages")
    kills = ref.table("kills")
    bomb = ref.table("bomb")
    snaps = _snapshots(ref, sites).sort("tick")
    elo = dict(ref.elo)

    grids, events, rosters = [], [], []
    for r in rounds.iter_rows(named=True):
        start, end = int(r["freeze_end_tick"] or r["start_tick"]), int(r["end_tick"])
        in_round = snaps.filter(pl.col("tick").is_between(start, end))
        first = in_round.filter(pl.col("tick") == in_round["tick"].min()) if not in_round.is_empty() else in_round
        if first.is_empty():
            continue
        roster = first.select("steamid", "side").unique("steamid")
        players = roster["steamid"].to_list()
        side = roster["side"].to_numpy()
        rosters.append(roster.with_columns(pl.lit(ref.key).alias("key"), pl.lit(r["round_num"]).alias("round_num")))
        buy =in_round.filter(pl.col("tick") <= start + BUY_WINDOW_TICKS).group_by("steamid").agg(pl.col("equipment_value").max())
        equip = dict(zip(buy["steamid"].to_list(), buy["equipment_value"].to_list()))
        ct_equip = float(sum(equip.get(p, 0) or 0 for p, s in zip(players, side) if s == CT))
        t_equip = float(sum(equip.get(p, 0) or 0 for p, s in zip(players, side) if s == T))
        elo_diff = elo.get(r["ct_lp_team"], math.nan) - elo.get(r["t_lp_team"], math.nan)
        rb = bomb.filter(pl.col("tick").is_between(start, end))
        plant = rb.filter(pl.col("event") == "finish_plant").head(1)
        plant_tick = int(plant["tick"][0]) if plant.height else None
        plant_site = plant["bombsite"][0] if plant.height else None
        ct_win = r["winner_side"] == "ct"
        base = {"key": ref.key, "date": ref.date, "map": ref.map, "round_num": r["round_num"], "ct_win": ct_win,
                "ct_equip": ct_equip, "t_equip": t_equip, "elo_diff_ct": elo_diff}

        def bomb_state(t: np.ndarray, after_plant: np.ndarray) -> dict[str, np.ndarray]:
            planted = after_plant if plant_tick is not None else np.zeros(len(t), bool)
            return {
                "seconds": ((t - start) / TICK_RATE).astype(np.float32),
                "bomb_planted": planted.astype(np.float32),
                "bomb_site": np.where(planted, plant_site or "none", "none"),
                "since_plant": np.where(planted, (t - (plant_tick or 0)) / TICK_RATE, np.nan).astype(np.float32),
            }

        # Grid: every snapshot strictly before the round is decided.
        grid_ticks = np.unique(in_round.filter(pl.col("tick") < end)["tick"].to_numpy())
        if len(grid_ticks):
            f = {c: _matrix(in_round, players, grid_ticks, c) for c in FIELDS}
            hp = _matrix(in_round, players, grid_ticks, "health")
            feats = side_features(np.nan_to_num(hp), side, f)
            after = grid_ticks >= plant_tick if plant_tick is not None else np.zeros(len(grid_ticks), bool)
            grids.append(pl.DataFrame({**{k: [v] * len(grid_ticks) for k, v in base.items()}, "tick": grid_ticks,
                                       **bomb_state(grid_ticks, after), **feats}))

        events.append(_round_events(ref, r, base, start, end, players, side, in_round, damages, kills, rb, bomb_state))

    grid = pl.concat(grids, how="diagonal_relaxed") if grids else pl.DataFrame()
    ev = pl.concat([e for e in events if not e.is_empty()], how="diagonal_relaxed") if any(not e.is_empty() for e in events) else pl.DataFrame()
    roster = pl.concat(rosters) if rosters else pl.DataFrame()
    return grid, ev, roster


def _round_events(ref, r, base, start, end, players, side, in_round, damages, kills, rb, bomb_state) -> pl.DataFrame:
    """One row per damage, plant or defuse, with the state just before (`pre_*`) and just after (`post_*`)."""
    index = {p: j for j, p in enumerate(players)}
    dmg = damages.filter(
        pl.col("tick").is_between(start, end)
        & pl.col("victim_steamid").is_in(players)
        & ~pl.col("weapon").is_in(list(OUTCOME_WEAPONS))
        & (pl.col("health_pre") > 0)
    ).with_row_index("row")
    kill_info = kills.filter(pl.col("tick").is_between(start, end)).select(
        "tick", "victim_steamid", "assist_flash", "assister_steamid", "victim_traded"
    )
    dmg = dmg.join(kill_info, on=["tick", "victim_steamid"], how="left")

    steps: list[dict] = []
    for d in dmg.iter_rows(named=True):
        lethal = d["health_post"] <= 0
        steps.append({
            "tick": d["tick"], "order": 0, "kind": "damage", "actor": d["attacker_steamid"] or None,
            "actor_side": SIDE_CODE.get(d["attacker_side"]), "victim": d["victim_steamid"],
            "victim_side": SIDE_CODE.get(d["victim_side"]), "weapon": d["weapon"],
            "dmg": d["health_pre"] - max(d["health_post"], 0), "hp_post": max(d["health_post"], 0), "lethal": lethal,
            "flash_assister": d["assister_steamid"] if lethal and d["assist_flash"] else None,
            "traded": bool(lethal and d["victim_traded"]),
        })
    for b in rb.filter(pl.col("event").is_in(["finish_plant", "defuse"])).iter_rows(named=True):
        steps.append({
            "tick": b["tick"], "order": 1, "kind": "plant" if b["event"] == "finish_plant" else "defuse",
            "actor": b["steamid"], "actor_side": T if b["event"] == "finish_plant" else CT, "victim": None,
            "victim_side": None, "weapon": None, "dmg": 0, "hp_post": None, "lethal": False,
            "flash_assister": None, "traded": False,
        })
    if not steps:
        return pl.DataFrame()
    steps.sort(key=lambda s: (s["tick"], s["order"]))

    ticks = np.array([s["tick"] for s in steps])
    f = {c: _matrix(in_round, players, ticks, c) for c in FIELDS}
    n, p = len(steps), len(players)
    hp_pre, hp_post = np.zeros((n, p), np.float32), np.zeros((n, p), np.float32)
    planted_pre, planted_post, defused = np.zeros(n, bool), np.zeros(n, bool), np.zeros(n, bool)
    hp = np.full(p, 100.0, np.float32)
    planted = done = False
    for i, s in enumerate(steps):
        hp_pre[i], planted_pre[i] = hp, planted
        if s["kind"] == "damage" and s["victim"] in index:
            hp[index[s["victim"]]] = s["hp_post"]
        elif s["kind"] == "plant":
            planted = True
        elif s["kind"] == "defuse":
            done = True
        hp_post[i], planted_post[i], defused[i] = hp, planted, done

    pre = side_features(hp_pre, side, f)
    post = side_features(hp_post, side, f)
    out = pl.DataFrame({
        **{k: [v] * n for k, v in base.items()},
        "tick": ticks, "seq": np.arange(n),
        **{k: [s[k] for s in steps] for k in ("kind", "actor", "actor_side", "victim", "victim_side", "weapon",
                                                 "dmg", "lethal", "flash_assister", "traded")},
        **{f"pre_{k}": v for k, v in {**bomb_state(ticks, planted_pre), **pre}.items()},
        **{f"post_{k}": v for k, v in {**bomb_state(ticks, planted_post), **post}.items()},
    })
    # Who's alive on each side just before the event, for splitting a plant or defuse among the other side.
    alive_ct = [[players[j] for j in range(p) if side[j] == CT and hp_pre[i, j] > 0] for i in range(n)]
    alive_t = [[players[j] for j in range(p) if side[j] == T and hp_pre[i, j] > 0] for i in range(n)]
    terminal = np.where(
        defused, 1.0,
        np.where(post["ct_alive"] == 0, 0.0, np.where((post["t_alive"] == 0) & ~planted_post, 1.0, np.nan)),
    )
    return out.with_columns(
        pl.Series("alive_ct", alive_ct, dtype=pl.List(pl.UInt64)),
        pl.Series("alive_t", alive_t, dtype=pl.List(pl.UInt64)),
        pl.Series("terminal", terminal),
    )


def write(ref: MapRef, grid: pl.DataFrame, events: pl.DataFrame, root: Path) -> None:
    out = root / ref.slug
    out.mkdir(parents=True, exist_ok=True)
    grid.write_parquet(out / "grid.parquet")
    events.write_parquet(out / "events.parquet")
