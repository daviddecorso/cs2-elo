"""Parquet output, R2 upload and the per-map manifest."""

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

import polars as pl

from .paths import MANIFEST, REPO_ROOT

MANIFEST_KEY = "manifest.json"


def map_key(hltv_id: int, map_number: int) -> str:
    return f"{hltv_id}/m{map_number}"


def object_prefix(parser_version: str, lp_pagename: str, hltv_id: int, map_number: int, demo_map: str) -> str:
    return f"v{parser_version}/{lp_pagename}/{hltv_id}/m{map_number}-{demo_map.removeprefix('de_')}"


def write_tables(tables: dict[str, pl.DataFrame], out_dir: Path) -> list[Path]:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    paths = []
    for name, df in tables.items():
        path = out_dir / f"{name}.parquet"
        df.write_parquet(path, compression="zstd")
        paths.append(path)
    return paths


class R2:
    def __init__(self) -> None:
        import boto3
        from dotenv import load_dotenv

        load_dotenv(REPO_ROOT / ".env")
        missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET") if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"Missing {', '.join(missing)} in .env (or pass --no-upload)")
        self.bucket = os.environ["R2_BUCKET"]
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
        )

    def upload_dir(self, local: Path, prefix: str) -> list[str]:
        keys = []
        for path in sorted(local.glob("*.parquet")):
            key = f"{prefix}/{path.name}"
            self.client.upload_file(str(path), self.bucket, key)
            keys.append(key)
        return keys

    def list_keys(self, prefix: str) -> list[str]:
        keys: list[str] = []
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            keys += [o["Key"] for o in page.get("Contents", [])]
        return keys

    def get_json(self, key: str) -> dict | None:
        try:
            return json.loads(self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read())
        except self.client.exceptions.NoSuchKey:
            return None

    def put_json(self, key: str, data: dict) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=json.dumps(data, indent=2).encode(), ContentType="application/json")


class Manifest:
    """Per-map status. R2's copy is the source of truth; the local file mirrors it."""

    def __init__(self, r2: R2 | None, path: Path = MANIFEST) -> None:
        self.r2, self.path = r2, path
        remote = r2.get_json(MANIFEST_KEY) if r2 else None
        local = json.loads(path.read_text()) if path.exists() else {}
        self.maps: dict[str, dict] = (remote or local).get("maps", {})

    def get(self, key: str) -> dict | None:
        return self.maps.get(key)

    def record(self, key: str, **entry) -> None:
        self.maps[key] = {**entry, "updated": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        self.save()

    def save(self) -> None:
        data = {"maps": dict(sorted(self.maps.items()))}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, indent=2) + "\n")
        if self.r2:
            self.r2.put_json(MANIFEST_KEY, data)
