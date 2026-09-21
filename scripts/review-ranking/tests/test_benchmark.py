import json
from dataclasses import replace

import numpy as np
import pytest

from review_rank.data import Dataset, PullRequest, load_cache, timestamp
from review_rank.features import FEATURE_NAMES, Choice, build_choices
from review_rank.metrics import evaluate, event_metrics, paired_interval
from review_rank.models import Ranker, Spec


def pr(key, requests=(1,), reviews=(), closed=None, author="a"):
    return PullRequest(key, author, 0, closed, requests, reviews, False)


def choices(rows, cutoff=100):
    return build_choices(Dataset(cutoff, {"user": rows}, {}, "fixture"))[0]


@pytest.mark.parametrize("requested", [10, 11])
def test_winner_needs_an_earlier_request(requested):
    assert choices([pr("a", (requested,), (10,)), pr("b")]) == []


@pytest.mark.parametrize("closed", [9, 10])
def test_closed_winner_is_not_inserted(closed):
    assert choices([pr("a", reviews=(10,), closed=closed), pr("b")]) == []


def test_future_outcome_does_not_remove_training_alternative():
    result = choices([pr("a", reviews=(10,)), pr("b", reviews=(90,))])
    assert result[0].keys == ("a", "b")


def test_future_history_cannot_change_earlier_features():
    rows = [pr("a", reviews=(10,)), pr("b", reviews=(20,))]
    original = choices(rows)[0]
    future = choices([*rows, pr("c", (50,), (60,))])[0]
    np.testing.assert_array_equal(original.x, future.x)


def test_current_review_does_not_enter_affinity():
    result = choices([pr("a", reviews=(10,)), pr("b")])[0]
    assert np.all(result.x[:, FEATURE_NAMES.index("log_author_reviews")] == 0)


def test_review_rounds_are_separate_and_reset_intervening_reviews():
    result = choices(
        [
            pr("a", (1, 30), (10, 40)),
            pr("b", (1,), (20,)),
            pr("c", (1,)),
        ]
    )
    first, _, second = result
    assert first.at == 10 and second.at == 40
    row = second.x[second.chosen]
    assert row[FEATURE_NAMES.index("log_previous_rounds")] == pytest.approx(np.log(2))
    assert row[FEATURE_NAMES.index("log_intervening_reviews")] == 0


def test_simultaneous_choices_are_not_given_an_artificial_order():
    result, audit = build_choices(
        Dataset(
            100,
            {
                "user": [
                    pr("a", reviews=(10,)),
                    pr("b", reviews=(10,)),
                    pr("c"),
                ]
            },
            {},
            "fixture",
        )
    )
    assert result == []
    assert audit["simultaneous_review_events"] == 2


def test_all_candidates_are_kept():
    rows = [pr(str(i), reviews=(10,) if i == 0 else ()) for i in range(30)]
    assert len(choices(rows)[0].keys) == 30


def test_input_permutation_cannot_change_features():
    rows = [pr("a", reviews=(10,)), pr("b"), pr("c")]
    left, right = choices(rows)[0], choices(rows[::-1])[0]
    assert left.keys == right.keys
    np.testing.assert_array_equal(left.x, right.x)


@pytest.mark.parametrize("size", [2, 3, 5, 30])
def test_constant_model_has_exact_random_expectation(size):
    for chosen in range(size):
        metric = event_metrics(np.zeros(size), chosen)
        assert metric["hit3"] == pytest.approx(min(3 / size, 1))
        assert metric["hit1"] == pytest.approx(1 / size)


@pytest.mark.parametrize(
    "scores,chosen,expected",
    [
        ([3, 2, 1, 0], 3, 0),
        ([3, 2, 1, 0], 2, 1),
        ([3, 2, 1, 1], 2, 0.5),
    ],
)
def test_top_three_boundary(scores, chosen, expected):
    assert event_metrics(np.asarray(scores), chosen)["hit3"] == expected


def test_nonfinite_predictions_fail():
    with pytest.raises(ValueError, match="finite"):
        event_metrics(np.asarray([np.nan, 1]), 0)


def test_naive_timestamp_fails():
    with pytest.raises(ValueError, match="timezone"):
        timestamp("2026-01-01T10:00:00")


@pytest.mark.parametrize(
    "team,truncated,expected", [(True, False, 0), (False, True, 0), (False, False, 1)]
)
def test_raw_cache_requires_direct_complete_history(tmp_path, team, truncated, expected):
    raw = {
        "number": 1,
        "repository": {"nameWithOwner": "owner/repo"},
        "createdAt": "2026-01-01T00:00:00Z",
        "closedAt": None,
        "author": {"login": "author", "__typename": "User"},
        "timelineItems": {
            "nodes": [
                {
                    "createdAt": "2026-01-02T00:00:00Z",
                    "requestedReviewer": {
                        "__typename": "Team" if team else "User",
                        "login": "viewer",
                    },
                }
            ]
        },
        "reviews": {
            "nodes": [{"author": {"login": "viewer"}, "submittedAt": "2026-01-03T00:00:00Z"}]
        },
    }
    if truncated:
        raw["reviews"]["nodes"] *= 20
    legacy = {
        "builtAt": "2026-02-01T00:00:00Z",
        "subjects": [
            {
                "login": "viewer",
                "rows": [{"repoFullName": "owner/repo", "prNumber": 1}],
            }
        ],
    }
    (tmp_path / "dataset.json").write_text(json.dumps(legacy))
    (tmp_path / "cache.json").write_text(json.dumps({"data": {"search": {"nodes": [raw]}}}))
    dataset = load_cache(tmp_path / "dataset.json", tmp_path)
    assert sum(len(row.requests) for row in dataset.subjects["reviewer-1"]) == expected
    assert "viewer" not in json.dumps(dataset.audit)


def synthetic(seed=31, count=70):
    rng = np.random.default_rng(seed)
    result = []
    for index in range(count):
        x = rng.normal(size=(6, 3))
        winner = int(np.argmax(x[:, 0]))
        result.append(
            Choice(
                f"user-{index % 2}",
                index * 86400,
                tuple(map(str, range(6))),
                winner,
                x,
                np.arange(6),
                np.arange(6),
            )
        )
    return result


@pytest.mark.parametrize(
    "spec",
    [
        Spec("logit"),
        Spec("logit", personal=True),
        Spec("lightgbm", iterations=80),
        Spec("catboost", iterations=80),
    ],
)
def test_rankers_learn_signal_and_accept_an_unseen_user(spec):
    train, test = synthetic(), synthetic(seed=41, count=20)
    test = [replace(choice, user="unseen") for choice in test]
    model = Ranker(spec, np.arange(3)).fit(train)
    result, _ = evaluate(test, model.predict(test))
    assert result["macro"]["hit3"] > 0.85


def test_paired_interval_is_reproducible_and_keeps_pairing():
    query = synthetic(count=30)
    zero = paired_interval(query, np.zeros(len(query)), samples=50)
    assert zero["low"] == zero["high"] == 0
    one = paired_interval(query, np.ones(len(query)), samples=50)
    assert one["low"] == one["high"] == 1
    assert one == paired_interval(query, np.ones(len(query)), samples=50)
