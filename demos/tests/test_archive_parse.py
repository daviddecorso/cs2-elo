from pathlib import Path

import polars as pl

from cs2demos.archive import group_by_map
from cs2demos.liquipedia import LpMap
from cs2demos.parse import (
    SIDE_CT, SIDE_T, Part, _align_team_names, _side_code, _to_polars, assign_rounds, fill_round_starts, read_round_ends,
    rounds_from_events,
)
from cs2demos.rounds import RoundEnd


def lp(n, name, demo):
    return LpMap(n, name, demo, (13, 0), ([], []), ("", ""))


def test_group_by_map_number_parts_and_name_fallback():
    maps = [lp(1, "Inferno", "de_inferno"), lp(2, "Nuke", "de_nuke"), lp(3, "Dust II", "de_dust2")]
    dems = [
        Path("9z-vs-aurora-m1-inferno.dem"),
        Path("9z-vs-aurora-m2-nuke-p2.dem"),
        Path("9z-vs-aurora-m2-nuke-p1.dem"),
        Path("9z-vs-aurora-dust2.dem"),
    ]
    groups = group_by_map(dems, maps)
    assert groups[1] == [dems[0]]
    assert [p.name for p in groups[2]] == ["9z-vs-aurora-m2-nuke-p1.dem", "9z-vs-aurora-m2-nuke-p2.dem"]
    assert groups[3] == [dems[3]]


def test_group_by_map_ignores_team_name_like_map_number():
    maps = [lp(1, "Cache", "de_cache"), lp(2, "Cache", "de_cache")]
    dems = [Path("spirit-vs-m80-m1-cache.dem"), Path("spirit-vs-m80-m2-cache-p1.dem")]
    groups = group_by_map(dems, maps)
    assert groups == {1: [dems[0]], 2: [dems[1]]}


def test_group_by_map_rejects_mismatched_map_slug_and_falls_back():
    maps = [lp(1, "Tuscan", "de_tuscan")]
    dems = [
        Path("natus-vincere-vs-vitality-r1-tuscan.dem"),
        Path("natus-vincere-vs-vitality-r2-m1-shoots.dem"),
        Path("natus-vincere-vs-vitality-r2-m2-pool-day.dem"),
    ]
    assert group_by_map(dems, maps) == {1: [dems[0]]}

    bo1_m80 = [lp(1, "Nuke", "de_nuke")]
    m80_dem = [Path("spirit-vs-m80-nuke.dem")]
    assert group_by_map(m80_dem, bo1_m80) == {1: m80_dem}


def test_side_code():
    df = pl.DataFrame({"side": ["counter-terrorist", "terrorist", "ct", "3", None]})
    assert df.select(_side_code("side"))["side"].to_list() == [SIDE_CT, SIDE_T, SIDE_CT, SIDE_CT, None]


def test_assign_rounds_keeps_post_round_and_drops_gaps():
    windows = pl.DataFrame(
        {"round_num": [1, 2], "window_start": [100, 500], "window_end": [300, 900]},
        schema={"round_num": pl.Int32, "window_start": pl.Int64, "window_end": pl.Int64},
    )
    # 50: warmup; 250: post-round of 1; 400: a dropped (replayed) round; 950: after the map.
    events = pl.DataFrame({"tick": [50, 150, 250, 400, 600, 950]})
    out = assign_rounds(events, windows)
    assert out["tick"].to_list() == [150, 250, 600]
    assert out["round_num"].to_list() == [1, 1, 2]


def test_rounds_from_events_matches_awpy_rounds():
    events = {
        "round_start": pl.DataFrame({"round": [1, 17, 18], "tick": [1, 4, 3189]}),
        "round_freeze_end": pl.DataFrame({"tick": [1496, 4469]}),
        "round_end": pl.DataFrame(
            {"reason": [None, "t_killed", "bomb_exploded"], "round": [17, 18, 19], "tick": [4, 2869, 9750],
             "winner": [None, "CT", "T"]}
        ),
        "round_officially_ended": pl.DataFrame({"tick": [4, 3189]}),
    }
    out = rounds_from_events(events)
    assert out.select("start_tick", "freeze_end_tick", "end_tick", "official_end_tick").rows() == [
        (4, 1496, 2869, 3189),
        (3189, 4469, 9750, 9750),
    ]
    assert out["winner"].to_list() == [SIDE_CT, SIDE_T]
    assert out["reason_name"].to_list() == ["ct_win", "target_bombed"]


def test_rounds_from_events_restart_and_restore():
    # Ticks from G2 vs BIG (2397605) m3: a match restart before round 1, and a backup restore during round 13.
    events = {
        "round_start": pl.DataFrame({"tick": [1, 3231, 3552, 18758, 92710, 96601, 96909, 115013]}),
        "round_freeze_end": pl.DataFrame({"tick": [1676, 3358, 13664, 20038, 94406, 112013, 116293]}),
        "round_end": pl.DataFrame(
            {"reason": ["ct_killed", "bomb_defused", "ct_killed", None, None, "ct_killed"],
             "tick": [2924, 18438, 92166, 96601, 96909, 114693], "winner": ["T", "CT", "T", None, None, "T"]}
        ),
        "round_officially_ended": pl.DataFrame({"tick": [18758, 92710, 96601, 96909, 115013]}),
    }
    out = rounds_from_events(events)
    assert out.select("start_tick", "freeze_end_tick", "end_tick", "official_end_tick").rows() == [
        (1, 1676, 2924, 2924),
        (3552, 13664, 18438, 18758),
        (18758, 20038, 92166, 92710),
        (96909, 112013, 114693, 115013),
    ]


def test_rounds_from_events_2023_numeric_winner_and_reason():
    # Ticks from Vitality vs BetBoom (2367124) m1 part 1, IEM Sydney 2023: three rounds, then a match restart.
    events = {
        "round_start": pl.DataFrame({"tick": [5408, 11164, 17773, 23926]}),
        "round_freeze_end": pl.DataFrame({"tick": [1300, 6700, 12500]}),
        "round_end": pl.DataFrame({"reason": [9, 9, 1], "tick": [5088, 10844, 17453], "winner": [2, 2, 2]}),
        "round_officially_ended": pl.DataFrame({"tick": [5408, 11164, 17773, 23926]}),
    }
    out = rounds_from_events(events)
    assert out["end_tick"].to_list() == [5088, 10844, 17453]
    assert out["winner"].to_list() == [SIDE_T, SIDE_T, SIDE_T]
    assert out["reason"].to_list() == [9, 9, 1]
    assert out["reason_name"].to_list() == ["terrorists_win", "terrorists_win", "target_bombed"]


def test_fill_round_starts_after_restore_stub():
    rounds = pl.DataFrame(
        {"start_tick": [None, 96601, None], "freeze_end_tick": [500, None, 112013],
         "end_tick": [92166, 96909, 114693], "official_end_tick": [92710, None, 115013]},
        schema={c: pl.Int32 for c in ("start_tick", "freeze_end_tick", "end_tick", "official_end_tick")},
    )
    assert fill_round_starts(rounds)["start_tick"].to_list() == [500, 96601, 96909]


def test_to_polars_accepts_empty_event_list():
    assert _to_polars([]).is_empty()


def test_rounds_from_events_null_winner_float_column():
    events = {
        "round_start": pl.DataFrame({"round": [1], "tick": [1]}),
        "round_freeze_end": pl.DataFrame({"tick": [1275]}),
        "round_end": pl.DataFrame(
            {"reason": [None], "round": [0], "tick": [1], "winner": [None]},
            schema={"reason": pl.Float64, "round": pl.UInt32, "tick": pl.Int32, "winner": pl.Float64},
        ),
        "round_officially_ended": pl.DataFrame(),
    }
    assert rounds_from_events(events).is_empty()


class FakeParser:
    """parse_ticks for a recording that skipped some ticks."""

    def __init__(self, scores_by_tick: dict[int, tuple[int, int]]):
        self.scores_by_tick = scores_by_tick

    def parse_ticks(self, fields, ticks):
        rows = [
            {"tick": t, "team_num": num, "team_clan_name": name, "team_rounds_total": score}
            for t in ticks if t in self.scores_by_tick
            for num, name, score in ((SIDE_CT, "a", self.scores_by_tick[t][0]), (SIDE_T, "b", self.scores_by_tick[t][1]))
        ]
        return pl.DataFrame(rows, schema={"tick": pl.Int64, "team_num": pl.Int64, "team_clan_name": pl.Utf8,
                                          "team_rounds_total": pl.Int64})


def test_read_round_ends_falls_back_when_the_read_tick_was_skipped():
    rounds = pl.DataFrame({"start_tick": [0, 1000], "end_tick": [500, 1500]})
    parser = FakeParser({532: (1, 0), 1516: (1, 1), 1564: (1, 1)})
    ends = read_round_ends(rounds, parser, None)
    assert [e.scores for e in ends] == [{"a": 1, "b": 0}, {"a": 1, "b": 1}]


class UnnamedParser:
    """parse_ticks for a recording with empty clan names: CT players 1-3, T players 4-6."""

    def parse_ticks(self, fields, ticks):
        rows = [
            {"tick": t, "team_num": num, "team_clan_name": "", "team_rounds_total": score, "steamid": str(sid)}
            for t in ticks
            for num, score, ids in ((SIDE_CT, 2, (1, 2, 3)), (SIDE_T, 4, (4, 5, 6)))
            for sid in ids
        ]
        return pl.DataFrame(rows)


def test_read_round_ends_names_unnamed_sides_by_their_players():
    rounds = pl.DataFrame({"start_tick": [0], "end_tick": [500]})
    team_of = {1: "FURIA", 2: "FURIA", 3: "BIG", 4: "BIG", 5: "BIG", 6: "BIG"}
    [end] = read_round_ends(rounds, UnnamedParser(), None, team_of)
    assert (end.ct_team, end.t_team, end.scores) == ("FURIA", "BIG", {"FURIA": 2, "BIG": 4})
    [end] = read_round_ends(rounds, UnnamedParser(), None)
    assert (end.ct_team, end.t_team) == ("team3", "team2")


def part(roster: dict[str, list[int]], ends: list[RoundEnd]) -> Part:
    rows = [{"steamid": sid, "team_clan_name": name} for name, ids in roster.items() for sid in ids]
    empty = pl.DataFrame()
    return Part("de_nuke", ends, empty, pl.DataFrame(rows), empty, {}, 0, False)


def test_align_team_names_swaps_back_a_restarted_part():
    first = part({"A": [1, 2, 3], "B": [4, 5, 6]}, [RoundEnd(0, 10, "B", "A", {"A": 13, "B": 7})])
    swapped = part({"B": [1, 2, 3], "A": [4, 5, 6]}, [RoundEnd(20, 30, "A", "B", {"B": 13, "A": 7})])
    kept = part({"A": [1, 2], "B": [4, 5, 6]}, [RoundEnd(40, 50, "B", "A", {"A": 14, "B": 7})])
    assert _align_team_names([first, swapped, kept]) == [1]
    assert swapped.ends == [RoundEnd(20, 30, "B", "A", {"A": 13, "B": 7})]
    roster = dict(swapped.roster.select("steamid", "team_clan_name").iter_rows())
    assert roster == {1: "A", 2: "A", 3: "A", 4: "B", 5: "B", 6: "B"}
    assert kept.ends == [RoundEnd(40, 50, "B", "A", {"A": 14, "B": 7})]
