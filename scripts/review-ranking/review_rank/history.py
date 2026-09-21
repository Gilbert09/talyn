"""Collect repository-wide PR histories without selecting by review outcomes."""

import argparse
import json
import re
import subprocess
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from itertools import islice
from pathlib import Path
from threading import Lock

from .historical_content import title_history
from .outcomes import digest, iso, required_time, write_private

PAGE = "pageInfo { hasNextPage endCursor } totalCount"
HEADER = "id number createdAt updatedAt closedAt isDraft author { login __typename }"
EVENT_TYPES = """REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, CLOSED_EVENT,
REOPENED_EVENT, MERGED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, RENAMED_TITLE_EVENT"""
REVIEWER = "requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } }"
EVENTS = f"""__typename
... on ReviewRequestedEvent {{ id createdAt {REVIEWER} }}
... on ReviewRequestRemovedEvent {{ id createdAt {REVIEWER} }}
... on ClosedEvent {{ id createdAt }}
... on ReopenedEvent {{ id createdAt }}
... on MergedEvent {{ id createdAt }}
... on ReadyForReviewEvent {{ id createdAt }}
... on ConvertToDraftEvent {{ id createdAt }}
... on RenamedTitleEvent {{ id createdAt previousTitle currentTitle }}"""
REVIEWS = "id createdAt submittedAt state author { login __typename }"
CONNECTIONS = f"""
timelineItems(first:100, itemTypes:[{EVENT_TYPES}]) {{
  {PAGE} filteredCount nodes {{ {EVENTS} }} }}
reviews(first:100) {{ {PAGE} nodes {{ {REVIEWS} }} }}"""


class HistoryAPI:
    def __init__(self, cache: Path, max_requests: int = 3000, reserve: int = 200):
        self.cache = cache
        self.max_requests = max_requests
        self.reserve = reserve
        self.requests = 0
        self.last_rate = None
        self.lock = Lock()

    def query(self, query: str, variables: dict, namespace: str = "history") -> dict:
        payload = {"query": query, "variables": variables}
        path = self.cache / namespace / f"{digest(payload)}.json"
        if path.exists():
            return json.loads(path.read_text())
        for attempt in range(3):
            with self.lock:
                if self.requests >= self.max_requests:
                    raise ValueError("Request budget exhausted; resume with the same cache")
                self.requests += 1
            try:
                result = subprocess.run(
                    ["gh", "api", "--hostname", "github.com", "graphql", "--input", "-"],
                    input=json.dumps(payload),
                    capture_output=True,
                    text=True,
                    timeout=90,
                    check=False,
                )
                if not result.returncode:
                    break
                status = re.search(r"HTTP (\d{3})", result.stderr)
                reason = f"HTTP {status[1]}" if status else "request error"
            except subprocess.TimeoutExpired:
                reason = "timeout"
            if attempt == 2:
                raise RuntimeError(f"GitHub read failed ({reason}); resume with the same cache")
            time.sleep(2**attempt)
        response = json.loads(result.stdout)
        if response.get("errors") or not response.get("data"):
            raise ValueError("GitHub returned partial data; no complete history was written")
        data = response["data"]
        self.last_rate = data.get("rateLimit")
        write_private(path, data)
        if self.last_rate and self.last_rate["remaining"] < self.reserve:
            raise ValueError("GitHub reserve reached; resume after the rate window resets")
        return data


def inventory(api: HistoryAPI, repo: str, start: float, end: float) -> dict:
    owner, name = repo.split("/")
    query = f"""query($owner:String!, $name:String!, $cursor:String) {{
      repository(owner:$owner,name:$name) {{ pullRequests(first:100,after:$cursor,
        orderBy:{{field:CREATED_AT,direction:ASC}}) {{
        {PAGE} nodes {{ {HEADER} }} }} }}
      rateLimit {{ cost remaining resetAt }} }}"""
    records = {}
    cursor = None
    cursors = set()
    seen = set()
    previous = float("-inf")
    while True:
        data = api.query(query, {"owner": owner, "name": name, "cursor": cursor}, "inventory")
        connection = data["repository"]["pullRequests"]
        done = False
        for row in connection["nodes"]:
            if not row or row["id"] in seen:
                raise ValueError("Duplicate or missing PR during inventory")
            seen.add(row["id"])
            created, updated = required_time(row["createdAt"]), required_time(row["updatedAt"])
            if created < previous:
                raise ValueError("PR creation order changed during inventory")
            previous = created
            if created >= end:
                done = True
                break
            if updated >= start or row["closedAt"] is None:
                records[row["id"]] = row
        if len(cursors) % 100 == 0:
            print(
                json.dumps({"scanned": len(seen), "eligible_histories": len(records)}), flush=True
            )
        page = connection["pageInfo"]
        if done or not page["hasNextPage"]:
            return records
        cursor = page["endCursor"]
        if not cursor or cursor in cursors:
            raise ValueError("Inventory cursor did not advance")
        cursors.add(cursor)


def complete_connection(api: HistoryAPI, node: dict, field: str) -> list[dict]:
    connection = node[field]
    count_field = "filteredCount" if field == "timelineItems" else "totalCount"
    total = connection[count_field]
    rows = list(connection["nodes"])
    page = connection["pageInfo"]
    cursors = set()
    while page["hasNextPage"]:
        cursor = page["endCursor"]
        if not cursor or cursor in cursors:
            raise ValueError("History cursor did not advance")
        cursors.add(cursor)
        selection = EVENTS if field == "timelineItems" else REVIEWS
        arguments = f",itemTypes:[{EVENT_TYPES}]" if field == "timelineItems" else ""
        extra = "filteredCount" if field == "timelineItems" else ""
        query = f"""query($id:ID!, $cursor:String!) {{ node(id:$id) {{ ... on PullRequest {{
          {field}(first:100,after:$cursor{arguments}) {{ {PAGE} {extra} nodes {{ {selection} }} }}
        }} }} rateLimit {{ cost remaining resetAt }} }}"""
        data = api.query(query, {"id": node["id"], "cursor": cursor})
        connection = data["node"][field]
        if connection[count_field] != total:
            raise ValueError("History changed during pagination; use a new cache")
        rows.extend(connection["nodes"])
        page = connection["pageInfo"]
    if len(rows) != total or any(not row or not row.get("id") for row in rows):
        raise ValueError("Incomplete history connection")
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Duplicate history identity")
    return rows


def history_quality(pull: dict) -> dict[str, bool]:
    title_matches = True
    try:
        title_history(pull)
    except ValueError:
        title_matches = False
    closing_times = []
    draft = None
    for event in pull["events"]:
        kind = event["__typename"]
        if kind in {"ClosedEvent", "MergedEvent"}:
            closing_times.append(event["createdAt"])
        elif kind == "ReopenedEvent":
            closing_times.clear()
        elif kind == "ReadyForReviewEvent":
            draft = False
        elif kind == "ConvertToDraftEvent":
            draft = True
    # Timeline events can be emitted after the state changes.
    closure_matches = (
        pull["closedAt"] is not None
        and max(map(required_time, closing_times)) >= required_time(pull["closedAt"])
        if closing_times
        else pull["closedAt"] is None
    )
    return {
        "title": title_matches,
        "lifecycle": closure_matches and (draft is None or draft == pull["isDraft"]),
    }


def state_matches(pull: dict) -> bool:
    return all(history_quality(pull).values())


def collect_history(api: HistoryAPI, repo: str, start: float, end: float) -> dict:
    if start >= end or end > time.time():
        raise ValueError("Use a closed, ordered historical window")
    second = inventory(api, repo, start, end)
    print(json.dumps({"inventory_complete": True, "pulls": len(second)}), flush=True)
    query = f"""query($ids:[ID!]!) {{ nodes(ids:$ids) {{ ... on PullRequest {{
      {HEADER} title {CONNECTIONS} }} }} rateLimit {{ cost remaining resetAt }} }}"""
    ids = sorted(second)

    def fetch_batch(batch):
        data = api.query(query, {"ids": batch})
        nodes = data["nodes"]
        if len(nodes) != len(batch) or any(not node for node in nodes):
            raise ValueError("PR became inaccessible during history collection")
        if {node["id"] for node in nodes} != set(batch):
            raise ValueError("History does not match the inventory")
        result = []
        for node in nodes:
            if node["createdAt"] != second[node["id"]]["createdAt"]:
                raise ValueError("PR identity changed")
            for attempt in range(2):
                pull = {
                    **{
                        field: node[field]
                        for field in (
                            "id",
                            "number",
                            "createdAt",
                            "closedAt",
                            "isDraft",
                            "author",
                            "title",
                        )
                    },
                    "events": complete_connection(api, node, "timelineItems"),
                    "reviews": complete_connection(api, node, "reviews"),
                }
                pull["quality"] = history_quality(pull)
                if all(pull["quality"].values()) or attempt:
                    pull["state_rechecked"] = bool(attempt)
                    result.append(pull)
                    break
                refreshed = api.query(query, {"ids": [node["id"]]}, "state-recheck")
                if not refreshed["nodes"] or not refreshed["nodes"][0]:
                    raise ValueError("PR became inaccessible during its state check")
                node = refreshed["nodes"][0]
        return result

    pulls = []
    batches = iter(ids[offset : offset + 50] for offset in range(0, len(ids), 50))
    with ThreadPoolExecutor(max_workers=4) as executor:
        pending = {executor.submit(fetch_batch, batch) for batch in islice(batches, 4)}
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                pulls.extend(future.result())
                batch = next(batches, None)
                if batch is not None:
                    pending.add(executor.submit(fetch_batch, batch))
            if len(pulls) % 500 == 0 or len(pulls) == len(ids):
                print(
                    json.dumps({"histories": len(pulls), "total": len(ids), "rate": api.last_rate}),
                    flush=True,
                )
    return {
        "schema_version": 1,
        "source": "repository_history",
        "repo": repo.lower(),
        "start": start,
        "end": end,
        "complete": True,
        "inventory": {
            "method": "all_PRs_in_creation_order; updated_since_start_union_currently_open",
            "pulls": len(ids),
            "state_rechecked": sum(pull["state_rechecked"] for pull in pulls),
            "unresolved_lifecycle": sum(not pull["quality"]["lifecycle"] for pull in pulls),
            "unresolved_title": sum(not pull["quality"]["title"] for pull in pulls),
            "ids_sha256": digest(ids),
        },
        "pulls": sorted(pulls, key=lambda row: row["number"]),
        "limits": [
            "Deleted and inaccessible records remain unknown.",
            "GitHub reads are not a transactional snapshot.",
            "Team membership and historical production readiness are unknown.",
            "Review creation is an approximation of the review decision time.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-requests", type=int, default=3000)
    args = parser.parse_args()
    start, end = required_time(args.start), required_time(args.end)
    protocol = {"repo": args.repo.lower(), "start": iso(start), "end": iso(end)}
    scope = args.cache / digest(protocol)
    api = HistoryAPI(scope, args.max_requests)
    payload = collect_history(api, args.repo, start, end)
    write_private(args.output, payload)
    print(json.dumps({"complete": True, "pulls": len(payload["pulls"]), "requests": api.requests}))


if __name__ == "__main__":
    main()
