"""Freeze a shared candidate for a controlled production experiment."""

import argparse
import json
from dataclasses import replace
from pathlib import Path

from threadpoolctl import threadpool_limits

from .features import DAY, FEATURE_NAMES
from .metrics import evaluate
from .neural import SharedNetwork
from .outcomes import digest, required_time
from .replay import build_history_choices, load_history

FEATURES = (
    "log_request_age",
    "recency_quantile",
    "is_newest",
    "in_newest_three",
    "log_creation_age",
    "bot_author",
    "log_queue_size",
    "recency_x_deep_queue",
)


def train(path: Path) -> tuple[dict, dict]:
    source = load_history(path)
    choices, audit = build_history_choices(source)
    columns = [FEATURE_NAMES.index(name) for name in FEATURES]
    choices = [replace(row, x=row.x[:, columns]) for row in choices]
    start = required_time("2026-04-24T00:00:00Z")
    end = required_time("2026-08-24T00:00:00Z")
    train_rows = [row for row in choices if start <= row.at < end and row.outcome_at < end]
    development = [row for row in choices if end <= row.at < end + 28 * DAY]
    with threadpool_limits(limits=1):
        model = SharedNetwork(hidden=32, regularization=0.05, seed=71).fit(train_rows)
    saved = {
        "schemaVersion": 1,
        "usage": "production_experiment",
        "featureNames": list(FEATURES),
        "hidden": model.hidden,
        "mean": model.mean.tolist(),
        "scale": model.scale.tolist(),
        "parameters": model.parameters.tolist(),
        "training": {
            "sourceSha256": digest(source),
            "start": start,
            "end": end,
            "choices": len(train_rows),
            "reviewers": len({r.user for r in train_rows}),
        },
    }
    saved["version"] = "shared-queue-v1-" + digest(saved)[:16]
    metrics, _ = evaluate(development, model.predict(development))
    report = {
        "modelVersion": saved["version"],
        "training": saved["training"],
        "audit": audit,
        "developmentRawModel": metrics,
        "promotionProven": False,
        "limits": [
            "These historical outcomes were used during development.",
            "Historical direct requests differ from live requests first observed by Talyn.",
            "Live readiness rules and the bounded score component need online evaluation.",
            "Features were selected for serving availability, without tuning on these results.",
            "This fixed candidate has no personal residual or content encoder.",
        ],
    }
    return saved, report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    model, report = train(args.history)
    for path, data in ((args.model, model), (args.report, report)):
        with path.open("x") as stream:
            json.dump(data, stream, indent=2, allow_nan=False)
            stream.write("\n")
    print(json.dumps(model["training"]))


if __name__ == "__main__":
    main()
