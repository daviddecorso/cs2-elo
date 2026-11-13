import polars as pl
import pytest

from cs2wp.rolecheck import MIN_MAPS, auc, load_labels, pool_ct, pool_t
from cs2wp.paths import PLAYSTYLE_2024


def test_auc_counts_ties_as_half():
    assert auc([3, 2], [1]) == 1
    assert auc([1], [1]) == 0.5
    assert auc([1, 3], [2]) == 0.5


def test_pool_t_sums_counts_before_dividing_and_drops_small_samples():
    n = MIN_MAPS
    roles = pl.DataFrame({
        "steamid": [1] * n + [2] * (n - 1), "date": list(range(n)) + list(range(n - 1)),
        "lp_player": ["a"] * n + ["b"] * (n - 1),
        "opening_kills": [1] + [0] * (n - 1) + [0] * (n - 1), "opening_deaths": [0] * (2 * n - 1),
        "t_rounds": [1] + [9] * (n - 1) + [10] * (n - 1),
        "t_awp_rounds": [5] * n + [0] * (n - 1), "ct_awp_rounds": [5] * n + [0] * (n - 1),
        "t_buy_rounds": [10] * (2 * n - 1), "ct_buy_rounds": [10] * (2 * n - 1),
        "t_role": ["AWPer"] * (n // 2 + 1) + ["Rifler"] * (n - n // 2 - 1) + ["Rifler"] * (n - 1),
    }, schema_overrides={"steamid": pl.UInt64})
    out = pool_t(roles)
    assert out["steamid"].to_list() == [1]
    row = out.row(0, named=True)
    assert row["entry"] == pytest.approx(1 / (1 + 9 * (n - 1)))
    assert row["awp"] == 0.5 and row["awper"]


def test_pool_ct_site_share():
    pos = pl.DataFrame({"steamid": [1] * MIN_MAPS, "position": ["A", "B"] + ["Mid"] * (MIN_MAPS - 2)},
                       schema_overrides={"steamid": pl.UInt64})
    assert pool_ct(pos)["site_share"].item() == pytest.approx(2 / MIN_MAPS)


def test_vendored_labels_load():
    labels = load_labels(PLAYSTYLE_2024)
    assert labels["steamid"].is_unique().all()
    assert set(labels["role_t"].drop_nulls()) == {"AWPer", "Spacetaker", "Half-Lurker", "Lurker"}
