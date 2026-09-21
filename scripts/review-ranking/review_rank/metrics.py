"""Score complete queues with label-independent treatment of ties."""

from collections import defaultdict

import numpy as np

from .features import DAY, Choice


def event_metrics(scores: np.ndarray, chosen: int) -> dict[str, float]:
    if not np.isfinite(scores).all():
        raise ValueError("Scores must be finite")
    greater = int(np.sum(scores > scores[chosen]))
    tied = int(np.sum(scores == scores[chosen]))
    ranks = np.arange(greater + 1, greater + tied + 1)
    return {
        "hit1": float(np.mean(ranks <= 1)),
        "hit3": float(np.mean(ranks <= 3)),
        "mrr": float(np.mean(1 / ranks)),
        "ndcg3": float(np.mean(np.where(ranks <= 3, 1 / np.log2(ranks + 1), 0))),
    }


def evaluate(choices: list[Choice], predictions: list[np.ndarray]) -> tuple[dict, np.ndarray]:
    if len(choices) != len(predictions) or not choices:
        raise ValueError("Each nonempty choice list needs one prediction per choice")
    by_user = defaultdict(list)
    rows = []
    for choice, scores in zip(choices, predictions, strict=True):
        if len(scores) != len(choice.keys):
            raise ValueError("Prediction length must match the complete queue")
        row = event_metrics(scores, choice.chosen)
        rows.append(row)
        by_user[choice.user].append(row)
    per_user = {
        user: {
            "events": len(values),
            **{name: float(np.mean([row[name] for row in values])) for name in rows[0]},
        }
        for user, values in sorted(by_user.items())
    }
    nontrivial = defaultdict(list)
    for choice, row in zip(choices, rows, strict=True):
        if len(choice.keys) > 3:
            nontrivial[choice.user].append(row["hit3"])
    return {
        "events": len(rows),
        "macro": {
            name: float(np.mean([row[name] for row in per_user.values()])) for name in rows[0]
        },
        "micro": {name: float(np.mean([row[name] for row in rows])) for name in rows[0]},
        "per_user": per_user,
        "queues_over_three": {
            "events": sum(len(values) for values in nontrivial.values()),
            "macro_hit3": float(np.mean([np.mean(v) for v in nontrivial.values()]))
            if nontrivial
            else None,
        },
    }, np.asarray([row["hit3"] for row in rows])


def paired_interval(
    choices: list[Choice],
    delta: np.ndarray,
    seed: int = 71,
    samples: int = 2000,
) -> dict:
    """Resample reviewers, then week blocks within each sampled reviewer."""
    by_user = defaultdict(lambda: defaultdict(list))
    for choice, value in zip(choices, delta, strict=True):
        by_user[choice.user][int(choice.at // (7 * DAY))].append(float(value))
    users = sorted(by_user)
    if not users:
        raise ValueError("The interval needs choices")
    rng = np.random.default_rng(seed)
    draws = []
    for _ in range(samples):
        means = []
        for user in rng.choice(users, size=len(users), replace=True):
            blocks = list(by_user[user].values())
            selected = rng.integers(0, len(blocks), size=len(blocks))
            means.append(np.mean([value for index in selected for value in blocks[index]]))
        draws.append(np.mean(means))
    low, high = np.quantile(draws, [0.025, 0.975])
    return {
        "macro_delta": float(
            np.mean(
                [
                    np.mean([value for block in by_user[user].values() for value in block])
                    for user in users
                ]
            )
        ),
        "low": float(low),
        "high": float(high),
        "samples": samples,
        "method": "paired reviewer/week bootstrap; descriptive on the development replay",
    }
