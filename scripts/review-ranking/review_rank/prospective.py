"""Build observed features without using later content or later review outcomes."""

import math
from collections import Counter, defaultdict
from dataclasses import dataclass

import numpy as np

from .data import timestamp
from .features import DAY, Choice
from .outcomes import Protocol

GATES = {"blocking_others": 3, "actionable": 2, "waiting_on_author": 1, "not_ready": 0}
NUMERIC = (
    "request_age_hours",
    "creation_age_hours",
    "summary_age_hours",
    "additions",
    "deletions",
    "requested_team_count",
    "human_threads",
    "bot_threads",
    "viewer_threads",
    "checks_passed",
    "checks_failed",
    "checks_pending",
    "previous_review_age_hours",
)
BOOLEAN = ("direct_request", "bot_author", "draft")
FEATURES = tuple(name for field in NUMERIC for name in (f"log_{field}", f"missing_{field}")) + (
    *[name for field in BOOLEAN for name in (field, f"missing_{field}")],
    *[f"affinity_{i}" for i in range(6)],
    "missing_affinity",
    "request_recency_quantile",
    "log_queue_size",
    "log_reviews_7d",
    "log_reviews_30d",
    "log_hours_since_review",
    "log_same_repo_reviews_30d",
    "previously_approved",
    "previously_changes_requested",
    "mergeable",
    "conflicting",
    "missing_content",
    "missing_recent_content",
    "recent_content_cosine",
)


@dataclass
class ObservedChoice:
    choice: Choice
    review_at: float
    displayed: np.ndarray
    gates: np.ndarray
    team: bool
    returning: bool
    sort_mode: str = "unknown"


def vector_for(records: dict, candidate: dict, at: float, dimension: int) -> np.ndarray | None:
    key = (candidate["repo"].lower(), candidate["pr_number"], candidate.get("head_sha"))
    eligible = [row for row in records.get(key, []) if row["observed_at"] <= at]
    if not eligible:
        return None
    row = max(eligible, key=lambda value: value["observed_at"])
    vector = np.asarray(row["vector"], dtype=float)
    if vector.shape != (dimension,) or not np.isfinite(vector).all():
        raise ValueError("Invalid content vector")
    return vector


def age(value: str | None, at: float) -> float | None:
    instant = timestamp(value)
    return None if instant is None or instant > at else (at - instant) / 3600


def build_observed(
    joined: list[dict], embeddings: dict | None = None
) -> tuple[list[ObservedChoice], dict]:
    if any(data.get("schema_version") != 1 for data in joined):
        raise ValueError("Expected version 1 joined data")
    workspaces = {data["protocol"]["workspace"] for data in joined}
    if len(workspaces) != 1:
        raise ValueError("Pool only one workspace under one agreed data scope")
    users = {
        key: f"reviewer-{i + 1}"
        for i, key in enumerate(sorted({data["protocol"]["reviewer"] for data in joined}))
    }
    records = defaultdict(list)
    dimension = 0
    if embeddings is not None:
        if embeddings.get("schema_version") != 1:
            raise ValueError("Expected version 1 embeddings")
        dimension = embeddings["encoder"]["dimension"]
        if type(dimension) is not int or not 1 <= dimension <= 8192:
            raise ValueError("Invalid embedding dimension")
        seen_content = {}
        for record in embeddings["records"]:
            key = (record["repo"].lower(), record["number"], record["head_sha"])
            version = (*key, record["observed_at"])
            if version in seen_content and seen_content[version] != record:
                raise ValueError("Conflicting observed content")
            seen_content[version] = record
            records[key].append(record)
    rows, seen = [], set()
    for data in joined:
        protocol = Protocol(**{**data["protocol"], "repos": tuple(data["protocol"]["repos"])})
        for row in data["choices"]:
            key = (protocol.reviewer, row["review_id"])
            if key in seen:
                raise ValueError("Overlapping exports duplicate a review decision")
            if not protocol.start <= row["at"] < row["review_at"] < protocol.end:
                raise ValueError("Decision outside the observation window")
            decision_at = row.get("decision_at")
            if (
                type(decision_at) not in {int, float}
                or not row["at"] < decision_at <= row["review_at"]
            ):
                raise ValueError("The queue must precede the recorded review decision")
            seen.add(key)
            rows.append((row, users[protocol.reviewer]))
    rows.sort(key=lambda item: (item[0]["at"], item[1]))
    history = defaultdict(list)
    results, audit = [], Counter()
    for row, user in rows:
        at = row["at"]
        prior = sorted((item for item in history[user] if item[0] < at), key=lambda item: item[0])
        recent = [item for item in prior if item[0] > at - 30 * DAY]
        recent_vectors = [item[2] for item in recent[-20:] if item[2] is not None]
        recent_vector = np.mean(recent_vectors, axis=0) if recent_vectors else np.zeros(dimension)
        norm = np.linalg.norm(recent_vector)
        if norm:
            recent_vector /= norm
        candidates = row["candidates"]
        requested = np.asarray(
            [timestamp(item.get("request_first_seen_at")) or -1e15 for item in candidates]
        )
        created = np.asarray([timestamp(item.get("created_at")) or -1e15 for item in candidates])
        requested[requested > at] = -1e15
        created[created > at] = -1e15
        vectors, matrix = [], []
        for i, candidate in enumerate(candidates):
            checks = candidate.get("checks") or {}
            previous = candidate.get("previous_review") or {}
            values = {
                **candidate,
                "request_age_hours": age(candidate.get("request_first_seen_at"), at),
                "creation_age_hours": age(candidate.get("created_at"), at),
                "summary_age_hours": age(candidate.get("summary_updated_at"), at),
                **{f"checks_{name}": checks.get(name) for name in ["passed", "failed", "pending"]},
                "checks_pending": checks.get("inProgress"),
                "previous_review_age_hours": age(previous.get("submittedAt"), at),
            }
            features = []
            for field in NUMERIC:
                value = values.get(field)
                missing = (
                    not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0
                )
                features.extend([0 if missing else math.log1p(value), float(missing)])
            for field in BOOLEAN:
                value = candidate.get(field)
                features.extend([float(value is True), float(type(value) is not bool)])
            affinity = candidate.get("affinity_features")
            missing_affinity = (
                not isinstance(affinity, list)
                or len(affinity) != 6
                or any(
                    not isinstance(value, (int, float)) or not math.isfinite(value)
                    for value in affinity
                )
            )
            features.extend([0.0] * 6 if missing_affinity else affinity)
            features.extend(
                [
                    float(missing_affinity),
                    sum(requested > requested[i]) / max(len(candidates) - 1, 1),
                    math.log1p(len(candidates)),
                    math.log1p(sum(item[0] > at - 7 * DAY for item in prior)),
                    math.log1p(len(recent)),
                    math.log1p((at - max(item[0] for item in prior)) / 3600) if prior else 0,
                    math.log1p(sum(item[1] == candidate["repo"].lower() for item in recent)),
                    float(previous.get("state") == "APPROVED"),
                    float(previous.get("state") == "CHANGES_REQUESTED"),
                    float(candidate.get("mergeable") == "MERGEABLE"),
                    float(candidate.get("mergeable") == "CONFLICTING"),
                ]
            )
            vector = vector_for(records, candidate, at, dimension)
            vectors.append(vector)
            audit["candidate_rows"] += 1
            audit["rows_with_content"] += vector is not None
            vector = np.zeros(dimension) if vector is None else vector
            features.extend(
                [
                    float(vectors[-1] is None),
                    float(not recent_vectors),
                    float(vector @ recent_vector),
                ]
            )
            features.extend(vector)
            features.extend(vector * recent_vector)
            matrix.append(features)
        chosen = row["chosen"]
        if type(chosen) is not int or not 0 <= chosen < len(candidates) or len(candidates) < 2:
            raise ValueError("Invalid choice label")
        choice = Choice(
            user,
            at,
            tuple(item["pr_id"] for item in candidates),
            chosen,
            np.asarray(matrix),
            requested,
            created,
        )
        if not np.isfinite(choice.x).all():
            raise ValueError("Observed features must be finite")
        results.append(
            ObservedChoice(
                choice,
                row["review_at"],
                -np.asarray([item["displayed_rank"] for item in candidates]),
                np.asarray([GATES.get(item.get("gate"), -1) for item in candidates]),
                bool(candidates[chosen].get("requested_team_count")),
                bool(candidates[chosen].get("previous_review")),
                row.get("header", {}).get("sort_mode", "unknown"),
            )
        )
        history[user].append(
            (row["review_at"], candidates[chosen]["repo"].lower(), vectors[chosen])
        )
    audit["choices"] = len(results)
    audit["embedding_dimension"] = dimension
    return results, dict(audit)


def gated_order(row: ObservedChoice, scores: np.ndarray) -> np.ndarray:
    if np.any(row.gates < 0):
        raise ValueError("Every candidate needs an observed readiness gate")
    # Preserve score ties within each gate for the common metric implementation.
    return np.asarray(
        [
            np.sum((row.gates < gate) | ((row.gates == gate) & (scores < score)))
            for gate, score in zip(row.gates, scores, strict=True)
        ],
        dtype=float,
    )
