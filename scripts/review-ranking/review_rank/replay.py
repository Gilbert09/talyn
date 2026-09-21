"""Replay complete direct-request histories before each submitted review starts."""

import json
from bisect import bisect_left
from collections import Counter, defaultdict
from dataclasses import dataclass
from itertools import groupby
from pathlib import Path

import numpy as np

from .data import PullRequest
from .features import Choice, Pending, vector
from .outcomes import digest, required_time


@dataclass
class HistoryChoice(Choice):
    outcome_at: float


def human(actor: dict | None) -> bool:
    return bool(
        actor
        and actor.get("__typename") == "User"
        and actor.get("login")
        and not actor["login"].lower().endswith("[bot]")
    )


def availability(pull: dict) -> tuple[list[float], list[bool | None]]:
    if pull.get("quality", {}).get("lifecycle") is False:
        times, states = [required_time(pull["createdAt"])], [None]
        if pull["closedAt"]:
            times.append(required_time(pull["closedAt"]))
            states.append(False)
        return times, states
    transitions = sorted(
        (
            event
            for event in pull["events"]
            if event["__typename"]
            in {
                "ClosedEvent",
                "MergedEvent",
                "ReopenedEvent",
                "ReadyForReviewEvent",
                "ConvertToDraftEvent",
            }
        ),
        key=lambda event: required_time(event["createdAt"]),
    )
    draft_events = [
        event
        for event in transitions
        if event["__typename"] in {"ReadyForReviewEvent", "ConvertToDraftEvent"}
    ]
    draft = (
        draft_events[0]["__typename"] == "ReadyForReviewEvent" if draft_events else pull["isDraft"]
    )
    opened = True
    times, states = [required_time(pull["createdAt"])], [not draft]
    for at, group in groupby(transitions, key=lambda event: required_time(event["createdAt"])):
        types = {event["__typename"] for event in group}
        if "ReopenedEvent" in types and types & {"ClosedEvent", "MergedEvent"}:
            opened = None
        elif types & {"ClosedEvent", "MergedEvent"}:
            opened = False
        elif "ReopenedEvent" in types:
            opened = True
        if {
            "ReadyForReviewEvent",
            "ConvertToDraftEvent",
        } <= types:
            draft = None
        elif "ReadyForReviewEvent" in types:
            draft = False
        elif "ConvertToDraftEvent" in types:
            draft = True
        times.append(at)
        states.append(
            False
            if opened is False or draft is True
            else None
            if opened is None or draft is None
            else True
        )
    return times, states


def load_history(path: Path) -> dict:
    data = json.loads(path.read_text())
    if (
        data.get("schema_version") != 1
        or data.get("source") != "repository_history"
        or data.get("complete") is not True
        or data["start"] >= data["end"]
    ):
        raise ValueError("Expected complete repository history")
    ids = sorted(pull["id"] for pull in data["pulls"])
    if len(ids) != len(set(ids)) or digest(ids) != data["inventory"]["ids_sha256"]:
        raise ValueError("History does not match its inventory")
    return data


def build_history_choices(
    data: dict, decision_time: str = "created"
) -> tuple[list[HistoryChoice], dict]:
    if decision_time not in {"created", "submitted"}:
        raise ValueError("Unknown review timing policy")
    audit = Counter()
    by_user = defaultdict(list)
    active = {}
    for pull in data["pulls"]:
        key = f"{data['repo']}#{pull['number']}"
        active[key] = availability(pull)
        author = (pull.get("author") or {}).get("login", f"unknown:{key}").lower()
        row = PullRequest(
            key,
            author,
            required_time(pull["createdAt"]),
            None,
            (),
            (),
            bool(pull.get("author") and not human(pull["author"])),
        )
        for event in pull["events"]:
            kind = event["__typename"]
            if kind not in {"ReviewRequestedEvent", "ReviewRequestRemovedEvent"}:
                continue
            target = event.get("requestedReviewer")
            if not human(target):
                audit["nonhuman_or_team_request_events"] += 1
                continue
            at = required_time(event["createdAt"])
            if at < data["end"]:
                by_user[target["login"].lower()].append(
                    (at, "request" if kind == "ReviewRequestedEvent" else "remove", row, at)
                )
        for review in pull["reviews"]:
            if not review.get("submittedAt") or not human(review.get("author")):
                continue
            end = required_time(review["submittedAt"])
            start = required_time(review["createdAt"])
            if review["state"] not in {"APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"}:
                raise ValueError("Unknown submitted review state")
            if end >= data["end"]:
                continue
            user = review["author"]["login"].lower()
            by_user[user].append((end, "submit", row, end))
            if end >= data["start"]:
                audit["submitted_reviews_in_window"] += 1
            if start > end:
                if end >= data["start"]:
                    audit["invalid_review_start_times"] += 1
                if decision_time == "created":
                    continue
            at = start if decision_time == "created" else end
            by_user[user].append((at, "decision", row, end))

    choices = []
    for index, (_, events) in enumerate(sorted(by_user.items())):
        user = f"reviewer-{index + 1}"
        events.sort(key=lambda event: (event[0], event[1], event[2].key))
        pending = {}
        seen_requests = set()
        author_requests, author_reviews, author_answered, rounds = (Counter() for _ in range(4))
        history = []
        for at, group in groupby(events, key=lambda event: event[0]):
            batch = list(group)
            decisions = [event for event in batch if event[1] == "decision"]
            in_window = data["start"] <= at < data["end"]
            if decisions and in_window:
                audit["submitted_review_decisions"] += len(decisions)
                candidates = []
                uncertain = False
                for item in pending.values():
                    times, states = active[item.row.key]
                    position = bisect_left(times, at) - 1
                    if position >= 0 and states[position] is None:
                        uncertain = True
                    elif position >= 0 and states[position]:
                        candidates.append(item)
                candidates.sort(key=lambda item: item.row.key)
                keys = tuple(item.row.key for item in candidates)
                if uncertain:
                    audit["decisions_with_uncertain_candidate_state"] += len(decisions)
                elif len(decisions) != 1:
                    audit["simultaneous_decisions"] += len(decisions)
                elif decisions[0][2].key not in keys:
                    audit["review_outside_direct_queue"] += 1
                    winner = decisions[0][2].key
                    if winner in pending:
                        audit["outside_queue_closed_or_draft"] += 1
                    elif rounds[winner]:
                        audit["outside_queue_after_prior_review"] += 1
                    elif winner in seen_requests:
                        audit["outside_queue_removed_request"] += 1
                    else:
                        audit["outside_queue_no_prior_direct_request"] += 1
                elif len(keys) < 2:
                    audit["single_candidate_choices"] += 1
                else:
                    chosen = keys.index(decisions[0][2].key)
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
                        ]
                    )
                    choices.append(
                        HistoryChoice(
                            user,
                            at,
                            keys,
                            chosen,
                            x,
                            np.asarray([item.latest for item in candidates]),
                            np.asarray([item.row.created for item in candidates]),
                            decisions[0][3],
                        )
                    )
            for _, kind, row, _ in batch:
                if kind == "request":
                    seen_requests.add(row.key)
                    if in_window:
                        author_requests[row.author] += 1
                    if row.key in pending:
                        pending[row.key].latest = at
                        pending[row.key].requests += 1
                    else:
                        pending[row.key] = Pending(row, at, at, len(history))
            for _, kind, row, _ in batch:
                if kind == "submit":
                    if in_window:
                        if (
                            row.key in pending
                            and pending[row.key].first < at
                            and pending[row.key].latest >= data["start"]
                        ):
                            author_answered[row.author] += 1
                        author_reviews[row.author] += 1
                        history.append((at, row.author))
                    rounds[row.key] += 1
                if kind in {"remove", "submit"}:
                    pending.pop(row.key, None)
    choices.sort(key=lambda choice: (choice.at, choice.user, choice.keys[choice.chosen]))
    audit["choices"] = len(choices)
    audit["candidate_rows"] = sum(len(choice.keys) for choice in choices)
    audit["reviewers_with_choices"] = len({choice.user for choice in choices})
    audit["informative_choices"] = sum(len(choice.keys) > 3 for choice in choices)
    return choices, dict(audit)
