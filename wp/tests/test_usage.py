import numpy as np
import polars as pl
import pytest

from cs2wp.baselines import VERSIONS
from cs2wp.states import CT, T
from cs2wp.usage import OWN, TEAM, Expectation, player_folds, split


def _rounds(players=40, per_player=60, seed=0):
    rng = np.random.default_rng(seed)
    n = players * per_player
    equip = rng.integers(200, 6000, n)
    team = rng.integers(2000, 30000, n)
    df = pl.DataFrame({
        "steamid": np.repeat(np.arange(1, players + 1, dtype=np.uint64), per_player),
        "map": rng.choice(["de_inferno", "de_mirage"], n), "side": rng.choice([CT, T], n).astype(np.int32),
        "role": rng.choice(["AWPer", "Rifler"], n), "team_equip": team, "opp_equip": rng.integers(2000, 30000, n),
        "pistol": rng.random(n) < 0.08, "equip": equip, "equip_share": equip / team,
        "gun": rng.choice(["Rifle", "SMG", "AWP", "Pistol"], n), "awp": rng.random(n) < 0.2,
        "armor": rng.choice([0, 100], n), "helmet": rng.random(n) < 0.5, "has_defuser": rng.random(n) < 0.3,
        **{u: rng.integers(0, 2, n) for u in ("smokes", "flashes", "hes", "fires")},
    }).with_columns(*(pl.when(pl.col(c) < 5000).then(pl.lit("eco")).when(pl.col(c) < 20000).then(pl.lit("force"))
                      .otherwise(pl.lit("full")).alias(b) for c, b in (("team_equip", "team_buy"),
                                                                      ("opp_equip", "opp_buy"))))
    signal = 0.00001 * equip + 0.000002 * team
    return df.with_columns(
        *(pl.Series(v, signal + rng.normal(0, 0.05, n)) for v in VERSIONS),
        *(pl.lit(0.03).alias(f"{v}_baseline") for v in VERSIONS))


def test_igl_adjustment_lands_in_conversion():
    from cs2wp.war import apply_igl_adjustment, fit_igl_adjustment

    rows = pl.DataFrame({"key": ["a", "a", "b"], "steamid": [1, 2, 1], "side": [CT, T, T], "is_igl": [True, False, True],
                         "role": ["Anchor", "Rifler", "Entry"], "rounds": [12, 12, 10]},
                        schema_overrides={"side": pl.Int32}).with_columns(
        *(pl.lit(x).alias(f"{v}_{t}") for v in VERSIONS for t, x in (("context", 0.1), ("usage", -0.2), ("conversion", 0.4))),
        *(pl.lit(0.3).alias(f"{v}_above") for v in VERSIONS))
    out = apply_igl_adjustment(rows, fit_igl_adjustment(rows), replacement_rate=0.01)
    for v in VERSIONS:
        total = out[f"{v}_context"] + out[f"{v}_usage"] + out[f"{v}_conversion_rw"]
        assert total.to_numpy() == pytest.approx(out[f"{v}_rw"].to_numpy())


def test_player_folds_keep_players_whole():
    df = _rounds(players=12, per_player=5)
    folds = player_folds(df)
    per = df.with_columns(pl.Series("f", folds)).group_by("steamid").agg(pl.col("f").n_unique())
    assert per["f"].max() == 1 and len(set(folds)) == 5


def test_three_terms_sum_to_credit_above_baseline():
    df, _ = split(_rounds(), OWN)
    for v in VERSIONS:
        total = df[f"{v}_context"] + df[f"{v}_usage"] + df[f"{v}_conversion"]
        assert total.to_numpy() == pytest.approx((df[v] - df[f"{v}_baseline"]).to_numpy(), abs=1e-9)
    assert df.select(pl.corr("wpa_usage", "equip")).item() > 0.5


def test_a_player_is_never_predicted_by_a_model_that_saw_them():
    """Each player's `armor` and credit are unique to them; only a model trained on their rounds could reproduce
    that pairing."""
    df = _rounds(players=20, per_player=400, seed=1)
    rng = np.random.default_rng(2)
    level = dict(zip(range(1, 21), rng.normal(0, 1, 20)))
    df = df.with_columns(pl.col("steamid").cast(pl.Float64).alias("armor"),
                         pl.col("steamid").replace_strict(level, return_dtype=pl.Float64).alias("wpa"))
    m = Expectation(df, TEAM + ["armor"])
    y = df["wpa"].to_numpy()
    oof, _ = m.cross_fit(df, y, player_folds(df))
    in_sample = m.fit(df, y, 200).predict(m.x(df))
    assert np.corrcoef(in_sample, y)[0, 1] > 0.9
    assert np.corrcoef(oof, y)[0, 1] < 0.5
