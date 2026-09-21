"""Run reproducible development experiments on the local cache."""

import argparse
import hashlib
import importlib.metadata
import json
import platform
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from threadpoolctl import threadpool_limits

from .data import load_cache
from .features import ACTIVITY_FEATURES, DAY, FEATURE_NAMES, build_choices, summarize_choices
from .metrics import evaluate, paired_interval
from .models import SPECS, Ranker


def iso(at: float) -> str:
    return datetime.fromtimestamp(at, UTC).isoformat()


def selection_score(metrics: dict) -> float:
    value = metrics["queues_over_three"]["macro_hit3"]
    if value is None:
        raise ValueError("Model selection needs queues with more than three candidates")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("artifacts/benchmark.json"))
    parser.add_argument("--seed", type=int, default=71)
    args = parser.parse_args()
    dataset = load_cache(args.dataset, args.cache)
    choices, audit = build_choices(dataset)
    train_start = dataset.cutoff - 180 * DAY
    train_end = dataset.cutoff - 60 * DAY
    validation_end = dataset.cutoff - 30 * DAY
    train = [choice for choice in choices if train_start <= choice.at < train_end]
    validation = [choice for choice in choices if train_end <= choice.at < validation_end]
    replay = [choice for choice in choices if validation_end <= choice.at < dataset.cutoff]
    if min(len(train), len(validation), len(replay)) < 10:
        raise ValueError("Each development window needs at least ten decisions")
    print(
        json.dumps(
            {
                "audit": audit,
                "train": len(train),
                "validation": len(validation),
                "replay": len(replay),
            },
            sort_keys=True,
        ),
        flush=True,
    )
    columns = np.arange(len(FEATURE_NAMES))
    selected = []
    trials = []
    with threadpool_limits(limits=2):
        for spec in SPECS:
            started = time.monotonic()
            model = Ranker(spec, columns, args.seed).fit(train)
            metrics, _ = evaluate(validation, model.predict(validation))
            trials.append({"spec": asdict(spec), "name": spec.name, "metrics": metrics})
            print(
                f"validate {spec.name}: Hit@3 (>3)={selection_score(metrics):.4f} "
                f"({time.monotonic() - started:.1f}s)",
                flush=True,
            )
        for family in ["pooled-logit", "personal-logit", "lightgbm", "catboost"]:
            candidates = [trial for trial in trials if trial["name"].startswith(family)]
            selected.append(max(candidates, key=lambda trial: selection_score(trial["metrics"])))
        winner = max(selected, key=lambda trial: selection_score(trial["metrics"]))["name"]

        results = {}
        event_hits = {}
        for name, predictions in {
            "request-newest": [choice.requested for choice in replay],
            "creation-newest": [choice.created for choice in replay],
            "request-oldest": [-choice.requested for choice in replay],
            "uniform-random-expectation": [np.zeros(len(choice.keys)) for choice in replay],
        }.items():
            results[name], event_hits[name] = evaluate(replay, predictions)
        baseline_validation = {
            name: evaluate(validation, [getattr(choice, field) for choice in validation])[0]
            for name, field in [("request-newest", "requested"), ("creation-newest", "created")]
        }
        baseline = max(
            baseline_validation, key=lambda name: selection_score(baseline_validation[name])
        )
        combined = train + validation
        for trial in selected:
            spec = next(spec for spec in SPECS if spec.name == trial["name"])
            model = Ranker(spec, columns, args.seed).fit(combined)
            results[spec.name], event_hits[spec.name] = evaluate(replay, model.predict(replay))
            print(
                f"replay {spec.name}: Hit@3 (>3)={selection_score(results[spec.name]):.4f}",
                flush=True,
            )

        winner_spec = next(spec for spec in SPECS if spec.name == winner)
        ablations = {}
        groups = {
            "without_activity": set(ACTIVITY_FEATURES),
            "without_affinity": {
                "log_author_reviews",
                "log_author_requests",
                "author_response_rate",
                "log_author_reviews_30d",
                "log_author_reviews_7d",
                "affinity_x_unpassed",
            },
            "without_intervening_reviews": {
                "log_intervening_reviews",
                "is_unpassed",
                "affinity_x_unpassed",
            },
        }
        # Ablations use validation only and do not select a new replay winner.
        for label, removed in groups.items():
            included = np.asarray(
                [i for i, name in enumerate(FEATURE_NAMES) if name not in removed]
            )
            model = Ranker(winner_spec, included, args.seed).fit(train)
            ablations[label], _ = evaluate(validation, model.predict(validation))

        nontrivial = np.asarray([len(choice.keys) > 3 for choice in replay])
        interval = paired_interval(
            [choice for choice in replay if len(choice.keys) > 3],
            (event_hits[winner] - event_hits[baseline])[nontrivial],
            args.seed,
        )
        holdout_users = {}
        for user in sorted({choice.user for choice in validation}):
            prior = [choice for choice in train if choice.user != user]
            unseen = [choice for choice in validation if choice.user == user]
            model = Ranker(winner_spec, columns, args.seed).fit(prior)
            holdout_users[user], _ = evaluate(unseen, model.predict(unseen))

    code_hash = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob("*.py")):
        code_hash.update(path.name.encode())
        code_hash.update(path.read_bytes())
    report = {
        "schema_version": 1,
        "source": "historical_proxy",
        "source_sha256": dataset.source_hash,
        "code_sha256": code_hash.hexdigest(),
        "seed": args.seed,
        "python": platform.python_version(),
        "packages": {
            name: importlib.metadata.version(name)
            for name in ["numpy", "scipy", "lightgbm", "catboost", "scikit-learn"]
        },
        "windows": {
            "train_start": iso(train_start),
            "train_end": iso(train_end),
            "validation_end": iso(validation_end),
            "replay_end": iso(dataset.cutoff),
        },
        "data_audit": dataset.audit,
        "choice_audit": audit,
        "cohorts": {
            "train": summarize_choices(train),
            "validation": summarize_choices(validation),
            "replay": summarize_choices(replay),
        },
        "features": FEATURE_NAMES,
        "trials": trials,
        "baseline_validation": baseline_validation,
        "selected_model": winner,
        "selection_metric": "macro Hit@3 on queues with more than three candidates",
        "selected_baseline": baseline,
        "replay": results,
        "paired_hit3_interval": interval,
        "validation_ablations": ablations,
        "validation_unseen_users": holdout_users,
        "promotion": {
            "allowed": False,
            "reason": "History is incomplete. The replay period was examined before this run.",
            "next_gate": "Complete prospective data and positive evidence of useful outcomes.",
        },
        "limitations": [
            "Direct requests only; historical team membership is unknown.",
            "Request removals and reopen events were not collected.",
            "Search at collection time cannot recover every historical alternative.",
            "Connections with 20 items are excluded because pagination is unknown.",
            "Mutable content and live-state features are excluded.",
            "Submission time is an approximation of decision time.",
            "Bootstrap blocks do not remove every dependence between repeated PRs.",
            "All reported replay results are development evidence, not a new untouched test.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(
        json.dumps(
            {"selected": winner, "baseline": baseline, "interval": interval, "promotion": False}
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
