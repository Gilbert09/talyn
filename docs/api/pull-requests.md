# Pull requests, the merge queue and code reviews

Talyn tracks pull requests for each workspace: the pull requests you opened, the pull requests that wait for your review, and the pull requests you watch. The API reads these pull requests and acts on them.

Scopes: `pull_requests:read` and `pull_requests:write` for pull requests and the merge queue. `code_reviews:read` and `code_reviews:write` for code reviews. See [authentication](authentication.md).

## Read pull requests

```bash
curl -s "https://api.talyn.dev/v1/pull-requests?workspace_id=$WORKSPACE_ID&relationship=authored" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

The list holds open pull requests. Use `state=closed`, `state=merged` or `state=all` for others. The filters:

| Query | Values |
| --- | --- |
| `state` | `open` (default), `closed`, `merged`, `all` |
| `relationship` | `authored` (the "Mine" bucket), `review_requested` (the "Review" bucket), `watching` |
| `repository_id` | A repository id |
| `merge_queued` | `true` or `false` |

The list is newest first by the time Talyn started to track each pull request. It pages with a cursor. See [pagination](pagination.md).

Each pull request has the facts that the app shows:

- `ci_status`: the CI result alone. `failing_required` also covers a failing check when Talyn does not know if the check is required.
- `blocking_reason`: the whole merge result, for example `mergeable`, `merge_conflicts` or `checks_failed`.
- `human_gates`: failing checks that only a person can clear, for example a visual review.
- `review_decision`, `mergeable` and `merge_state_status`, lower-cased.
- `merge_queue`: the entry in the merge queue, or `null`.

### Fresh data

The API reads only what Talyn has stored. `last_synced_at` tells you when Talyn last read the pull request from GitHub. To read it from GitHub now, send a refresh:

```bash
curl -s -X POST https://api.talyn.dev/v1/pull-requests/$PR_ID/refresh \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

A refresh uses your own GitHub rate limit. The API allows 30 refreshes and posts each minute for each token. See [rate limits](rate-limits.md).

`GET /pull-requests/{id}` also gives `session_ids` (the sessions that work on the pull request) and `code_review` (a summary of the latest review). The full description is at `GET /pull-requests/{id}/description`.

## Keep a pull request mergeable

```bash
curl -s -X PATCH https://api.talyn.dev/v1/pull-requests/$PR_ID \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "auto_keep_mergeable": true }'
```

When auto-keep is on, Talyn starts a fix when the pull request gets conflicts or failing checks. Each fix counts against your plan.

## Start a session on a pull request

`POST /pull-requests/{id}/sessions` starts a session on the head branch of the pull request. The session links to the pull request. This is the same as `POST /sessions` with `pull_request_id`. It needs `sessions:write`.

```bash
curl -s https://api.talyn.dev/v1/pull-requests/$PR_ID/sessions \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "agent": "claude", "prompt": "Fix the failing checks and push." }'
```

## The merge queue

The merge queue merges a pull request when it is clean. It works on one pull request at a time for each repository and base branch. When a queued pull request has conflicts or failing checks, the queue starts a fix.

```bash
curl -s -X POST https://api.talyn.dev/v1/pull-requests/$PR_ID/merge-queue \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "method": "squash" }'
```

- `DELETE /pull-requests/{id}/merge-queue` removes the pull request. It also turns off a GitHub auto-merge that Talyn armed.
- `GET /merge-queue?workspace_id=...` lists the queue in the order the pull requests joined. `position` counts from 1 in each repository and base branch.
- `GET /pull-requests/{id}/merge-queue/events` tells you what the queue did and why.
- A `blocked` entry has a `blocked_code` and a `blocked_reason`.
- `POST /pull-requests/{id}/merge-queue/resubmit` sends a parked entry again, after an external merge queue (trunk.io) gave it back.

The free plan holds 3 pull requests in the queue. Over that, the answer is `402` `merge_queue_limit_reached`.

The API cannot merge a pull request directly. Use the merge queue.

## Code reviews

A code review runs several AI reviewers on a pull request. The findings stay in Talyn. Nothing goes to GitHub until you post it.

A pull request has at most one review. Each new review is a new `cycle` of the same review. Findings carry over between cycles, and a dismissal stays dismissed.

### Start a review and wait

```bash
curl -s https://api.talyn.dev/v1/pull-requests/$PR_ID/code-reviews \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "preset": "standard" }'
```

The answer is `201` with the review. If a cycle already runs, the answer is `200` with that cycle. Read `GET /code-reviews/{id}` until `phase` is `ready` or `failed`. A review takes some minutes. Poll each 30 seconds or less often.

The free plan runs 1 review at a time. Over that, the answer is `402` `code_review_limit_reached`.

### Read the findings

`GET /code-reviews/{id}` gives the review and its findings, most severe first. Each finding has:

- `severity`: `blocker`, `major`, `minor` or `nit`.
- `file_path`, `line_start` and `line_end`.
- `anchor_verified`: `true` when the quoted code is at that place. Trust a finding with `false` less.
- `lenses`: the reviewers that found it. Two or more reviewers is agreement.
- `verdict` and `verdict_reason`: what the judging pass decided, and why.
- `status`: `open`, `selected` (a fix works on it), `dismissed`, `fixed` or `stale`.

The list leaves out the long text. `GET /code-reviews/{id}/findings/{finding_id}` gives `body`, `suggestion` and `anchor`.

### Dismiss a finding

```bash
curl -s https://api.talyn.dev/v1/code-reviews/$REVIEW_ID/findings/$FINDING_ID/dismiss \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "not_a_problem" }'
```

The reasons are `not_a_problem`, `already_handled`, `wont_fix_here` and `wrong_about_code`. The reason is optional. `DELETE` on the same path undoes the dismissal. When you dismiss a blocker, a merge-queue entry that waits for it can continue.

### Post to the pull request

```bash
curl -s https://api.talyn.dev/v1/code-reviews/$REVIEW_ID/post \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "finding_ids": ["..."] }'
```

The API writes one GitHub review from your account. The review is always a comment. It never approves and never requests changes. Leave out `finding_ids` to post each open finding that is not on the pull request yet.

- A finding goes on a line of the diff only when its quoted code is there. The others go in the review body.
- A finding is never posted twice.
- `409` `code_review_post_not_ready`: the review still runs.
- `409` `code_review_post_nothing_to_post`: no open finding is left.
- `502` `code_review_post_github_failed`: GitHub refused. The message has the answer from GitHub.

The API cannot start a fix run for findings. Start a session on the pull request and tell the agent what to fix.
