/**
 * The skills the desktop app installs for Claude Code and Codex on this
 * computer (Settings → MCP server → Connect). They teach a LOCAL agent to work
 * through Talyn's MCP server: hand work to a cloud session, follow and steer
 * sessions, bring a session's branch to this machine, and look after pull
 * requests.
 *
 * They are not the sandbox pack in `packages/backend/.../skillPack/`. Those
 * are written for an agent INSIDE a session ("this session's pull request");
 * these are written for an agent on the person's own machine, and the names
 * differ so the two can never be confused in one skills directory.
 *
 * When you change a tool these skills name, update them in the same pull
 * request (see "Docs — keep them current" in claude.md).
 */

export interface LocalSkill {
  name: string;
  description: string;
  content: string;
}

function skill(name: string, description: string, body: string): LocalSkill {
  return {
    name,
    description,
    content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`,
  };
}

const REMOTE_SESSION = skill(
  'talyn-remote-session',
  'Use when the person asks to run work in Talyn, in the cloud, remotely or in a sandbox, or to hand a task off so it runs while they do something else. Starts a Talyn cloud session on a repository with a complete brief, on a new branch, on the current branch or on a pull request, and reports how to follow it. Needs the talyn MCP server.',
  `
# Hand work to a Talyn cloud session

A Talyn session is a cloud sandbox with its own clone of the repository and its own branch.
A Claude or Codex agent works there. It cannot see this conversation or this computer.

## 1. Find the repository

- Read the remote of the current directory: \`git remote get-url origin\`.
- Call \`talyn_list_repositories\`. Find the id of that \`owner/name\`.
- When the repository is not in the list, tell the person. Talyn must watch it first.
  Do not call \`talyn_add_repository\` unless the person asks.
- With more than one workspace, pass \`workspace_id\`. \`talyn_list_workspaces\` lists them.

## 2. Decide the branch

The sandbox clones from GitHub. It sees only what is pushed.

- New work: start on a new branch. Pass nothing for \`branch\`.
- Continue local work: run \`git status\` and \`git log @{u}..\` first.
  - When there are uncommitted changes or commits that are not pushed, tell the person.
    Ask before you commit or push. Never push to the default branch.
  - Then pass the branch name in \`branch\`.
- Work on an open pull request: pass \`pull_request_id\`.
  \`talyn_list_pull_requests\` gives the id.

## 3. Write the brief

The brief is the first message. It must be complete:

\`\`\`
Goal: <one sentence>
Context: <why, and what the person already decided>
Where: <files, packages and functions to start from>
Constraints: <what not to change, versions, style>
Acceptance: <the commands to run and what must pass>
Finish: <open a pull request, or stop and report>
\`\`\`

Include facts from this conversation that the session needs. Do not refer to "the above".

## 4. Start it

\`\`\`
talyn_create_session
  repository_id: <id>
  agent: claude | codex   (ask when the person did not say; default to the agent you are)
  prompt: <the brief>
  branch: <only to continue an existing branch>
  auto_create_pr: true    (when the brief ends in a pull request)
\`\`\`

The first token of the result is the session id.

For independent parts of a large task, start one session for each part.
Give each part its own files, so the sessions do not change the same code.

## 5. Report

Tell the person the session id, the repository, the branch and what you asked for.
They can follow it in the Talyn app. Do not wait in a loop for it to finish.
To check later, use the talyn-follow-sessions skill.
`
);

const FOLLOW_SESSIONS = skill(
  'talyn-follow-sessions',
  'Use when the person asks how their Talyn sessions are going, what a session did, why a session is stuck, or wants to answer, steer, stop, resize or archive a session. Reads status, transcripts and diffs of Talyn cloud sessions and sends follow-up messages. Needs the talyn MCP server.',
  `
# Follow and steer Talyn sessions

## Find the session

- \`talyn_list_sessions\` lists the sessions of a workspace, newest first.
- \`talyn_get_session\` with \`session_id\` shows the status, the branch, the pull request and the chats.
- \`talyn_list_thread_sessions\` lists the sessions that a thread started.

## Read what happened

- \`talyn_get_session_transcript\` reads a chat as text. Pass the returned \`cursor\` to read the next page.
- \`talyn_get_session_changes\` lists the changed files.
- \`talyn_get_session_diff\` reads the diff. Pass \`path\` for one file.
- \`talyn_session_sandbox_status\` tells if the sandbox is running, idle, asleep or lost, and what is not pushed.
- \`talyn_session_timing\` shows where the time of each turn went.

Give the person a short summary: what the session did, what is left, and what it needs from them.

## Steer it

- To answer a question or add an instruction: \`talyn_send_session_message\`.
  When a turn runs, the message waits in the queue.
- To stop a turn that goes the wrong way: \`talyn_cancel_session_turn\`. Then send the correction.
- When the session needs more memory or CPU: \`talyn_resize_session\`.
- When the session needs an MCP server that was connected later: \`talyn_restart_session\`.
- When the session failed or is stuck while it starts: \`talyn_retry_session\`.

Ask the person before you cancel a turn, retry a session or change its account.

## Finish it

- To open the pull request: \`talyn_open_session_pull_request\`.
- To archive a session when its work is done: \`talyn_archive_session\`. Ask first.
  \`talyn_restore_session\` brings it back.

A session that runs in the Talyn desktop app on this computer is a local session.
These tools refuse it. Tell the person to open it in the app.
`
);

const PULL_SESSION = skill(
  'talyn-pull-session',
  "Use when the person wants a Talyn cloud session's work on this computer, for example to run it, test it, debug it or continue it locally. Gets the session's branch from Talyn, makes sure the work is pushed, and checks it out here without losing local changes. Needs the talyn MCP server and git.",
  `
# Bring a session's work to this computer

## 1. Find the branch

- \`talyn_get_session\` with \`session_id\` gives the repository and the branch.
- Make sure the current directory is a clone of that repository: \`git remote get-url origin\`.
  If it is not, ask the person where the clone is.

## 2. Make sure the work is pushed

- \`talyn_session_sandbox_status\` shows the commits and changes that are not pushed.
- When work is not pushed, ask the session to push it:
  \`talyn_send_session_message\` with "Commit your work and push the branch. Do not open a pull request yet."
- Wait for that turn to end. Check with \`talyn_get_session\`. Do not poll faster than once a minute.

## 3. Check it out

Run \`git status\` first. Never discard local changes.

- When the working tree is clean: \`git fetch origin <branch>\`, then \`git switch <branch>\`.
- When it is not clean, use a worktree and tell the person its path:
  \`git fetch origin <branch>\`, then \`git worktree add ../<repo>-<branch> <branch>\`.
- When the local branch exists and differs from the remote branch, ask the person before you reset or merge.

## 4. Work with it

- Install, build and run the tests here as the repository's instructions say.
- Report what passed and what failed, with the output.
- To send a fix back to the session: \`talyn_send_session_message\` with the failure and the fix you want.
- To continue locally: commit and push to the same branch. Tell the session with \`talyn_send_session_message\`,
  so it pulls before its next change.

When you are done with a worktree you created, remove it with \`git worktree remove <path>\`.
`
);

const PULL_REQUESTS = skill(
  'talyn-pull-requests',
  'Use when the person asks which pull requests need them, what is blocking a pull request, to fix failing checks or review comments in the cloud, to review a pull request, or to add a pull request to the merge queue. Works through Talyn: pull request status, checks, reviews, cloud fixes, code review and the merge queue. Needs the talyn MCP server.',
  `
# Pull requests through Talyn

## See what needs attention

- \`talyn_list_pull_requests\` with \`bucket\`: \`needs_attention\`, \`mine\`, \`review_requested\`, \`watching\` or \`all\`.
- \`talyn_get_pull_request\` shows the status, the checks, the human gates and the merge queue state.
- \`talyn_get_pull_request_reviews\` reads reviews, comments and threads that are not resolved.
- \`talyn_get_pull_request_diff\` lists the changed files. Ask for patches only when you need them.
- \`talyn_refresh_pull_request\` reads the pull request from GitHub again when the data looks old.

Give the person a short list: the pull request, what blocks it, and the next step.

## Fix it in the cloud

- For failing checks, merge conflicts and review comments: \`talyn_fix_pull_request\`.
  Talyn starts a cloud task that makes the pull request ready to merge.
- For a larger change: start a session on the pull request with the talyn-remote-session skill.
- To keep a pull request mergeable automatically: \`talyn_set_auto_keep_mergeable\`.

## Review it

- \`talyn_start_code_review\` with \`quick\`, \`standard\` or \`deep\`.
- \`talyn_get_code_review\` reads the status and the findings.
- \`talyn_fix_code_review_findings\` starts a cloud task for the findings that the person chooses.
- \`talyn_dismiss_code_review_finding\` dismisses a finding that is wrong.

## Land it

- Add the pull request to Talyn's merge queue: \`talyn_set_merge_queue\`.
  For a stack of pull requests: \`talyn_set_merge_queue_stack\`.
- \`talyn_get_merge_queue_timeline\` shows what the queue did and why.
- Use \`talyn_merge_pull_request\` only when the person asks for a merge now.

Ask the person before you merge, close or queue a pull request.
To close a pull request, use \`talyn_close_pull_request\`, not \`gh\`.
`
);

export const LOCAL_SKILL_PACK: readonly LocalSkill[] = [
  REMOTE_SESSION,
  FOLLOW_SESSIONS,
  PULL_SESSION,
  PULL_REQUESTS,
];
