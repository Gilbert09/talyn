"""Explore an earlier-validation fallback and reproduce the selected model results."""

import argparse
import hashlib
import json
from pathlib import Path

from threadpoolctl import threadpool_limits

from .historical_content import add_content
from .outcomes import digest, write_private
from .replay import build_history_choices, load_history
from .rolling import baseline, diagnostics, models, partition, summary


def supported_users(model: dict, reference: dict, minimum: int = 20) -> set[str]:
    """Require earlier informative choices and a positive observed personal gain."""
    if minimum < 1:
        raise ValueError("The minimum must be positive")
    selected = model.get("informative", {}).get("per_reviewer", {})
    base = reference.get("informative", {}).get("per_reviewer", {})
    return {
        user
        for user, values in selected.items()
        if user in base
        and values["events"] >= minimum
        and values["events"] == base[user]["events"]
        and values["hit3"] > base[user]["hit3"]
    }


def run(history: dict, embeddings: dict, report: dict) -> dict:
    if report["source_sha256"] != digest(history):
        raise ValueError("The report must match the historical source")
    choices, _ = build_history_choices(history, report["decision_time"])
    choices = add_content(choices, history, embeddings)
    all_choices, all_scores, all_reference, folds = [], [], [], []
    for fold in report["folds"]:
        window = fold["windows"]
        train = partition(choices, window["train_start"], window["train_end"])
        tune = partition(choices, window["train_end"], window["tune_end"])
        test = partition(choices, window["tune_end"], window["test_end"])
        name, base_name = fold["selected_model"], fold["selected_baseline"]
        model = models(with_content=True)[name].fit(train)
        tune_scores, test_scores = model.predict(tune), model.predict(test)
        validation = summary(tune, tune_scores)
        evaluation = summary(test, test_scores)
        if validation != fold["validation"][name] or evaluation != fold["evaluation"][name]:
            raise ValueError("The selected model does not reproduce the earlier report")
        eligible = supported_users(validation, summary(tune, baseline(tune, base_name)))
        reference = baseline(test, base_name)
        scores = [
            learned if choice.user in eligible else default
            for choice, learned, default in zip(test, test_scores, reference, strict=True)
        ]
        folds.append(
            {
                "windows": window,
                "selected_model": name,
                "selected_baseline": base_name,
                "eligible_reviewers": sorted(eligible),
                "learned_decisions": sum(choice.user in eligible for choice in test),
                "evaluation": summary(test, scores),
                "paired": diagnostics(test, scores, reference),
            }
        )
        all_choices.extend(test)
        all_scores.extend(scores)
        all_reference.extend(reference)
        print(json.dumps({"completed_window": window["test_end"]}), flush=True)
    return {
        "source_sha256": digest(history),
        "original_report_sha256": digest(report),
        "policy_code_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "decision_time": report["decision_time"],
        "minimum_informative_validation_choices": 20,
        "rule": "Use the selected model only with a positive earlier personal Hit@3 gain.",
        "selected_results_reproduced": True,
        "folds": folds,
        "combined": summary(all_choices, all_scores),
        "paired": diagnostics(all_choices, all_scores, all_reference),
        "promotion_allowed": False,
        "limits": [
            "This policy was proposed after the original development results were inspected.",
            "The minimum and positive point estimate are a heuristic, not a confidence gate.",
            "Global selection and personal screening share the earlier validation window.",
            "A separate future evaluation must test the frozen policy before production use.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--embeddings", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    with threadpool_limits(limits=2):
        result = run(
            load_history(args.history),
            json.loads(args.embeddings.read_text()),
            json.loads(args.report.read_text()),
        )
    write_private(args.output, result)
    print(json.dumps(result["paired"]))


if __name__ == "__main__":
    main()
