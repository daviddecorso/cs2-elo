import numpy as np
import polars as pl

from cs2wp import evaluate as ev


def clustered(rounds: int, states: int, seed: int = 0) -> tuple[pl.DataFrame, np.ndarray]:
    """Calibrated predictions where every state in a round shares one outcome."""
    rng = np.random.default_rng(seed)
    p_round = rng.uniform(0.05, 0.95, rounds)
    y_round = rng.random(rounds) < p_round
    df = pl.DataFrame({
        "key": np.repeat([f"m{i // 30}" for i in range(rounds)], states),
        "round_num": np.repeat(np.arange(rounds) % 30, states),
        "ct_win": np.repeat(y_round, states),
    })
    return df, np.repeat(p_round, states)


def test_noise_limit_covers_a_calibrated_model_but_not_a_biased_one():
    fails = 0
    for seed in range(10):
        df, p = clustered(rounds=3000, states=100, seed=seed)
        y = df["ct_win"].cast(pl.Int8).to_numpy()
        fails += ev.calibration(y, p, bins=20)["max_gap"] > ev.bin_gap_noise(df, p, n=100, bins=20, seed=seed)
    assert fails <= 2

    biased = np.clip(p + 0.15, 0, 1)
    assert ev.calibration(y, biased, bins=20)["max_gap"] > ev.bin_gap_noise(df, biased, n=100, bins=20)
