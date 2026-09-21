"""Build each choice before applying the events at its timestamp."""

import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from itertools import groupby

import numpy as np

from .data import Dataset, PullRequest

DAY = 86_400
FEATURE_NAMES = (
    "log_request_age",
    "log_first_request_age",
    "recency_quantile",
    "is_newest",
    "in_newest_three",
    "log_creation_age",
    "log_intervening_reviews",
    "is_unpassed",
    "log_author_reviews",
    "log_author_requests",
    "author_response_rate",
    "bot_author",
    "log_previous_rounds",
    "log_requests_this_round",
    "same_author_last",
    "same_author_recent",
    "author_share_last_five",
    "log_author_reviews_30d",
    "log_author_reviews_7d",
    "log_queue_size",
    "log_minutes_since_review",
    "affinity_x_session",
    "recency_x_deep_queue",
    "affinity_x_unpassed",
)
ACTIVITY_FEATURES = (
    "same_author_last",
    "same_author_recent",
    "author_share_last_five",
    "log_author_reviews_30d",
    "log_author_reviews_7d",
    "log_minutes_since_review",
    "affinity_x_session",
)


@dataclass
class Choice:
    user: str
    at: float
    keys: tuple[str, ...]
    chosen: int
    x: np.ndarray
    requested: np.ndarray
    created: np.ndarray


@dataclass
class Pending:
    row: PullRequest
    first: float
    latest: float
    review_index: int
    requests: int = 1


def vector(
    candidate: Pending,
    candidates: list[Pending],
    at: float,
    history: list[tuple[float, str]],
    author_requests: Counter,
    author_reviews: Counter,
    author_answered: Counter,
    rounds: Counter,
) -> list[float]:
    author = candidate.row.author
    # Equal timestamps get equal recency features.
    newer = sum(other.latest > candidate.latest for other in candidates)
    quantile = newer / max(len(candidates) - 1, 1)
    intervening = len(history) - candidate.review_index
    last_time, last_author = history[-1] if history else (None, None)
    gap = (at - last_time) / 60 if last_time is not None else 1440
    same = author == last_author
    recent = same and gap < 20
    author_count = author_reviews[author]
    recent_30 = sum(who == author and time > at - 30 * DAY for time, who in history)
    recent_7 = sum(who == author and time > at - 7 * DAY for time, who in history)
    recent_five = history[-5:]
    log_affinity = math.log1p(author_count)
    return [
        math.log1p((at - candidate.latest) / 3600),
        math.log1p((at - candidate.first) / 3600),
        quantile,
        float(newer == 0),
        float(newer < 3),
        math.log1p(max(0, at - candidate.row.created) / 3600),
        math.log1p(intervening),
        float(intervening == 0),
        log_affinity,
        math.log1p(author_requests[author]),
        (author_answered[author] + 1) / (author_requests[author] + 2),
        float(candidate.row.bot),
        math.log1p(rounds[candidate.row.key]),
        math.log1p(candidate.requests),
        float(same),
        float(recent),
        sum(who == author for _, who in recent_five) / max(len(recent_five), 1),
        math.log1p(recent_30),
        math.log1p(recent_7),
        math.log1p(len(candidates)),
        math.log1p(min(gap, 1440)),
        log_affinity * float(gap < 20),
        quantile * float(len(candidates) > 10),
        log_affinity * float(intervening == 0),
    ]


def build_choices(dataset: Dataset) -> tuple[list[Choice], dict]:
    choices = []
    audit: Counter = Counter()
    for user, rows in sorted(dataset.subjects.items()):
        events = []
        for row in rows:
            events.extend((time, "request", row) for time in row.requests if time < dataset.cutoff)
            events.extend((time, "review", row) for time in row.reviews if time < dataset.cutoff)
        events.sort(key=lambda item: (item[0], item[1], item[2].key))
        pending: dict[str, Pending] = {}
        author_requests: Counter = Counter()
        author_reviews: Counter = Counter()
        author_answered: Counter = Counter()
        rounds: Counter = Counter()
        history = []
        for at, same_time in groupby(events, key=lambda item: item[0]):
            batch = list(same_time)
            reviews = [row for _, kind, row in batch if kind == "review"]
            pending = {
                key: item
                for key, item in pending.items()
                if item.row.closed is None or item.row.closed > at
            }
            if len(reviews) > 1:
                audit["simultaneous_review_events"] += len(reviews)
            elif reviews:
                winner = reviews[0]
                audit["observed_reviews"] += 1
                if winner.key not in pending:
                    audit["review_without_active_direct_request"] += 1
                elif len(pending) < 2:
                    audit["single_candidate_choices"] += 1
                else:
                    candidates = sorted(pending.values(), key=lambda item: item.row.key)
                    keys = tuple(item.row.key for item in candidates)
                    x = np.asarray(
                        [
                            vector(
                                item,
                                candidates,
                                at,
                                history,
                                author_requests,
                                author_reviews,
                                author_answered,
                                rounds,
                            )
                            for item in candidates
                        ],
                        dtype=np.float64,
                    )
                    if not np.isfinite(x).all():
                        raise ValueError("Features must be finite")
                    choices.append(
                        Choice(
                            user,
                            at,
                            keys,
                            keys.index(winner.key),
                            x,
                            np.asarray([item.latest for item in candidates]),
                            np.asarray([item.row.created for item in candidates]),
                        )
                    )
            # These updates cannot affect a choice at the same timestamp.
            for _, kind, row in batch:
                if kind != "request" or (row.closed is not None and row.closed <= at):
                    continue
                author_requests[row.author] += 1
                if row.key in pending:
                    pending[row.key].latest = at
                    pending[row.key].requests += 1
                else:
                    pending[row.key] = Pending(row, at, at, len(history))
            for row in reviews:
                if row.key in pending and pending[row.key].first < at:
                    author_answered[row.author] += 1
                pending.pop(row.key, None)
                author_reviews[row.author] += 1
                rounds[row.key] += 1
                history.append((at, row.author))
    choices.sort(key=lambda choice: (choice.at, choice.user, choice.keys[choice.chosen]))
    audit["choices"] = len(choices)
    audit["candidate_rows"] = sum(len(choice.keys) for choice in choices)
    return choices, dict(audit)


def summarize_choices(choices: list[Choice]) -> dict:
    users = defaultdict(list)
    for choice in choices:
        users[choice.user].append(len(choice.keys))
    return {
        user: {"events": len(sizes), "mean_candidates": float(np.mean(sizes))}
        for user, sizes in sorted(users.items())
    }
