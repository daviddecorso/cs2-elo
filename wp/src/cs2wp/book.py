"""Which model values each map: its month's walk-forward fold from test_from on, its month's cross-fit model before."""

import hashlib
import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import polars as pl

from . import evaluate as ev
from .features import with_derived
from .paths import MODELS, PATCHES, STATES

RECAL_ROUNDS = 1500
# An economy patch turns the weekly intercept on from its date for this many days.
RECAL_DAYS = 31


def file_version(name: str, rel: str, root: Path) -> str:
    """`<model dir>/<kind>/<month>@<first 8 hex of the model file's sha256>`, stored on every credit row."""
    return f"{name}/{rel.removesuffix('.json')}@{hashlib.sha256((root / rel).read_bytes()).hexdigest()[:8]}"


def economy_patches(path: Path = PATCHES) -> list[str]:
    if not path.exists():
        return []
    return sorted(p["date"] for p in json.loads(path.read_text())["patches"] if p.get("type") == "economy")


def recal_on(day: str, patches: list[str]) -> bool:
    d = date.fromisoformat(day)
    return any(date.fromisoformat(p) <= d < date.fromisoformat(p) + timedelta(days=RECAL_DAYS) for p in patches)


def monday(day: str) -> str:
    d = date.fromisoformat(day)
    return (d - timedelta(days=d.weekday())).isoformat()


def design(df: pl.DataFrame, features: list[str], maps: list[str]):
    import pandas as pd

    exprs = [pl.col(c) if c in ("map", "bomb_site") else pl.col(c).cast(pl.Float32) for c in features]
    x = df.select(exprs).to_pandas()
    x["map"] = pd.Categorical(x["map"], categories=maps)
    x["bomb_site"] = pd.Categorical(x["bomb_site"], categories=["none", "A", "B"])
    return x


def shifted(p: np.ndarray, shift: float) -> np.ndarray:
    if not shift:
        return p
    pc = np.clip(p, 1e-6, 1 - 1e-6)
    return 1 / (1 + np.exp(-(np.log(pc / (1 - pc)) + shift)))


class ModelBook:
    def __init__(self, name: str):
        self.name, self.root = name, MODELS / name
        path = self.root / "index.json"
        if not path.exists():
            raise SystemExit(f"{path} is missing; run `cs2wp walk-forward --model {name}` and "
                             f"`cs2wp cross-fit --model {name}` first")
        self.index = json.loads(path.read_text())
        self.patches = economy_patches()
        self._models: dict[str, object] = {}
        self._shifts: dict[str, float] = {}

    def entry(self, month: str) -> dict | None:
        for kind in ("folds", "crossfit"):
            e = self.index.get(kind, {}).get(month)
            if e is not None:
                return e
        return None

    def _model(self, e: dict):
        if e["path"] not in self._models:
            from xgboost import XGBClassifier

            m = XGBClassifier()
            m.load_model(self.root / e["path"])
            self._models[e["path"]] = m
        return self._models[e["path"]]

    def predict(self, e: dict, frame: pl.DataFrame, shift: float = 0.0) -> np.ndarray:
        return shifted(self._model(e).predict_proba(design(frame, e["features"], e["maps"]))[:, 1], shift)

    def shift(self, day: str, refs) -> float:
        """0 outside an economy patch's window. Inside it, the intercept refit on the RECAL_ROUNDS rounds before the
        day's week, each valued out of sample by its own month's model."""
        if not recal_on(day, self.patches):
            return 0.0
        week = monday(day)
        if week not in self._shifts:
            frames, rounds = [], 0
            for ref in sorted((r for r in refs if r.date < week), key=lambda r: (r.date, r.key), reverse=True):
                e, path = self.entry(ref.date[:7]), STATES / ref.slug / "grid.parquet"
                if e is None or not path.exists():
                    continue
                g = with_derived(pl.read_parquet(path))
                if g.is_empty():
                    continue
                frames.append(g.select("key", "round_num", "date", "ct_win").with_columns(pl.Series("p", self.predict(e, g))))
                rounds += g["round_num"].n_unique()
                if rounds >= RECAL_ROUNDS:
                    break
            if not frames:
                self._shifts[week] = 0.0
            else:
                d = pl.concat(frames)
                keep = d.select("key", "round_num", "date").unique().sort("date", "key", "round_num").tail(RECAL_ROUNDS)
                d = d.join(keep, on=["key", "round_num", "date"], how="semi")
                pc = np.clip(d["p"].to_numpy(), 1e-6, 1 - 1e-6)
                self._shifts[week] = ev.intercept_shift(np.log(pc / (1 - pc)), d["ct_win"].cast(pl.Float64).to_numpy())
        return self._shifts[week]
