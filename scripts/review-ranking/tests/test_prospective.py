import copy
from dataclasses import asdict, replace

import numpy as np
import pytest
from test_outcomes import START, journal, protocol, review, snapshot

from review_rank.experiment import run
from review_rank.features import DAY
from review_rank.outcomes import iso, join
from review_rank.prospective import FEATURES, build_observed, gated_order


def data():
    return join(protocol(), [snapshot()], journal([review()]))


def embeddings(observed=START, head="head"):
    return {
        "schema_version": 1,
        "encoder": {"dimension": 2},
        "records": [
            {
                "repo": "org/repo",
                "number": 1,
                "head_sha": head,
                "observed_at": observed,
                "vector": [1.0, 0.0],
            },
        ],
    }


@pytest.mark.parametrize(
    "at,head,present",
    [
        (START, "head", True),
        (START + 10, "head", True),
        (START + 11, "head", False),
        (START, "future-head", False),
    ],
)
def test_content_needs_matching_revision_and_earlier_observation(at, head, present):
    rows, audit = build_observed([data()], embeddings(at, head))
    assert audit["rows_with_content"] == int(present)
    assert rows[0].choice.x.shape == (5, len(FEATURES) + 4)
    assert rows[0].choice.x[0, FEATURES.index("missing_content")] == int(not present)


def test_newer_content_and_labels_cannot_change_earlier_features():
    source = data()
    earlier, _ = build_observed([source], embeddings())
    later = copy.deepcopy(source["choices"][0])
    later.update(
        at=START + 30, decision_at=START + 40, review_at=START + 40, review_id="later", chosen=1
    )
    source["choices"].append(later)
    vectors = embeddings()
    vectors["records"].append(
        {**vectors["records"][0], "observed_at": START + 25, "vector": [0.0, 1.0]}
    )
    expanded, _ = build_observed([source], vectors)
    np.testing.assert_array_equal(earlier[0].choice.x, expanded[0].choice.x)
    assert expanded[1].choice.x[0, FEATURES.index("missing_recent_content")] == 0


def test_review_after_current_snapshot_is_not_recent_activity():
    source = data()
    source["choices"][0]["review_at"] = START + 100
    later = copy.deepcopy(source["choices"][0])
    later.update(at=START + 30, decision_at=START + 40, review_at=START + 40, review_id="other")
    source["choices"].append(later)
    rows, _ = build_observed([source], embeddings())
    assert rows[1].choice.x[0, FEATURES.index("log_reviews_30d")] == 0


@pytest.mark.parametrize("decision", [None, START + 9, START + 10, START + 21, float("nan")])
def test_model_input_refuses_a_queue_at_or_after_the_review_decision(decision):
    source = data()
    source["choices"][0]["decision_at"] = decision
    with pytest.raises(ValueError, match="precede"):
        build_observed([source])


def test_missing_and_future_times_have_explicit_missing_features():
    source = data()
    candidate = source["choices"][0]["candidates"][0]
    candidate.update(
        request_first_seen_at=iso(START + 50),
        additions=None,
        checks={"passed": 2, "failed": 0, "inProgress": 3},
    )
    rows, _ = build_observed([source])
    x = rows[0].choice.x[0]
    assert x[FEATURES.index("missing_request_age_hours")] == 1
    assert x[FEATURES.index("missing_additions")] == 1
    assert x[FEATURES.index("log_checks_pending")] == np.log1p(3)
    assert rows[0].choice.requested[0] < 0


@pytest.mark.parametrize("fault", ["workspace", "duplicate", "boundary", "vector"])
def test_reject_conflicting_or_invalid_inputs(fault):
    source, vector = [data()], embeddings()
    if fault == "workspace":
        other = copy.deepcopy(source[0])
        other["protocol"]["workspace"] = "other"
        source.append(other)
    elif fault == "duplicate":
        source.append(source[0])
    elif fault == "boundary":
        source[0]["choices"][0]["review_at"] = START
    else:
        vector["records"][0]["vector"] = [float("nan"), 0.0]
    with pytest.raises(ValueError):
        build_observed(source, vector)


def test_gates_cannot_be_crossed_by_any_score_and_ties_survive():
    rows, _ = build_observed([data()])
    row = rows[0]
    row.gates = np.array([3, 2, 2, 1, 0])
    scores = gated_order(row, np.array([-1e99, 0.0, 0.0, 1e50, 1e99]))
    assert scores[0] > scores[1] == scores[2] > scores[3] > scores[4]


def fixture_run():
    p = replace(protocol(), end=START + 70 * DAY)
    rows = []
    for window in range(4):
        for i in range(24):
            at = START + (window * 14 + i / 2) * DAY
            candidates = [dict(item) for item in snapshot().candidates]
            chosen = i % 5
            for k, candidate in enumerate(candidates):
                candidate.update(
                    additions=10 if k == chosen else 200,
                    created_at=iso(at - (k + 1) * DAY),
                    request_first_seen_at=iso(at - (k + 1) * 100),
                )
            rows.append(
                {
                    "at": at,
                    "review_at": at + 60,
                    "decision_at": at + 30,
                    "review_id": f"r-{window}-{i}",
                    "snapshot_id": f"s-{window}-{i}",
                    "chosen": chosen,
                    "candidates": candidates,
                    "header": {},
                }
            )
    return [{"schema_version": 1, "protocol": asdict(p), "choices": rows, "audit": {}}]


def test_four_windows_train_real_models_without_promoting():
    report, model = run(fixture_run(), None, [START + d * DAY for d in [14, 28, 42, 56]])
    assert report["window_choices"] == [24] * 4
    assert not report["promotion"]["allowed"]
    assert not model["serving_allowed"]
    assert model["personal"]["enabled"] == []
    assert report["test"]["shared-queue-network"]["macro"]["hit3"] > 0.9


def test_empty_or_unordered_windows_refuse_training():
    with pytest.raises(ValueError, match="increasing"):
        run(fixture_run(), None, [START] * 4)
    with pytest.raises(ValueError, match="ten decisions"):
        run([data()], None, [START + d * DAY for d in [1, 2, 3, 4]])
