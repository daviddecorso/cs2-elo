"""cs2wp: game states, the win-probability model, WPA credit and the paper's validation tests."""

import argparse
import sys

from . import data

TEST_FROM = "2026-01-01"
# Walk-forward folds plus 2025 cross-fit models; what credit and publish read.
PRODUCTION = "production"


def cmd_sync(args) -> int:
    got, have = data.sync(force=args.force)
    print(f"{got} tables downloaded, {have} already present")
    return 0


def cmd_states(args) -> int:
    from .pipeline import build_states

    return build_states(args.map, force=args.force, workers=args.workers)


def cmd_train(args) -> int:
    from .pipeline import train

    return train(args.test_from, args.model, args.ablations, device=args.device)


def cmd_walk_forward(args) -> int:
    from .walkforward import walk_forward

    return walk_forward(args.test_from, args.model, args.variant, device=args.device)


def cmd_cross_fit(args) -> int:
    from .walkforward import cross_fit

    return cross_fit(args.model, device=args.device)


def cmd_monthly(args) -> int:
    from .walkforward import monthly

    return monthly(args.model, args.today, args.force, device=args.device)


def cmd_patch_candidates(args) -> int:
    from .patches import candidates

    return candidates(args.since)


def cmd_patch_report(args) -> int:
    from .patches import postplant_report

    return postplant_report(args.model, args.candidates)


def cmd_credit(args) -> int:
    from .pipeline import credit

    return credit(args.model, args.recredit)


def cmd_validate(args) -> int:
    from .pipeline import validate

    return validate(args.test_from)


def cmd_publish(args) -> int:
    from .publish import publish

    return publish(args.model, args.upload)


def cmd_positions(args) -> int:
    from .positions import UnmappedCallouts, build, callout_report

    if args.callouts:
        return callout_report(args.map)
    try:
        return build(args.map)
    except UnmappedCallouts as e:
        print(e, file=sys.stderr)
        return 1


def cmd_roles(args) -> int:
    from .roles import build

    return build(args.map)


def cmd_validate_roles(args) -> int:
    from .rolecheck import build

    return build()


def cmd_baselines(args) -> int:
    from .baselines import build

    return build()


def cmd_duels(args) -> int:
    from .duels import build

    return build(args.ablations)


def cmd_igls(args) -> int:
    from .igls import AmbiguousIGL, UnmappedTeams, build

    try:
        return build()
    except (UnmappedTeams, AmbiguousIGL) as e:
        print(e, file=sys.stderr)
        return 1


def cmd_war(args) -> int:
    from .igls import AmbiguousIGL, UnmappedTeams
    from .war import build

    try:
        return build(
            window_from=args.window_from,
            min_rounds=args.min_rounds,
            resamples=args.resamples,
            replacement_rate=args.replacement_rate,
            model=args.model,
            publish=args.publish,
            allow_ungated=args.allow_ungated,
        )
    except (UnmappedTeams, AmbiguousIGL) as e:
        print(e, file=sys.stderr)
        return 1


def cmd_validate_war(args) -> int:
    from .warcheck import build

    return build(test_from=args.test_from, min_rounds=args.min_rounds)


def main() -> None:
    ap = argparse.ArgumentParser(prog="cs2wp")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("sync", help="Mirror every map parsed at the current parser version from R2")
    p.add_argument("--force", action="store_true", help="Download tables already present")
    p = sub.add_parser("states", help="Build the 4 Hz grid and per-event states for every mirrored map")
    p.add_argument("--map", help="Only this manifest key, e.g. 2399384/m1")
    p.add_argument("--force", action="store_true", help="Rebuild maps whose inputs haven't changed")
    p.add_argument("--workers", type=int, help="Worker processes (default: min(cores, 6), or 1 with --map)")
    p = sub.add_parser("train", help="Fit on maps before --test-from, score the rest, and run the gate")
    p.add_argument("--test-from", default=TEST_FROM)
    p.add_argument("--model", default="latest", help="Directory name under data/wp/models/")
    p.add_argument("--ablations", action="store_true", help="Also fit the feature ablations")
    p.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto", help="XGBoost device")
    p = sub.add_parser("walk-forward", help="Retrain monthly on everything before each test month, gate the pooled "
                       "predictions, and save each month's fold for credit")
    p.add_argument("--test-from", default=TEST_FROM)
    p.add_argument("--model", default=PRODUCTION, help="Directory name under data/wp/models/")
    p.add_argument("--variant", default="full_plant_clock_bomb_dist", help="Feature set from walkforward.VARIANTS")
    p.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto", help="XGBoost device")
    p = sub.add_parser("cross-fit", help="One model per month before --test-from, trained on every other month")
    p.add_argument("--model", default=PRODUCTION)
    p.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto", help="XGBoost device")
    p = sub.add_parser("monthly", help="Train the live fold for this month, gate last month, flag a failure")
    p.add_argument("--model", default=PRODUCTION)
    p.add_argument("--today", help="YYYY-MM-DD; defaults to today")
    p.add_argument("--force", action="store_true", help="Retrain folds that already exist")
    p.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto", help="XGBoost device")
    p = sub.add_parser("patch-candidates", help="Classify CS2 Steam announcements into wp/patches.candidates.json")
    p.add_argument("--since", default="2025-01-01")
    p = sub.add_parser("patch-report", help="Post-plant calibration 30 days before and after each mechanics patch")
    p.add_argument("--model", default=PRODUCTION)
    p.add_argument("--candidates", action="store_true", help="Use every mechanics candidate, not just approved patches")
    p = sub.add_parser("credit", help="WPA and the two context-neutral versions for every event, each map valued by "
                       "its own month's out-of-sample model")
    p.add_argument("--model", default=PRODUCTION)
    p.add_argument("--recredit", action="store_true", help="Re-credit frozen maps and refit the neutral tables")
    p = sub.add_parser("validate", help="Month-to-month stability and correlation with K/D, as in the paper")
    p.add_argument("--test-from", default=TEST_FROM)
    p = sub.add_parser("publish", help="Write player WPA to Parquet and public/data/wpa/players.json")
    p.add_argument("--model", default=PRODUCTION)
    p.add_argument("--upload", action="store_true", help="Also upload the Parquet to R2 under wp/<model>/")
    p = sub.add_parser("positions", help="Each player's CT position per map, from callouts 15-25 s into CT rounds")
    p.add_argument("--map", help="Only this manifest key, e.g. 2399384/m1")
    p.add_argument("--callouts", action="store_true", help="Write the callout report used to label the position table")
    p = sub.add_parser("roles", help="Each player's T role per map: entry share from opening duels, AWP share")
    p.add_argument("--map", help="Only this manifest key, e.g. 2399384/m1")
    sub.add_parser("validate-roles", help="Compare pooled T roles and CT positions with NER0cs's 2024 role labels")
    sub.add_parser("baselines", help="Average credit per round for each map, side and role, partially pooled")
    p = sub.add_parser("duels", help="Expected duel wins from weapons, peeker vs holder, flashes, HP and distance")
    p.add_argument("--ablations", action="store_true", help="Also cross-fit the model without each input group")
    sub.add_parser("igls", help="Tag per-map IGLs from data/war/igls.json and cross-check local Liquipedia data")
    p = sub.add_parser("war", help="Player WAA/WAR with zero-sum IGL adjustment and round-bootstrap intervals")
    p.add_argument("--from", dest="window_from", help="Only maps on or after YYYY-MM-DD")
    p.add_argument("--min-rounds", type=int, default=300)
    p.add_argument("--resamples", type=int, default=1000)
    p.add_argument("--replacement-rate", type=float, default=0.0, help="Replacement round-WPA/round vs Tier-1 mean")
    p.add_argument("--model", help="Model directory under data/wp/models/ for gate checks when publishing")
    p.add_argument("--publish", action="store_true", help="Write public/data/war/players.json")
    p.add_argument("--allow-ungated", action="store_true", help="Allow publishing provisional JSON before Phase 5 gate")
    p = sub.add_parser("validate-war", help="WAR split-half reliability, and whether prior lineup WAR adds to Elo")
    p.add_argument("--test-from", default="2026-03-01", help="Score maps on or after YYYY-MM-DD")
    p.add_argument("--min-rounds", type=int, default=300)

    args = ap.parse_args()
    handlers = {"sync": cmd_sync, "states": cmd_states, "train": cmd_train, "credit": cmd_credit,
                "walk-forward": cmd_walk_forward, "cross-fit": cmd_cross_fit, "monthly": cmd_monthly,
                "patch-candidates": cmd_patch_candidates, "patch-report": cmd_patch_report,
                "validate": cmd_validate, "publish": cmd_publish, "positions": cmd_positions, "roles": cmd_roles,
                "validate-roles": cmd_validate_roles, "baselines": cmd_baselines, "duels": cmd_duels,
                "igls": cmd_igls, "war": cmd_war, "validate-war": cmd_validate_war}
    sys.exit(handlers[args.cmd](args))


if __name__ == "__main__":
    main()
