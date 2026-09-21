import json
from types import SimpleNamespace

import pytest
from test_snapshots import events

from review_rank.parity import check


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
