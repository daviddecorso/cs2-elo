from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
LP_RAW = REPO_ROOT / "data" / "raw"
DEMOS_DATA = REPO_ROOT / "data" / "demos"
RAW_DEMOS = DEMOS_DATA / "raw"
WORK = DEMOS_DATA / "work"
PARQUET = DEMOS_DATA / "parquet"
HLTV_CACHE = DEMOS_DATA / "hltv-cache"
MANIFEST = DEMOS_DATA / "manifest.json"
STEAM_PLAYERS = DEMOS_DATA / "steam-players.json"
UNRESOLVED_PLAYERS = DEMOS_DATA / "unresolved-players.json"
HLTV_PROFILE = Path.home() / ".cache" / "cs2-elo" / "hltv-profile"
