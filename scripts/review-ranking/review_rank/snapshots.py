"""Check a local export. Queue entries and opens are not review labels."""

import argparse
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .data import timestamp


@dataclass(frozen=True)
class Snapshot:
    workspace: str
    reviewer: str
    snapshot_id: str
    at: float
    filtered: bool
    candidates: tuple[dict, ...]
    visible: frozenset[str]
    opened: frozenset[str]
    header: dict = field(default_factory=dict)


def nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value)


def load_snapshots(path: Path) -> tuple[list[Snapshot], dict]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise ValueError("Expected a version 1 local export")
    if not isinstance(payload.get("events"), list):
        raise ValueError("Expected an events list")
    chunks = defaultdict(list)
    observations = defaultdict(list)
    audit = Counter()
    for event in payload["events"]:
        if not isinstance(event, dict):
            audit["invalid_events"] += 1
            continue
        p = event.get("properties")
        if (
            not isinstance(p, dict)
            or p.get("schema_version") != 1
            or not nonempty(p.get("workspace_id"))
            or not nonempty(p.get("snapshot_id"))
        ):
            audit["invalid_events"] += 1
            continue
        key = (p["workspace_id"], p["snapshot_id"])
        if event.get("event") == "pr_review_queue_snapshot":
            chunks[key].append(p)
        elif event.get("event") in {"pr_review_rows_visible", "pr_review_candidate_opened"}:
            observations[key].append(event)
        else:
            audit["unknown_events"] += 1

    snapshots = []
    for (workspace, snapshot_id), parts in chunks.items():
        try:
            first = parts[0]
            count, size = first["chunk_count"], first["candidate_count"]
            if type(count) is not int or type(size) is not int or count < 1 or size < 0:
                raise ValueError("Invalid counts")
            if count != max(1, (size + 24) // 25):
                raise ValueError("Invalid chunk count")
            header = {k: v for k, v in first.items() if k not in {"chunk_index", "candidates"}}
            at = timestamp(first["recorded_at"])
            if at is None or not nonempty(first["viewer_login"]):
                raise ValueError("Missing identity or timestamp")
            if type(first["filtered"]) is not bool:
                raise ValueError("Missing filter state")
            if first.get("sort_mode") not in {"newest", "oldest", "priority"}:
                raise ValueError("Invalid sort mode")
            ordered = {}
            for part in parts:
                if header != {
                    k: v for k, v in part.items() if k not in {"chunk_index", "candidates"}
                }:
                    raise ValueError("Conflicting headers")
                index = part["chunk_index"]
                if type(index) is not int or not 0 <= index < count:
                    raise ValueError("Invalid chunk index")
                if index in ordered and ordered[index] != part["candidates"]:
                    raise ValueError("Conflicting duplicate chunk")
                ordered[index] = part["candidates"]
                expected = min(25, max(0, size - 25 * index))
                if not isinstance(ordered[index], list) or len(ordered[index]) != expected:
                    raise ValueError("Invalid chunk length")
            if len(ordered) != count:
                raise ValueError("Incomplete snapshot")
            candidates = tuple(row for i in range(count) for row in ordered[i])
            ids = set()
            for rank, candidate in enumerate(candidates, start=1):
                if not isinstance(candidate, dict) or not nonempty(candidate.get("pr_id")):
                    raise ValueError("Missing PR identity")
                if candidate["pr_id"] in ids or candidate.get("displayed_rank") != rank:
                    raise ValueError("Duplicate PR or invalid rank")
                if (
                    not nonempty(candidate.get("repo"))
                    or type(candidate.get("pr_number")) is not int
                    or candidate["pr_number"] < 1
                    or not re.fullmatch(r"[\w.-]+/[\w.-]+", candidate["repo"])
                ):
                    raise ValueError("Missing GitHub identity")
                ids.add(candidate["pr_id"])
            visible, opened = set(), set()
            for observation in observations[(workspace, snapshot_id)]:
                try:
                    p = observation["properties"]
                    observed_at = timestamp(p.get("observed_at"))
                    if observed_at is None or observed_at < at:
                        raise ValueError("Observation precedes snapshot")
                    is_visible = observation["event"] == "pr_review_rows_visible"
                    references = p.get("pr_ids") if is_visible else [p.get("pr_id")]
                    if not isinstance(references, list) or any(
                        not isinstance(value, str) or value not in ids for value in references
                    ):
                        raise ValueError("Observation names an absent candidate")
                    (visible if is_visible else opened).update(references)
                except (KeyError, TypeError, ValueError, AttributeError):
                    audit["invalid_observations"] += 1
            snapshots.append(
                Snapshot(
                    workspace,
                    first["viewer_login"],
                    snapshot_id,
                    at,
                    first["filtered"],
                    candidates,
                    frozenset(visible),
                    frozenset(opened),
                    header,
                )
            )
        except (KeyError, TypeError, ValueError, AttributeError):
            audit["rejected_snapshots"] += 1
    audit["orphan_observation_groups"] = sum(key not in chunks for key in observations)
    audit["complete_snapshots"] = len(snapshots)
    audit["candidate_rows"] = sum(len(snapshot.candidates) for snapshot in snapshots)
    audit["visible_rows"] = sum(len(snapshot.visible) for snapshot in snapshots)
    audit["opened_rows"] = sum(len(snapshot.opened) for snapshot in snapshots)
    audit["filtered_snapshots"] = sum(snapshot.filtered for snapshot in snapshots)
    return sorted(snapshots, key=lambda item: (item.at, item.workspace, item.snapshot_id)), dict(
        audit
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    args = parser.parse_args()
    _, audit = load_snapshots(args.export)
    print(json.dumps({"audit": audit, "review_labels": 0}, indent=2))


if __name__ == "__main__":
    main()
