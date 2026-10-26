"""cs2wp: game states, the win-probability model, WPA credit and the paper's validation tests."""

import argparse
import sys

from . import data

TEST_FROM = "2026-01-01"


def cmd_sync(args) -> int:
    got, have = data.sync(force=args.force)
    print(f"{got} tables downloaded, {have} already present")
    return 0


def cmd_states(args) -> int:
    from .pipeline import build_states

    return build_states(args.map)


def cmd_train(args) -> int:
    from .pipeline import train

    return train(args.test_from, args.model, args.ablations)


def cmd_credit(args) -> int:
    from .pipeline import credit

    return credit(args.model)


def cmd_validate(args) -> int:
    from .pipeline import validate

    return validate(args.test_from)


def cmd_publish(args) -> int:
    from .publish import publish

    return publish(args.model, args.upload)


def main() -> None:
    ap = argparse.ArgumentParser(prog="cs2wp")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("sync", help="Mirror every map parsed at the current parser version from R2")
    p.add_argument("--force", action="store_true", help="Download tables already present")
    p = sub.add_parser("states", help="Build the 4 Hz grid and per-event states for every mirrored map")
    p.add_argument("--map", help="Only this manifest key, e.g. 2399384/m1")
    p = sub.add_parser("train", help="Fit on maps before --test-from, score the rest, and run the gate")
    p.add_argument("--test-from", default=TEST_FROM)
    p.add_argument("--model", default="latest", help="Directory name under data/wp/models/")
    p.add_argument("--ablations", action="store_true", help="Also fit the feature ablations")
    p = sub.add_parser("credit", help="WPA and the two context-neutral versions for every event")
    p.add_argument("--model", default="latest")
    p = sub.add_parser("validate", help="Month-to-month stability and correlation with K/D, as in the paper")
    p.add_argument("--test-from", default=TEST_FROM)
    p = sub.add_parser("publish", help="Write player WPA to Parquet and public/data/wpa/players.json")
    p.add_argument("--model", default="latest")
    p.add_argument("--upload", action="store_true", help="Also upload the Parquet to R2 under wp/<model>/")

    args = ap.parse_args()
    handlers = {"sync": cmd_sync, "states": cmd_states, "train": cmd_train, "credit": cmd_credit,
                "validate": cmd_validate, "publish": cmd_publish}
    sys.exit(handlers[args.cmd](args))


if __name__ == "__main__":
    main()
