# @talyn/cli

Command-line client for the Talyn backend. Lets you create and list tasks
and manage the CLI auth token without touching the UI.

## Install

From a checkout of the Talyn monorepo:

```bash
npm install        # from the repo root
npm run build -w @talyn/cli
npm link -w @talyn/cli
# now `talyn` is on your PATH
```

## Environment

- `TALYN_API_URL`: defaults to `http://localhost:4747`. A non-local URL must be `https://`.
- `TALYN_AUTH_TOKEN`: auth token. Wins over the stored token file (`~/.fastowl/token`).
- `TALYN_WORKSPACE_ID`: default workspace for commands that need one
- `TALYN_TASK_ID`: current task id

## Commands

```bash
talyn ping                              # health check

talyn token set [token]                 # store the auth token (Settings → Copy CLI token)
talyn token whoami                      # decode the token and print the user
talyn token show                        # print the stored token (scripting only)
talyn token clear                       # remove the stored token

talyn task list                         # list tasks in the current workspace
talyn task create --prompt "Add foo"    # create a code_writing task
talyn task create --type manual \
    --title "Merge PR #42"              # non-agent task
```

Add `--json` to the task commands to get machine-readable output.
`--status` and `--type` filter `task list`.
