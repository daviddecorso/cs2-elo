"""Checks a parsed map against Liquipedia's official result. Any failure quarantines the map."""

from .liquipedia import LpMap
from .match_page import HltvMapScore
from .rounds import REGULATION_ROUNDS, HALF_ROUNDS, Round, rounds_per_half

REGULATION_HALVES = REGULATION_ROUNDS // HALF_ROUNDS


def validate_map(
    lp_map: LpMap,
    demo_map: str,
    rounds: list[Round],
    team_by_opponent: tuple[str, str],
    players_per_side: dict[int, tuple[int, int]],
    hltv: HltvMapScore | None = None,
) -> tuple[list[str], list[str]]:
    """Returns (failures, notes). `team_by_opponent` is the demo clan name of Liquipedia opponents 1 and 2.
    `players_per_side` is round number → distinct (CT, T) SteamIDs seen in that round.
    A Liquipedia half or side mismatch passes, with a note, when HLTV's half scores agree with the demo."""
    failures: list[str] = []
    notes: list[str] = []
    if demo_map != lp_map.demo_map:
        failures.append(f"map is {demo_map}, Liquipedia has {lp_map.demo_map}")

    won = tuple(sum(1 for r in rounds if r.winner == team) for team in team_by_opponent)
    if won != lp_map.scores:
        failures.append(f"rounds {won[0]}-{won[1]}, Liquipedia has {lp_map.scores[0]}-{lp_map.scores[1]}")
    else:
        for i, team in enumerate(team_by_opponent):
            halves = rounds_per_half(rounds, team)
            if lp_map.halfs[i] and halves != lp_map.halfs[i]:
                problem = f"opponent {i + 1} halves {halves}, Liquipedia has {lp_map.halfs[i]}"
                regulation, overtime = halves[:REGULATION_HALVES], sum(halves[REGULATION_HALVES:])
                if hltv and regulation == hltv.halves[i] and overtime == hltv.overtime[i]:
                    notes.append(f"{problem}; HLTV agrees with the demo")
                else:
                    failures.append(problem)

    if rounds and lp_map.first_half_sides[0] in ("ct", "t"):
        demo_side = "ct" if rounds[0].ct_team == team_by_opponent[0] else "t"
        if demo_side != lp_map.first_half_sides[0]:
            problem = f"opponent 1 starts {demo_side}, Liquipedia has {lp_map.first_half_sides[0]}"
            if hltv and hltv.first_side == demo_side:
                notes.append(f"{problem}; HLTV agrees with the demo")
            else:
                failures.append(problem)

    bad = [n for n, counts in sorted(players_per_side.items()) if counts != (5, 5)]
    missing = [r.number for r in rounds if r.number not in players_per_side]
    if bad:
        failures.append(f"not 5v5 in rounds {bad[:10]}: {[players_per_side[n] for n in bad[:10]]}")
    if missing:
        failures.append(f"no player snapshots in rounds {missing[:10]}")
    return failures, notes
