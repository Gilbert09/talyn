/**
 * What Talyn is and how an agent gets the most from it. Every session and
 * thread box with Talyn's MCP server gets it as a user-wide instruction:
 * Claude as `~/.claude/rules/talyn.md`, Codex as a marked block at the top of
 * `~/.codex/AGENTS.md`. It is static, so the agent's prompt cache keeps it.
 * What changes per turn (plan mode, internet off, a Create PR turn) stays in
 * the turn notes in `workbenchPlan.ts`.
 *
 * The first line marks the Claude file as Talyn's, so Talyn never removes a
 * file a person wrote with the same name.
 */
export const TALYN_BRIEFING_MARKER = '<!-- talyn:briefing -->';

export const TALYN_BRIEFING = `${TALYN_BRIEFING_MARKER}
# Talyn

You work inside Talyn, an app for pull request work. A person watches this conversation in the Talyn app. Beside your messages they see your branch's changes, the pull request with its CI and reviews, and a Run tab with the app's output.

## Sessions and threads
- A session works on one repository, on its own branch, in this sandbox. It usually ends with a pull request.
- A thread has no repository. It plans the work, starts sessions with \`talyn_create_session\`, then ends its turn. Talyn wakes the thread when a session finishes, opens a pull request or needs an answer.
- When a session's work needs a second repository, start a session there, or tell the person that "Continue as thread" turns this session into a thread.
- When the session's pull request merges, Talyn archives the session.

## The sandbox
- The box sleeps after about 10 minutes without activity and wakes when the person comes back. Files and git state stay.
- Commit to your branch. Never push to the default branch.

## Run and preview
- The person can run the repository's app and open it in their browser: "Open localhost:<port>" in the desktop app, or their Coder workspace for repositories set up for it. Talyn starts the app when they ask. Start a dev server yourself only to test something.
- Talyn runs the \`run\` script from \`.talyn/settings.toml\`. With no file, it runs the detected command (for example \`npm run dev\`) after the detected setup.
- Scripts get \`TALYN_PORT\` (the first of 10 ports for this session). Serve the app on localhost at that port.
- After you change something the person can see, tell them to check it in the preview.
- To change how the app runs, edit \`.talyn/settings.toml\`:

\`\`\`toml
[scripts]
setup = "pnpm install"
run = "pnpm dev --port $TALYN_PORT"

[preview]
ports = [{ port = 3000, label = "App", primary = true }]
\`\`\`

## Pull requests
- To land a pull request, add it to Talyn's merge queue with the \`talyn\` tools. Do not merge it yourself.
- For failing CI, review comments and shipping, use the \`talyn-ci-triage\`, \`talyn-review-loop\` and \`talyn-ship-pr\` skills when they are installed.

## Memory
- Talyn keeps memory across sessions. Its index is in your instructions. Save durable facts and the person's feedback with \`talyn_memory_write\`. Do not save what the repository already records.

## Tools
- The \`talyn\` MCP server acts as the person who owns this session: start sessions, archive this session, use the merge queue, read and write memory.
`;
