import json
from types import SimpleNamespace

import pytest
from test_snapshots import events

from review_rank.parity import check, production_baselines


def export(tmp_path, entries):
    path = tmp_path / "queue.json"
    path.write_text(json.dumps({"schema_version": 1, "events": entries}))
    return path


def test_wrapper_preserves_trace_and_does_not_authorize_promotion(tmp_path, monkeypatch):
    entries = events(1)
    entries[0]["properties"]["candidates"][0]["priority_trace"] = {"source": "server"}
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"all_passed": True, "counts": {}, "snapshots": []}),
        )

    monkeypatch.setattr("review_rank.parity.subprocess.run", run)
    result = check(export(tmp_path, entries))
    payload = json.loads(calls[0][1]["input"])
    assert payload[0]["candidates"][0]["priority_trace"] == {"source": "server"}
    assert payload[0]["sort_mode"] == "newest"
    assert calls[0][0][0] == "node"
    assert len(result["export_sha256"]) == 64
    assert result["all_passed"] is True
    assert result["promotion_allowed"] is False


@pytest.mark.parametrize("fault", ["incomplete", "invalid"])
def test_invalid_exports_do_not_reach_replay(tmp_path, monkeypatch, fault):
    entries = events(26)
    if fault == "incomplete":
        entries.pop()
    else:
        entries.append(None)

    def run(*args, **kwargs):
        pytest.fail("Invalid exports must not reach the scorer")

    monkeypatch.setattr("review_rank.parity.subprocess.run", run)
    with pytest.raises(ValueError, match="complete export"):
        check(export(tmp_path, entries))


def test_runtime_failure_does_not_expose_private_output(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "review_rank.parity.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout="private", stderr="private"),
    )
    with pytest.raises(ValueError, match="build @talyn/shared") as error:
        check(export(tmp_path, events(1)))
    assert "private" not in str(error.value)


def choices():
    return [
        {
            "review_id": "review",
            "at": 1_000_000_000,
            "header": {"sort_mode": "newest"},
            "candidates": [{"pr_id": "a"}, {"pr_id": "b"}],
        }
    ]


def replay_result():
    return {
        "all_passed": True,
        "scorer_version": "test",
        "bridge_sha256": "b" * 64,
        "runtime_sha256": "a" * 64,
        "snapshots": [
            {
                "snapshot_id": "review",
                "passed": True,
                "order_checked": False,
                "priority_order": ["b", "a"],
            }
        ],
    }


def test_baseline_uses_replayed_order_instead_of_the_display_order(monkeypatch):
    requests = []

    def replay(payload):
        requests.append(payload)
        return replay_result()

    monkeypatch.setattr("review_rank.parity.replay", replay)
    orders, evidence = production_baselines(choices())
    assert orders == {"review": ["b", "a"]}
    assert requests[0][0]["sort_mode"] == "newest"
    assert requests[0][0]["candidates"] == choices()[0]["candidates"]
    assert evidence["choices"] == 1
    assert evidence["runtime_sha256"] == "a" * 64
    assert len(evidence["payload_sha256"]) == len(evidence["orders_sha256"]) == 64


@pytest.mark.parametrize(
    "fault", ["failed", "missing", "unknown", "duplicate", "partial", "wrong", "null", "unpassed"]
)
def test_incomplete_replay_cannot_supply_a_baseline(monkeypatch, fault):
    result = replay_result()
    row = result["snapshots"][0]
    if fault == "failed":
        result["all_passed"] = False
    elif fault == "missing":
        result["snapshots"] = []
    elif fault == "unknown":
        row["snapshot_id"] = "other"
    elif fault == "duplicate":
        result["snapshots"].append(dict(row))
    elif fault == "partial":
        row["priority_order"] = ["b"]
    elif fault == "wrong":
        row["priority_order"] = ["b", "b"]
    elif fault == "null":
        row["priority_order"] = None
    else:
        row["passed"] = False
    monkeypatch.setattr("review_rank.parity.replay", lambda _payload: result)
    with pytest.raises(ValueError, match="production|Production"):
        production_baselines(choices())


@pytest.mark.parametrize("fault", ["empty", "duplicate", "unknown-mode", "duplicate-candidate"])
def test_invalid_baseline_choices_fail_before_replay(monkeypatch, fault):
    rows = choices()
    if fault == "empty":
        rows = []
    elif fault == "duplicate":
        rows.append(dict(rows[0]))
    elif fault == "unknown-mode":
        rows[0]["header"] = {}
    else:
        rows[0]["candidates"].append(dict(rows[0]["candidates"][0]))

    def fail(_payload):
        pytest.fail("Invalid choices must not reach the runtime")

    monkeypatch.setattr("review_rank.parity.replay", fail)
    with pytest.raises(ValueError):
        production_baselines(rows)
