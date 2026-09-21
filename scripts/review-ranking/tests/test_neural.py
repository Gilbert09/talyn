from dataclasses import replace

import numpy as np
import pytest
from scipy.optimize import check_grad

from review_rank.experiment import artifact, restore_artifact
from review_rank.features import DAY, Choice
from review_rank.models import Ranker, Spec
from review_rank.neural import PersonalAdjustments, SharedNetwork, layout


def choices(count=30, start=0, user="one"):
    rng = np.random.default_rng(71)
    result = []
    for i in range(count):
        x = rng.normal(size=(5 + i % 3, 3))
        result.append(
            Choice(
                user,
                start + i * DAY,
                tuple(str(k) for k in range(len(x))),
                int(np.argmax(x[:, 0])),
                x,
                np.zeros(len(x)),
                np.zeros(len(x)),
            )
        )
    return result


def test_network_gradient_matches_numerical_derivative():
    model = SharedNetwork(hidden=2)
    model.mean, model.scale = np.zeros(3), np.ones(3)
    rows = choices(3)
    x = model.design(rows)
    parameters = np.linspace(-0.2, 0.2, x.shape[1] * 2 + 4)
    error = check_grad(
        lambda w: model.objective(w, x, layout(rows))[0],
        lambda w: model.objective(w, x, layout(rows))[1],
        parameters,
    )
    assert error < 1e-6


def test_shared_scores_are_equivariant_to_candidate_order():
    train = choices()
    model = SharedNetwork().fit(train)
    row = train[0]
    order = np.array([3, 1, 4, 0, 2])
    reordered = replace(row, keys=tuple(row.keys[i] for i in order), x=row.x[order])
    a, b = model.predict([row, reordered])
    np.testing.assert_allclose(a[order], b, atol=1e-12)
    assert (
        sum(
            np.argmax(scores) == row.chosen
            for row, scores in zip(train, model.predict(train), strict=True)
        )
        > 25
    )


def test_unknown_and_ungated_reviewers_get_exact_shared_scores():
    train = choices()
    shared = SharedNetwork().fit(train)
    personal = PersonalAdjustments(shared).fit(train)
    future = choices(5, 40 * DAY, "unknown")
    for base, adjusted in zip(shared.predict(future), personal.predict(future), strict=True):
        np.testing.assert_array_equal(base, adjusted)
    assert personal.validate(choices(5, 40 * DAY))["one"]["reason"] == "insufficient_history"


@pytest.mark.parametrize("overlap", [0, 10 * DAY, 29 * DAY])
def test_personal_validation_cannot_overlap_training(overlap):
    train = choices()
    personal = PersonalAdjustments(SharedNetwork().fit(train)).fit(train)
    with pytest.raises(ValueError, match="follow training"):
        personal.validate(choices(30, overlap))


class WrongShared:
    def predict(self, rows):
        return [-row.x[:, 0] for row in rows]


def test_personal_gate_requires_gain_and_disables_regression():
    train = choices()
    personal = PersonalAdjustments(WrongShared()).fit(train)
    # Exercise the gate with a controlled residual, independently of fitting quality.
    personal.mean, personal.scale = np.zeros(3), np.ones(3)
    personal.coefficients["one"] = np.array([3.0, 0.0, 0.0])
    gate = choices(30, 40 * DAY)
    assert personal.validate(gate)["one"]["enabled"]
    personal.coefficients["one"] = np.array([-3.0, 0.0, 0.0])
    assert not personal.validate(gate)["one"]["enabled"]
    with pytest.raises(ValueError, match="follow validation"):
        personal.predict(gate)


@pytest.mark.parametrize("kind", ["logit", "neural"])
def test_json_artifact_restores_exact_predictions(kind):
    train = choices()
    shared = SharedNetwork() if kind == "neural" else Ranker(Spec("logit"), np.arange(3))
    personal = PersonalAdjustments(shared.fit(train)).fit(train)
    personal.validate(choices(30, 40 * DAY))
    restored = restore_artifact(artifact(shared, personal))
    future = choices(4, 80 * DAY)
    for a, b in zip(personal.predict(future), restored.predict(future), strict=True):
        np.testing.assert_array_equal(a, b)
