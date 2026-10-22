"""Rebuild the counted rounds of a map from round-end events and the team scores after each."""

from dataclasses import dataclass

REGULATION_ROUNDS = 24
HALF_ROUNDS = 12
OT_HALF_ROUNDS = 3


@dataclass(frozen=True)
class RoundEnd:
    start_tick: int
    end_tick: int
    ct_team: str
    t_team: str
    # Score per team (clan name) as shown after this round ended.
    scores: dict[str, int]


@dataclass(frozen=True)
class Round:
    number: int
    start_tick: int
    end_tick: int
    ct_team: str
    t_team: str
    winner: str
    scores: dict[str, int]


class RoundRebuildError(Exception):
    pass


def rebuild_rounds(ends: list[RoundEnd]) -> list[Round]:
    """Keep the last occurrence of each score state, so warmup, knife rounds, restarts and
    backup-restored rounds drop out. A round whose total score is T replaces everything from round T on."""
    kept: list[RoundEnd] = []
    for end in sorted(ends, key=lambda e: e.end_tick):
        total = sum(end.scores.values())
        if total < 1:
            continue
        if total - 1 > len(kept):
            raise RoundRebuildError(f"score jumps to {total} at tick {end.end_tick} with {len(kept)} rounds kept")
        kept = kept[: total - 1] + [end]

    rounds: list[Round] = []
    prev: dict[str, int] = {}
    for i, end in enumerate(kept):
        gained = [team for team, s in end.scores.items() if s == prev.get(team, 0) + 1]
        others_same = all(end.scores[t] == prev.get(t, 0) for t in end.scores if t not in gained)
        if len(gained) != 1 or not others_same:
            raise RoundRebuildError(f"round {i + 1}: score {prev} -> {end.scores} isn't one round won")
        rounds.append(Round(i + 1, end.start_tick, end.end_tick, end.ct_team, end.t_team, gained[0], end.scores))
        prev = end.scores
    return rounds


def half_index(round_number: int) -> int:
    """0-based half: two regulation halves of 12, then overtime halves of 3."""
    if round_number <= REGULATION_ROUNDS:
        return (round_number - 1) // HALF_ROUNDS
    return 2 + (round_number - REGULATION_ROUNDS - 1) // OT_HALF_ROUNDS


def rounds_per_half(rounds: list[Round], team: str) -> list[int]:
    if not rounds:
        return []
    halves = [0] * (half_index(rounds[-1].number) + 1)
    for r in rounds:
        if r.winner == team:
            halves[half_index(r.number)] += 1
    return halves
