"""Compare fixed models on successive chronological development windows."""

import argparse
import hashlib
import importlib.metadata
import json
import platform
from collections import Counter, defaultdict
from dataclasses import replace
from pathlib import Path

import numpy as np
from threadpoolctl import threadpool_limits

from .features import DAY, FEATURE_NAMES, Choice
from .historical_content import ALL_FEATURES, add_content
from .metrics import evaluate, paired_interval
from .models import HierarchicalRanker, Ranker, Spec
from .neural import SharedNetwork
from .outcomes import digest, write_private
from .replay import build_history_choices, load_history

SPECS = (
    Spec("logit", regularization=0.001),
    Spec("logit", regularization=0.01),
    Spec("logit", regularization=0.01, personal=True),
    Spec("lightgbm", depth=3, iterations=300),
    Spec("catboost", depth=4),
)


def partition(choices: list[Choice], start: float, end: float) -> list[Choice]:
    return [choice for choice in choices if start <= choice.at < end and choice.outcome_at < end]


def sample_training(choices: list[Choice], fraction: float, seed: int = 71) -> list[Choice]:
    if not 0 < fraction <= 1:
        raise ValueError("Use a training fraction in (0, 1]")
    by_user = defaultdict(list)
    for index, choice in enumerate(choices):
        by_user[choice.user].append(index)
    rng, selected = np.random.default_rng(seed), set()
    for user in sorted(by_user):
        indexes = by_user[user]
        count = max(1, int(np.ceil(len(indexes) * fraction)))
        selected.update(rng.permutation(indexes)[:count].tolist())
    return [choice for index, choice in enumerate(choices) if index in selected]


def summary(choices: list[Choice], scores: list[np.ndarray]) -> dict:
    result, _ = evaluate(choices, scores)
    informative = [i for i, choice in enumerate(choices) if len(choice.keys) > 3]
    if informative:
        metrics, hits = evaluate(
            [choices[i] for i in informative], [scores[i] for i in informative]
        )
        result["informative"] = {
            "decisions": len(informative),
            "reviewers": len(metrics["per_user"]),
            "macro_hit3": metrics["macro"]["hit3"],
            "micro_hit3": metrics["micro"]["hit3"],
            "hits": float(hits.sum()),
            "per_reviewer": metrics["per_user"],
        }
    return result


def score(result: dict) -> float:
    if "informative" not in result:
        raise ValueError("Each comparison needs queues larger than three")
    return result["informative"]["macro_hit3"]


def baseline(choices: list[Choice], name: str) -> list[np.ndarray]:
    if name == "request-newest":
        return [choice.requested for choice in choices]
    if name == "creation-newest":
        return [choice.created for choice in choices]
    if name == "request-oldest":
        return [-choice.requested for choice in choices]
    if name == "random-expectation":
        return [np.zeros(len(choice.keys)) for choice in choices]
    raise ValueError("Unknown baseline")


class ColumnModel:
    def __init__(self, estimator, columns: np.ndarray):
        self.estimator, self.columns = estimator, columns

    def project(self, choices: list[Choice]) -> list[Choice]:
        return [replace(choice, x=choice.x[:, self.columns]) for choice in choices]

    def fit(self, choices: list[Choice]):
        self.estimator.fit(self.project(choices))
        return self

    def predict(self, choices: list[Choice]) -> list[np.ndarray]:
        return self.estimator.predict(self.project(choices))


def models(with_content: bool = False) -> dict:
    columns = np.arange(len(FEATURE_NAMES))
    result = {
        **{spec.name: Ranker(spec, columns) for spec in SPECS},
        "shared-network-32": ColumnModel(SharedNetwork(hidden=32), columns),
        "hierarchical-logit-prior-50": HierarchicalRanker(columns),
    }
    if with_content:
        columns = np.arange(len(ALL_FEATURES))
        for spec in (
            Spec("logit", regularization=0.01),
            Spec("lightgbm", depth=3, iterations=300),
            Spec("catboost", depth=4),
        ):
            result[f"title-{spec.name}"] = Ranker(spec, columns)
        result["title-shared-network-32"] = SharedNetwork(hidden=32)
        result["title-hierarchical-logit-prior-50"] = HierarchicalRanker(columns)
    return result


def diagnostics(
    choices: list[Choice], predictions: list[np.ndarray], reference: list[np.ndarray]
) -> dict:
    _, hits = evaluate(choices, predictions)
    _, base_hits = evaluate(choices, reference)
    keep = np.asarray([len(choice.keys) > 3 for choice in choices])
    retained = [choice for choice in choices if len(choice.keys) > 3]
    delta = (hits - base_hits)[keep]
    counts = Counter(choice.user for choice in retained)
    bins = {}
    for name, lo, hi in [("4-5", 4, 5), ("6-10", 6, 10), ("11+", 11, float("inf"))]:
        indexes = [i for i, choice in enumerate(choices) if lo <= len(choice.keys) <= hi]
        bins[name] = {
            "decisions": len(indexes),
            "model_hits": float(hits[indexes].sum()),
            "baseline_hits": float(base_hits[indexes].sum()),
        }
    return {
        "interval": paired_interval(retained, delta),
        "gains": int((delta > 0).sum()),
        "losses": int((delta < 0).sum()),
        "largest_reviewer_share": max(counts.values()) / len(retained),
        "queue_sizes": bins,
    }


def run(history: dict, timing: str = "created", embeddings: dict | None = None) -> dict:
    code = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob("*.py")):
        code.update(path.name.encode())
        code.update(path.read_bytes())
    choices, audit = build_history_choices(history, timing)
    if embeddings is not None:
        choices = add_content(choices, history, embeddings)
    train_start = history["start"] + 30 * DAY
    baseline_names = ("request-newest", "creation-newest", "request-oldest", "random-expectation")
    folds = []
    all_choices, all_predictions, all_reference = [], [], []
    family_predictions = defaultdict(list)
    for lag in (42, 28, 14, 0):
        test_end = history["end"] - lag * DAY
        tune_end, train_end = test_end - 14 * DAY, test_end - 28 * DAY
        train = partition(choices, train_start, train_end)
        tune = partition(choices, train_end, tune_end)
        test = partition(choices, tune_end, test_end)
        if min(map(len, [train, tune, test])) < 20:
            raise ValueError("Not enough decisions for the fixed development windows")
        print(
            json.dumps({"fold": lag, "train": len(train), "tune": len(tune), "test": len(test)}),
            flush=True,
        )
        validation = {name: summary(tune, baseline(tune, name)) for name in baseline_names}
        selected_baseline = max(baseline_names, key=lambda name: score(validation[name]))
        fitted = models(embeddings is not None)
        for name, model in fitted.items():
            model.fit(train)
            validation[name] = summary(tune, model.predict(tune))
            print(
                json.dumps(
                    {"fold": lag, "model": name, "validation_hit3": score(validation[name])}
                ),
                flush=True,
            )
        selected = max(fitted, key=lambda name: score(validation[name]))
        # Keep the training budget equal. Neither family refits on the selection period.
        predictions = {name: model.predict(test) for name, model in fitted.items()}
        predictions.update({name: baseline(test, name) for name in baseline_names})
        results = {name: summary(test, values) for name, values in predictions.items()}
        counts = Counter(choice.user for choice in train if len(choice.keys) > 3)
        supported = [i for i, choice in enumerate(test) if counts[choice.user] >= 20]
        supported_results = (
            {
                name: summary([test[i] for i in supported], [values[i] for i in supported])
                for name, values in predictions.items()
            }
            if supported
            else {}
        )
        curves, sample_curves = {}, {}
        for fraction in (0.25, 0.5, 1.0):
            recent_start = train_end - (train_end - train_start) * fraction
            subset = partition(train, recent_start, train_end)
            model = Ranker(Spec("logit", regularization=0.01), np.arange(len(FEATURE_NAMES)))
            model.fit(subset)
            curves[str(fraction)] = {
                "training_decisions": len(subset),
                "training_reviewers": len({choice.user for choice in subset}),
                "validation": summary(tune, model.predict(tune)),
            }
            sampled = sample_training(train, fraction)
            model = Ranker(Spec("logit", regularization=0.01), np.arange(len(FEATURE_NAMES)))
            model.fit(sampled)
            sample_curves[str(fraction)] = {
                "training_decisions": len(sampled),
                "validation": summary(tune, model.predict(tune)),
            }
        rng = np.random.default_rng(71)
        shuffled = [replace(choice, chosen=int(rng.integers(len(choice.keys)))) for choice in train]
        control = Ranker(Spec("logit", regularization=0.01), np.arange(len(FEATURE_NAMES))).fit(
            shuffled
        )
        fold = {
            "windows": {
                "train_start": train_start,
                "train_end": train_end,
                "tune_end": tune_end,
                "test_end": test_end,
            },
            "counts": {"train": len(train), "tune": len(tune), "test": len(test)},
            "selected_model": selected,
            "selected_baseline": selected_baseline,
            "validation": validation,
            "evaluation": results,
            "supported_reviewers_evaluation": supported_results,
            "paired": diagnostics(test, predictions[selected], predictions[selected_baseline]),
            "learning_curve": curves,
            "sample_learning_curve": sample_curves,
            "shuffled_training_labels_validation": summary(tune, control.predict(tune)),
        }
        folds.append(fold)
        all_choices.extend(test)
        all_predictions.extend(predictions[selected])
        all_reference.extend(predictions[selected_baseline])
        for name, values in predictions.items():
            family_predictions[name].extend(values)
        print(json.dumps({"fold": lag, "selected": selected, "paired": fold["paired"]}), flush=True)
    return {
        "schema_version": 1,
        "source_sha256": digest(history),
        "code_sha256": code.hexdigest(),
        "python": platform.python_version(),
        "seed": 71,
        "packages": {
            name: importlib.metadata.version(name)
            for name in ("numpy", "scipy", "lightgbm", "catboost", "scikit-learn")
        },
        "decision_time": timing,
        "features": ALL_FEATURES if embeddings is not None else FEATURE_NAMES,
        "title_encoder": embeddings["encoder"] if embeddings is not None else None,
        "audit": audit,
        "folds": folds,
        "combined_selected": summary(all_choices, all_predictions),
        "combined_baseline": summary(all_choices, all_reference),
        "combined_paired": diagnostics(all_choices, all_predictions, all_reference),
        "combined_families": {
            name: {
                "metrics": summary(all_choices, values),
                "paired": diagnostics(all_choices, values, all_reference),
            }
            for name, values in family_predictions.items()
        },
        "promotion_allowed": False,
        "limits": [
            "All windows are development evidence. They are not an untouched final test.",
            "The cohort includes direct human requests only, not team membership.",
            "Historical CI gates, production scores, PR bodies, and diffs are unavailable.",
            "Review creation is an approximation of the actual decision time.",
            "Learning curves use earlier validation, not final evaluation, to assess data needs.",
            "Missing and deleted GitHub records can still affect candidate coverage.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--embeddings", type=Path)
    parser.add_argument("--decision-time", choices=["created", "submitted"], default="created")
    args = parser.parse_args()
    history = load_history(args.history)
    with threadpool_limits(limits=2):
        embeddings = json.loads(args.embeddings.read_text()) if args.embeddings else None
        result = run(history, args.decision_time, embeddings)
    write_private(args.output, result)
    print(json.dumps({"combined": result["combined_paired"], "promotion": False}), flush=True)


if __name__ == "__main__":
    main()
