---
title: Sessions and threads
description: A session is one task on one branch, with its own agent, chat, diff, terminal and sandbox. A thread works across repositories by starting sessions for you.
---

A session is one task. It has its own branch, its own agent and its own cloud sandbox. You chat with the agent, read its changes, run your app, and open the pull request, all from one screen. You can run many sessions at the same time, and they never touch each other's files.

## Start a session

1. Select **New session** in the sidebar.
2. Describe the task.
3. Pick the repository.
4. Optionally, change the agent, model, reasoning effort or base branch.
5. Press Enter, or select **Create and start**.

Talyn names the session, creates a branch, starts a sandbox and gives your message to the agent. Press Shift+Enter for a new line in the message.

On the home page, **Recent** under the composer lists your newest sessions and threads. Select one to open it. In the mobile app, the composer stays in the middle of the screen with **Recent** below it until you start to type. Each row shows the live state, the repository, the lines added and removed, and the pull request. When you tap the message field, the composer moves to the bottom of the screen above the keyboard. Press and hold a row to open its menu.

If you have no sessions yet, the sidebar suggests a few to start. A suggestion on one of your pull requests comes first: fix its failing checks, resolve its merge conflicts, address its review comments, or review a pull request that asks for your review. A suggestion fills in the message and the pull request, and you can change both before you start.

Other options in the composer:

- **Create from…** starts the session on an existing branch or an open pull request, instead of a new branch. In the mobile app, the branch control above the message opens **Start from**, which lists a base branch for a new branch and the repository's open pull requests.
- To start a session from a pull request, you can also use **Open in session** on the pull request. On mobile, it is in the pull request's menu.
- **Plan** turns on plan mode. The agent reads the code and writes a plan, and changes nothing until you approve it. Press Shift+Tab to switch plan mode.
- **Internet on** / **Internet off** controls whether the sandbox can reach the internet. See [Internet access](/docs/sandboxes#internet-access).
- The attach button adds images, videos and text files. You can also paste or drop them into the chat. Images can be PNG, JPEG, WebP or GIF, up to 10 MB. Videos can be MP4, MOV or WebM, up to 50 MB. On the phone, pick a video from your library.
- A text file must be UTF-8 text, up to 1 MB. Examples are logs, Markdown, CSV, JSON, YAML and source code. The file keeps its name. The agent reads it from the sandbox. The phone shows text files that you attach on the web or desktop, but cannot attach them yet.
- You can attach a video only after the session starts. When you start a new session, attach images and text files only.
- You can send a message while a file uploads. The message waits, and goes when the upload finishes. Press send again to cancel it. If the upload fails, the message is not sent and stays in the composer.
- The agent gets a video as a file in the sandbox. It cannot watch the video. It can take still frames from the video with a tool such as ffmpeg, if the sandbox has one.

Your defaults for new sessions are in **Settings > Sessions**: the agent, the model, the reasoning effort, plan mode, internet access and a branch prefix such as `yourname/`.

In the desktop app and the web app, **Settings > Notifications** holds all notification settings. In the mobile app, they are in the **Notifications** group in **Settings**.

- On a computer, turn on a notification when an agent finishes, and a notification when a merge-queue pull request is blocked. These settings apply only to that computer or browser.
- For your phone, turn workspace notifications on or off, and choose the types: session updates, PR reviews, CI failures, ready to merge and human input. You can get alerts only when you are away from your computer, and you can set quiet hours. A change on one device also applies to the others. Each phone must also allow notifications in the Talyn mobile app.

Claude adds itself as a commit co-author by default. Turn this off under **Settings > Sessions > Commits**.

## See a session at a glance

Hover over a session in the sidebar to see its details immediately. The card shows:

- The session's state, its full title, the repository and the branch.
- The pull request: its title, its checks and their counts, its review status and its size.
- Uncommitted changes, and committed changes when there is no pull request yet.
- The agent and the model, and whether the sandbox is awake or asleep.
- Running background jobs, a scheduled wake-up, where the session started (for example a Slack channel), and an error if there is one.
- When the session was last active and when it started.

A session in a space also shows who started it. In the mobile app, press and hold a session. The menu shows its state, branch, changes, agent, sandbox and times above the actions.

## The session screen

The chat is in the middle. Each message you send shows when you sent it, for example "5 minutes ago". Each finished agent reply shows when it ended. Hover over a time to see the full date and time. The session header shows **Last message** with the time of the newest message in the session.

The panel on the right has four tabs:

- **Changes**: the diff of the branch against its base branch.
- **All files**: every file on the branch.
- **Pull request**: the pull request's status, checks and reviews, once there is one.
- **Sandbox**: what the sandbox is doing, its CPU and memory use over the last hour, and whether your work is saved.

The terminal dock below has a **Run** tab for your run scripts and a **Terminal** tab with a shell in the sandbox. Press ⌘J on a Mac to show or hide it.

## Find in the transcript

Press ⌘F (Ctrl+F on Windows and Linux) to search the session's chat. The find bar shows the number of matches and highlights them.

- Press Enter to go to the next match. Press Shift+Enter to go to the previous match.
- Press Esc to close the find bar.
- In split view, ⌘F searches the pane that has focus.
- The search includes only the messages that are loaded. To search earlier messages, scroll up to load them. When earlier messages are not loaded, the find bar tells you.
- The search does not include the contents of collapsed tool calls.
- In the code viewer and in the terminal, ⌘F keeps its usual function.

In the mobile app, tap the search button in the session header. The row of the current match has a tinted background.

## Talk to the agent while it works

You can send a message while the agent is in the middle of a turn. The message waits in a queue and goes in when the turn ends. Queued messages show above the composer, and you can remove one before it is sent.

To stop the agent, select **Stop the agent**.

Type `@` to mention a file, and `/` for the agent's slash commands. The agent is the real Claude Code or Codex tool, so its commands, skills and plan mode work as they do on your own computer.

## Wait for CI

An agent can wait for the checks on its pull request instead of polling them. It sets a wake-up that fires when the checks on the commit finish, when the pull request head moves, or when the pull request merges or closes. The wake-up also has a latest time, which is 3 hours unless the agent sets another. The session shows that it waits for CI, and the agent starts a new turn when the wake-up fires.

## When the model API fails

Sometimes the Claude or Codex API fails on its side, for example with a server error or an overload. Talyn then suspends the sandbox and tries again later. It waits 2, 5, 10, 20 and then 30 minutes between tries, and it tries at most 8 times. The chat shows **The model API is failing** and the time of the next try. Select **Resume now** to try at once, or **Cancel** to stop waiting.

With automatic resume enabled, a waiting session continues by itself when usage returns or you reconnect an account.

To turn this off, open **Settings > Sessions** and turn off **Continue when an agent hits its limit**. That setting also covers usage limits. See [The model API is failing](/docs/troubleshooting#the-model-api-is-failing).

## Undo with checkpoints

Each message you send is a checkpoint. To put the files back to how they were before a message, hover over the message and select **Revert to here**, then confirm.

## From the diff to a merged pull request

One button in the session header moves the work on. Its label changes as the pull request moves:

1. **Create PR**: the agent writes the title and description from your changes and your PR template. Talyn then commits, pushes the branch and opens the pull request.
2. **Resolve conflicts**: the agent merges the base branch in and resolves the conflicts.
3. **Fix checks**: the agent gets each failing check with its link and fixes them.
4. **Merge**: Talyn merges the pull request on GitHub.
5. **Archive session**: once the pull request is merged.

**Address review comments** asks the agent to read and handle the unresolved review comments.

In the desktop app, you can have the agent open the pull request by itself when it finishes. Turn on **Open a PR when the agent is done** in **Settings > Agents**.

Sometimes Talyn cannot push the branch or commit the changes for a reason that the agent can fix. For example, the branch on GitHub has commits that the session does not have. Then Talyn gives the error back to the agent in a new turn. The agent merges the remote commits or fixes the commit, and Talyn tries again. The chat shows this turn as one line, **Talyn could not open the pull request**, and **Show error** shows the error. Talyn tries at most two times. It does not try again when GitHub refuses access, because only you can fix that. It also does not try again when you already sent the next message.

When the session has an open pull request, the header shows its number. Select the copy button next to it to copy the link to the pull request. You can copy the plain link, or a Markdown link that uses the pull request's title. In the mobile app, the session menu has **Copy pull request link** and **Copy pull request as Markdown link**.

To link a pull request that already exists, open the **More actions** menu in the header and select **Link pull request…**.

## Threads

A thread is a conversation with no repository of its own. You give it a goal, and it starts a session on each repository that needs a change. Use a thread when one change needs work in several repositories, for example an API, its client and the docs.

To start one, select **New thread** in the sidebar and describe the goal.

The thread keeps track of its sessions. When a session finishes a turn, opens a pull request, has its pull request merged or needs an answer, the thread's agent hears about it and can act. When it needs you, it says so in the thread, with a link to the session.

Every session a thread starts is an ordinary session. You can open it, read its diff and send it messages yourself.

To turn a session into a thread, open **More actions** in the session header and select **Continue as thread**. The new thread starts with a recap of the session, and the session joins it.

## Split view

Split view shows up to four sessions side by side, each with its own chat and composer. It is in the desktop app and the web app. It is not in the mobile app.

- Open **Split view** from the command palette, or right-click a session in the sidebar and select **Open in split view**. You can also hold ⌘ (Ctrl on Windows and Linux) and click a session.
- Drag a session or thread from the sidebar onto a pane. Drop it in the middle of a pane to replace that session. Drop it near an edge to add it beside the pane.
- Drag a pane header onto another pane to swap the two. The arrows in a header move a pane left or right, and the close button removes it.
- Only the pane you click has the keyboard focus. Select the open icon in a pane header to open that session on its own.

Talyn keeps your panes on the device. A pane closes when its session is archived.

## Archive a session

When you are done, archive the session:

1. Select **Archive** in the session header, or archive the session from its row in the sidebar.
2. Confirm.

The session moves to **History**. Its branch, its chats and any pull request stay. Talyn saves any work you did not push before it removes the sandbox. It pushes nothing to GitHub to do this.

Talyn also archives a session by itself:

- When its pull request is merged and no chat is running.
- When it has been idle for 7 days.

Open **Settings > Sessions > Auto-archive** to change these rules. You can turn off either rule. You can also choose how long a session stays idle before Talyn archives it.

To bring a session back, open **History** and select **Restore**.

To delete a session for good, open **History** and select delete. This removes the session and its chats. It does not touch the branch on GitHub.

## Local sessions

In the desktop app, a session can also run in a git worktree on your own computer, with your own tools. Choose **Local** instead of **Sandbox** when you start it. A local session has no sandbox, so it does not use your plan's box-hours.

## Limits

Each running sandbox counts against your plan. See [Plans, usage and billing](/docs/billing).

### Add an agent to an older sandbox

A new sandbox includes connected Claude and Codex accounts, even when a temporary usage limit applies.
Accounts that need sign-in are excluded. Each turn still selects its account again.

An older sandbox can run only one agent. When you have connected the other agent, select **Restart sandbox** beside the chat input to add it.
The restart keeps your branch and uncommitted changes. It starts after all running turns end.
Running processes stop. Large ignored files may not transfer.
If the transfer fails, the session keeps its old sandbox.
