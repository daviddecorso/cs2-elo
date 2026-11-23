"""Player style and archetypes: per-player tendencies as percentiles among qualified players, each player's nearest
hand-written archetype for their T role, and the split-half gate every new metric passes before it's published."""

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import polars as pl

from . import unitstats as us
from .data import MapRef, catalog
from .duels import GUN_CLASS
from .paths import (DUELS, PUBLIC_WAR, RESOURCE_ROUNDS, STYLE_PLAYERS, STYLE_ROUNDS, TEAM_ROUNDS, WAR_REPORTS)
from .publish import SOURCE
from .resources import GRENADE_COLUMNS, GRENADE_COUNT, thrower_grenades
from .rolecheck import auc, load_labels
from .states import CT, SIDE_CODE, TICK_RATE, T
from .warcheck import _alternating

SPLIT_GATE = 0.5
# Observations a player needs in each half (or year) to count toward a reliability correlation.
MIN_HALF = 40
COMP_SIZE = 5
COMP_MIN_SHARE = 0.7
ISOLATION_AT = 20 * TICK_RATE
RIFLES = {"Rifle", "Cheap rifle"}
UTILITY_DAMAGE = ("hegrenade", "inferno")
CREDIT = "wpa_opp"
AWPER = "AWPer"


@dataclass(frozen=True)
class Metric:
    key: str
    label: str
    group: str
    unit: str
    # A lower raw value ranks higher (seconds to first duel: earlier is more "early fights").
    lower_first: bool = False
    # False for numbers published and gated elsewhere (WAA, ADR, clutch), which never feed archetypes.
    own: bool = True


METRICS = [
    Metric("firepower", "Firepower", "production", "duel wins above expected per 100 duels"),
    Metric("adr", "Damage", "production", "ADR", own=False),
    Metric("openingWin", "Opening duels", "production", "opening duel wins above expected per 100"),
    Metric("tradeKills", "Trading", "production", "trade kills per 100 rounds"),
    Metric("utilityDamage", "Utility damage", "production", "HE and fire damage per round"),
    Metric("flashAssists", "Flash assists", "production", "flash assists per 100 rounds"),
    Metric("survival", "Survival", "production", "% of rounds survived"),
    Metric("clutch", "Clutch", "production", "1vN wins above expected per 100", own=False),
    Metric("rating", "Rating", "overall", "WAA per 100 rounds", own=False),
    Metric("pace", "Early fights", "style", "seconds from freeze end to first duel", lower_first=True),
    Metric("opening", "Opening attempts", "style", "% of rounds in the opening duel"),
    Metric("peeking", "Peeking", "style", "speed into duels, units/s"),
    Metric("range", "Duel range", "style", "units"),
    Metric("isolation", "Isolation", "style", "T side, units to nearest teammate 20 s in"),
    Metric("utilityThrown", "Utility thrown", "style", "grenades per round"),
    Metric("flashing", "Flashing", "style", "enemy blind seconds per round"),
    Metric("support", "Supported duels", "style", "% of duels with a teammate's flash or smoke"),
    Metric("traded", "Deaths traded", "style", "% of deaths traded"),
    Metric("resourceShare", "Resource share", "style", "% of team equipment on full buys"),
    Metric("headshot", "Headshots", "style", "% of rifle kills"),
]
BY_KEY = {m.key: m for m in METRICS}


@dataclass(frozen=True)
class Archetype:
    key: str
    label: str
    description: str
    roles: tuple[str, ...]
    # Metric key -> target percentile. Only `own` metrics, so the split-half check sees the same inputs.
    targets: dict[str, float]


ARCHETYPES = [
    Archetype("aggressiveAwp", "Aggressive AWP", "Takes early, contested fights and plays for the opening pick",
              (AWPER,), {"pace": 80, "opening": 80, "peeking": 75, "range": 40}),
    Archetype("anchorAwp", "Anchor AWP", "Holds long angles and lets the round come to them",
              (AWPER,), {"pace": 20, "opening": 30, "peeking": 25, "range": 80}),
    Archetype("hybridAwp", "Hybrid AWP", "Mixes picks with trading and utility like a rifler",
              (AWPER,), {"opening": 50, "peeking": 50, "utilityThrown": 65, "tradeKills": 60}),
    Archetype("spacetaker", "Spacetaker", "First through the door, and dies where the team can trade",
              ("Entry", "Rifler"), {"opening": 85, "pace": 85, "traded": 75, "survival": 25}),
    Archetype("starEntry", "Star Entry", "Opens rounds and wins the opening duel",
              ("Entry",), {"opening": 80, "openingWin": 80, "firepower": 75}),
    Archetype("trader", "Trader", "Second through the door, turning teammates' deaths into kills",
              ("Entry", "Rifler"), {"tradeKills": 85, "pace": 60, "isolation": 30}),
    Archetype("starRifler", "Star Rifler", "Gets the resources and wins the fights",
              ("Entry", "Rifler"), {"firepower": 85, "resourceShare": 80, "survival": 65}),
    Archetype("lurker", "Lurker", "Works away from the team, late in the round",
              ("Rifler",), {"isolation": 85, "pace": 20, "opening": 30, "traded": 25}),
    Archetype("support", "Support", "Throws the utility and sets up the team's fights",
              ("Rifler",), {"utilityThrown": 80, "flashing": 75, "flashAssists": 75, "resourceShare": 25}),
    Archetype("closer", "Closer", "Survives the opening and decides the late round",
              ("Rifler",), {"survival": 85, "pace": 25, "isolation": 55, "firepower": 60}),
]


def _enemy() -> pl.Expr:
    sides = list(SIDE_CODE)
    return (pl.col("attacker_side").is_in(sides) & pl.col("victim_side").is_in(sides)
            & (pl.col("attacker_side") != pl.col("victim_side")) & (pl.col("attacker_steamid") > 0))


def isolation(ticks: pl.DataFrame, rounds: pl.DataFrame) -> pl.DataFrame:
    """T side: each living player's distance to the nearest living teammate at the first tick ISOLATION_AT after
    freeze end. Players alone or dead by then get no row."""
    alive = (ticks.filter((pl.col("side") == T) & (pl.col("steamid") > 0) & (pl.col("health") > 0))
             .select("tick", pl.col("round_num").cast(pl.Int64), "steamid", "x", "y"))
    at = (alive.join(rounds.select("round_num", (pl.col("freeze_end_tick") + ISOLATION_AT).alias("at")), on="round_num")
          .filter(pl.col("tick") >= pl.col("at")).group_by("round_num").agg(pl.col("tick").min()))
    snap = alive.join(at, on=["round_num", "tick"])
    return (snap.join(snap, on="round_num", suffix="_o").filter(pl.col("steamid") != pl.col("steamid_o"))
            .group_by("round_num", "steamid")
            .agg(((pl.col("x") - pl.col("x_o")) ** 2 + (pl.col("y") - pl.col("y_o")) ** 2).sqrt().min()
                 .alias("isolation")))


def map_style(ref: MapRef) -> pl.DataFrame:
    """Per player-round counts the derived tables don't carry: kills by kind, flash assists, utility damage and blind
    time dealt to enemies, grenades thrown, and T-side isolation."""
    import warnings

    warnings.filterwarnings("ignore", message="Sortedness of columns cannot be checked")
    rid = pl.col("round_num").cast(pl.Int64)
    rounds = ref.table("rounds", ["round_num", "freeze_end_tick"]).with_columns(rid)
    kills = (ref.table("kills", ["round_num", "attacker_steamid", "attacker_side", "victim_side", "weapon", "headshot",
                                 "is_trade", "assister_steamid", "assister_side", "assist_flash"])
             .filter(_enemy()).with_columns(rid))
    rifle = pl.col("weapon").replace_strict(GUN_CLASS, default=None).is_in(list(RIFLES)).fill_null(False)
    killer = kills.group_by("round_num", pl.col("attacker_steamid").alias("steamid")).agg(
        pl.len().alias("kills"), rifle.sum().alias("rifle_kills"),
        (rifle & pl.col("headshot").fill_null(False)).sum().alias("hs_kills"),
        pl.col("is_trade").fill_null(False).sum().alias("trade_kills"))
    assists = (kills.filter(pl.col("assist_flash").fill_null(False) & (pl.col("assister_steamid") > 0)
                            & (pl.col("assister_side") == pl.col("attacker_side")))
               .group_by("round_num", pl.col("assister_steamid").alias("steamid")).agg(pl.len().alias("flash_assists")))
    util = (ref.table("damages", ["round_num", "attacker_steamid", "attacker_side", "victim_side", "weapon", "dmg_health"])
            .filter(_enemy() & pl.col("weapon").is_in(UTILITY_DAMAGE)).with_columns(rid)
            .group_by("round_num", pl.col("attacker_steamid").alias("steamid"))
            .agg(pl.col("dmg_health").sum().alias("util_damage")))
    blind = (ref.table("flashes", ["round_num", "attacker_steamid", "attacker_side", "victim_side", "duration"])
             .filter(_enemy()).with_columns(rid)
             .group_by("round_num", pl.col("attacker_steamid").alias("steamid"))
             .agg(pl.col("duration").sum().alias("blind_secs")))
    ticks = ref.table("ticks", ["tick", "round_num", "steamid", "side", "x", "y", "health", *GRENADE_COUNT.values()])
    path = ref.dir / "grenades.parquet"
    has_grenades = path.exists()
    parts = [killer, assists, util, blind, isolation(ticks, rounds)]
    if has_grenades:
        parts.append(thrower_grenades(pl.read_parquet(path, columns=GRENADE_COLUMNS), ticks)
                     .filter(pl.col("thrower").is_not_null())
                     .group_by("round_num", pl.col("thrower").alias("steamid")).agg(pl.len().alias("thrown")))
    out = (ticks.filter((pl.col("steamid") > 0) & pl.col("side").is_in([CT, T]))
           .select(rid, "steamid").unique()
           .join(rounds, on="round_num", how="left"))
    for p in parts:
        out = out.join(p.with_columns(pl.col("steamid").cast(pl.UInt64)), on=["round_num", "steamid"], how="left")
    counts = ["kills", "rifle_kills", "hs_kills", "trade_kills", "flash_assists", "util_damage"]
    return out.with_columns(
        pl.col(counts).fill_null(0).cast(pl.Int32), pl.col("blind_secs").fill_null(0.0).cast(pl.Float32),
        (pl.col("thrown").fill_null(0).cast(pl.Int32) if has_grenades else pl.lit(None, pl.Int32)).alias("thrown"),
        pl.col("isolation").cast(pl.Float32), pl.lit(ref.key).alias("key"),
    ).select("key", "round_num", "steamid", "freeze_end_tick", *counts, "blind_secs", "thrown", "isolation")


def build_rounds(rebuild: bool = False) -> pl.DataFrame:
    """`style-rounds.parquet`, adding only maps that `resource-rounds` has and it doesn't, unless `rebuild`."""
    from concurrent.futures import ProcessPoolExecutor

    keys = set(pl.read_parquet(RESOURCE_ROUNDS, columns=["key"])["key"].unique().to_list())
    old = None if rebuild or not STYLE_ROUNDS.exists() else pl.read_parquet(STYLE_ROUNDS)
    have = set() if old is None else set(old["key"].unique().to_list())
    todo = [r for r in catalog() if r.key in keys and r.key not in have]
    print(f"style: {len(todo)} maps to parse, {len(have)} cached")
    frames = [] if old is None else [old]
    if todo:
        with ProcessPoolExecutor(max_workers=6) as ex:
            frames += list(ex.map(map_style, todo, chunksize=8))
    df = pl.concat(frames, how="vertical_relaxed")
    STYLE_ROUNDS.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(STYLE_ROUNDS)
    return df


def _duel_views(d: pl.DataFrame) -> pl.DataFrame:
    """Each duel once from each player's side: win, win probability, speed into it, distance, support, opening."""
    def view(who: str, p: str, win: int) -> pl.DataFrame:
        return d.select("key", pl.col("round_num").cast(pl.Int64), pl.col(who).alias("steamid"),
                        pl.lit(float(win)).alias("win"), (pl.col("p") if win else 1 - pl.col("p")).alias("expected"),
                        pl.col(f"{p}_speed").alias("speed"), "distance", "start",
                        pl.col("opening").cast(pl.Float64),
                        (pl.col(f"{p}_flash_support") | pl.col(f"{p}_smoke_support")).alias("support"))
    return pl.concat([view("attacker", "a", 1), view("victim", "v", 0)])


def observations(rounds: pl.DataFrame, duels: pl.DataFrame) -> pl.DataFrame:
    """One row per observation of each `own` metric: a duel, a player-round, a death or a rifle kill, as fits it.

    `rounds` is `resource-rounds` joined to `style-rounds`. Columns: steamid, key, metric, value.
    """
    v = _duel_views(duels)
    first = v.group_by("key", "round_num", "steamid").agg(pl.col("start").min(), pl.col("opening").max().alias("in_opening"))
    r = (rounds.join(first, on=["key", "round_num", "steamid"], how="left")
         .with_columns(pl.col("in_opening").fill_null(0.0)))
    kills = (r.filter(pl.col("rifle_kills") > 0)
             .select("steamid", "key", "hs_kills", pl.int_ranges(0, pl.col("rifle_kills")).alias("i")).explode("i"))
    pace = ((pl.col("start") - pl.col("freeze_end_tick")) / TICK_RATE)
    parts = {
        "firepower": (v, 100 * (pl.col("win") - pl.col("expected"))),
        "openingWin": (v.filter(pl.col("opening") > 0), 100 * (pl.col("win") - pl.col("expected"))),
        # Older parses carry no velocity: speed is null or 0 on every duel of the map.
        "peeking": (v.filter(pl.col("speed").is_not_null() & (pl.col("speed").max().over("key") > 0)),
                    pl.col("speed")),
        "range": (v, pl.col("distance")),
        "support": (v, 100 * pl.col("support").cast(pl.Float64)),
        "tradeKills": (r, 100 * pl.col("trade_kills")),
        "flashAssists": (r, 100 * pl.col("flash_assists")),
        "utilityDamage": (r, pl.col("util_damage")),
        "survival": (r, 100 * (pl.col("deaths") == 0).cast(pl.Float64)),
        "opening": (r, 100 * pl.col("in_opening")),
        "pace": (r.filter(pl.col("start").is_not_null() & (pace >= 0)), pace),
        "utilityThrown": (r.filter(pl.col("thrown").is_not_null()), pl.col("thrown")),
        "flashing": (r, pl.col("blind_secs")),
        "traded": (r.filter(pl.col("deaths") > 0), 100 * (pl.col("deaths_traded") > 0).cast(pl.Float64)),
        "resourceShare": (r.filter(pl.col("team_buy") == "full"), 100 * pl.col("equip_share")),
        "isolation": (r.filter((pl.col("side") == T) & pl.col("isolation").is_not_null()), pl.col("isolation")),
        "headshot": (kills, 100 * (pl.col("i") < pl.col("hs_kills")).cast(pl.Float64)),
    }
    return pl.concat([
        df.select(pl.col("steamid").cast(pl.UInt64).cast(pl.String), "key", pl.lit(k).alias("metric"),
                  value.cast(pl.Float64).alias("value"))
        for k, (df, value) in parts.items()
    ])


def means(obs: pl.DataFrame) -> pl.DataFrame:
    """Wide: one row per steamid, one column per metric mean."""
    return (obs.group_by("steamid", "metric").agg(pl.col("value").mean())
            .pivot("metric", index="steamid", values="value"))


def percentiles(wide: pl.DataFrame, keys: list[str]) -> pl.DataFrame:
    """Adds `<key>_pct`, 0 (lowest) to 100 (highest) by average rank. Style metrics rank within `awper` (AWPers
    against AWPers), the rest against everyone. Needs `steamid` and `awper` columns."""
    cols = []
    for k in keys:
        m = BY_KEY[k]
        x = -pl.col(k) if m.lower_first else pl.col(k)
        pool = "awper" if m.group == "style" else pl.lit(True)
        n = pl.col(k).count().over(pool)
        cols.append(pl.when(n > 1).then(100 * (x.rank("average").over(pool) - 1) / (n - 1)).alias(f"{k}_pct"))
    return wide.with_columns(cols)


def _rms(a: dict[str, float | None], b: dict[str, float | None], keys: list[str],
         min_share: float = COMP_MIN_SHARE, min_count: int = 1) -> float | None:
    if not keys:
        return None
    d = [(a[k] - b[k]) ** 2 for k in keys if a.get(k) is not None and b.get(k) is not None]
    if len(d) < min_count or len(d) / len(keys) < min_share:
        return None
    return math.sqrt(sum(d) / len(d))


def assign(pct: dict[str, float | None], role: str | None, keys: set[str]) -> tuple[str | None, str | None, float | None]:
    """Nearest archetype for `role` by RMS distance over the targets in `keys` the player has (needs 2+), with the
    runner-up and the winner's distance in percentile points."""
    scored = []
    for a in ARCHETYPES:
        if role not in a.roles:
            continue
        dist = _rms(pct, a.targets, [k for k in a.targets if k in keys], min_share=0.0, min_count=2)
        if dist is not None:
            scored.append((dist, a.key))
    scored.sort()
    if not scored:
        return None, None, None
    return scored[0][1], scored[1][1] if len(scored) > 1 else None, scored[0][0]


def comps(table: pl.DataFrame, keys: list[str], pool_col: str | None = None,
          n: int = COMP_SIZE) -> dict[str, list[dict[str, object]]]:
    """Nearest `n` players by RMS percentile distance over `keys`; similarity is 100 - RMS."""
    rows = list(table.iter_rows(named=True))
    sids = [r["steamid"] for r in rows]
    pools = [r[pool_col] for r in rows] if pool_col else None
    pcts = [{k: r.get(f"{k}_pct") for k in keys} for r in rows]
    out: dict[str, list[dict[str, object]]] = {}
    for i, sid in enumerate(sids):
        scored = []
        for j, other in enumerate(sids):
            if i == j or (pools is not None and pools[i] != pools[j]):
                continue
            d = _rms(pcts[i], pcts[j], keys, COMP_MIN_SHARE)
            if d is not None:
                scored.append((d, other))
        scored.sort()
        out[sid] = [{"steamid": other, "similarity": 100.0 - d} for d, other in scored[:n]]
    return out


def _assign_all(wide: pl.DataFrame, keys: set[str]) -> dict[str, str | None]:
    rows = percentiles(wide, sorted(keys)).iter_rows(named=True)
    return {r["steamid"]: assign({k: r.get(f"{k}_pct") for k in keys}, r["t_role"], keys)[0] for r in rows}


def reliability(obs: pl.DataFrame, resamples: int) -> dict[str, dict]:
    out = {}
    for m in (m for m in METRICS if m.own):
        rows = obs.filter(pl.col("metric") == m.key)
        out[m.key] = {"n": rows.height,
                      "split": us.split_half(rows, "steamid", "value", MIN_HALF, resamples),
                      "year": us.persistence(rows, "steamid", "value", "year", MIN_HALF, resamples)}
    return out


def split_agreement(obs: pl.DataFrame, roles: pl.DataFrame, keys: set[str]) -> dict:
    """Assign archetypes on each player's alternating-series halves separately; share of players whose two match."""
    halves = _alternating(obs.filter(pl.col("metric").is_in(list(keys))), ["steamid"])
    got = [_assign_all(means(halves.filter(pl.col("half") == h)).join(roles, on="steamid"), keys) for h in (0, 1)]
    both = [s for s in got[0] if got[0][s] and got[1].get(s)]
    same = sum(got[0][s] == got[1][s] for s in both)
    return {"players": len(both), "same": same, "share": same / len(both) if both else None}


def _eval_comps(h0: pl.DataFrame, h1: pl.DataFrame, table: pl.DataFrame, col: str, keys: list[str],
                pool_col: str | None, n: int) -> dict:
    def by_id(df: pl.DataFrame) -> dict[str, tuple[object, dict[str, float | None]]]:
        return {r["steamid"]: (r[pool_col] if pool_col else None, {k: r.get(f"{k}_pct") for k in keys})
                for r in df.iter_rows(named=True)}

    p0, p1 = by_id(h0), by_id(h1)
    top1 = topn = eval_n = 0
    chance1 = chancen = 0.0
    for sid, (pool, v0) in p0.items():
        if sid not in p1:
            continue
        ranked = []
        for other, (opool, v1) in p1.items():
            if pool_col and opool != pool:
                continue
            d = _rms(v0, v1, keys, COMP_MIN_SHARE)
            if d is not None:
                ranked.append((d, other))
        if not any(other == sid for _, other in ranked):
            continue
        ranked.sort()
        eval_n += 1
        m = len(ranked)
        chance1 += 1 / m
        chancen += min(n, m) / m
        if ranked[0][1] == sid:
            top1 += 1
        if any(other == sid for _, other in ranked[:n]):
            topn += 1

    c0, c1 = comps(h0, keys, pool_col, n), comps(h1, keys, pool_col, n)
    pool_sizes: dict[object, int] = {}
    for sid in set(c0) & set(c1):
        pool = p0[sid][0]
        pool_sizes[pool] = pool_sizes.get(pool, 0) + 1
    overlaps, chance_ov = [], []
    for sid in set(c0) & set(c1):
        ids0 = {c["steamid"] for c in c0[sid]}
        ids1 = {c["steamid"] for c in c1[sid]}
        m = pool_sizes[p0[sid][0]] - 1
        if ids0 and ids1 and m > 0:
            overlaps.append(len(ids0 & ids1))
            chance_ov.append(len(ids0) * len(ids1) / m)

    teams = dict(zip(table["steamid"].to_list(), table["lp_team"].to_list()))
    same_team = total_comps = 0
    for r in table.iter_rows(named=True):
        t = r["lp_team"]
        for c in r[col] or []:
            total_comps += 1
            if t is not None and teams.get(c["steamid"]) == t:
                same_team += 1

    return {
        "players": eval_n,
        "top1": top1 / eval_n if eval_n else None,
        "topn": topn / eval_n if eval_n else None,
        "chance1": chance1 / eval_n if eval_n else None,
        "chancen": chancen / eval_n if eval_n else None,
        "overlap": sum(overlaps) / len(overlaps) if overlaps else None,
        "overlap_chance": sum(chance_ov) / len(chance_ov) if chance_ov else None,
        "same_team": same_team,
        "total_comps": total_comps,
        "teammate_share": same_team / total_comps if total_comps else None,
    }


def comp_check(obs: pl.DataFrame, roles: pl.DataFrame, table: pl.DataFrame, prod_keys: list[str],
               style_keys: list[str], n: int = COMP_SIZE) -> dict:
    prod_own = [k for k in prod_keys if BY_KEY[k].own]
    style_own = [k for k in style_keys if BY_KEY[k].own]
    all_own = prod_own + style_own
    halves = _alternating(obs.filter(pl.col("metric").is_in(all_own)), ["steamid"])
    h0, h1 = [percentiles(means(halves.filter(pl.col("half") == h)).join(roles, on="steamid"), all_own) for h in (0, 1)]
    return {
        "n": n,
        "prod_own": prod_own,
        "production": _eval_comps(h0, h1, table, "production_comps", prod_own, None, n),
        "style": _eval_comps(h0, h1, table, "style_comps", style_own, "awper", n),
    }


def _players_json() -> dict:
    return json.loads((PUBLIC_WAR / "players.json").read_text())


def _external(pj: dict) -> pl.DataFrame:
    """Metrics gated and published elsewhere, plus role and team, per qualified player."""
    clutch_path = PUBLIC_WAR / "clutch.json"
    clutch = ({p["steamid"]: p["clutch"]["per100"] for p in json.loads(clutch_path.read_text()).get("players", [])}
              if clutch_path.exists() else {})
    return pl.DataFrame([{
        "steamid": p["steamid"], "name": p["name"], "lp_team": p.get("lpTeam"), "t_role": p["tRole"],
        "awper": p["tRole"] == AWPER, "adr": p["adr"], "clutch": clutch.get(p["steamid"]),
        "rating": p["metrics"][CREDIT]["per100"],
    } for p in pj["players"]], schema={"steamid": pl.String, "name": pl.String, "lp_team": pl.String,
                                       "t_role": pl.String, "awper": pl.Boolean, "adr": pl.Float64,
                                       "clutch": pl.Float64, "rating": pl.Float64})


def _f(v, d=2):
    return "—" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:.{d}f}"


def report_lines(rel: dict, shipped: list[str], table: pl.DataFrame, agreement: dict, lurk: dict,
                 comp_diag: dict | None = None) -> list[str]:
    lines = ["# Player style and archetypes", "",
             f"{table.height} qualified players. A metric ships when its split-half r (alternating series, "
             f"{MIN_HALF}+ observations per half) is at least {SPLIT_GATE}. Intervals are 90%, resampling series.", "",
             "## Reliability", "",
             "| Metric | Observations | Split-half r (90% CI, players) | Year-to-year r (90% CI, players) | Ships |",
             "| --- | --- | --- | --- | --- |"]
    for k, t in rel.items():
        s, y = t["split"], t["year"]
        lines.append(f"| {BY_KEY[k].label} | {t['n']:,} | {_f(s['r'])} ({_f(s['r_ci'][0])}, {_f(s['r_ci'][1])}), "
                     f"{s['pairs']} | {_f(y['r'])} ({_f(y['r_ci'][0])}, {_f(y['r_ci'][1])}), {y['pairs']} | "
                     f"{'yes' if k in shipped else '**no**'} |")
    lines += ["", "## Archetypes", "",
              f"Split-half agreement: {agreement['same']} of {agreement['players']} players get the same archetype on "
              f"both halves ({_f(agreement['share'] and 100 * agreement['share'], 0)}%).", "",
              "| Archetype | Players | Examples |", "| --- | --- | --- |"]
    for a in ARCHETYPES:
        who = table.filter(pl.col("archetype") == a.key).sort("fit")
        lines.append(f"| {a.label} | {who.height} | {', '.join(who['name'].head(6).to_list()) or '–'} |")
    unassigned = table.filter(pl.col("archetype").is_null()).height
    if unassigned:
        lines.append(f"| (none) | {unassigned} | |")
    lines += ["", "## Lurkers against the 2024 role labels", "",
              f"{lurk['matched']} non-AWP players matched to the NER0cs-based labels (CS2 Playstyle & Roles Dataset, "
              "Jamie Packer, CC BY 4.0). The labels are from 2024, so role changes since count against us.", "",
              f"- Isolation, Lurker over Spacetaker: AUC {_f(lurk['auc_spacetaker'])}; over every other T label: "
              f"AUC {_f(lurk['auc_rest'])}.",
              f"- Assigned Lurker: {lurk['lurk_hit']} of {lurk['lurkers']} labelled Lurkers, and {lurk['rest_hit']} of "
              f"{lurk['rest']} other players."]
    if comp_diag:
        n = comp_diag["n"]
        pct = lambda v: _f(None if v is None else 100 * v, 1)
        lines += ["", "## Comps", "",
                  f"Top-{n} nearest players by RMS percentile distance (similarity = 100 − RMS; a random pair of "
                  "uniform percentiles averages about 41 RMS, or ~59 similarity). Split-half checks use alternating "
                  f"series; production uses only `own` axes ({', '.join(BY_KEY[k].label for k in comp_diag['prod_own'])}) "
                  "because ADR, clutch and rating don't exist per half.", "",
                  f"| Group | Players | Top-1 ID (chance) | Top-{n} ID (chance) | Top-{n} overlap (chance) | Teammate share |",
                  "| --- | --- | --- | --- | --- | --- |"]
        for label, key in [("Production", "production"), ("Style", "style")]:
            c = comp_diag[key]
            lines.append(f"| {label} | {c['players']} | {pct(c['top1'])}% ({pct(c['chance1'])}%) | "
                         f"{pct(c['topn'])}% ({pct(c['chancen'])}%) | {_f(c['overlap'])} ({_f(c['overlap_chance'])}) | "
                         f"{c['same_team']}/{c['total_comps']} ({pct(c['teammate_share'])}%) |")
    return lines


def lurker_check(table: pl.DataFrame) -> dict:
    labels = load_labels().select(pl.col("steamid").cast(pl.String), "role_t")
    t = table.filter(~pl.col("awper")).join(labels, on="steamid")
    lur = t.filter(pl.col("role_t") == "Lurker")
    rest = t.filter(pl.col("role_t") != "Lurker")
    iso = lambda df: df["isolation"].drop_nulls().to_list() if "isolation" in df.columns else []
    have = lambda a, b: auc(a, b) if a and b else None
    return {"matched": t.height, "lurkers": lur.height, "rest": rest.height,
            "auc_spacetaker": have(iso(lur), iso(t.filter(pl.col("role_t") == "Spacetaker"))),
            "auc_rest": have(iso(lur), iso(rest)),
            "lurk_hit": lur.filter(pl.col("archetype") == "lurker").height,
            "rest_hit": rest.filter(pl.col("archetype") == "lurker").height}


def export_public(table: pl.DataFrame, rel: dict, shipped: list[str], agreement: dict, pj: dict,
                  out_dir: Path = PUBLIC_WAR) -> None:
    keys = [m.key for m in METRICS if not m.own or m.key in shipped]
    used = {a.key for a in ARCHETYPES}
    fmt_comps = lambda xs: [{"steamid": c["steamid"], "similarity": round(float(c["similarity"]))} for c in (xs or [])]
    players = []
    for r in table.iter_rows(named=True):
        values = {k: {"value": round(float(r[k]), 3), "pct": round(float(r[f"{k}_pct"]))}
                  for k in keys if r.get(k) is not None and r.get(f"{k}_pct") is not None}
        players.append({"steamid": r["steamid"], "archetype": r["archetype"], "runnerUp": r["runner_up"],
                        "fit": None if r["fit"] is None else round(float(r["fit"]), 1), "values": values,
                        "comps": {"production": fmt_comps(r.get("production_comps")),
                                  "style": fmt_comps(r.get("style_comps"))}})
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "minRounds": pj["minRounds"], "window": pj["window"], "splitGate": SPLIT_GATE,
        "compSize": COMP_SIZE,
        "agreement": agreement["share"] and round(agreement["share"], 3),
        "metrics": {k: {"label": BY_KEY[k].label, "group": BY_KEY[k].group, "unit": BY_KEY[k].unit,
                        "pool": "role" if BY_KEY[k].group == "style" else "all",
                        "splitHalfR": (round(rel[k]["split"]["r"], 3) if k in rel and rel[k]["split"]["r"] is not None
                                       else None)}
                    for k in keys},
        "archetypes": {a.key: {"label": a.label, "description": a.description, "roles": list(a.roles)}
                       for a in ARCHETYPES if a.key in used},
        "source": SOURCE,
        "players": players,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "style.json").write_text(json.dumps(payload, indent=1) + "\n")
    print(f"wrote {len(players)} players to {out_dir / 'style.json'}")


def build(rebuild: bool = False, resamples: int = 200, publish: bool = False) -> int:
    pj = _players_json()
    ext = _external(pj)
    sr = build_rounds(rebuild)
    rr = pl.read_parquet(RESOURCE_ROUNDS, columns=["key", "round_num", "steamid", "side", "equip_share", "team_buy",
                                                   "deaths", "deaths_traded"])
    duels = pl.read_parquet(DUELS, columns=["key", "round_num", "attacker", "victim", "p", "distance", "start", "opening",
                                            "a_speed", "v_speed", "a_flash_support", "a_smoke_support",
                                            "v_flash_support", "v_smoke_support"])
    meta = pl.read_parquet(TEAM_ROUNDS, columns=["key", "series", "date"]).unique("key")
    obs = (observations(rr.join(sr, on=["key", "round_num", "steamid"], how="left"), duels)
           .filter(pl.col("steamid").is_in(ext["steamid"].implode()))
           .join(meta, on="key").with_columns(pl.col("date").str.slice(0, 4).alias("year")))
    print(f"style: {obs.height:,} observations for {obs['steamid'].n_unique()} players")

    rel = reliability(obs, resamples)
    shipped = [k for k, t in rel.items() if t["split"]["r"] is not None and t["split"]["r"] >= SPLIT_GATE]
    keys = [m.key for m in METRICS if not m.own or m.key in shipped]
    prod_keys = [k for k in keys if BY_KEY[k].group == "production"]
    style_keys = [k for k in keys if BY_KEY[k].group == "style"]
    roles = ext.select("steamid", "t_role", "awper")
    table = percentiles(ext.join(means(obs.filter(pl.col("metric").is_in(shipped))), on="steamid", how="left"), keys)
    picks = [assign({k: r.get(f"{k}_pct") for k in shipped}, r["t_role"], set(shipped))
             for r in table.iter_rows(named=True)]
    comp_dtype = pl.List(pl.Struct({"steamid": pl.String, "similarity": pl.Float64}))
    prod_comps = comps(table, prod_keys, None)
    style_comps = comps(table, style_keys, "awper")
    sids = table["steamid"].to_list()
    table = table.with_columns(pl.Series("archetype", [p[0] for p in picks], pl.String),
                               pl.Series("runner_up", [p[1] for p in picks], pl.String),
                               pl.Series("fit", [p[2] for p in picks], pl.Float64),
                               pl.Series("production_comps", [prod_comps[s] for s in sids], comp_dtype),
                               pl.Series("style_comps", [style_comps[s] for s in sids], comp_dtype))
    agreement = split_agreement(obs, roles, set(shipped))
    lurk = lurker_check(table)
    comp_diag = comp_check(obs, roles, table, prod_keys, style_keys)

    table.write_parquet(STYLE_PLAYERS)
    WAR_REPORTS.mkdir(parents=True, exist_ok=True)
    report = WAR_REPORTS / "style.md"
    report.write_text("\n".join(report_lines(rel, shipped, table, agreement, lurk, comp_diag)) + "\n")
    print(f"wrote {report}")
    if publish:
        export_public(table, rel, shipped, agreement, pj)
    return 0
