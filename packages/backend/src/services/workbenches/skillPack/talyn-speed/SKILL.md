---
name: talyn-speed
description: Use when setup, a build or a test run in this Talyn sandbox is slow, a tool is missing, a command hits the 10-minute limit, or the box runs out of memory. Explains where to find setup facts first, how to install prebuilt tools instead of compiling them, which tests to run and when, how to wait on a long command without long sleeps, and how to move the session to a larger sandbox with talyn_resize_session.
---

# Work fast in the sandbox

Time in this box is the person's time. Do not spend it on waits and repeated work.

## 1. Find the setup facts first

Before you install or start anything:

1. Read your memory index and the repository's instructions (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, the README).
2. Read `.talyn/settings.toml`, the CI workflow files and the dev-container files. They show the real setup commands.
3. Check what the box already has: `command -v <tool>`, `docker info`, `ls ~/.cargo/bin`.

Do the setup that the repository describes. Do not invent another one.
When you learn a setup fact that took time to find, save it with `talyn_memory_write`.

## 2. Install prebuilt tools

Compiling a tool from source can take 10 minutes or more. Use a prebuilt binary:

| Tool kind | Use this | Not this |
| --- | --- | --- |
| Rust CLI (`sqlx-cli`, `cargo-nextest`) | `cargo binstall -y <crate>`, or the GitHub release binary | `cargo install` |
| Python CLI | `uv tool install <name>`, or `pipx install <name>` | a build from a git checkout |
| Common system tool | `sudo apt-get install -y <package>` | `make install` from a tarball |
| Node CLI | `npx <name>`, or the repository's own script | a global build |

If `cargo binstall` is missing, install it from its release script, then use it.
Install only what the task needs.

## 3. Run the right tests

1. Run the tests for the files you changed first. Give the file or the test name, for example `pytest path/to/test_file.py -k name` or `npx vitest run path/to/file.test.ts`.
2. Fix the failures, then run those tests again.
3. Run a whole suite one time, before the pull request. CI runs the rest.

A whole suite of a large repository can run longer than one command may run. Do not start it again and again.

## 4. Wait on long commands

A command stops after about 10 minutes. Your own background shells (`&`, `nohup`) also stop when your turn ends.

For a wait of a few minutes inside this turn, run the command in the background and check it:

```bash
nohup <command> > /tmp/run.log 2>&1 &
echo $! > /tmp/run.pid
```

Then check it with short waits:

```bash
sleep 45; tail -n 20 /tmp/run.log; kill -0 "$(cat /tmp/run.pid)" 2>/dev/null && echo running || echo done
```

- Wait 60 seconds or less in each check.
- Never `sleep` for minutes. A long sleep wastes the turn and shows nothing to the person.
- Between checks, do other useful work: read code, write the next change, prepare the pull request text.

For work that must outlive this turn, use Talyn's tools if you have them:

```
talyn_run_background
  command: npm test -- --all
  name: full test suite
  chat_id: <the TALYN_CHAT_ID environment variable>
```

- The job keeps running after your turn ends. Talyn starts a new turn in your chat when it exits, with the exit code and the last 40 lines of output. End your turn after you start it.
- `keep_awake_seconds` (default 3600) keeps the sandbox awake while the job runs. That time is billed box time. Use 0 to let the sandbox sleep; the job then pauses with the sandbox.
- Read output with `talyn_background_logs`, list jobs with `talyn_list_background`, stop one with `talyn_stop_background`.
- A move or resize of the session stops every job.

To look at something later (a deploy, a CI run), schedule a wake-up and end your turn:

```
talyn_schedule_wakeup
  delay_seconds: 1200
  reason: Check that the deploy finished and the smoke tests pass.
```

Start Docker and database services only when a test needs them. Stop them when you are done.

## 5. Move to a larger sandbox

Move the session when:
- a build or a test is killed for memory (`Killed`, exit code 137, "out of memory"),
- the test stack needs many services (ClickHouse, Kafka, Postgres and the like),
- builds or tests are slow because the box has too few CPUs.

Sizes: `small` (2 GB), `standard` (4 GB), `medium` (8 GB), `large` (12 GB), `xlarge` (16 GB).
Ask for the next size up. Do not ask for `xlarge` unless `large` was not enough.

```
talyn_resize_session
  size: large
  reason: The test stack runs ClickHouse and Kafka, and pytest was killed for memory.
  continue_with: Continue the task on the larger sandbox. Run the failing tests again.
```

What happens:
- Talyn does not stop your turn. It moves the session after your turn ends, or at the next turn start.
- Files, branches, uncommitted changes and the conversation come with you. Running processes and terminals stop.
- With `continue_with`, Talyn sends that message after the move, so your next turn starts on the new sandbox.
- After the call, end your turn. Do not start more long work on the old sandbox.
- The fleet can refuse a size over the account's limit. Then the session stays on its sandbox, and the transcript says why.

Add `remember_for_repository: true` only when every session of this repository needs the larger size.

## 6. Report

In your reply, say which setup steps were slow, what you did about each, and what you recommend for the next session.
