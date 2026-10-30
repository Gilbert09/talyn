---
name: talyn-ci-triage
description: Use when checks fail on this Talyn session's pull request, or the person asks why CI is red. Lists the failing checks, reads their logs, decides from evidence whether each failure is flaky or real, re-runs flaky jobs, fixes real failures, and stops for human gates and required approvals.
---

# Triage failing CI

Work on this session's own pull request. You can push only to this session's repository.

Never do these things:
- Never create or update a check run, a check suite or a commit status. The proxy refuses it.
- Never edit branch protection, rulesets, workflows' required status or repository settings.
- Never skip, delete or weaken a test only to make CI green.
- Never add `[skip ci]` to a commit.

## 1. Set up

```bash
GH="http://github.$YAS_INTEGRATIONS_DOMAIN"
PROXY=$(git config --get-regexp '^url\..*\.insteadof$' | awk '$2=="https://github.com/" {sub(/^url\./,"",$1); sub(/\/gh\/\.insteadof$/,"",$1); print $1; exit}')
# If YAS_INTEGRATIONS_DOMAIN is empty: GH="$PROXY/ghapi"
```

There is no `gh` login in this box. Use `curl`. Install `jq` with `sudo apt-get install -y jq` if it is missing.

Find the pull request:
1. Call `talyn_get_session` with `session_id` set to your session id (run `echo $TALYN_SESSION_ID`). Read the `pull request:` line.
2. Call `talyn_list_pull_requests` with `search` set to the repository `owner/name`. Find the line with that number.
   The first token is the Talyn pull request id.
3. Read the pull request state:

```
talyn_get_pull_request
  pull_request_id: <Talyn id>
```

Read the `checks`, `CI`, `human gate` and `review` lines.

Get the head commit:

```bash
SHA=$(curl -s "$GH/repos/OWNER/REPO/pulls/N" | jq -r .head.sha)
```

## 2. Stop conditions

Stop and tell the person when:
- `talyn_get_pull_request` shows a `human gate:` line. A person must act on it, for example a visual review.
- The only blocker is a required approval or `CHANGES_REQUESTED`. Use the talyn-review-loop skill for review comments.
- A check needs a secret, a credential or an environment this box does not have.
- You fixed and pushed 3 times and the same check still fails.

## 3. List the failures

```bash
curl -s "$GH/repos/OWNER/REPO/commits/$SHA/check-runs?per_page=100" \
  | jq -r '.check_runs[] | select(.conclusion=="failure" or .conclusion=="timed_out" or .conclusion=="cancelled" or .conclusion=="action_required") | "\(.id)  \(.name)  \(.conclusion)  \(.html_url)"'
curl -s "$GH/repos/OWNER/REPO/commits/$SHA/status" | jq -r '.statuses[] | select(.state!="success") | "\(.context)  \(.state)  \(.target_url)"'
```

For an Actions job, the URL ends in `/actions/runs/RUN_ID/job/JOB_ID`. Keep both ids.

## 4. Read the logs

```bash
curl -s "$PROXY/cilogs/$SHA?tail=200&maxJobs=5" | jq -r '.failed[] | "=== \(.name)\n\(.log)"'
curl -s "$GH/repos/OWNER/REPO/check-runs/CHECK_RUN_ID/annotations" | jq -r '.[] | "\(.path):\(.start_line) \(.message)"'
```

Do not download `actions/jobs/JOB_ID/logs` directly. It redirects to a host this box cannot reach.

## 5. Decide: flaky or real

Collect evidence for each failure. Write the decision and the evidence in your reply.

It is real when:
- the error names a file, a test or a type that this pull request changed,
- you can reproduce it in the box with the same command,
- it fails the same way after a re-run.

It is probably flaky when:
- the log shows a network error, a timeout, a lost runner or an out-of-memory kill,
- the failing test does not touch the changed code and passes in the box,
- the same check also fails on the base branch: `curl -s "$GH/repos/OWNER/REPO/commits/BASE/check-runs"`.

If you are not sure, treat it as real and reproduce it.

## 6. Re-run a flaky job

Re-run each flaky job one time only:

```bash
curl -s -X POST "$GH/repos/OWNER/REPO/actions/runs/RUN_ID/rerun-failed-jobs"
curl -s -X POST "$GH/repos/OWNER/REPO/actions/jobs/JOB_ID/rerun"
curl -s -X POST "$GH/repos/OWNER/REPO/check-runs/CHECK_RUN_ID/rerequest"   # a check from a GitHub App, not Actions
```

If it fails again the same way, treat it as real.

## 7. Fix a real failure

1. Reproduce it locally with the command from the log.
2. Make the smallest fix. Run the same command again until it passes.
3. Run the nearby tests, lint and type checks for the files you changed.
4. Commit with a clear message, then `git push`.
   A repository that requires signed commits accepts a plain push. The box republishes the commits through GitHub.
   Your local commit ids can then change to GitHub's ids. That is normal.
   A refused push is not a published change. Do not say it is pushed until the push succeeded.
5. Call `talyn_refresh_pull_request` with the `pull_request_id`, so Talyn sees the new commit.

## 8. Wait for the new result

Wait in one call. Do not loop on short sleeps:

```bash
SHA=$(git rev-parse HEAD)
curl -s "$PROXY/ci/$SHA?timeout=100&failFast=1" | jq '{state, counts, failed: [.failed[]?.name], pending}'
```

- `settled` means all checks finished. `failed` means one failed. `pending` means the wait ended first.
- Call it again for `pending`. Stop after about 30 minutes and report.

## 9. Report

For each check: the name, flaky or real, the evidence, and what you did.
Say which checks still fail or wait, and who must act.
