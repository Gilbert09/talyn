"""Replay recorded production inputs through the actual shared TypeScript scorer."""

import argparse
import json
import subprocess
from pathlib import Path

from .outcomes import digest, write_private
from .snapshots import load_snapshots


def replay(payload: list[dict]) -> dict:
    script = Path(__file__).resolve().parents[1] / "production-parity.mjs"
    process = subprocess.run(
        ["node", str(script)],
        input=json.dumps(payload, allow_nan=False),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if process.returncode:
        raise ValueError("Production replay failed; build @talyn/shared and check the Node runtime")
    return json.loads(process.stdout)


def production_baselines(choices: list[dict]) -> tuple[dict[str, list[str]], dict]:
    """Require actual production orders for every selected development choice."""
    if not choices:
        raise ValueError("A production baseline needs choices")
    payload, expected = [], {}
    for row in choices:
        identity = row["review_id"]
        keys = [candidate["pr_id"] for candidate in row["candidates"]]
        mode = row["header"].get("sort_mode")
        if (
            not isinstance(identity, str)
            or not identity
            or identity in expected
            or any(not isinstance(key, str) or not key for key in keys)
            or len(set(keys)) != len(keys)
            or not keys
        ):
            raise ValueError("Duplicate or empty production baseline identity")
        if mode not in {"newest", "oldest", "priority"}:
            raise ValueError("A production baseline needs the recorded display mode")
        expected[identity] = keys
        payload.append(
            {
                "snapshot_id": identity,
                "at": row["at"],
                "sort_mode": mode,
                "candidates": row["candidates"],
            }
        )
    result = replay(payload)
    if result.get("all_passed") is not True:
        raise ValueError("Every selected choice must pass production score replay")
    orders = {}
    for row in result["snapshots"]:
        identity, order = row["snapshot_id"], row.get("priority_order")
        if (
            row.get("passed") is not True
            or identity not in expected
            or identity in orders
            or not isinstance(order, list)
            or len(order) != len(expected[identity])
            or any(not isinstance(key, str) for key in order)
            or set(order) != set(expected[identity])
        ):
            raise ValueError("Production replay returned an incomplete or invalid order")
        orders[identity] = order
    if orders.keys() != expected.keys():
        raise ValueError("Production replay omitted selected choices")
    evidence = {
        "choices": len(orders),
        "payload_sha256": digest(payload),
        "scorer_version": result["scorer_version"],
        "bridge_sha256": result["bridge_sha256"],
        "runtime_sha256": result["runtime_sha256"],
        "orders_sha256": digest(orders),
        "all_passed": True,
    }
    return orders, evidence


def check(path: Path) -> dict:
    snapshots, audit = load_snapshots(path)
    if audit.get("invalid_events") or audit.get("rejected_snapshots"):
        raise ValueError("Use a complete export before checking production parity")
    payload = [
        {
            "snapshot_id": row.snapshot_id,
            "at": row.at,
            "sort_mode": row.header["sort_mode"],
            "candidates": row.candidates,
        }
        for row in snapshots
    ]
    result = replay(payload)
    return {
        "schema_version": 1,
        "export_sha256": digest(json.loads(path.read_text())),
        "audit": audit,
        **result,
        "promotion_allowed": False,
        "limits": [
            "This check proves score replay and observed Priority order, not model quality.",
            "It cannot establish candidate completeness or repair missing request rounds.",
            "Other sort modes check scores only; they do not display Priority order.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = check(args.export)
    write_private(args.output, result)
    print(json.dumps({"all_passed": result["all_passed"], "counts": result["counts"]}))
    if not result["all_passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
