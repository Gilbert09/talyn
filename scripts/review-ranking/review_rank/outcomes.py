"""Collect scoped GitHub reviews and join them to earlier local snapshots."""

import argparse
import hashlib
import json
import math
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
    decision_time: str = "created"

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
        decision_time = payload.get("decision_time", "created")
        if decision_time not in {"created", "submitted"}:
            raise ValueError("Unknown review timing policy")
        return cls(
            payload["workspace"],
            payload["reviewer"].lower(),
            tuple(sorted(repo.lower() for repo in repos)),
            start,
            end,
            decision_time=decision_time,
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

    def query(self, query: str, variables: dict) -> dict:
        if self.requests >= self.max_requests:
            raise ValueError("Request budget exhausted; no complete journal was written")
        self.requests += 1
        result = subprocess.run(
            ["gh", "api", "--hostname", "github.com", "graphql", "--input", "-"],
            input=json.dumps({"query": query, "variables": variables}),
            capture_output=True,
            text=True,
            check=False,
            timeout=90,
        )
        if result.returncode:
            raise RuntimeError("GitHub GraphQL read failed")
        response = json.loads(result.stdout)
        if response.get("errors") or not response.get("data"):
            raise ValueError("GitHub returned incomplete GraphQL data")
        return response["data"]


def enrich_review_timing(api: GitHub, reviews: dict[str, dict]) -> None:
    query = """query($ids:[ID!]!) { nodes(ids:$ids) { ... on PullRequestReview {
      id createdAt submittedAt author { login }
      pullRequest { number repository { nameWithOwner } }
    } } }"""
    ids = sorted(reviews)
    for offset in range(0, len(ids), 100):
        batch = ids[offset : offset + 100]
        nodes = api.query(query, {"ids": batch}).get("nodes")
        if (
            not isinstance(nodes, list)
            or any(not node or not node.get("id") for node in nodes)
            or len(nodes) != len(batch)
            or {node["id"] for node in nodes} != set(batch)
        ):
            raise ValueError("Review timing does not cover the complete journal")
        for node in nodes:
            row = reviews[node["id"]]
            pull = node["pullRequest"]
            created = required_time(node["createdAt"])
            if (
                timestamp(node["submittedAt"]) != row["at"]
                or (row["at"] is not None and created > row["at"])
                or (node.get("author") or {}).get("login", "").lower() != row["reviewer"]
                or pull["repository"]["nameWithOwner"].lower() != row["repo"]
                or pull["number"] != row["number"]
            ):
                raise ValueError("Review identity or timing changed during collection")
            row["created_at"] = created


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
                        if at is not None and at < protocol.start:
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
                            "PENDING",
                        }:
                            raise ValueError("Unknown submitted review state")
                        if (at is None) != (row["state"] == "PENDING"):
                            raise ValueError("Review state does not match its submission time")
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
    enrich_review_timing(api, reviews)
    return outcome_journal(protocol, reviews, evidence, now, api.requests, "rest")


def outcome_journal(
    protocol: Protocol, reviews: dict, evidence: list, now: float, requests: int, transport: str
) -> dict:
    completed = [
        row for row in reviews.values() if row["at"] is not None and row["at"] < protocol.end
    ]
    censored = [
        row
        for row in reviews.values()
        if row["created_at"] < protocol.end and (row["at"] is None or row["at"] >= protocol.end)
    ]
    return {
        "schema_version": 1,
        "review_timing": "github_created_at",
        "transport": transport,
        "protocol": asdict(protocol),
        "protocol_sha256": digest(asdict(protocol)),
        "collection_started_at": now,
        "complete": True,
        "evidence": evidence,
        "requests": requests,
        "reviews": sorted(completed, key=lambda row: (row["at"], row["id"])),
        "censored_reviews": sorted(censored, key=lambda row: (row["created_at"], row["id"])),
        "limits": [
            "Deleted or inaccessible GitHub records cannot be recovered.",
            "Review creation time is a proxy, not an observed human decision time.",
            "Pending reviews are limited to what the authenticated account can read.",
            "The GitHub API does not supply a transactional snapshot.",
        ],
    }


REVIEW_PAGE = """totalCount pageInfo { hasNextPage endCursor }
nodes { id createdAt submittedAt state author { login } commit { oid }
  pullRequest { number repository { nameWithOwner } } }"""
PULL_QUERY = f"""query($owner:String!, $name:String!, $reviewer:String!, $cursor:String) {{
  repository(owner:$owner,name:$name) {{ nameWithOwner
    pullRequests(first:50,after:$cursor,orderBy:{{field:CREATED_AT,direction:ASC}}) {{
      totalCount pageInfo {{ hasNextPage endCursor }}
      nodes {{ id number createdAt
        reviews(first:100,author:$reviewer) {{ {REVIEW_PAGE} }} }}
    }}
  }}
}}"""
REVIEW_QUERY = f"""query($id:ID!, $reviewer:String!, $cursor:String!) {{
  node(id:$id) {{ ... on PullRequest {{ id number repository {{ nameWithOwner }}
    reviews(first:100,after:$cursor,author:$reviewer) {{ {REVIEW_PAGE} }}
  }} }}
}}"""


def connection_page(connection: dict, seen_cursors: set) -> tuple[list, int, str | None]:
    rows, count, page = connection["nodes"], connection["totalCount"], connection["pageInfo"]
    if (
        not isinstance(rows, list)
        or any(not isinstance(row, dict) for row in rows)
        or type(count) is not int
        or count < len(rows)
        or type(page["hasNextPage"]) is not bool
    ):
        raise ValueError("Invalid GraphQL connection")
    cursor = page["endCursor"] if page["hasNextPage"] else None
    if page["hasNextPage"] and (
        not rows or not isinstance(cursor, str) or not cursor or cursor in seen_cursors
    ):
        raise ValueError("GraphQL pagination did not advance")
    if cursor:
        seen_cursors.add(cursor)
    return rows, count, cursor


def collect_graphql(protocol: Protocol, api: GitHub, now: float) -> dict:
    """Read every scoped PR, with reviews filtered only by the protocol reviewer."""
    if now < protocol.end:
        raise ValueError("The outcome window is still open")
    reviews, evidence = {}, []
    all_review_ids = set()
    for repo in protocol.repos:
        owner, name = repo.split("/")
        cursor, seen_cursors, seen_ids, seen_numbers = None, set(), set(), set()
        previous_created, pages = float("-inf"), 0
        while True:
            response = api.query(
                PULL_QUERY,
                {"owner": owner, "name": name, "reviewer": protocol.reviewer, "cursor": cursor},
            )["repository"]
            if not response or response["nameWithOwner"].lower() != repo:
                raise ValueError("GitHub repository identity does not match the protocol")
            pulls, count, cursor = connection_page(response["pullRequests"], seen_cursors)
            pages += 1
            reached_end = False
            for pull in pulls:
                created = required_time(pull["createdAt"])
                if created < previous_created:
                    raise ValueError("GitHub PR order changed during collection")
                previous_created = created
                if created >= protocol.end:
                    reached_end = True
                    break
                number = pull["number"]
                if (
                    not isinstance(pull["id"], str)
                    or not pull["id"]
                    or type(number) is not int
                    or number < 1
                    or pull["id"] in seen_ids
                    or number in seen_numbers
                ):
                    raise ValueError("Duplicate or invalid PR identity")
                seen_ids.add(pull["id"])
                seen_numbers.add(number)
                review_connection, review_cursors = pull["reviews"], set()
                review_count, expected = 0, None
                while True:
                    rows, total, review_cursor = connection_page(review_connection, review_cursors)
                    if expected is not None and total != expected:
                        raise ValueError("Review count changed during pagination")
                    expected = total
                    for row in rows:
                        identity = row["id"]
                        at, created_at = (
                            timestamp(row["submittedAt"]),
                            required_time(row["createdAt"]),
                        )
                        parent = row["pullRequest"]
                        if (
                            not isinstance(identity, str)
                            or not identity
                            or identity in all_review_ids
                            or (row.get("author") or {}).get("login", "").lower()
                            != protocol.reviewer
                            or parent["number"] != number
                            or parent["repository"]["nameWithOwner"].lower() != repo
                            or (at is not None and created_at > at)
                            or (row["submittedAt"] is not None and at is None)
                            or row["state"]
                            not in {
                                "PENDING",
                                "APPROVED",
                                "CHANGES_REQUESTED",
                                "COMMENTED",
                                "DISMISSED",
                            }
                            or (at is None) != (row["state"] == "PENDING")
                        ):
                            raise ValueError("Invalid or duplicate scoped review")
                        all_review_ids.add(identity)
                        review_count += 1
                        if at is not None and at < protocol.start:
                            continue
                        reviews[identity] = {
                            "id": identity,
                            "repo": repo,
                            "number": number,
                            "reviewer": protocol.reviewer,
                            "at": at,
                            "created_at": created_at,
                            "commit": (row.get("commit") or {}).get("oid"),
                            "state": row["state"],
                        }
                    if review_count > total or (review_cursor is None and review_count != total):
                        raise ValueError("Incomplete review connection")
                    if review_cursor is None:
                        break
                    more = api.query(
                        REVIEW_QUERY,
                        {
                            "id": pull["id"],
                            "reviewer": protocol.reviewer,
                            "cursor": review_cursor,
                        },
                    )["node"]
                    if (
                        not more
                        or more["id"] != pull["id"]
                        or more["number"] != number
                        or more["repository"]["nameWithOwner"].lower() != repo
                    ):
                        raise ValueError("Review pagination changed PR identity")
                    review_connection = more["reviews"]
            if reached_end:
                break
            if len(seen_ids) > count or (cursor is None and len(seen_ids) != count):
                raise ValueError("Incomplete PR connection")
            if cursor is None:
                break
        evidence.append(
            {
                "repo": repo,
                "pull_pages": pages,
                "pulls_scanned": len(seen_ids),
                "enumeration_complete": True,
            }
        )
    return outcome_journal(protocol, reviews, evidence, now, api.requests, "graphql")


def validate_journal(protocol: Protocol, journal: dict) -> list[dict]:
    if (
        journal.get("schema_version") != 1
        or journal.get("review_timing") != "github_created_at"
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
    if not isinstance(journal.get("censored_reviews"), list):
        raise ValueError("The journal must record visible unfinished reviews")
    for completed, row in [
        *[(True, row) for row in journal["reviews"]],
        *[(False, row) for row in journal["censored_reviews"]],
    ]:
        valid_submission = type(row.get("at")) in {int, float} and math.isfinite(row["at"])
        if (
            row["repo"] not in protocol.repos
            or row["reviewer"] != protocol.reviewer
            or not isinstance(row["id"], str)
            or not row["id"]
            or type(row["number"]) is not int
            or row["number"] < 1
            or type(row.get("created_at")) not in {int, float}
            or not math.isfinite(row["created_at"])
            or (row["at"] is not None and (not valid_submission or row["created_at"] > row["at"]))
            or (
                completed
                and (not valid_submission or not protocol.start <= row["at"] < protocol.end)
            )
            or (
                not completed
                and (
                    row["created_at"] >= protocol.end
                    or (row["at"] is not None and row["at"] < protocol.end)
                )
            )
        ):
            raise ValueError("Review outside the protocol")
        if row["id"] in unique and unique[row["id"]] != row:
            raise ValueError("Conflicting review identity")
        unique[row["id"]] = row
    return sorted(
        (row for row in unique.values() if row["at"] is not None and row["at"] < protocol.end),
        key=lambda row: (row["at"], row["id"]),
    )


def join(
    protocol: Protocol,
    snapshots: list[Snapshot],
    journal: dict,
    excluded_snapshot_ids: frozenset[str] = frozenset(),
) -> dict:
    reviews = validate_journal(protocol, journal)
    audit = Counter(
        submitted_reviews=len(reviews), censored_reviews=len(journal["censored_reviews"])
    )
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
    time_field = "created_at" if protocol.decision_time == "created" else "at"
    decisions = [
        *[{**row, "decision_at": row[time_field], "outcome_complete": True} for row in reviews],
        *[
            {**row, "decision_at": row["created_at"], "outcome_complete": False}
            for row in journal["censored_reviews"]
        ],
    ]
    decisions.sort(key=lambda row: (row["decision_at"], row["id"]))
    for at, group in groupby(decisions, key=lambda row: row["decision_at"]):
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
        scope = snapshot.header.get("repository_scope")
        scope_matches = (
            isinstance(scope, list)
            and all(isinstance(repo, str) for repo in scope)
            and tuple(sorted(repo.lower() for repo in scope)) == protocol.repos
        )
        if not scope_matches:
            audit["snapshots_with_unknown_or_mismatched_scope"] += 1
        if snapshot.snapshot_id in excluded_snapshot_ids:
            audit["explicitly_excluded_snapshots"] += 1
        eligible = (
            not snapshot.filtered
            and scope_matches
            and snapshot.snapshot_id not in excluded_snapshot_ids
            and all(repo in protocol.repos for repo, _ in keys)
            and len(set(keys)) == len(keys)
            and times[snapshot.at] == 1
        )
        next_at = ordered[index + 1].at if index + 1 < len(ordered) else float("inf")
        deadline = snapshot.at + protocol.horizon
        converted = any(snapshot.at < review["at"] <= min(deadline, next_at) for review in reviews)
        conversion = (
            None
            if not eligible
            else True
            if converted
            else False
            if deadline <= protocol.end and next_at > deadline
            else None
        )
        if not eligible:
            status = "excluded_snapshot"
            audit["reviews_on_excluded_snapshots"] += len(outcomes)
        elif outcomes:
            first_at = outcomes[0]["decision_at"]
            simultaneous = [row for row in outcomes if row["decision_at"] == first_at]
            audit["later_reviews_without_fresh_snapshot"] += len(outcomes) - len(simultaneous)
            if any(not row["outcome_complete"] for row in simultaneous):
                status = "incomplete_review"
            elif len(simultaneous) != 1:
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
                            "decision_at": review[time_field],
                            "review_id": review["id"],
                            "chosen": keys.index(key),
                            "candidates": candidates,
                            "header": snapshot.header,
                            "request_round": "unknown",
                        }
                    )
        else:
            # A newer snapshot censors this opportunity; no duplicate conversion labels.
            status = (
                "submitted_without_new_choice"
                if conversion is True
                else "no_review"
                if conversion is False
                else "censored"
            )
        sessions.append(
            {
                "snapshot_id": snapshot.snapshot_id,
                "at": snapshot.at,
                "status": status,
                "submitted_review_conversion": conversion,
            }
        )
        audit[status] += 1
    return {
        "schema_version": 1,
        "protocol": asdict(protocol),
        "audit": dict(audit),
        "choices": choices,
        "sessions": sessions,
        "journal_sha256": digest(journal),
        "excluded_snapshot_ids": sorted(excluded_snapshot_ids),
        "promotion_allowed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    collector = sub.add_parser("collect")
    collector.add_argument("--max-requests", type=int, default=2000)
    collector.add_argument("--transport", choices=["graphql", "rest"], default="graphql")
    joiner = sub.add_parser("join")
    joiner.add_argument("--journal", type=Path, required=True)
    joiner.add_argument("--exports", type=Path, nargs="+", required=True)
    joiner.add_argument("--exclude-snapshots", type=Path)
    for command in [collector, joiner]:
        command.add_argument("--protocol", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    protocol = Protocol.parse(json.loads(args.protocol.read_text()))
    if args.command == "collect":
        collector_fn = collect_graphql if args.transport == "graphql" else collect
        result = collector_fn(protocol, GitHub(args.max_requests), datetime.now(UTC).timestamp())
    else:
        snapshots, import_audit = [], Counter()
        for path in args.exports:
            rows, counts = load_snapshots(path)
            snapshots.extend(rows)
            import_audit.update(counts)
        if import_audit["rejected_snapshots"] or import_audit["invalid_events"]:
            raise ValueError("Repair incomplete exports before joining outcomes")
        exclusions = (
            json.loads(args.exclude_snapshots.read_text()) if args.exclude_snapshots else {}
        )
        excluded_ids = exclusions.get("excluded_snapshot_ids", [])
        if not isinstance(excluded_ids, list) or any(
            not isinstance(value, str) or not value for value in excluded_ids
        ):
            raise ValueError("List snapshot IDs for explicit exclusions")
        result = join(
            protocol, snapshots, json.loads(args.journal.read_text()), frozenset(excluded_ids)
        )
        result["exclusions_sha256"] = digest(exclusions)
        result["import_audit"] = dict(import_audit)
        result["export_sha256"] = [
            hashlib.sha256(path.read_bytes()).hexdigest() for path in args.exports
        ]
    write_private(args.output, result)
    counts = {"reviews": len(result["reviews"])} if "reviews" in result else result["audit"]
    print(json.dumps(counts, sort_keys=True))


if __name__ == "__main__":
    main()
