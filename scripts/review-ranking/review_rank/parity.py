"""Replay recorded production inputs through the actual shared TypeScript scorer."""

import argparse
import json
import subprocess
from pathlib import Path

from .outcomes import digest, write_private
from .snapshots import load_snapshots


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
    result = json.loads(process.stdout)
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
