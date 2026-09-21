import copy
from dataclasses import replace

import pytest

from review_rank.outcomes import GitHub, Protocol, collect_graphql, iso, validate_journal

START = 1_000_000_000.0
PROTOCOL = Protocol("workspace", "reviewer", ("org/repo",), START, START + 100)


def connection(rows, count=None, cursor=None):
    return {
        "nodes": rows,
        "totalCount": len(rows) if count is None else count,
        "pageInfo": {"hasNextPage": cursor is not None, "endCursor": cursor},
    }


def review(identity="r", at=START + 20, created=START + 10, number=1):
    return {
        "id": identity,
        "createdAt": iso(created),
        "submittedAt": iso(at) if at else None,
        "state": "COMMENTED" if at else "PENDING",
        "author": {"login": "REVIEWER"},
        "commit": {"oid": "head"},
        "pullRequest": {"number": number, "repository": {"nameWithOwner": "Org/Repo"}},
    }


def pull(number=1, reviews=None, created=START - 100):
    return {
        "id": f"pull-{number}",
        "number": number,
        "createdAt": iso(created),
        "reviews": reviews if reviews is not None else connection([review(number=number)]),
    }


def repo(pulls=None):
    return {
        "repository": {
            "nameWithOwner": "Org/Repo",
            "pullRequests": pulls if pulls is not None else connection([pull()]),
        }
    }


class API(GitHub):
    def __init__(self, *responses):
        super().__init__()
        self.responses = copy.deepcopy(list(responses))
        self.variables = []

    def query(self, query, variables):
        assert "author:$reviewer" in query
        assert variables["reviewer"] == "reviewer"
        self.requests += 1
        self.variables.append(variables)
        return self.responses.pop(0)


def test_batches_all_prs_including_empty_review_connections():
    api = API(repo(connection([pull(), pull(2, connection([]))])))
    result = collect_graphql(PROTOCOL, api, PROTOCOL.end)
    assert len(validate_journal(PROTOCOL, result)) == 1
    assert result["transport"] == "graphql"
    assert result["requests"] == 1
    assert result["evidence"][0]["pulls_scanned"] == 2
    assert result["reviews"][0]["commit"] == "head"


def test_pages_reviews_and_all_pulls_and_preserves_censored_reviews():
    first = repo(
        connection([pull(reviews=connection([review()], 3, "review-page"))], 3, "pull-page")
    )
    more = {
        "node": {
            "id": "pull-1",
            "number": 1,
            "repository": {"nameWithOwner": "org/repo"},
            "reviews": connection(
                [
                    review("pending", None),
                    review("late", PROTOCOL.end + 1),
                ],
                3,
            ),
        }
    }
    last = repo(
        connection(
            [
                pull(2, connection([review("old", START - 1, START - 2, 2)])),
                pull(3, created=PROTOCOL.end),
            ],
            3,
        )
    )
    api = API(first, more, last)
    result = collect_graphql(PROTOCOL, api, PROTOCOL.end + 2)
    assert len(validate_journal(PROTOCOL, result)) == 1
    assert {row["id"] for row in result["censored_reviews"]} == {"pending", "late"}
    assert result["evidence"][0]["pulls_scanned"] == 2
    assert [v["cursor"] for v in api.variables] == [None, "review-page", "pull-page"]


def test_empty_repository_is_complete():
    result = collect_graphql(PROTOCOL, API(repo(connection([]))), PROTOCOL.end)
    assert validate_journal(PROTOCOL, result) == []
    assert result["evidence"][0]["enumeration_complete"] is True


@pytest.mark.parametrize(
    "fault",
    [
        "author",
        "parent_repo",
        "parent_number",
        "time",
        "missing_time",
        "state",
        "pending",
        "duplicate_review",
        "duplicate_pull",
        "number",
        "repo",
        "order",
        "missing_pull",
        "missing_review",
        "null_node",
        "page_type",
        "cursor",
        "count",
    ],
)
def test_corrupt_or_incomplete_data_never_yields_a_journal(fault):
    response = repo()
    r = response["repository"]["pullRequests"]["nodes"][0]["reviews"]["nodes"][0]
    p = response["repository"]["pullRequests"]["nodes"][0]
    pulls = response["repository"]["pullRequests"]
    if fault == "author":
        r["author"] = None
    elif fault == "parent_repo":
        r["pullRequest"]["repository"]["nameWithOwner"] = "org/other"
    elif fault == "parent_number":
        r["pullRequest"]["number"] = 2
    elif fault == "time":
        r["createdAt"] = iso(START + 30)
    elif fault == "missing_time":
        r["submittedAt"] = "broken"
    elif fault == "state":
        r["state"] = "UNKNOWN"
    elif fault == "pending":
        r["state"] = "PENDING"
    elif fault == "duplicate_review":
        p["reviews"] = connection([r, r])
    elif fault == "duplicate_pull":
        response["repository"]["pullRequests"] = connection([p, p])
    elif fault == "number":
        p["number"] = True
    elif fault == "repo":
        response["repository"]["nameWithOwner"] = "org/other"
    elif fault == "order":
        response["repository"]["pullRequests"] = connection([p, pull(2, created=START - 200)])
    elif fault == "missing_pull":
        pulls["totalCount"] = 2
    elif fault == "missing_review":
        p["reviews"]["totalCount"] = 2
    elif fault == "null_node":
        pulls["nodes"] = [None]
    elif fault == "page_type":
        pulls["pageInfo"]["hasNextPage"] = "false"
    elif fault == "cursor":
        pulls["pageInfo"]["hasNextPage"] = True
    else:
        pulls["totalCount"] = True
    with pytest.raises(ValueError):
        collect_graphql(PROTOCOL, API(response), PROTOCOL.end)


@pytest.mark.parametrize("fault", ["count_changed", "identity_changed", "cursor_loop"])
def test_followup_pages_must_match_the_original_pr(fault):
    first = repo(connection([pull(reviews=connection([review()], 2, "next"))]))
    more = {
        "node": {
            "id": "pull-1",
            "number": 1,
            "repository": {"nameWithOwner": "org/repo"},
            "reviews": connection([review("r2")], 2),
        }
    }
    if fault == "count_changed":
        more["node"]["reviews"]["totalCount"] = 3
    elif fault == "identity_changed":
        more["node"]["number"] = 2
    else:
        more["node"]["reviews"]["pageInfo"] = {"hasNextPage": True, "endCursor": "next"}
    with pytest.raises(ValueError):
        collect_graphql(PROTOCOL, API(first, more), PROTOCOL.end)


def test_pull_cursor_loop_is_refused():
    first = repo(connection([pull()], 3, "next"))
    more = repo(connection([pull(2)], 3, "next"))
    with pytest.raises(ValueError, match="advance"):
        collect_graphql(PROTOCOL, API(first, more), PROTOCOL.end)


def test_each_repository_is_enumerated_and_early_collection_is_refused():
    p = replace(PROTOCOL, repos=("org/empty", "org/repo"))
    empty = repo(connection([]))
    empty["repository"]["nameWithOwner"] = "org/empty"
    result = collect_graphql(p, API(empty, repo()), p.end)
    assert len(validate_journal(p, result)) == 1
    assert [row["repo"] for row in result["evidence"]] == list(p.repos)
    api = API()
    with pytest.raises(ValueError, match="still open"):
        collect_graphql(p, api, p.end - 1)
    assert api.requests == 0
