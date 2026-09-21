"""Read the local GitHub cache without network requests."""

import hashlib
import json
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


def timestamp(value: str | None) -> float | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamps must include a timezone")
    return parsed.timestamp()


@dataclass(frozen=True)
class PullRequest:
    key: str
    author: str
    created: float
    closed: float | None
    requests: tuple[float, ...]
    reviews: tuple[float, ...]
    bot: bool


@dataclass
class Dataset:
    cutoff: float
    subjects: dict[str, list[PullRequest]]
    audit: dict
    source_hash: str


def load_cache(dataset_path: Path, cache_path: Path) -> Dataset:
    dataset_bytes = dataset_path.read_bytes()
    legacy = json.loads(dataset_bytes)
    cutoff = timestamp(legacy["builtAt"])
    if cutoff is None:
        raise ValueError("The dataset needs a fixed collection time")
    digest = hashlib.sha256(dataset_bytes)
    raw_by_key: dict[str, list[dict]] = {}
    for path in sorted(cache_path.glob("*.json")):
        if path.resolve() == dataset_path.resolve():
            continue
        content = path.read_bytes()
        cached = json.loads(content)
        nodes = cached.get("data", {}).get("search", {}).get("nodes", [])
        if not nodes:
            continue
        digest.update(hashlib.sha256(content).digest())
        for node in nodes:
            if node and node.get("repository") and node.get("number"):
                key = f"{node['repository']['nameWithOwner']}#{node['number']}"
                raw_by_key.setdefault(key, []).append(node)

    counts: Counter = Counter()
    subjects = {}
    for index, subject in enumerate(sorted(legacy["subjects"], key=lambda s: s["login"].lower())):
        viewer = subject["login"].lower()
        records = []
        for row in subject["rows"]:
            counts["legacy_rows"] += 1
            key = f"{row['repoFullName']}#{row['prNumber']}"
            observations = raw_by_key.get(key, [])
            if not observations:
                counts["missing_raw_pr"] += 1
                continue
            request_times = set()
            review_times = set()
            truncated = False
            for raw in observations:
                requests = (raw.get("timelineItems") or {}).get("nodes", [])
                reviews = (raw.get("reviews") or {}).get("nodes", [])
                truncated |= len(requests) >= 20 or len(reviews) >= 20
                for event in requests:
                    target = event.get("requestedReviewer") or {}
                    if (
                        target.get("__typename") == "User"
                        and target.get("login", "").lower() == viewer
                    ):
                        at = timestamp(event.get("createdAt"))
                        if at is not None and at < cutoff:
                            request_times.add(at)
                for review in reviews:
                    if (review.get("author") or {}).get("login", "").lower() == viewer:
                        at = timestamp(review.get("submittedAt"))
                        if at is not None and at < cutoff:
                            review_times.add(at)
            if truncated:
                counts["possibly_truncated_history"] += 1
                continue
            raw = observations[0]
            created = timestamp(raw.get("createdAt"))
            author = raw.get("author") or {}
            if created is None or not author.get("login"):
                counts["missing_identity_or_created_time"] += 1
                continue
            if not request_times:
                counts["without_confirmed_direct_request"] += 1
            closures = {timestamp(item.get("closedAt")) for item in observations}
            if len(closures) > 1:
                counts["inconsistent_closure"] += 1
                continue
            records.append(
                PullRequest(
                    key=key,
                    author=author["login"].lower(),
                    created=created,
                    closed=closures.pop(),
                    requests=tuple(sorted(request_times)),
                    reviews=tuple(sorted(review_times)),
                    bot=author.get("__typename") in {"Bot", "Organization", "Mannequin"}
                    or author["login"].endswith("[bot]"),
                )
            )
        subjects[f"reviewer-{index + 1}"] = sorted(records, key=lambda row: row.key)

    return Dataset(cutoff, subjects, dict(counts), digest.hexdigest())
