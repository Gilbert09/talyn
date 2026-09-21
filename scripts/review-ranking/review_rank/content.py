"""Capture current PR content locally for use in later snapshots."""

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from .outcomes import GitHub, digest, write_private
from .snapshots import load_snapshots


def capture(api: GitHub, repo: str, number: int, clock) -> dict:
    endpoint = f"repos/{repo}/pulls/{number}"
    before = api.get(endpoint)
    files = [row for page in api.pages(f"{endpoint}/files") for row in page]
    if len(files) >= 3000 or len(files) != before["changed_files"]:
        raise ValueError("The GitHub file list is incomplete")
    after = api.get(endpoint)
    for key in ["head", "base"]:
        if before[key]["sha"] != after[key]["sha"]:
            raise ValueError("The PR revision changed during capture")
    if any(before[key] != after[key] for key in ["title", "body", "updated_at", "changed_files"]):
        raise ValueError("The PR content changed during capture")
    text = "\n".join(
        [before["title"], before.get("body") or ""]
        + [f"{row['filename']}\n{row.get('patch') or ''}" for row in files]
    )
    return {
        "repo": repo.lower(),
        "number": number,
        "head_sha": before["head"]["sha"],
        "base_sha": before["base"]["sha"],
        "observed_at": clock(),
        "text": text,
        "text_sha256": digest(text),
        "files_without_patch": sum(not row.get("patch") for row in files),
        "source": "github_current_observation",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-requests", type=int, default=500)
    args = parser.parse_args()
    snapshots, audit = load_snapshots(args.export)
    if audit.get("rejected_snapshots") or audit.get("invalid_events"):
        raise ValueError("Use a complete export")
    keys = sorted(
        {
            (row["repo"].lower(), row["pr_number"])
            for snapshot in snapshots
            for row in snapshot.candidates
        }
    )
    api = GitHub(args.max_requests)
    records = [
        capture(api, repo, number, lambda: datetime.now(UTC).timestamp()) for repo, number in keys
    ]
    write_private(args.output, {"schema_version": 1, "records": records})
    print(json.dumps({"content_records": len(records), "requests": api.requests}))


if __name__ == "__main__":
    main()
