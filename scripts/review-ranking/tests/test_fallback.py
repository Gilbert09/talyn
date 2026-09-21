import pytest

from review_rank.fallback import supported_users


def metrics(events, hit3):
    return {"informative": {"per_reviewer": {"user": {"events": events, "hit3": hit3}}}}


@pytest.mark.parametrize(
    "count,learned,reference,enabled",
    [(19, 1, 0, False), (20, 0.8, 0.7, True), (20, 0.7, 0.7, False), (50, 0.6, 0.8, False)],
)
def test_only_supported_positive_earlier_results_enable_model(count, learned, reference, enabled):
    assert bool(supported_users(metrics(count, learned), metrics(count, reference))) is enabled


@pytest.mark.parametrize("reference", [{}, metrics(19, 0)])
def test_missing_or_different_cohort_uses_fallback(reference):
    assert supported_users(metrics(20, 1), reference) == set()


def test_trivial_queues_cannot_enable_model():
    assert (
        supported_users({"per_user": {"user": {"events": 100, "hit3": 1}}}, metrics(100, 0))
        == set()
    )


def test_invalid_minimum_is_rejected():
    with pytest.raises(ValueError, match="positive"):
        supported_users({}, {}, minimum=0)
