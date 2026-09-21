from dataclasses import replace

import numpy as np
import pytest

from review_rank.features import Choice
from review_rank.models import HierarchicalRanker


def examples(copies=1):
    return [
        Choice(
            f"{direction}-{copy}",
            float(index),
            ("a", "b", "c", "d"),
            chosen,
            np.asarray([[-2.0], [-1.0], [1.0], [2.0]]),
            np.arange(4),
            np.arange(4),
        )
        for copy in range(copies)
        for direction, chosen in [("left", 0), ("right", 3)]
        for index in range(40)
    ]


def test_personal_model_learns_opposite_preferences_and_preserves_unknown_fallback():
    train = examples()
    model = HierarchicalRanker(np.asarray([0])).fit(train)
    left, right = model.predict([train[0], train[-1]])
    assert left.argmax() == 0
    assert right.argmax() == 3
    unknown = replace(train[0], user="unseen")
    prediction = model.predict([unknown])[0]
    shared = ((unknown.x - model.mean) / model.scale) @ model.coefficients[:1]
    np.testing.assert_allclose(prediction, shared)


def test_larger_pool_does_not_automatically_strengthen_each_personal_prior():
    small = HierarchicalRanker(np.asarray([0])).fit(examples())
    large = HierarchicalRanker(np.asarray([0])).fit(examples(copies=5))
    queries = [examples()[0], examples()[-1]]
    for left, right in zip(small.predict(queries), large.predict(queries), strict=True):
        np.testing.assert_allclose(left, right, atol=1e-4)


@pytest.mark.parametrize("prior", [0, -1])
def test_personal_prior_must_be_positive(prior):
    with pytest.raises(ValueError, match="positive"):
        HierarchicalRanker(np.asarray([0]), prior_decisions=prior)
