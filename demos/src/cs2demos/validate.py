"""Checks a parsed map against Liquipedia's official result. Any failure quarantines the map."""

from .liquipedia import LpMap
from .rounds import Round, rounds_per_half


def validate_map(
    lp_map: LpMap,
    demo_map: str,
    rounds: list[Round],
    team_by_opponent: tuple[str, str],
    players_per_side: dict[int, tuple[int, int]],
) -> list[str]:
    """`team_by_opponent` is the demo clan name of Liquipedia opponents 1 and 2.
    `players_per_side` is round number → distinct (CT, T) SteamIDs seen in that round."""
    failures: list[str] = []
    if demo_map != lp_map.demo_map:
        failures.append(f"map is {demo_map}, Liquipedia has {lp_map.demo_map}")

    won = tuple(sum(1 for r in rounds if r.winner == team) for team in team_by_opponent)
    if won != lp_map.scores:
        failures.append(f"rounds {won[0]}-{won[1]}, Liquipedia has {lp_map.scores[0]}-{lp_map.scores[1]}")
    else:
        for i, team in enumerate(team_by_opponent):
            halves = rounds_per_half(rounds, team)
            if lp_map.halfs[i] and halves != lp_map.halfs[i]:
                failures.append(f"opponent {i + 1} halves {halves}, Liquipedia has {lp_map.halfs[i]}")

    if rounds and lp_map.first_half_sides[0] in ("ct", "t"):
        demo_side = "ct" if rounds[0].ct_team == team_by_opponent[0] else "t"
        if demo_side != lp_map.first_half_sides[0]:
            failures.append(f"opponent 1 starts {demo_side}, Liquipedia has {lp_map.first_half_sides[0]}")

    bad = [n for n, counts in sorted(players_per_side.items()) if counts != (5, 5)]
    missing = [r.number for r in rounds if r.number not in players_per_side]
    if bad:
        failures.append(f"not 5v5 in rounds {bad[:10]}: {[players_per_side[n] for n in bad[:10]]}")
    if missing:
        failures.append(f"no player snapshots in rounds {missing[:10]}")
    return failures
