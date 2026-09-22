"""Compare shared and personal models on four fixed forward windows."""

import argparse
import hashlib
import importlib.metadata
import json
import math
from collections import Counter
from dataclasses import asdict
from pathlib import Path

import numpy as np
from threadpoolctl import threadpool_limits

from .benchmark import selection_score
from .metrics import evaluate, paired_interval
from .models import Ranker, Spec
from .neural import PersonalAdjustments, SharedNetwork
from .outcomes import digest, required_time, write_private
from .parity import production_baselines
from .prospective import FEATURES, build_observed, gated_order


def artifact(model, personal: PersonalAdjustments) -> dict:
    if personal.shared is not model:
        raise ValueError("Personal adjustments must belong to the saved shared model")
    if isinstance(model, SharedNetwork):
        shared = {
            "family": "shared_network",
            "hidden": model.hidden,
            "regularization": model.regularization,
            "parameters": model.parameters.tolist(),
            "fit": model.fit_info,
        }
    else:
        shared = {
            "family": "pooled_logit",
            "spec": asdict(model.spec),
            "columns": model.columns.tolist(),
            "coefficients": model.coefficients.tolist(),
        }
    shared.update(mean=model.mean.tolist(), scale=model.scale.tolist())
    return {
        "schema_version": 1,
        "shared": shared,
        "personal": {
            "mean": personal.mean.tolist(),
            "scale": personal.scale.tolist(),
            "enabled": sorted(personal.enabled),
            "coefficients": {
                user: values.tolist() for user, values in personal.coefficients.items()
            },
            "validation_end": personal.validation_end,
        },
        "serving_allowed": False,
    }


_UNSPECIFIED_ENCODER = object()


def finite_number(value: object, name: str) -> float:
    if type(value) not in {int, float}:
        raise ValueError(f"{name} must be a finite number")
    try:
        result = float(value)
    except OverflowError:
        raise ValueError(f"{name} must be a finite number") from None
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number")
    return result


def numeric_vector(value: object, name: str, length: int | None = None) -> np.ndarray:
    if not isinstance(value, list) or not value or (length is not None and len(value) != length):
        raise ValueError(f"Invalid {name} dimension")
    return np.asarray([finite_number(item, name) for item in value], dtype=float)


def positive_scale(value: object, name: str, length: int) -> np.ndarray:
    result = numeric_vector(value, name, length)
    if np.any(result <= 0):
        raise ValueError(f"{name} must be positive")
    return result


def restore_artifact(
    saved: dict,
    *,
    expected_features: list[str] | None = None,
    expected_encoder: object = _UNSPECIFIED_ENCODER,
) -> PersonalAdjustments:
    """Restore a local experiment without executable pickle data."""
    if (
        not isinstance(saved, dict)
        or type(saved.get("schema_version")) is not int
        or saved["schema_version"] != 1
        or saved.get("serving_allowed") is not False
    ):
        raise ValueError("Expected a version 1 offline artifact")
    source, adjustment = saved.get("shared"), saved.get("personal")
    if not isinstance(source, dict) or not isinstance(adjustment, dict):
        raise ValueError("Shared and personal model records are required")
    mean = numeric_vector(adjustment.get("mean"), "personal mean")
    dimension = len(mean)
    scale = positive_scale(adjustment.get("scale"), "personal scale", dimension)
    names = saved.get("feature_names")
    if names is not None and (
        not isinstance(names, list)
        or len(names) != dimension
        or any(not isinstance(name, str) or not name for name in names)
        or len(set(names)) != len(names)
    ):
        raise ValueError("Feature names must identify every input column once")
    if expected_features is not None and names != expected_features:
        raise ValueError("The saved feature order does not match the input contract")
    if expected_encoder is not _UNSPECIFIED_ENCODER and digest(saved.get("encoder")) != digest(
        expected_encoder
    ):
        raise ValueError("The saved encoder does not match the input contract")

    if source.get("family") == "shared_network":
        hidden = source.get("hidden")
        regularization = finite_number(source.get("regularization"), "regularization")
        if type(hidden) is not int or hidden < 1 or regularization < 0:
            raise ValueError("Invalid shared network configuration")
        shared = SharedNetwork(hidden, regularization)
        shared.parameters = numeric_vector(
            source.get("parameters"),
            "network parameters",
            (2 * dimension + 2) * hidden,
        )
        shared.fit_info = source.get("fit", {})
        shared_width = dimension
    elif source.get("family") == "pooled_logit":
        try:
            spec = Spec(**source["spec"])
        except (KeyError, TypeError):
            raise ValueError("Invalid shared logistic configuration") from None
        regularization = finite_number(spec.regularization, "regularization")
        if spec.family != "logit" or spec.personal is not False or regularization < 0:
            raise ValueError("Expected shared logistic coefficients")
        columns = source.get("columns")
        if (
            not isinstance(columns, list)
            or not columns
            or any(type(column) is not int or not 0 <= column < dimension for column in columns)
            or len(set(columns)) != len(columns)
        ):
            raise ValueError("Invalid shared feature columns")
        shared = Ranker(spec, np.asarray(columns, dtype=int))
        shared_width = len(columns)
        shared.coefficients = numeric_vector(
            source.get("coefficients"), "shared coefficients", shared_width
        )
        shared.users = {}
    else:
        raise ValueError("Unknown shared model")
    shared.mean = numeric_vector(source.get("mean"), "shared mean", shared_width)
    shared.scale = positive_scale(source.get("scale"), "shared scale", shared_width)
    personal = PersonalAdjustments(shared)
    personal.mean, personal.scale = mean, scale
    coefficients, enabled = adjustment.get("coefficients"), adjustment.get("enabled")
    if (
        not isinstance(coefficients, dict)
        or any(not isinstance(user, str) or not user for user in coefficients)
        or not isinstance(enabled, list)
        or any(not isinstance(user, str) or not user for user in enabled)
        or len(set(enabled)) != len(enabled)
    ):
        raise ValueError("Invalid personal model identities")
    personal.coefficients = {
        user: numeric_vector(values, "personal coefficients", dimension)
        for user, values in coefficients.items()
    }
    personal.enabled = set(enabled)
    personal.validation_end = finite_number(adjustment.get("validation_end"), "validation end")
    if not personal.enabled <= personal.coefficients.keys():
        raise ValueError("Missing enabled personal coefficients")
    return personal


def run(joined: list[dict], embeddings: dict | None, boundaries: list[float]) -> tuple[dict, dict]:
    if len(boundaries) != 4 or any(
        a >= b for a, b in zip(boundaries, boundaries[1:], strict=False)
    ):
        raise ValueError("Use four increasing window ends")
    observed, audit = build_observed(joined, embeddings)
    if any(data["protocol"]["end"] < boundaries[-1] for data in joined):
        raise ValueError("Every outcome journal must cover the full test window")
    windows = []
    start = float("-inf")
    for end in boundaries:
        rows = [
            row
            for row in observed
            if start <= row.choice.at < end and row.review_at < end and np.all(row.gates >= 0)
        ]
        if len(rows) < 10 or not any(len(row.choice.keys) > 3 for row in rows):
            raise ValueError(
                "Each window needs ten decisions and queues larger than three with gates"
            )
        windows.append(rows)
        start = end
    train_rows, tune_rows, personal_rows, test_rows = windows
    train, tune, personal_window, test = [[row.choice for row in rows] for rows in windows]
    selected_ids = {row.review_id for rows in windows for row in rows}
    production_orders, production_evidence = production_baselines(
        [row for data in joined for row in data["choices"] if row["review_id"] in selected_ids]
    )
    audit["missing_gate_choices"] = sum(bool(np.any(row.gates < 0)) for row in observed)
    audit["boundary_or_outside_choices"] = (
        len(observed) - sum(map(len, windows)) - audit["missing_gate_choices"]
    )

    def predictions(rows, model):
        return [
            gated_order(row, scores)
            for row, scores in zip(rows, model.predict([row.choice for row in rows]), strict=True)
        ]

    models = {
        "pooled-observed": Ranker(Spec("logit", regularization=0.01), np.arange(len(FEATURES) - 3)),
        "shared-queue-network": SharedNetwork(),
    }
    if embeddings is not None:
        models["pooled-with-content"] = Ranker(
            Spec("logit", regularization=0.01), np.arange(train[0].x.shape[1])
        )
    trials = {}
    for name, model in models.items():
        model.fit(train)
        trials[name] = evaluate(tune, predictions(tune_rows, model))[0]
    winner = max(trials, key=lambda name: selection_score(trials[name]))
    # No refit after selection: the personal gate validates these exact shared weights.
    selected = models[winner]
    personal = PersonalAdjustments(selected).fit(train)
    personal_by_id = {id(row.choice): row for row in personal_rows}
    personal.validate(
        personal_window, lambda choice, scores: gated_order(personal_by_id[id(choice)], scores)
    )
    results, hits = {}, {}
    for name, model in {**models, "selected-with-personal": personal}.items():
        results[name], hits[name] = evaluate(test, predictions(test_rows, model))

    def baselines(rows):
        return {
            "production-priority": [
                -np.asarray(
                    [production_orders[row.review_id].index(key) for key in row.choice.keys]
                )
                for row in rows
            ],
            "displayed-order": [row.displayed for row in rows],
            "observed-request-newest-raw": [row.choice.requested for row in rows],
            "creation-newest-raw": [row.choice.created for row in rows],
            "observed-request-newest": [gated_order(row, row.choice.requested) for row in rows],
            "creation-newest": [gated_order(row, row.choice.created) for row in rows],
        }

    baseline_validation = {
        name: evaluate(tune, values)[0] for name, values in baselines(tune_rows).items()
    }
    baseline = max(baseline_validation, key=lambda name: selection_score(baseline_validation[name]))
    for name, values in baselines(test_rows).items():
        results[name], hits[name] = evaluate(test, values)
    informative = np.asarray([len(choice.keys) > 3 for choice in test])
    interval = paired_interval(
        [choice for choice in test if len(choice.keys) > 3],
        (hits["selected-with-personal"] - hits[baseline])[informative],
    )
    interval["method"] = "paired reviewer/week bootstrap; descriptive development comparison"
    final = predictions(test_rows, personal)
    slices = {}
    for name, indices in {
        "team_requested": [i for i, row in enumerate(test_rows) if row.team],
        "returning": [i for i, row in enumerate(test_rows) if row.returning],
        "priority_sort": [i for i, row in enumerate(test_rows) if row.sort_mode == "priority"],
        "queues_over_ten": [i for i, row in enumerate(test_rows) if len(row.choice.keys) > 10],
        "unseen_reviewers": [
            i
            for i, row in enumerate(test_rows)
            if row.choice.user not in {choice.user for choice in train}
        ],
    }.items():
        slices[name] = (
            evaluate([test[i] for i in indices], [final[i] for i in indices])[0]
            if indices
            else {"events": 0}
        )
    code_hash = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob("*.py")):
        code_hash.update(path.name.encode())
        code_hash.update(path.read_bytes())
    report = {
        "schema_version": 1,
        "source": "prospective_development",
        "joined_sha256": digest(joined),
        "embeddings_sha256": digest(embeddings),
        "code_sha256": code_hash.hexdigest(),
        "seed": 71,
        "packages": {name: importlib.metadata.version(name) for name in ["numpy", "scipy"]},
        "window_ends": boundaries,
        "window_choices": list(map(len, windows)),
        "audit": audit,
        "sessions": dict(sum((Counter(data["audit"]) for data in joined), Counter())),
        "features": [
            *FEATURES,
            *[f"content_{i}" for i in range(audit["embedding_dimension"])],
            *[f"recent_content_product_{i}" for i in range(audit["embedding_dimension"])],
        ],
        "encoder": embeddings["encoder"] if embeddings else None,
        "validation": trials,
        "selected_shared": winner,
        "personal_validation": personal.validation,
        "baseline_validation": baseline_validation,
        "selected_baseline": baseline,
        "production_replay": production_evidence,
        "test": results,
        "slices": slices,
        "paired_interval": interval,
        "promotion": {
            "allowed": False,
            "reason": "Development only. Freeze a fresh product evaluation.",
        },
        "limits": [
            "The production baseline uses the actual scorer, caps, and comparator.",
            "Candidate models preserve gates but do not establish production serving parity.",
            "Request age starts at first observation, not the GitHub request event.",
            "Recent activity includes joined decisions only.",
            "Team eligibility is taken from the observed application queue.",
            "Request rounds and deleted review history remain unknown.",
        ],
    }
    saved = artifact(selected, personal)
    saved["feature_names"] = report["features"]
    saved["encoder"] = report["encoder"]
    restored = restore_artifact(
        json.loads(json.dumps(saved, allow_nan=False)),
        expected_features=report["features"],
        expected_encoder=report["encoder"],
    )
    if any(
        not np.array_equal(before, after)
        for before, after in zip(personal.predict(test), restored.predict(test), strict=True)
    ):
        raise ValueError("The saved model changed predictions after restoration")
    report["artifact_validation"] = {"exact_score_roundtrip": True, "choices": len(test)}
    saved["report_sha256"] = digest(report)
    return report, saved


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--joined", type=Path, nargs="+", required=True)
    parser.add_argument("--embeddings", type=Path)
    for name in ["train-end", "tune-end", "personal-end", "test-end"]:
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-output", type=Path, required=True)
    args = parser.parse_args()
    joined = [json.loads(path.read_text()) for path in args.joined]
    embeddings = json.loads(args.embeddings.read_text()) if args.embeddings else None
    ends = [
        required_time(getattr(args, name))
        for name in ["train_end", "tune_end", "personal_end", "test_end"]
    ]
    with threadpool_limits(limits=2):
        report, saved = run(joined, embeddings, ends)
    write_private(args.output, report)
    write_private(args.model_output, saved)
    print(
        json.dumps(
            {
                "selected_shared": report["selected_shared"],
                "personal_enabled": len(saved["personal"]["enabled"]),
                "promotion_allowed": False,
            }
        )
    )


if __name__ == "__main__":
    main()
