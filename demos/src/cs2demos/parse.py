"""One map's demo → validated polars tables. awpy for events and snapshots, demoparser2 for team scores and callouts."""

import os
import re
from dataclasses import dataclass, field
from importlib.metadata import version
from pathlib import Path

import awpy
import polars as pl
from demoparser2 import DemoParser

from .identity import IdentityTable, match_opponent
from .liquipedia import LpMap, LpMatch
from .match_page import cached_page, map_score
from .rounds import Round, RoundEnd, RoundRebuildError, rebuild_rounds
from .validate import validate_map

# Bump when the stored columns change, so maps parsed under the old layout count as stale.
SCHEMA_VERSION = 2
PARSER_VERSION = f"awpy{version('awpy')}-dp{version('demoparser2')}-s{SCHEMA_VERSION}"
SNAPSHOT_EVERY_TICKS = 16
# Scores update on the round-end tick; read them a little later but well inside the post-round delay.
SCORE_READ_DELAY_TICKS = 32
SIDE_T, SIDE_CT = 2, 3
ROUND_TICK_COLUMNS = ("start_tick", "freeze_end_tick", "end_tick", "official_end_tick")
EVENT_TABLES = {"kills": "kills", "damages": "damages", "grenades": "grenades", "flashes": "blinds", "bomb": "bomb"}
# demoparser2's round_end reasons → awpy's (reason, reason_name).
EVENT_REASONS = {
    "bomb_exploded": (1, "target_bombed"),
    "bomb_defused": (7, "bomb_defused"),
    "t_killed": (8, "ct_win"),
    "ct_killed": (9, "terrorists_win"),
    "time_ran_out": (12, "target_saved"),
}
ROUND_EVENTS = ("round_start", "round_freeze_end", "round_end", "round_officially_ended")
# awpy's error when a recording stops mid-command, e.g. after a server crash.
TRUNCATED = re.compile(r"command at byte (\d+) .*unexpected end of data")

SNAPSHOT_COLUMNS = [
    "tick", "steamid", "name", "side", "x", "y", "z", "pitch", "yaw", "velocity",
    "health", "armor", "has_helmet", "has_defuser", "has_bomb", "active_weapon",
    "money", "equipment_value", "equipment_value_round_start", "is_crouched", "is_scoped", "is_blinded",
    "is_defusing", "smoke_grenades", "flashbangs", "he_grenades", "fire_grenades",
]


@dataclass
class ParsedMap:
    demo_map: str
    rounds: list[Round]
    tables: dict[str, pl.DataFrame] = field(default_factory=dict)
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class Part:
    """One recording of a map, with every tick shifted onto the map-wide axis."""

    demo_map: str
    ends: list[RoundEnd]
    rounds: pl.DataFrame
    roster: pl.DataFrame
    snaps: pl.DataFrame
    events: dict[str, pl.DataFrame]
    last_tick: int
    truncated: bool
    rounds_from_events: bool = False
    # Rebuilt from raw events, for when awpy's rounds don't rebuild.
    event_rounds: pl.DataFrame | None = None
    event_ends: list[RoundEnd] | None = None


def _to_polars(df) -> pl.DataFrame:
    return df if isinstance(df, pl.DataFrame) else pl.from_pandas(df)


def _steamid(col: str = "steamid") -> pl.Expr:
    return pl.col(col).cast(pl.Utf8).str.replace(r"\.0$", "").cast(pl.UInt64, strict=False)


def _side_code(col: str) -> pl.Expr:
    """awpy 3 reports sides as 'counter-terrorist'/'terrorist'; team numbers and 'ct'/'t' are accepted too."""
    c = pl.col(col)
    as_str = c.cast(pl.Utf8).str.to_lowercase()
    return (
        pl.when(as_str.is_in(["3", "ct", "counter-terrorist"])).then(SIDE_CT)
        .when(as_str.is_in(["2", "t", "terrorist"])).then(SIDE_T)
        .otherwise(None)
        .alias(col)
    )


def open_demo(path: Path) -> tuple[awpy.Demo, bool]:
    """Opens a demo, cutting a truncated final command off the (work-dir) file. Returns whether it was cut."""
    demo = awpy.Demo(path)
    try:
        demo.rounds
        return demo, False
    except awpy.InvalidDemoError as e:
        m = TRUNCATED.search(str(e))
        if not m:
            raise
        os.truncate(path, int(m.group(1)))
    demo = awpy.Demo(path)
    demo.rounds
    return demo, True


def read_round_ends(rounds: pl.DataFrame, parser: DemoParser, last_tick: int | None) -> list[RoundEnd]:
    read_ticks = [int(t) + SCORE_READ_DELAY_TICKS for t in rounds["end_tick"]]
    if last_tick:
        read_ticks = [min(t, last_tick) for t in read_ticks]
    teams = _to_polars(parser.parse_ticks(["team_num", "team_clan_name", "team_rounds_total"], ticks=read_ticks))
    teams = teams.filter(pl.col("team_num").cast(pl.Int64).is_in([SIDE_T, SIDE_CT])).unique(["tick", "team_num"])

    by_tick: dict[int, dict[int, tuple[str, int]]] = {}
    for row in teams.iter_rows(named=True):
        by_tick.setdefault(int(row["tick"]), {})[int(row["team_num"])] = (
            str(row["team_clan_name"] or f"team{row['team_num']}"),
            int(row["team_rounds_total"] or 0),
        )

    ends = []
    for row, tick in zip(rounds.iter_rows(named=True), read_ticks):
        sides = by_tick.get(tick, {})
        if SIDE_CT not in sides or SIDE_T not in sides:
            continue
        (ct, ct_score), (t, t_score) = sides[SIDE_CT], sides[SIDE_T]
        ends.append(RoundEnd(int(row["start_tick"]), int(row["end_tick"]), ct, t, {ct: ct_score, t: t_score}))
    return ends


def rounds_from_events(events: dict[str, pl.DataFrame]) -> pl.DataFrame:
    """awpy's rounds rebuilt from raw round events. awpy drops every round before the last
    `begin_new_match`, so a recording that ends on a match restart reads as having none."""

    def ticks(name: str) -> list[int]:
        df = events.get(name)
        return sorted(int(t) for t in df["tick"]) if df is not None and "tick" in df.columns else []

    starts, freezes, officials = ticks("round_start"), ticks("round_freeze_end"), ticks("round_officially_ended")
    ends = events.get("round_end")
    rows = []
    prev_official = 0
    if ends is not None and "winner" in ends.columns:
        won = ends.filter(pl.col("winner").is_in(["CT", "T"])).sort("tick").rows(named=True)
        for row, nxt in zip(won, [*won[1:], None]):
            end = int(row["tick"])
            next_end = int(nxt["tick"]) if nxt else 2**62
            # The latest start wins, so a match restart or backup restore mid-round starts it over.
            start = max([prev_official, *(t for t in starts if t <= end)])
            official = next((t for t in officials if end <= t < next_end), end)
            reason, reason_name = EVENT_REASONS.get(row["reason"], (None, row["reason"]))
            rows.append({
                "start_tick": start,
                "freeze_end_tick": max((t for t in freezes if start < t <= end), default=None),
                "end_tick": end,
                "official_end_tick": official,
                "winner": SIDE_CT if row["winner"] == "CT" else SIDE_T,
                "winner_side": "counter-terrorist" if row["winner"] == "CT" else "terrorist",
                "reason": reason,
                "reason_name": reason_name,
            })
            prev_official = official
    schema = {
        "start_tick": pl.Int32, "freeze_end_tick": pl.Int32, "end_tick": pl.Int32, "official_end_tick": pl.Int32,
        "winner": pl.Int32, "winner_side": pl.Utf8, "reason": pl.Int32, "reason_name": pl.Utf8,
    }
    return pl.DataFrame(rows, schema=schema)


def fill_round_starts(rounds: pl.DataFrame) -> pl.DataFrame:
    """awpy leaves start_tick null when a backup restore hands the round's round_start to a stub
    'still_in_progress' round; the real round starts where the previous one officially ended."""
    prev_end = pl.coalesce(pl.col("official_end_tick").shift(1), pl.col("end_tick").shift(1))
    return rounds.with_columns(
        pl.coalesce("start_tick", prev_end, "freeze_end_tick", pl.lit(0)).cast(rounds["start_tick"].dtype)
    )


def _event_frames(parser: DemoParser, names: tuple[str, ...]) -> dict[str, pl.DataFrame]:
    return {n: _to_polars(parser.parse_event(n)) for n in names}


def _snapshots(demo: awpy.Demo, parser: DemoParser) -> pl.DataFrame:
    snaps = demo.snapshots(every=SNAPSHOT_EVERY_TICKS)
    snaps = snaps.select([c for c in SNAPSHOT_COLUMNS if c in snaps.columns]).with_columns(
        _steamid(), _side_code("side")
    )
    ticks = sorted(set(int(t) for t in snaps["tick"]))
    places = _to_polars(parser.parse_ticks(["last_place_name"], ticks=ticks))
    places = places.select(pl.col("tick").cast(snaps["tick"].dtype), _steamid(), "last_place_name")
    return snaps.join(places, on=["tick", "steamid"], how="left")


def _shift(df: pl.DataFrame, offset: int, part: int, columns=("tick",)) -> pl.DataFrame:
    present = [c for c in columns if c in df.columns]
    return df.with_columns(*(pl.col(c).cast(pl.Int64) + offset for c in present), pl.lit(part, pl.Int32).alias("part"))


def _shifted_ends(rounds: pl.DataFrame, parser: DemoParser, playback: int | None, offset: int) -> list[RoundEnd]:
    return [
        RoundEnd(e.start_tick + offset, e.end_tick + offset, e.ct_team, e.t_team, e.scores)
        for e in read_round_ends(rounds, parser, playback)
    ]


def read_part(path: Path, part: int, offset: int) -> Part:
    demo, cut = open_demo(path)
    parser = DemoParser(str(path))
    playback = None if cut else demo.header.get("playback_ticks")
    playback = int(playback) if playback else None
    event_rounds = fill_round_starts(rounds_from_events(_event_frames(parser, ROUND_EVENTS)).sort("end_tick"))
    only_events = demo.rounds.is_empty()
    rounds = event_rounds if only_events else fill_round_starts(demo.rounds.sort("end_tick"))
    has_alt = not only_events and not event_rounds.is_empty()
    snaps = _snapshots(demo, parser)
    last_tick = max(int(snaps["tick"].max() or 0), int(rounds["end_tick"].max() or 0))
    return Part(
        demo_map=str(demo.header.get("map_name", "")),
        ends=_shifted_ends(rounds, parser, playback, offset),
        rounds=_shift(rounds, offset, part, ROUND_TICK_COLUMNS),
        roster=demo.players.with_columns(_steamid()),
        snaps=_shift(snaps, offset, part),
        events={name: _shift(getattr(demo, attr), offset, part) for name, attr in EVENT_TABLES.items()},
        last_tick=offset + last_tick,
        truncated=cut,
        rounds_from_events=only_events and not rounds.is_empty(),
        event_rounds=_shift(event_rounds, offset, part, ROUND_TICK_COLUMNS) if has_alt else None,
        event_ends=_shifted_ends(event_rounds, parser, playback, offset) if has_alt else None,
    )


def _round_windows(kept: list[Round], all_rounds: pl.DataFrame) -> pl.DataFrame:
    """Each kept round owns ticks from its start until the next round starts, so post-round kills stay with it."""
    starts = sorted(int(s) for s in all_rounds["start_tick"])
    rows = []
    for r in kept:
        nxt = next((s for s in starts if s > r.end_tick), 2**62)
        rows.append({"round_num": r.number, "window_start": r.start_tick, "window_end": nxt})
    return pl.DataFrame(rows, schema={"round_num": pl.Int32, "window_start": pl.Int64, "window_end": pl.Int64})


def assign_rounds(df: pl.DataFrame, windows: pl.DataFrame) -> pl.DataFrame:
    if df.is_empty() or "tick" not in df.columns:
        return df.with_columns(pl.lit(None, pl.Int32).alias("round_num"))
    out = df.with_columns(pl.col("tick").cast(pl.Int64)).sort("tick").join_asof(
        windows.sort("window_start"), left_on="tick", right_on="window_start", strategy="backward"
    )
    return out.filter(pl.col("tick") < pl.col("window_end")).drop("window_start", "window_end")


def _players_per_side(snaps: pl.DataFrame, kept: list[Round], freeze_end: dict[int, int]) -> dict[int, tuple[int, int]]:
    out: dict[int, tuple[int, int]] = {}
    live = snaps.filter(pl.col("steamid") > 0)
    for r in kept:
        in_round = live.filter(pl.col("tick").is_between(freeze_end.get(r.end_tick, r.start_tick), r.end_tick))
        if in_round.is_empty():
            continue
        counts = in_round.group_by("side").agg(pl.col("steamid").n_unique())
        by_side = dict(zip(counts["side"].to_list(), counts["steamid"].to_list()))
        out[r.number] = (by_side.get(SIDE_CT, 0), by_side.get(SIDE_T, 0))
    return out


def parse_map(dem_paths: list[Path], lp_match: LpMatch, lp_map: LpMap, identity: IdentityTable) -> ParsedMap:
    """`dem_paths` are the map's recordings in order; a server restart splits a map into several."""
    parts: list[Part] = []
    offset = 0
    for i, path in enumerate(dem_paths):
        parts.append(read_part(path, i, offset))
        offset = parts[-1].last_tick + 1
    demo_maps = {p.demo_map for p in parts}
    demo_map = parts[0].demo_map if len(demo_maps) == 1 else "/".join(sorted(demo_maps))
    context = f"{lp_match.pagename} {lp_match.match2id} m{lp_map.number}"

    try:
        kept = rebuild_rounds([e for p in parts for e in p.ends])
        events_note = None
    except RoundRebuildError as e:
        # awpy can drop every round before a backup restore; the raw events keep them.
        try:
            kept = rebuild_rounds([e for p in parts for e in (p.event_ends or p.ends)])
        except RoundRebuildError:
            return ParsedMap(demo_map, [], failures=[f"round rebuild: {e}"])
        for p in parts:
            if p.event_rounds is not None:
                p.rounds = p.event_rounds
        events_note = f"rounds rebuilt from raw events; awpy's: {e}"

    all_rounds = pl.concat([p.rounds for p in parts], how="diagonal_relaxed")
    roster = pl.concat([p.roster for p in parts], how="diagonal_relaxed").unique("steamid", keep="last", maintain_order=True)
    snaps = pl.concat([p.snaps for p in parts], how="diagonal_relaxed")

    pages: dict[int, str | None] = {}
    for row in roster.filter(pl.col("steamid") > 0).iter_rows(named=True):
        pages[row["steamid"]] = identity.resolve(str(row["steamid"]), str(row["name"] or ""), lp_match, context)

    clans = {r.ct_team for r in kept} | {r.t_team for r in kept}
    clan_players = {
        clan: [pages.get(sid) for sid in roster.filter(pl.col("team_clan_name") == clan)["steamid"]]
        for clan in clans
    }
    opponent_of = {clan: match_opponent(clan, players, lp_match) for clan, players in clan_players.items()}
    team_by_opponent = tuple(next((c for c, i in opponent_of.items() if i == idx), "") for idx in (0, 1))
    failures = []
    if len(clans) != 2 or "" in team_by_opponent:
        failures.append(f"can't map demo teams {sorted(clans)} to Liquipedia opponents: {opponent_of}")

    freeze_end = {int(r["end_tick"]): int(r["freeze_end_tick"] or r["start_tick"]) for r in all_rounds.iter_rows(named=True)}
    page = cached_page(lp_match)
    hltv = map_score(lp_match, lp_map, page) if page else None
    invalid, notes = validate_map(lp_map, demo_map, kept, team_by_opponent, _players_per_side(snaps, kept, freeze_end), hltv)
    failures += invalid

    windows = _round_windows(kept, all_rounds)
    lp_page = {clan: lp_match.opponents[i].page for clan, i in opponent_of.items() if i is not None}
    rounds_df = pl.DataFrame(
        [
            {
                "round_num": r.number, "start_tick": r.start_tick,
                "freeze_end_tick": freeze_end.get(r.end_tick), "end_tick": r.end_tick,
                "ct_team": r.ct_team, "t_team": r.t_team, "winner_team": r.winner,
                "ct_lp_team": lp_page.get(r.ct_team), "t_lp_team": lp_page.get(r.t_team),
                "winner_lp_team": lp_page.get(r.winner), "winner_side": "ct" if r.winner == r.ct_team else "t",
                "ct_score": r.scores[r.ct_team], "t_score": r.scores[r.t_team],
            }
            for r in kept
        ]
    )
    reasons = all_rounds.select(pl.col("end_tick").cast(pl.Int64), "part", "reason", "reason_name")
    if not rounds_df.is_empty():
        rounds_df = rounds_df.join(reasons, on="end_tick", how="left")

    players_df = roster.with_columns(
        pl.col("steamid").map_elements(lambda s: pages.get(s), return_dtype=pl.Utf8).alias("lp_player"),
        pl.col("team_clan_name").map_elements(lambda c: lp_page.get(c), return_dtype=pl.Utf8).alias("lp_team"),
    )

    tables = {"rounds": rounds_df, "players": players_df}
    for name in EVENT_TABLES:
        tables[name] = assign_rounds(pl.concat([p.events[name] for p in parts], how="diagonal_relaxed"), windows)
    tables["ticks"] = assign_rounds(snaps, windows)
    meta = {
        "hltv_match_id": lp_match.hltv_id, "map_number": lp_map.number, "map": demo_map,
        "lp_match2id": lp_match.match2id, "lp_pagename": lp_match.pagename, "tier": lp_match.tier,
        "parser_version": PARSER_VERSION,
    }
    tables = {name: df.with_columns(*(pl.lit(v).alias(k) for k, v in meta.items())) for name, df in tables.items()}
    notes += [f"part {i + 1} of {len(parts)} cut at its truncated final command" for i, p in enumerate(parts) if p.truncated]
    notes += [
        f"part {i + 1} of {len(parts)} rounds rebuilt from raw events; awpy found none"
        for i, p in enumerate(parts) if p.rounds_from_events
    ]
    if events_note:
        notes.append(events_note)
    return ParsedMap(demo_map, kept, tables, failures, notes)
