# Talyn on ReviewBench

This harness measures Talyn's review findings against the ReviewBench test set.
The adapter reads a local checkout, diff, and PR metadata.
Only Codex needs access to a model provider.

It reuses Talyn's prompt builders, output contract, parser, severity order, and dedupe key.
It also reuses the pure chunk selector, anchor verifier, and judge matching helper.
The backend still uses those helpers through `executor.ts`.

The harness implements the sequence of lens, sweep, and judge runs.
It keeps the production rules for duplicate findings, unmatched keeps, and failed judges.
It fails the PR if every lens fails.

Quick runs one lens. Standard runs three lenses, one sweep, and one judge.
Deep runs five lenses per chunk, then one sweep per chunk and one judge.
The judge receives all candidates. Its diff context uses the first chunk, as production does.

This harness uses Codex only, pinned to `0.166.0`, the fleet version.
It has no provider failover, fleet capacity pacing, database, or GitHub API calls.
It runs the preset's full lens list and all diff files.
Production can filter files and select fewer lenses for a change.
The model setting applies to lenses and sweeps. The judge can use a separate model.
Web search and Codex apps are disabled.

Codex runs with `--dangerously-bypass-approvals-and-sandbox` inside the container.
Its `read-only` sandbox needs bubblewrap, and Docker does not let bubblewrap make a namespace.
Without the flag, every agent command fails and the review sees only the diff.
The container is the isolation boundary. Do not use this flag outside the container.
A unit fails when its agent commands fail for an environment reason, so a blind review cannot pass.

Results and prompt experiments are in [FINDINGS.md](./FINDINGS.md).

Install Docker, Node.js 22, npm, Git, and jq on the host.
Refresh your host credentials with any normal `codex exec` run before you start.
The helper rejects credentials whose `last_refresh` is at least 7 days old. Codex refreshes a token after about 8 days, and a refresh inside the container rotates the refresh token, which can log the host out.
This check reduces token rotation risk. A container refresh can log the host out.

Run one PR from the Talyn root. `--pr` selects a zero-based corpus index, not a GitHub PR number.

```sh
benchmarks/review-bench/run.sh --pr 0
```

Run all 25 test PRs with no selection argument.
Use `--set full` for the full corpus, which currently contains 219 PRs.
These commands spend model usage.

```sh
benchmarks/review-bench/run.sh
benchmarks/review-bench/run.sh --set full
RB_CONFIG_PRESET=deep RB_CONFIG_EFFORT=high benchmarks/review-bench/run.sh --pr 0
benchmarks/review-bench/run.sh --pr 0 -e RB_CONFIG_PRESET=quick
```

The helper clones ReviewBench into `.work/ReviewBench`, installs its packages, and builds the image.
It exports each configuration value and forwards it through `-e NAME`.
ReviewBench supplies `RB_AGENT=try-agent`; the adapter preserves it.
Each run gets a new directory under `.work/runs/<preset>-<timestamp>-<suffix>`.
Findings appear in that directory's `findings/` folder.
Unit output and stderr tails appear under `.try-agent/out/<pr-key>/units/`.

| Variable | Default |
| --- | --- |
| `RB_CONFIG_PRESET` | `standard` (`quick`, `standard`, or `deep`) |
| `RB_CONFIG_MODEL` | `gpt-6.1-terra` |
| `RB_CONFIG_JUDGE_MODEL` | Same as the model |
| `RB_CONFIG_EFFORT` | Codex default |
| `RB_CONFIG_CONCURRENCY` | `5` |
| `RB_CONFIG_UNIT_TIMEOUT_SEC` | `900` |
| `RB_MODEL_BASE_URL` | Provider default; forwarded as `OPENAI_BASE_URL` |

The image also accepts a mounted `/root/.codex/auth.json` or `OPENAI_API_KEY`.
Replace the image digest in `manifest.json` before portal submission.
The manifest requests a 60-minute PR limit.
The local ReviewBench script does not enforce that limit or the portal's egress restrictions.
Use an egress proxy to restrict local runs to the hosts in the manifest.

Score the resulting findings from the ReviewBench checkout.
Set `run` to the absolute run directory printed by the helper.
Set the judge provider's API key in the environment.
The judge makes separate model calls and spends model usage.

```sh
cd benchmarks/review-bench/.work/ReviewBench
run=/absolute/path/to/benchmarks/review-bench/.work/runs/standard-TIMESTAMP-SUFFIX
npm run judge -- \
  --candidate "$run/findings" \
  --golden ./golden \
  --manifest ./corpus/manifest.json \
  --provider openai \
  --model <judge-model-id> \
  --output "$run/scoring/results.json" \
  --repo-dir "$run/.judge-repos" \
  --concurrency 4
```

Replace `<judge-model-id>` with a model that supports tool calls.
To score on a ChatGPT subscription, log in once with `npx pi` (`/login`, then OpenAI Codex).
Then use `--provider openai-codex --model gpt-6.1-sol`.
If pi does not know that model, add it to `~/.pi/agent/models.json` with the `openai-codex-responses` API.
Add `--limit 1` for a scoring smoke test.
Use `OPENAI_API_KEY` for `openai`, or `ANTHROPIC_API_KEY` for `anthropic`.
Other providers include `azure-openai-responses`, `google`, `deepseek`, and `openrouter`.
Run `npx pi --list-models` to inspect available models.

Check that the runner reports `failed 0`. The judge scores only PRs with findings files.
Keep the judge provider and model constant when you compare runs.
Local scores cannot be submitted to the leaderboard.
See [JUDGING.md](https://github.com/review-bench/ReviewBench/blob/main/docs/JUDGING.md)
and [OFFLINE_EVAL.md](https://github.com/review-bench/ReviewBench/blob/main/docs/OFFLINE_EVAL.md) for scoring details.

Run the harness tests from the Talyn root. They use fake agents and spend no model usage.

```sh
npx vitest run --config benchmarks/review-bench/vitest.config.ts
npx tsc --noEmit -p benchmarks/review-bench
docker build --platform linux/amd64 -f benchmarks/review-bench/Dockerfile -t talyn-review-bench:dev .
```
