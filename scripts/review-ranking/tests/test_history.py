import json
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest

from review_rank.features import FEATURE_NAMES
from review_rank.historical_content import CONTENT_FEATURES, add_content, title_at, title_history
from review_rank.history import (
    HistoryAPI,
    collect_history,
    complete_connection,
    inventory,
    state_matches,
)
from review_rank.history_audit import expected_queue
from review_rank.outcomes import digest, iso
from review_rank.replay import build_history_choices, load_history
from review_rank.rolling import diagnostics, partition, sample_training, summary


def actor(login="viewer"):
    return {"login": login, "__typename": "User"}


def event(kind="ReviewRequestedEvent", at=1, login="viewer"):
    return {
        "id": f"{kind}:{at}:{login}",
        "__typename": kind,
        "createdAt": iso(at),
        "requestedReviewer": actor(login),
    }


def review(start=10, end=10, login="viewer"):
    return {
        "id": f"review:{start}:{login}",
        "createdAt": iso(start),
        "submittedAt": iso(end),
        "author": actor(login),
        "state": "APPROVED",
    }


def pull(number, events=None, reviews=None, draft=False):
    return {
        "id": str(number),
        "number": number,
        "createdAt": iso(0),
        "isDraft": draft,
        "closedAt": None,
        "author": actor(f"author-{number}"),
        "title": f"fix(area): change {number}",
        "events": [event()] if events is None else events,
        "reviews": [] if reviews is None else reviews,
    }


def corpus(pulls):
    return {
        "schema_version": 1,
        "source": "repository_history",
        "complete": True,
        "repo": "owner/repo",
        "start": 0,
        "end": 100,
        "pulls": pulls,
        "inventory": {"ids_sha256": digest(sorted(p["id"] for p in pulls))},
    }


def replay(pulls, timing="created"):
    return build_history_choices(corpus(pulls), timing)


@pytest.mark.parametrize(
    "kind", ["ReviewRequestRemovedEvent", "ClosedEvent", "MergedEvent", "ConvertToDraftEvent"]
)
def test_removed_or_unavailable_alternative_leaves_queue(kind):
    choices, _ = replay(
        [
            pull(1, reviews=[review()]),
            pull(2, events=[event(), event(kind, 5)]),
            pull(3),
        ]
    )
    assert choices[0].keys == ("owner/repo#1", "owner/repo#3")


def test_never_reviewed_and_no_longer_requested_pr_is_an_earlier_alternative():
    choices, _ = replay(
        [
            pull(1, reviews=[review()]),
            pull(2, events=[event(), event("ReviewRequestRemovedEvent", 20)]),
        ]
    )
    assert choices[0].keys == ("owner/repo#1", "owner/repo#2")


@pytest.mark.parametrize(
    "first,second",
    [("ClosedEvent", "ReopenedEvent"), ("ConvertToDraftEvent", "ReadyForReviewEvent")],
)
def test_reopening_restores_pending_request(first, second):
    choices, _ = replay(
        [
            pull(1, reviews=[review()]),
            pull(2, events=[event(), event(first, 3), event(second, 7)]),
        ]
    )
    assert len(choices[0].keys) == 2


def test_initial_draft_is_reconstructed_from_first_ready_event():
    choices, _ = replay(
        [
            pull(1, reviews=[review()]),
            pull(2, events=[event(), event("ReadyForReviewEvent", 20)]),
            pull(3),
        ]
    )
    assert choices[0].keys == ("owner/repo#1", "owner/repo#3")


def test_review_start_prevents_later_requests_entering_the_choice():
    pulls = [pull(1, reviews=[review(10, 30)]), pull(2), pull(3, events=[event(at=20)])]
    earlier, _ = replay(pulls)
    later, _ = replay(pulls, "submitted")
    assert earlier[0].keys == ("owner/repo#1", "owner/repo#2")
    assert len(later[0].keys) == 3
    assert earlier[0].outcome_at == 30


def test_started_review_is_not_prior_completed_work():
    choices, _ = replay(
        [
            pull(1, reviews=[review(10, 30)]),
            pull(2, reviews=[review(20, 25)]),
            pull(3),
        ]
    )
    assert [choice.at for choice in choices] == [10, 20]
    assert len(choices[1].keys) == 3
    assert choices[1].x[:, FEATURE_NAMES.index("log_author_reviews")].sum() == 0


@pytest.mark.parametrize("requested", [10, 11])
def test_same_time_or_later_request_cannot_make_winner_eligible(requested):
    choices, audit = replay([pull(1, events=[event(at=requested)], reviews=[review()]), pull(2)])
    assert not choices
    assert audit["review_outside_direct_queue"] == 1


def test_future_outcomes_do_not_change_earlier_features():
    rows = [pull(1, reviews=[review()]), pull(2), pull(3)]
    original, _ = replay(rows)
    changed = deepcopy(rows)
    changed[1]["reviews"] = [review(50, 60)]
    changed[2]["events"].append(event("ReviewRequestRemovedEvent", 70))
    later, _ = replay(changed)
    np.testing.assert_array_equal(original[0].x, later[0].x)
    assert original[0].keys == later[0].keys


def test_request_round_restarts_after_removal():
    choices, _ = replay(
        [
            pull(1, reviews=[review(30, 30)]),
            pull(2, events=[event(), event("ReviewRequestRemovedEvent", 5), event(at=20)]),
        ]
    )
    assert choices[0].requested.tolist() == [1, 20]
    assert choices[0].x[1, FEATURE_NAMES.index("log_requests_this_round")] == pytest.approx(
        np.log(2)
    )


def test_ambiguous_simultaneous_reviews_do_not_invent_order():
    choices, audit = replay([pull(1, reviews=[review()]), pull(2, reviews=[review()]), pull(3)])
    assert not choices
    assert audit["simultaneous_decisions"] == 2


def test_outcome_crossing_window_cannot_enter_training():
    choices, _ = replay([pull(1, reviews=[review(10, 30)]), pull(2)])
    assert partition(choices, 0, 20) == []
    assert partition(choices, 0, 30) == []
    assert len(partition(choices, 0, 31)) == 1


def test_team_requests_do_not_become_direct_requests():
    request = event()
    request["requestedReviewer"] = {"__typename": "Team", "combinedSlug": "owner/team"}
    choices, audit = replay([pull(1, reviews=[review()]), pull(2, events=[request])])
    assert not choices
    assert audit["nonhuman_or_team_request_events"] == 1


def test_input_permutation_does_not_change_ranking_features():
    rows = [pull(1, reviews=[review()]), pull(2), pull(3)]
    left, _ = replay(rows)
    right, _ = replay(rows[::-1])
    assert left[0].keys == right[0].keys
    np.testing.assert_array_equal(left[0].x, right[0].x)


def test_loader_refuses_inventory_mismatch(tmp_path):
    data = corpus([pull(1), pull(2)])
    data["pulls"].pop()
    path = tmp_path / "history.json"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="inventory"):
        load_history(path)


class FakeAPI:
    def __init__(self, responses):
        self.responses = iter(responses)

    def query(self, *args):
        return next(self.responses)


def connection(nodes, total=None, cursor=None):
    return {
        "nodes": nodes,
        "totalCount": len(nodes) if total is None else total,
        "pageInfo": {"hasNextPage": cursor is not None, "endCursor": cursor},
    }


def test_history_connection_reads_all_pages():
    node = {"id": "pr", "reviews": connection([{"id": "1"}], 2, "next")}
    api = FakeAPI([{"node": {"reviews": connection([{"id": "2"}], 2)}}])
    assert complete_connection(api, node, "reviews") == [{"id": "1"}, {"id": "2"}]


def test_timeline_uses_filtered_count_not_total_count():
    events = connection([{"id": "requested"}])
    events.update(totalCount=100, filteredCount=1)
    assert complete_connection(
        FakeAPI([]), {"id": "pr", "timelineItems": events}, "timelineItems"
    ) == [{"id": "requested"}]


@pytest.mark.parametrize("rows,total", [([{"id": "1"}], 3), ([{"id": "1"}], 2), ([None], 2)])
def test_partial_or_conflicting_history_fails(rows, total):
    node = {"id": "pr", "reviews": connection([{"id": "1"}], 2, "next")}
    api = FakeAPI([{"node": {"reviews": connection(rows, total)}}])
    with pytest.raises(ValueError):
        complete_connection(api, node, "reviews")


def test_inventory_includes_old_open_prs_and_recently_closed_prs():
    rows = [
        {"id": "old-open", "createdAt": iso(1), "updatedAt": iso(2), "closedAt": None},
        {"id": "old-closed", "createdAt": iso(2), "updatedAt": iso(3), "closedAt": iso(3)},
        {"id": "later-closed", "createdAt": iso(3), "updatedAt": iso(20), "closedAt": iso(20)},
        {"id": "after-end", "createdAt": iso(101), "updatedAt": iso(102), "closedAt": None},
    ]
    api = FakeAPI([{"repository": {"pullRequests": connection(rows)}}])
    assert set(inventory(api, "owner/repo", 10, 100)) == {"old-open", "later-closed"}


def test_cache_never_accepts_partial_graphql_data(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "subprocess.run",
        lambda *a, **k: SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"data": {"node": None}, "errors": [{"message": "failure"}]}),
        ),
    )
    with pytest.raises(ValueError, match="partial"):
        HistoryAPI(tmp_path).query("query {}", {})
    assert list(tmp_path.rglob("*.json")) == []


def test_summary_exposes_informative_counts_and_pair_changes():
    choices, _ = replay([pull(i, reviews=[review()] if i == 1 else []) for i in range(1, 6)])
    predictions, reference = [np.array([5, 4, 3, 2, 1])], [np.array([1, 2, 3, 4, 5])]
    result = summary(choices, predictions)
    assert result["informative"]["decisions"] == 1
    assert result["informative"]["micro_hit3"] == 1
    paired = diagnostics(choices, predictions, reference)
    assert paired["gains"] == 1 and paired["losses"] == 0
    assert paired["queue_sizes"]["4-5"]["decisions"] == 1


def test_later_title_edits_do_not_enter_earlier_features():
    row = pull(1)
    original = row["title"]
    row["title"] = "feat(other): later content"
    row["events"].append(
        {
            "id": "rename",
            "__typename": "RenamedTitleEvent",
            "createdAt": iso(20),
            "previousTitle": original,
            "currentTitle": row["title"],
        }
    )
    versions = title_history(row)
    assert title_at(versions, 10) == original
    assert title_at(versions, 20) == original
    assert title_at(versions, 21) == row["title"]


def test_broken_title_chain_fails():
    row = pull(1)
    row["events"].append(
        {
            "id": "rename",
            "__typename": "RenamedTitleEvent",
            "createdAt": iso(20),
            "previousTitle": "previous",
            "currentTitle": "different from current field",
        }
    )
    with pytest.raises(ValueError, match="Current title"):
        title_history(row)


def test_content_profile_uses_completed_reviews_only():
    data = corpus(
        [
            pull(1, reviews=[review(10, 30)]),
            pull(2, reviews=[review(20, 25)]),
            pull(3, reviews=[review(40, 40)]),
            pull(4),
        ]
    )
    choices, _ = build_history_choices(data)
    embeddings = {
        "source_sha256": digest(data),
        "encoder": {"dimension": 2},
        "vectors": {digest(row["title"]): [1.0, 0.0] for row in data["pulls"]},
    }
    augmented = add_content(choices, data, embeddings)
    missing = len(FEATURE_NAMES) + CONTENT_FEATURES.index("title_recent_missing")
    assert augmented[0].x[:, missing].tolist() == [1] * 4
    assert augmented[1].x[:, missing].tolist() == [1] * 4
    assert augmented[2].x[:, missing].tolist() == [0] * 2
    cosine = len(FEATURE_NAMES) + CONTENT_FEATURES.index("title_last_review_cosine")
    assert augmented[2].x[:, cosine].tolist() == [1] * 2


@pytest.mark.parametrize("field,value", [("closedAt", iso(50)), ("isDraft", True)])
def test_current_state_detects_incomplete_lifecycle(field, value):
    row = pull(1, events=[event(), event("ReadyForReviewEvent", 2)])
    row[field] = value
    assert not state_matches(row)


def test_merge_and_close_events_can_have_different_timestamps():
    row = pull(1, events=[event(), event("MergedEvent", 20), event("ClosedEvent", 21)])
    row["closedAt"] = iso(20)
    assert state_matches(row)


def test_collector_refetches_inconsistent_history(monkeypatch):
    row = pull(1)
    stale = deepcopy(row)
    stale["closedAt"] = iso(20)
    refreshed = deepcopy(stale)
    refreshed["events"].append(event("ClosedEvent", 20))

    def node(record):
        events = connection(record["events"])
        events["filteredCount"] = len(record["events"])
        return {**record, "timelineItems": events, "reviews": connection(record["reviews"])}

    api = FakeAPI([{"nodes": [node(stale)]}, {"nodes": [node(refreshed)]}])
    api.last_rate = None
    monkeypatch.setattr("review_rank.history.inventory", lambda *args: {"1": row})
    result = collect_history(api, "owner/repo", 0, 100)
    assert result["complete"] is True
    assert result["inventory"]["state_rechecked"] == 1
    assert result["pulls"][0]["events"][-1]["__typename"] == "ClosedEvent"


def test_independent_queue_check_includes_later_removed_requests():
    rows = [
        pull(1, reviews=[review()]),
        pull(2, events=[event(), event("ReviewRequestRemovedEvent", 20)]),
        pull(3, events=[event(), event("ReviewRequestRemovedEvent", 5)]),
        pull(4, events=[event(), event("ClosedEvent", 5)]),
    ]
    assert expected_queue(corpus(rows), "viewer", 10) == {"owner/repo#1", "owner/repo#2"}


def test_uncertain_alternative_excludes_whole_decision_until_known_closed():
    uncertain = pull(2)
    uncertain.update(quality={"lifecycle": False, "title": True}, closedAt=iso(15))
    choices, audit = replay(
        [pull(1, reviews=[review()]), uncertain, pull(3, reviews=[review(20, 20)]), pull(4)]
    )
    assert audit["decisions_with_uncertain_candidate_state"] == 1
    assert len(choices) == 1 and choices[0].at == 20
    assert "owner/repo#2" not in choices[0].keys


def test_ambiguous_lifecycle_excludes_affected_decision():
    choices, audit = replay(
        [
            pull(1, reviews=[review()]),
            pull(2, events=[event(), event("ClosedEvent", 5), event("ReopenedEvent", 5)]),
            pull(3),
        ]
    )
    assert not choices
    assert audit["decisions_with_uncertain_candidate_state"] == 1


def test_unverified_title_is_missing_without_removing_candidate():
    unknown = pull(2)
    unknown["quality"] = {"title": False, "lifecycle": True}
    data = corpus([pull(1, reviews=[review()]), unknown])
    choices, _ = build_history_choices(data)
    embeddings = {
        "source_sha256": digest(data),
        "encoder": {"dimension": 2},
        "vectors": {digest(data["pulls"][0]["title"]): [1.0, 0.0]},
    }
    augmented = add_content(choices, data, embeddings)
    missing = len(FEATURE_NAMES) + CONTENT_FEATURES.index("title_missing")
    assert len(augmented[0].keys) == 2
    assert augmented[0].x[:, missing].tolist() == [0, 1]


def test_read_failure_retries_within_budget(tmp_path, monkeypatch):
    responses = iter(
        [
            SimpleNamespace(returncode=1, stderr="HTTP 502"),
            SimpleNamespace(returncode=0, stdout=json.dumps({"data": {"node": "value"}})),
        ]
    )
    monkeypatch.setattr("subprocess.run", lambda *a, **k: next(responses))
    monkeypatch.setattr("time.sleep", lambda *a: None)
    api = HistoryAPI(tmp_path, max_requests=2)
    assert api.query("query {}", {}) == {"node": "value"}
    assert api.requests == 2


def test_invalid_review_start_is_audited_but_completed_history_is_retained():
    rows = [pull(1, reviews=[review(11, 10)]), pull(2, reviews=[review(20, 20)]), pull(3)]
    choices, audit = replay(rows)
    assert audit["invalid_review_start_times"] == 1
    assert [choice.at for choice in choices] == [20]
    assert "owner/repo#1" not in choices[0].keys
    submitted, _ = replay(rows, "submitted")
    assert [choice.at for choice in submitted] == [10, 20]


def test_training_samples_are_nested_and_keep_complete_choice_groups():
    choices, _ = replay([pull(1, reviews=[review()]), pull(2)])
    train = [replace(choices[0], at=float(i), user=user) for user in ("a", "b") for i in range(20)]
    quarter, half = sample_training(train, 0.25), sample_training(train, 0.5)
    assert len(quarter) == 10 and len(half) == 20
    assert {id(choice) for choice in quarter} <= {id(choice) for choice in half}
    assert {choice.user for choice in quarter} == {"a", "b"}
    assert sample_training(train, 1) == train


def test_responses_to_old_requests_do_not_overflow_observed_response_rate():
    rows = [pull(1, reviews=[review()]), pull(2, reviews=[review(20, 20)]), pull(3)]
    for row in rows:
        row["author"] = actor("same-author")
    data = corpus(rows)
    data["start"] = 5
    choices, _ = build_history_choices(data)
    column = FEATURE_NAMES.index("author_response_rate")
    assert np.all(choices[-1].x[:, column] == 0.5)
