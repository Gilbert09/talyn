import copy
import json
from dataclasses import asdict, replace

import numpy as np
import pytest
from test_neural import choices

from review_rank.experiment import artifact, restore_artifact
from review_rank.models import Spec


def saved_model(family="pooled_logit"):
    shared = {
        "family": family,
        "spec": asdict(Spec("logit")),
        "columns": [2, 0],
        "coefficients": [0.3, -0.4],
        "mean": [0.1, 0.2],
        "scale": [1.5, 0.5],
    }
    if family == "shared_network":
        shared = {
            "family": family,
            "hidden": 2,
            "regularization": 0.05,
            "parameters": np.linspace(-0.1, 0.2, 16).tolist(),
            "mean": [0.1, 0.2, 0.3],
            "scale": [1.5, 0.5, 2.0],
            "fit": {"converged": True},
        }
    return {
        "schema_version": 1,
        "serving_allowed": False,
        "shared": shared,
        "feature_names": ["a", "b", "c"],
        "encoder": None,
        "personal": {
            "mean": [0.2, 0.3, 0.4],
            "scale": [0.5, 1.0, 2.0],
            "enabled": ["one"],
            "validation_end": 10,
            "coefficients": {"one": [0.4, 0.1, -0.2], "disabled": [0.5, 0.2, -0.1]},
        },
    }


@pytest.mark.parametrize("family", ["pooled_logit", "shared_network"])
@pytest.mark.parametrize("user", ["one", "disabled", "unknown"])
def test_json_roundtrip_preserves_scores_and_personal_fallback(family, user):
    saved = saved_model(family)
    restored = restore_artifact(saved, expected_features=["a", "b", "c"], expected_encoder=None)
    rows = [replace(row, user=user) for row in choices(4, start=20)]
    actual = restored.predict(rows)
    if user != "one":
        for shared, adjusted in zip(restored.shared.predict(rows), actual, strict=True):
            np.testing.assert_array_equal(shared, adjusted)
    else:
        assert any(
            not np.array_equal(shared, adjusted)
            for shared, adjusted in zip(restored.shared.predict(rows), actual, strict=True)
        )
    again = restore_artifact(json.loads(json.dumps(artifact(restored.shared, restored))))
    for before, after in zip(actual, again.predict(rows), strict=True):
        np.testing.assert_array_equal(before, after)


@pytest.mark.parametrize("field", ["mean", "scale", "coefficients"])
@pytest.mark.parametrize(
    "invalid", [float("nan"), float("inf"), -float("inf"), True, "1", [1], 10**1000]
)
def test_reject_invalid_shared_numbers(field, invalid):
    saved = saved_model()
    saved["shared"][field][0] = invalid
    with pytest.raises(ValueError):
        restore_artifact(saved)


@pytest.mark.parametrize("section", ["shared", "personal"])
@pytest.mark.parametrize("scale", [0, -1])
def test_reject_nonpositive_scales(section, scale):
    saved = saved_model()
    saved[section]["scale"][0] = scale
    with pytest.raises(ValueError, match="positive"):
        restore_artifact(saved)


@pytest.mark.parametrize("columns", [[0.9, 2], [-1, 2], [0, 3], [0, 0], [False, 2], [], ["0", 2]])
def test_reject_invalid_columns_without_coercion(columns):
    saved = saved_model()
    saved["shared"]["columns"] = columns
    with pytest.raises(ValueError, match="columns"):
        restore_artifact(saved)


@pytest.mark.parametrize("family", ["pooled_logit", "shared_network"])
@pytest.mark.parametrize(
    "field", ["shared-mean", "shared-scale", "weights", "personal-scale", "personal-coefficients"]
)
def test_reject_dimension_mismatches(family, field):
    saved = saved_model(family)
    if field.startswith("shared-"):
        saved["shared"][field.removeprefix("shared-")].pop()
    elif field == "weights":
        saved["shared"]["parameters" if family == "shared_network" else "coefficients"].pop()
    elif field == "personal-scale":
        saved["personal"]["scale"].pop()
    else:
        saved["personal"]["coefficients"]["one"].pop()
    with pytest.raises(ValueError, match="dimension"):
        restore_artifact(saved)


@pytest.mark.parametrize("hidden", [0, -1, 1.5, True, "2"])
def test_reject_invalid_network_width(hidden):
    saved = saved_model("shared_network")
    saved["shared"]["hidden"] = hidden
    with pytest.raises(ValueError):
        restore_artifact(saved)


@pytest.mark.parametrize(
    "fault",
    [
        "schema",
        "allowed",
        "shared",
        "personal",
        "family",
        "enabled-duplicate",
        "enabled-missing",
        "identity",
        "date",
        "names",
        "regularization",
        "spec",
    ],
)
def test_reject_malformed_model_contracts(fault):
    saved = saved_model()
    if fault == "schema":
        saved["schema_version"] = True
    elif fault == "allowed":
        saved["serving_allowed"] = True
    elif fault in {"shared", "personal"}:
        saved[fault] = None
    elif fault == "family":
        saved["shared"]["family"] = "unknown"
    elif fault == "enabled-duplicate":
        saved["personal"]["enabled"].append("one")
    elif fault == "enabled-missing":
        saved["personal"]["enabled"].append("absent")
    elif fault == "identity":
        saved["personal"]["coefficients"][""] = [0, 0, 0]
    elif fault == "date":
        saved["personal"]["validation_end"] = float("nan")
    elif fault == "names":
        saved["feature_names"] = ["a", "a", "c"]
    elif fault == "regularization":
        saved["shared"]["spec"]["regularization"] = -1
    else:
        saved["shared"]["spec"]["family"] = "catboost"
    with pytest.raises(ValueError):
        restore_artifact(saved)


def test_input_contract_must_match_feature_order_and_encoder():
    saved = saved_model()
    with pytest.raises(ValueError, match="feature order"):
        restore_artifact(saved, expected_features=["b", "a", "c"])
    saved["encoder"] = {"model": "example", "revision": "one", "max_chunks": 16}
    with pytest.raises(ValueError, match="encoder"):
        restore_artifact(saved, expected_encoder=None)
    for key, value in {"revision": "two", "max_chunks": 128}.items():
        expected = {**saved["encoder"], key: value}
        with pytest.raises(ValueError, match="encoder"):
            restore_artifact(saved, expected_encoder=expected)
    restore_artifact(saved, expected_encoder=copy.deepcopy(saved["encoder"]))


def test_personal_weights_cannot_be_saved_with_another_shared_model():
    first, other = [restore_artifact(saved_model()) for _ in range(2)]
    with pytest.raises(ValueError, match="belong"):
        artifact(first.shared, other)
