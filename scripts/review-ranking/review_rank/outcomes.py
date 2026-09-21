"""Collect scoped GitHub reviews and join them to earlier local snapshots."""

import argparse
import hashlib
import json
import os
import re
import subprocess
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from itertools import groupby
from pathlib import Path

from .data import timestamp
from .features import DAY
from .snapshots import Snapshot, load_snapshots


def iso(at: float) -> str:
    return datetime.fromtimestamp(at, UTC).isoformat()


def required_time(value: str) -> float:
    at = timestamp(value)
    if at is None:
        raise ValueError("A timestamp is required")
    return at


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def write_private(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Refuse replacement so that an earlier protocol or result stays available.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(payload, output, indent=2, allow_nan=False)
        output.write("\n")


@dataclass(frozen=True)
class Protocol:
    workspace: str
    reviewer: str
    repos: tuple[str, ...]
    start: float
    end: float
    horizon: int = DAY

    @classmethod
    def parse(cls, payload: dict) -> "Protocol":
        if payload.get("schema_version") != 1:
            raise ValueError("Expected a version 1 protocol")
        repos = payload["repos"]
        if (
            not isinstance(repos, list)
            or not repos
            or any(
                not isinstance(repo, str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo)
                for repo in repos
            )
        ):
            raise ValueError("List the complete repository scope")
        if len({repo.lower() for repo in repos}) != len(repos):
            raise ValueError("Duplicate repository")
        if not payload.get("workspace") or not re.fullmatch(r"[\w-]+", payload.get("reviewer", "")):
            raise ValueError("A workspace and GitHub reviewer are required")
        start, end = required_time(payload["start"]), required_time(payload["end"])
        if start >= end or payload.get("horizon_seconds", DAY) != DAY:
            raise ValueError("Use an ordered window and the fixed 24-hour horizon")
        return cls(
            payload["workspace"],
            payload["reviewer"].lower(),
            tuple(sorted(repo.lower() for repo in repos)),
            start,
            end,
        )


class GitHub:
    """Use the existing gh login. Never print credentials or response bodies."""

    def __init__(self, max_requests: int = 2000):
        self.requests = 0
        self.max_requests = max_requests

    def get(self, endpoint: str) -> object:
        if self.requests >= self.max_requests:
            raise ValueError("Request budget exhausted; no complete journal was written")
        self.requests += 1
        result = subprocess.run(
            [
                "gh",
                "api",
                "--hostname",
                "github.com",
                "--method",
                "GET",
                endpoint,
                "-H",
                "Accept: application/vnd.github+json",
                "-H",
                "X-GitHub-Api-Version: 2022-11-28",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=90,
        )
        if result.returncode:
            raise RuntimeError("GitHub read failed; no complete journal was written")
        return json.loads(result.stdout)

    def pages(self, endpoint: str):
        separator = "&" if "?" in endpoint else "?"
        page = 1
        while True:
            rows = self.get(f"{endpoint}{separator}per_page=100&page={page}")
            if not isinstance(rows, list):
                raise ValueError("Expected a GitHub list")
            yield rows
            if len(rows) < 100:
                return
            page += 1


def collect(protocol: Protocol, api: GitHub, now: float) -> dict:
    if now < protocol.end:
        raise ValueError("The outcome window is still open")
    reviews = {}
    evidence = []
    for repo in protocol.repos:
        pulls = set()
        pages = 0
        previous_created = float("-inf")
        # Creation order avoids moving records when reviews update a PR.
        for rows in api.pages(f"repos/{repo}/pulls?state=all&sort=created&direction=asc"):
            pages += 1
            reached_end = False
            for pull in rows:
                created = required_time(pull["created_at"])
                if created < previous_created:
                    raise ValueError("GitHub PR order changed during collection")
                previous_created = created
                if created >= protocol.end:
                    reached_end = True
                    break
                number = pull["number"]
                if number in pulls:
                    raise ValueError("Duplicate PR during pagination")
                pulls.add(number)
                for batch in api.pages(f"repos/{repo}/pulls/{number}/reviews"):
                    for row in batch:
                        at = timestamp(row.get("submitted_at"))
                        if at is None or not protocol.start <= at < protocol.end:
                            continue
                        login = (row.get("user") or {}).get("login")
                        if not login:
                            raise ValueError("A submitted review has an unknown author")
                        if login.lower() != protocol.reviewer:
                            continue
                        if row.get("state") not in {
                            "APPROVED",
                            "CHANGES_REQUESTED",
                            "COMMENTED",
                            "DISMISSED",
                        }:
                            raise ValueError("Unknown submitted review state")
                        review = {
                            "id": row["node_id"],
                            "repo": repo,
                            "number": number,
                            "reviewer": login.lower(),
                            "at": at,
                            "commit": row.get("commit_id"),
                            "state": row["state"],
                        }
                        if review["id"] in reviews and reviews[review["id"]] != review:
                            raise ValueError("Conflicting review identity")
                        reviews[review["id"]] = review
            if reached_end:
                break
        evidence.append(
            {
                "repo": repo,
                "pull_pages": pages,
                "pulls_scanned": len(pulls),
                "enumeration_complete": True,
            }
        )
    return {
        "schema_version": 1,
        "protocol": asdict(protocol),
        "protocol_sha256": digest(asdict(protocol)),
        "collection_started_at": now,
        "complete": True,
        "evidence": evidence,
        "requests": api.requests,
        "reviews": sorted(reviews.values(), key=lambda row: (row["at"], row["id"])),
        "limits": [
            "Deleted or inaccessible GitHub records cannot be recovered.",
            "Submission time is a proxy for the start of a review.",
            "The REST API does not supply a transactional snapshot.",
        ],
    }


def validate_journal(protocol: Protocol, journal: dict) -> list[dict]:
    if (
        journal.get("schema_version") != 1
        or journal.get("complete") is not True
        or journal.get("protocol_sha256") != digest(asdict(protocol))
        or digest(journal.get("protocol")) != digest(asdict(protocol))
        or journal.get("collection_started_at", 0) < protocol.end
    ):
        raise ValueError("The complete journal must match the frozen protocol")
    evidence = journal.get("evidence", [])
    if sorted(item["repo"] for item in evidence) != list(protocol.repos) or any(
        item.get("enumeration_complete") is not True for item in evidence
    ):
        raise ValueError("The journal does not cover every repository")
    unique = {}
    for row in journal["reviews"]:
        if (
            row["repo"] not in protocol.repos
            or row["reviewer"] != protocol.reviewer
            or not protocol.start <= row["at"] < protocol.end
            or not isinstance(row["id"], str)
            or not row["id"]
            or type(row["number"]) is not int
            or row["number"] < 1
        ):
            raise ValueError("Review outside the protocol")
        if row["id"] in unique and unique[row["id"]] != row:
            raise ValueError("Conflicting review identity")
        unique[row["id"]] = row
    return sorted(unique.values(), key=lambda row: (row["at"], row["id"]))


def join(protocol: Protocol, snapshots: list[Snapshot], journal: dict) -> dict:
    reviews = validate_journal(protocol, journal)
    audit = Counter(submitted_reviews=len(reviews))
    unique = {}
    for snapshot in snapshots:
        if (
            snapshot.workspace != protocol.workspace
            or snapshot.reviewer.lower() != protocol.reviewer
            or not protocol.start <= snapshot.at < protocol.end
        ):
            audit["snapshots_outside_protocol"] += 1
            continue
        if snapshot.snapshot_id in unique and unique[snapshot.snapshot_id] != snapshot:
            raise ValueError("Conflicting snapshot identity across exports")
        unique[snapshot.snapshot_id] = snapshot
    ordered = sorted(unique.values(), key=lambda row: (row.at, row.snapshot_id))
    assigned = defaultdict(list)
    pointer = 0
    for at, group in groupby(reviews, key=lambda row: row["at"]):
        group = list(group)
        while pointer < len(ordered) and ordered[pointer].at < at:
            pointer += 1
        if not pointer or at - ordered[pointer - 1].at > protocol.horizon:
            audit["reviews_without_snapshot"] += len(group)
            continue
        latest = ordered[pointer - 1]
        if pointer > 1 and ordered[pointer - 2].at == latest.at:
            audit["reviews_with_ambiguous_snapshot"] += len(group)
            # Both snapshots must remain censored, including the one not selected.
            for snapshot in ordered[:pointer]:
                if snapshot.at == latest.at:
                    assigned[snapshot.snapshot_id].extend(group)
            continue
        assigned[latest.snapshot_id].extend(group)

    choices, sessions = [], []
    times = Counter(snapshot.at for snapshot in ordered)
    for index, snapshot in enumerate(ordered):
        outcomes = assigned[snapshot.snapshot_id]
        candidates = list(snapshot.candidates)
        keys = [(row["repo"].lower(), row["pr_number"]) for row in candidates]
        eligible = (
            not snapshot.filtered
            and all(repo in protocol.repos for repo, _ in keys)
            and len(set(keys)) == len(keys)
            and times[snapshot.at] == 1
        )
        if not eligible:
            status = "excluded_snapshot"
            audit["reviews_on_excluded_snapshots"] += len(outcomes)
        elif outcomes:
            first_at = outcomes[0]["at"]
            simultaneous = [row for row in outcomes if row["at"] == first_at]
            audit["later_reviews_without_fresh_snapshot"] += len(outcomes) - len(simultaneous)
            if len(simultaneous) != 1:
                status = "ambiguous_reviews"
            else:
                review = simultaneous[0]
                key = (review["repo"], review["number"])
                if key not in keys:
                    status = "coverage_failure"
                elif len(keys) < 2:
                    status = "singleton"
                else:
                    status = "choice"
                    choices.append(
                        {
                            "snapshot_id": snapshot.snapshot_id,
                            "at": snapshot.at,
                            "review_at": review["at"],
                            "review_id": review["id"],
                            "chosen": keys.index(key),
                            "candidates": candidates,
                            "header": snapshot.header,
                            "request_round": "unknown",
                        }
                    )
        else:
            # A newer snapshot censors this opportunity; no duplicate conversion labels.
            next_at = ordered[index + 1].at if index + 1 < len(ordered) else float("inf")
            deadline = snapshot.at + protocol.horizon
            status = "no_review" if deadline <= protocol.end and next_at > deadline else "censored"
        sessions.append({"snapshot_id": snapshot.snapshot_id, "at": snapshot.at, "status": status})
        audit[status] += 1
    return {
        "schema_version": 1,
        "protocol": asdict(protocol),
        "audit": dict(audit),
        "choices": choices,
        "sessions": sessions,
        "journal_sha256": digest(journal),
        "promotion_allowed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    collector = sub.add_parser("collect")
    collector.add_argument("--max-requests", type=int, default=2000)
    joiner = sub.add_parser("join")
    joiner.add_argument("--journal", type=Path, required=True)
    joiner.add_argument("--exports", type=Path, nargs="+", required=True)
    for command in [collector, joiner]:
        command.add_argument("--protocol", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    protocol = Protocol.parse(json.loads(args.protocol.read_text()))
    if args.command == "collect":
        result = collect(protocol, GitHub(args.max_requests), datetime.now(UTC).timestamp())
    else:
        snapshots, import_audit = [], Counter()
        for path in args.exports:
            rows, counts = load_snapshots(path)
            snapshots.extend(rows)
            import_audit.update(counts)
        if import_audit["rejected_snapshots"] or import_audit["invalid_events"]:
            raise ValueError("Repair incomplete exports before joining outcomes")
        result = join(protocol, snapshots, json.loads(args.journal.read_text()))
        result["import_audit"] = dict(import_audit)
        result["export_sha256"] = [
            hashlib.sha256(path.read_bytes()).hexdigest() for path in args.exports
        ]
    write_private(args.output, result)
    counts = {"reviews": len(result["reviews"])} if "reviews" in result else result["audit"]
    print(json.dumps(counts, sort_keys=True))


if __name__ == "__main__":
    main()
