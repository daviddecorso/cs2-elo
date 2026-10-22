import pytest

from cs2demos.rounds import RoundEnd, RoundRebuildError, half_index, rebuild_rounds, rounds_per_half


def ends_from(winners: str, start_tick: int = 1000, a_ct_until: int = 12) -> list[RoundEnd]:
    """One RoundEnd per char: 'a' or 'b' won. Team a is CT for the first `a_ct_until` rounds."""
    out, score = [], {"a": 0, "b": 0}
    for i, w in enumerate(winners):
        score = {**score, w: score[w] + 1}
        ct, t = ("a", "b") if i < a_ct_until else ("b", "a")
        tick = start_tick + i * 100
        out.append(RoundEnd(tick, tick + 90, ct, t, dict(score)))
    return out


def test_clean_map():
    rounds = rebuild_rounds(ends_from("a" * 13 + "b" * 5))
    assert len(rounds) == 18
    assert rounds[-1].scores == {"a": 13, "b": 5}
    assert [r.number for r in rounds] == list(range(1, 19))


def test_knife_round_and_warmup_dropped():
    knife = RoundEnd(10, 50, "a", "b", {"a": 1, "b": 0})
    warmup = RoundEnd(0, 5, "a", "b", {"a": 0, "b": 0})
    rounds = rebuild_rounds([warmup, knife, *ends_from("ab" * 6 + "a")])
    assert len(rounds) == 13
    assert rounds[0].start_tick == 1000


def test_backup_restore_replays_round():
    ends = ends_from("aaab")
    # Round 4 is replayed after a backup restore to 3-0, and b wins it again later.
    replay = RoundEnd(5000, 5090, "a", "b", {"a": 3, "b": 1})
    rounds = rebuild_rounds([*ends, replay])
    assert len(rounds) == 4
    assert rounds[-1].end_tick == 5090


def test_restore_further_back_truncates():
    ends = ends_from("aaaa")
    replays = [RoundEnd(9000, 9090, "a", "b", {"a": 2, "b": 1}), RoundEnd(9100, 9190, "a", "b", {"a": 2, "b": 2})]
    rounds = rebuild_rounds([*ends, *replays])
    assert [r.winner for r in rounds] == ["a", "a", "b", "b"]


def test_duplicate_round_end_keeps_last():
    ends = ends_from("ab")
    dup = RoundEnd(ends[1].start_tick, ends[1].end_tick + 1, "a", "b", dict(ends[1].scores))
    assert len(rebuild_rounds([*ends, dup])) == 2


def test_missing_rounds_raise():
    ends = ends_from("aaaa")
    with pytest.raises(RoundRebuildError):
        rebuild_rounds([ends[0], ends[3]])


def test_overtime_halves():
    winners = "a" * 6 + "b" * 6 + "b" * 6 + "a" * 6 + "aab" + "baa" + "aa"
    rounds = rebuild_rounds(ends_from(winners))
    assert half_index(24) == 1 and half_index(25) == 2 and half_index(28) == 3 and half_index(31) == 4
    assert rounds_per_half(rounds, "a") == [6, 6, 2, 2, 2]
    assert rounds_per_half(rounds, "b") == [6, 6, 1, 1, 0]
