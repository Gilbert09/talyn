"""Reconstruct historical titles and add features from earlier completed reviews."""

import re
from bisect import bisect_left
from collections import defaultdict
from dataclasses import replace

import numpy as np

from .features import FEATURE_NAMES
from .outcomes import digest, required_time
from .replay import human

CONTENT_FEATURES = (
    "title_last_review_cosine",
    "title_recent_mean_cosine",
    "title_recent_max_cosine",
    "title_recent_scope_share",
    "title_recent_type_share",
    "title_recent_missing",
    "title_scope_missing",
    "title_type_fix",
    "title_type_feat",
    "title_type_chore",
    "title_type_docs",
    "title_type_test",
    "title_type_refactor",
    "title_missing",
    "title_last_review_missing",
)


def title_history(pull: dict) -> tuple[list[float], list[str]]:
    renames = [event for event in pull["events"] if event["__typename"] == "RenamedTitleEvent"]
    times = [required_time(pull["createdAt"])]
    titles = [renames[0]["previousTitle"] if renames else pull["title"]]
    for event in renames:
        at = required_time(event["createdAt"])
        if at < times[-1] or event["previousTitle"] != titles[-1]:
            raise ValueError("Title history is incomplete or out of order")
        times.append(at)
        titles.append(event["currentTitle"])
    if titles[-1] != pull["title"]:
        raise ValueError("Current title does not match the complete history")
    return times, titles


def title_at(history: tuple[list[float], list[str]], at: float) -> str:
    times, titles = history
    index = bisect_left(times, at) - 1
    if index < 0:
        raise ValueError("PR title is not yet available")
    return titles[index]


def title_parts(title: str) -> tuple[str, str]:
    match = re.match(r"^\s*([a-z]+)(?:\(([^)]+)\))?!?:", title, re.IGNORECASE)
    return (match[1].lower(), (match[2] or "").lower()) if match else ("", "")


def add_content(choices: list, history: dict, embeddings: dict) -> list:
    if embeddings.get("source_sha256") != digest(history):
        raise ValueError("Title vectors must match the historical source")
    vectors = {key: np.asarray(value, dtype=float) for key, value in embeddings["vectors"].items()}
    dimension = embeddings["encoder"]["dimension"]
    if any(
        value.shape != (dimension,) or not np.isfinite(value).all() for value in vectors.values()
    ):
        raise ValueError("Invalid title vectors")
    titles, by_user, users = {}, defaultdict(list), set()
    for pull in history["pulls"]:
        key = f"{history['repo']}#{pull['number']}"
        titles[key] = title_history(pull) if pull.get("quality", {}).get("title", True) else None
        for event in pull["events"]:
            target = event.get("requestedReviewer")
            if human(target) and required_time(event["createdAt"]) < history["end"]:
                users.add(target["login"].lower())
        for review in pull["reviews"]:
            if not human(review.get("author")) or not review.get("submittedAt"):
                continue
            at = required_time(review["submittedAt"])
            if at >= history["end"]:
                continue
            user = review["author"]["login"].lower()
            users.add(user)
            if at >= history["start"]:
                by_user[user].append((at, key))
    lookup = {f"reviewer-{i + 1}": user for i, user in enumerate(sorted(users))}
    grouped = defaultdict(list)
    for choice in choices:
        grouped[choice.user].append(choice)
    augmented = {}
    for user, subset in grouped.items():
        earlier = sorted(by_user[lookup[user]])
        pointer, recent = 0, []
        for choice in sorted(subset, key=lambda item: item.at):
            while pointer < len(earlier) and earlier[pointer][0] < choice.at:
                at, key = earlier[pointer]
                text = title_at(titles[key], at) if titles[key] is not None else None
                recent.append(
                    (vectors[digest(text)], title_parts(text))
                    if text is not None
                    else (None, ("", ""))
                )
                recent = recent[-20:]
                pointer += 1
            available = [v for v, _ in recent if v is not None]
            mean = np.mean(available, axis=0) if available else np.zeros(dimension)
            mean /= max(np.linalg.norm(mean), 1e-12)
            rows = []
            for key in choice.keys:
                text = title_at(titles[key], choice.at) if titles[key] is not None else None
                vector = vectors[digest(text)] if text is not None else np.zeros(dimension)
                kind, scope = title_parts(text) if text is not None else ("", "")
                last_available = bool(recent) and recent[-1][0] is not None
                rows.append(
                    [
                        float(vector @ recent[-1][0]) if last_available else 0,
                        float(vector @ mean),
                        max(
                            (float(vector @ v) for v, _ in recent[-5:] if v is not None), default=0
                        ),
                        sum(bool(scope) and scope == parts[1] for _, parts in recent)
                        / max(len(recent), 1),
                        sum(bool(kind) and kind == parts[0] for _, parts in recent)
                        / max(len(recent), 1),
                        float(not available),
                        float(not scope),
                        *[
                            float(kind == label)
                            for label in ("fix", "feat", "chore", "docs", "test", "refactor")
                        ],
                        float(text is None),
                        float(not last_available),
                    ]
                )
            augmented[id(choice)] = replace(choice, x=np.column_stack([choice.x, rows]))
    return [augmented[id(choice)] for choice in choices]


ALL_FEATURES = (*FEATURE_NAMES, *CONTENT_FEATURES)
