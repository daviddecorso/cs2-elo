from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA = REPO_ROOT / "data"
# Local copy of the R2 tables, one directory per map prefix.
MIRROR = DATA / "demos" / "mirror"
WP = DATA / "wp"
ELO_MAPS = WP / "elo-maps.jsonl"
STATES = WP / "states"
MODELS = WP / "models"
CREDITS = WP / "credits"
REPORTS = WP / "reports"
PUBLIC_WPA = REPO_ROOT / "public" / "data" / "wpa"
