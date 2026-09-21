import copy
import json

import pytest

from review_rank.snapshots import load_snapshots


def events(count=26):
    chunks = []
    for chunk in range(max(1, (count + 24) // 25)):
        chunks.append(
            {
                "event": "pr_review_queue_snapshot",
                "properties": {
                    "schema_version": 1,
                    "workspace_id": "workspace",
                    "snapshot_id": "snapshot",
                    "viewer_login": "reviewer",
                    "recorded_at": "2026-09-21T12:00:00Z",
                    "sort_mode": "newest",
                    "filtered": False,
                    "candidate_count": count,
                    "chunk_count": max(1, (count + 24) // 25),
                    "chunk_index": chunk,
                    "candidates": [
                        {
                            "pr_id": str(i),
                            "repo": "org/repo",
                            "pr_number": i + 1,
                            "displayed_rank": i + 1,
                        }
                        for i in range(chunk * 25, min(count, (chunk + 1) * 25))
                    ],
                },
            }
        )
    return chunks


def read(tmp_path, entries):
    path = tmp_path / "export.json"
    path.write_text(json.dumps({"schema_version": 1, "events": entries}))
    return load_snapshots(path)


@pytest.mark.parametrize("count", [0, 1, 25, 26, 103])
def test_complete_unordered_chunks_and_duplicate_exports(tmp_path, count):
    entries = events(count)
    snapshots, audit = read(tmp_path, list(reversed(entries)) + entries)
    assert len(snapshots) == 1
    assert len(snapshots[0].candidates) == count
    assert audit["complete_snapshots"] == 1
    assert audit["visible_rows"] == 0
    assert audit["opened_rows"] == 0


@pytest.mark.parametrize("fault", ["missing", "conflict", "identity", "rank", "timezone", "count"])
def test_rejects_incomplete_or_conflicting_snapshots(tmp_path, fault):
    entries = events()
    if fault == "missing":
        entries.pop()
    elif fault == "conflict":
        entries.append(copy.deepcopy(entries[0]))
        entries[-1]["properties"]["candidates"][0]["pr_number"] = 999
    elif fault == "identity":
        entries[1]["properties"]["viewer_login"] = "someone-else"
    elif fault == "rank":
        entries[0]["properties"]["candidates"][0]["displayed_rank"] = 2
    elif fault == "timezone":
        for entry in entries:
            entry["properties"]["recorded_at"] = "2026-09-21T12:00:00"
    elif fault == "count":
        entries[0]["properties"]["chunk_count"] = 1.5
    snapshots, audit = read(tmp_path, entries)
    assert snapshots == []
    assert audit["rejected_snapshots"] == 1


def test_exposure_needs_valid_time_and_membership(tmp_path):
    entries = events(1)
    for ids, at in [(["0"], "12:01:00"), (["missing"], "12:02:00"), (["0"], "11:59:00")]:
        entries.append(
            {
                "event": "pr_review_rows_visible",
                "properties": {
                    "schema_version": 1,
                    "workspace_id": "workspace",
                    "snapshot_id": "snapshot",
                    "observed_at": f"2026-09-21T{at}Z",
                    "pr_ids": ids,
                },
            }
        )
    snapshots, audit = read(tmp_path, entries)
    assert snapshots[0].visible == {"0"}
    assert not snapshots[0].opened
    assert audit["invalid_observations"] == 2


def test_workspaces_do_not_share_chunk_identity(tmp_path):
    first = events(1)
    second = events(1)
    second[0]["properties"]["workspace_id"] = "other"
    snapshots, _ = read(tmp_path, first + second)
    assert len(snapshots) == 2


def test_archive_loss_counts_remain_visible_in_import_audit(tmp_path):
    path = tmp_path / "export.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "events": events(1),
                "archive_available": False,
                "archive": {"expired": 12, "size_evicted": 3, "failed_writes": 1},
            }
        )
    )
    snapshots, audit = load_snapshots(path)
    assert len(snapshots) == 1
    assert audit["archive_expired"] == 12
    assert audit["archive_size_evicted"] == 3
    assert audit["archive_failed_writes"] == 1
    assert audit["archive_unavailable"] == 1
