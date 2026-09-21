"""Check sampled queues through a separate reconstruction from raw events."""

import argparse
from pathlib import Path

import numpy as np

from .historical_content import title_history
from .outcomes import digest, required_time, write_private
from .replay import build_history_choices, human, load_history


def expected_queue(data: dict, user: str, at: float) -> set[str]:
    expected = set()
    for pull in data["pulls"]:
        requests, clears = [], []
        opened, draft = True, pull["isDraft"]
        transitions = [
            event
            for event in pull["events"]
            if event["__typename"] in {"ReadyForReviewEvent", "ConvertToDraftEvent"}
        ]
        if transitions:
            draft = transitions[0]["__typename"] == "ReadyForReviewEvent"
        for event in pull["events"]:
            when = required_time(event["createdAt"])
            if when >= at:
                continue
            kind, target = event["__typename"], event.get("requestedReviewer")
            if human(target) and target["login"].lower() == user:
                if kind == "ReviewRequestedEvent":
                    requests.append(when)
                elif kind == "ReviewRequestRemovedEvent":
                    clears.append(when)
            if kind in {"ClosedEvent", "MergedEvent"}:
                opened = False
            elif kind == "ReopenedEvent":
                opened = True
            elif kind == "ReadyForReviewEvent":
                draft = False
            elif kind == "ConvertToDraftEvent":
                draft = True
        for review in pull["reviews"]:
            if not human(review.get("author")) or not review.get("submittedAt"):
                continue
            when = required_time(review["submittedAt"])
            if review["author"]["login"].lower() == user and when < at:
                clears.append(when)
        if pull.get("quality", {}).get("lifecycle") is False:
            if pull["closedAt"] and required_time(pull["closedAt"]) < at:
                opened = False
            elif requests and max(requests) > max(clears, default=-1):
                raise ValueError("Sampled queue contains an uncertain candidate")
        if opened and not draft and requests and max(requests) > max(clears, default=-1):
            expected.add(f"{data['repo']}#{pull['number']}")
    return expected


def audit(data: dict) -> dict:
    choices, counts = build_history_choices(data)
    users = set()
    title_changes = 0
    for pull in data["pulls"]:
        if pull.get("quality", {}).get("title", True):
            times, _ = title_history(pull)
            title_changes += len(times) - 1
        for event in pull["events"]:
            target = event.get("requestedReviewer")
            if human(target) and required_time(event["createdAt"]) < data["end"]:
                users.add(target["login"].lower())
        for review in pull["reviews"]:
            if human(review.get("author")) and review.get("submittedAt"):
                if required_time(review["submittedAt"]) < data["end"]:
                    users.add(review["author"]["login"].lower())
    lookup = {f"reviewer-{i + 1}": user for i, user in enumerate(sorted(users))}
    rng = np.random.default_rng(71)
    sampled = []
    for low, high in [(2, 5), (6, 10), (11, float("inf"))]:
        group = [choice for choice in choices if low <= len(choice.keys) <= high]
        order = rng.permutation(len(group))
        selected, seen = [], set()
        for index in order:
            choice = group[index]
            if choice.user not in seen:
                selected.append(choice)
                seen.add(choice.user)
            if len(selected) == 10:
                break
        sampled.extend(selected)
    rows = []
    for choice in sampled:
        expected = expected_queue(data, lookup[choice.user], choice.at)
        actual = set(choice.keys)
        rows.append(
            {
                "reviewer": choice.user,
                "at": choice.at,
                "outcome_at": choice.outcome_at,
                "candidates": len(actual),
                "missing": sorted(expected - actual),
                "extra": sorted(actual - expected),
                "chosen_in_expected": choice.keys[choice.chosen] in expected,
            }
        )
    return {
        "source_sha256": digest(data),
        "counts": counts,
        "samples": rows,
        "title_changes_checked": title_changes,
        "all_sampled_queues_match": bool(rows)
        and all(
            not row["missing"] and not row["extra"] and row["chosen_in_expected"] for row in rows
        ),
        "limits": [
            "The check independently replays API records. It does not observe the human's queue.",
            "Both reconstructions share the same GitHub source and its missing-record limits.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(load_history(args.history))
    write_private(args.output, result)
    if not result["all_sampled_queues_match"]:
        raise ValueError("Independent queue reconstruction disagrees; inspect the audit")
    print(f"Verified {len(result['samples'])} sampled queues against raw event histories")


if __name__ == "__main__":
    main()
