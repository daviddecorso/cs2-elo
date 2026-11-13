import json

import polars as pl
import pytest

from cs2wp.igls import AmbiguousIGL, UnmappedTeams, assign_igls, load_table


def _role_rounds(rows: list[tuple[str, str, str, str | None, int]]) -> pl.DataFrame:
    return pl.DataFrame(
        [{"key": k, "date": d, "lp_team": t, "lp_player": p, "steamid": s} for k, d, t, p, s in rows],
        schema_overrides={"steamid": pl.UInt64},
    )


def test_date_bounded_stints_resolve_midseason_caller_swap():
    rr = _role_rounds([
        ("m1", "2026-02-10", "MOUZ", "Brollan", 1),
        ("m1", "2026-02-10", "MOUZ", "XertioN", 2),
        ("m2", "2026-08-01", "MOUZ", "XertioN", 2),
        ("m2", "2026-08-01", "MOUZ", "PR", 3),
    ])
    table = {
        "MOUZ": [
            {"player": "Brollan", "to": "2026-06-14"},
            {"player": "XertioN", "from": "2026-06-15"},
        ]
    }
    out = {(r["key"], r["steamid"]): r["is_igl"] for r in assign_igls(rr, table).iter_rows(named=True)}
    assert out[("m1", 1)] and not out[("m1", 2)]
    assert out[("m2", 2)] and not out[("m2", 3)]


def test_unmapped_team_raises_with_candidate_hints():
    rr = _role_rounds([("m1", "2026-02-10", "Team Spirit", "Magixx", 10), ("m1", "2026-02-10", "Team Spirit", "Donk", 11)])
    with pytest.raises(UnmappedTeams, match="Magixx"):
        assign_igls(rr, {}, captains={("Team Spirit", "Magixx")})


def test_overlapping_stints_on_same_team_map_raise_ambiguous():
    rr = _role_rounds([
        ("m1", "2026-03-01", "FaZe Clan", "Karrigan", 1),
        ("m1", "2026-03-01", "FaZe Clan", "Twistzz", 2),
    ])
    table = {"FaZe Clan": [{"player": "Karrigan"}, {"player": "Twistzz"}]}
    with pytest.raises(AmbiguousIGL, match="Karrigan, Twistzz"):
        assign_igls(rr, table)


def test_load_table_rejects_inverted_date_range(tmp_path):
    bad = tmp_path / "igls.json"
    bad.write_text(json.dumps({"FURIA": [{"player": "FalleN", "from": "2026-06-01", "to": "2026-01-01"}]}))
    with pytest.raises(ValueError, match="after"):
        load_table(bad)


def test_committed_igl_table_loads_cleanly():
    table = load_table()
    assert len(table) >= 60
    assert table["Team Vitality"] == [{"player": "ApEX"}]
