import copy
from dataclasses import asdict, replace

import pytest

from review_rank.content import capture
from review_rank.features import DAY
from review_rank.outcomes import GitHub, Protocol, collect, digest, join, validate_journal
from review_rank.snapshots import Snapshot

START = 1_000_000_000.0


def protocol():
    return Protocol("workspace", "reviewer", ("org/repo",), START, START + 4 * DAY)


def snapshot(at=START + 10, name="snapshot", filtered=False):
    return Snapshot(
        "workspace",
        "reviewer",
        name,
        at,
        filtered,
        tuple(
            {
                "pr_id": str(i),
                "repo": "org/repo",
                "pr_number": i + 1,
                "displayed_rank": i + 1,
                "head_sha": "head",
                "gate": "actionable",
            }
            for i in range(5)
        ),
        frozenset(),
        frozenset(),
        {"repository_scope": ["org/repo"]},
    )


def review(at=START + 20, number=1, identity="review"):
    return {
        "id": identity,
        "at": at,
        "repo": "org/repo",
        "number": number,
        "reviewer": "reviewer",
        "state": "APPROVED",
        "commit": "head",
    }


def journal(reviews=()):
    p = protocol()
    return {
        "schema_version": 1,
        "protocol": asdict(p),
        "protocol_sha256": digest(asdict(p)),
        "collection_started_at": p.end,
        "complete": True,
        "evidence": [{"repo": "org/repo", "enumeration_complete": True}],
        "reviews": list(reviews),
    }


@pytest.mark.parametrize("fault", ["complete", "scope", "early", "evidence", "outside", "conflict"])
def test_incomplete_journals_cannot_make_labels(fault):
    data = journal([review()])
    if fault == "complete":
        data["complete"] = False
    elif fault == "scope":
        data["protocol"]["reviewer"] = "someone"
    elif fault == "early":
        data["collection_started_at"] -= 1
    elif fault == "evidence":
        data["evidence"] = []
    elif fault == "outside":
        data["reviews"][0]["repo"] = "org/elsewhere"
    else:
        data["reviews"].append(review(number=2))
    with pytest.raises(ValueError):
        validate_journal(protocol(), data)


def test_deduplicate_ids_and_assign_latest_snapshot_once():
    snapshots = [snapshot(name="old"), snapshot(START + 15), snapshot(START + 15)]
    data = join(protocol(), snapshots, journal([review(), review()]))
    assert len(data["choices"]) == 1
    assert data["choices"][0]["snapshot_id"] == "snapshot"
    assert data["audit"]["submitted_reviews"] == 1
    assert data["audit"]["censored"] == 1


@pytest.mark.parametrize(
    "fault,status",
    [
        ("outside", "coverage_failure"),
        ("filtered", "excluded_snapshot"),
        ("simultaneous", "ambiguous_reviews"),
        ("scope", "excluded_snapshot"),
        ("duplicate_pr", "excluded_snapshot"),
        ("singleton", "singleton"),
    ],
)
def test_no_forced_positive_or_filtered_fallback(fault, status):
    row = snapshot()
    reviews = [review()]
    if fault == "outside":
        reviews = [review(number=999)]
    elif fault == "filtered":
        row = replace(row, filtered=True)
    elif fault == "simultaneous":
        reviews.append(review(number=2, identity="other"))
    elif fault == "scope":
        row = replace(row, candidates=({**row.candidates[0], "repo": "org/other"},))
    elif fault == "duplicate_pr":
        row = replace(row, candidates=(row.candidates[0], row.candidates[0]))
    else:
        row = replace(row, candidates=row.candidates[:1])
    data = join(protocol(), [snapshot(START + 1, "old"), row], journal(reviews))
    assert data["choices"] == []
    assert data["audit"][status] == 1


@pytest.mark.parametrize("delta,labels", [(0, 0), (1, 1), (DAY, 1), (DAY + 1, 0)])
def test_strictly_earlier_snapshot_and_fixed_horizon(delta, labels):
    data = join(protocol(), [snapshot()], journal([review(at=START + 10 + delta)]))
    assert len(data["choices"]) == labels


def test_fresh_snapshot_required_for_each_next_review():
    data = join(protocol(), [snapshot()], journal([review(), review(START + 30, 2, "other")]))
    assert len(data["choices"]) == 1
    assert data["audit"]["later_reviews_without_fresh_snapshot"] == 1


@pytest.mark.parametrize("scope", [None, [], ["org/other"], ["org/repo", "org/other"], [3]])
def test_unknown_or_different_queue_scope_cannot_make_labels(scope):
    row = replace(snapshot(), header={"repository_scope": scope})
    data = join(protocol(), [row], journal([review()]))
    assert data["choices"] == []
    assert data["audit"]["snapshots_with_unknown_or_mismatched_scope"] == 1
    assert data["sessions"][0]["status"] == "excluded_snapshot"


def test_agent_snapshots_censor_attribution_instead_of_falling_back():
    rows = [snapshot(START + 1, "human"), snapshot()]
    data = join(protocol(), rows, journal([review()]), frozenset({"snapshot"}))
    assert data["choices"] == []
    assert data["audit"]["explicitly_excluded_snapshots"] == 1
    assert data["audit"]["reviews_on_excluded_snapshots"] == 1
    assert data["sessions"][0]["status"] == "censored"


def test_no_review_only_after_full_window_and_no_superseding_snapshot():
    data = join(protocol(), [snapshot(), snapshot(protocol().end - 100, "late")], journal())
    assert [row["status"] for row in data["sessions"]] == ["no_review", "censored"]


def test_ambiguous_snapshots_never_get_positive_or_negative():
    data = join(protocol(), [snapshot(), snapshot(name="other")], journal([review()]))
    assert data["audit"]["reviews_with_ambiguous_snapshot"] == 1
    assert all(row["status"] == "excluded_snapshot" for row in data["sessions"])


class API(GitHub):
    def __init__(self, responses):
        super().__init__()
        self.responses = responses
        self.endpoints = []

    def get(self, endpoint):
        self.requests += 1
        self.endpoints.append(endpoint)
        return copy.deepcopy(self.responses[endpoint])


def test_collection_enumerates_all_prs_and_all_review_pages():
    pull_url = "repos/org/repo/pulls?state=all&sort=created&direction=asc&per_page=100&page=1"
    review_url = "repos/org/repo/pulls/1/reviews?per_page=100&page="
    row = {
        "node_id": "r",
        "submitted_at": "2001-09-09T02:00:00Z",
        "state": "DISMISSED",
        "user": {"login": "REVIEWER"},
        "commit_id": "head",
    }
    api = API(
        {
            pull_url: [{"number": 1, "created_at": "2000-01-01T00:00:00Z"}],
            review_url + "1": [{**row, "node_id": str(i)} for i in range(100)],
            review_url + "2": [row],
        }
    )
    data = collect(protocol(), api, protocol().end)
    assert len(data["reviews"]) == 101
    assert api.requests == 3
    assert data["evidence"][0]["pulls_scanned"] == 1
    assert all(review["state"] == "DISMISSED" for review in data["reviews"])


def test_collection_refuses_open_window_and_exhausted_budget():
    with pytest.raises(ValueError, match="still open"):
        collect(protocol(), GitHub(), START)
    with pytest.raises(ValueError, match="budget"):
        GitHub(0).get("repos/org/repo/pulls")


@pytest.mark.parametrize("fault", ["revision", "files", "title"])
def test_content_capture_refuses_changes_and_truncation(fault):
    before = {
        "head": {"sha": "h"},
        "base": {"sha": "b"},
        "title": "test",
        "body": "",
        "updated_at": "now",
        "changed_files": 1,
    }
    after = copy.deepcopy(before)
    if fault == "revision":
        after["head"]["sha"] = "other"
    if fault == "title":
        after["title"] = "changed"
    api = API(
        {
            "repos/org/repo/pulls/1/files?per_page=100&page=1": []
            if fault == "files"
            else [{"filename": "test.py", "patch": "+test"}]
        }
    )
    original = api.get
    heads = iter([before, after])
    api.get = lambda endpoint: next(heads) if endpoint.endswith("/1") else original(endpoint)
    with pytest.raises(ValueError):
        capture(api, "org/repo", 1, lambda: START)
