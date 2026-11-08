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

Other options in the composer:

- **Create from…** starts the session on an existing branch or an open pull request, instead of a new branch.
- **Plan** turns on plan mode. The agent reads the code and writes a plan, and changes nothing until you approve it. Press Shift+Tab to switch plan mode.
- **Internet on** / **Internet off** controls whether the sandbox can reach the internet. See [Internet access](/docs/sandboxes#internet-access).
- The image button attaches screenshots. You can also paste an image.

Your defaults for new sessions are in **Settings > Sessions**: the agent, the model, the reasoning effort, plan mode, internet access, a branch prefix such as `yourname/`, and a notification when an agent finishes.

## The session screen

The chat is in the middle. The panel on the right has four tabs:

- **Changes**: the diff of the branch against its base branch.
- **All files**: every file on the branch.
- **Pull request**: the pull request's status, checks and reviews, once there is one.
- **Sandbox**: what the sandbox is doing, and whether your work is saved.

The terminal dock below has a **Run** tab for your run scripts and a **Terminal** tab with a shell in the sandbox. Press ⌘J on a Mac to show or hide it.

## Talk to the agent while it works

You can send a message while the agent is in the middle of a turn. The message waits in a queue and goes in when the turn ends. Queued messages show above the composer, and you can remove one before it is sent.

To stop the agent, select **Stop the agent**.

Type `@` to mention a file, and `/` for the agent's slash commands. The agent is the real Claude Code or Codex tool, so its commands, skills and plan mode work as they do on your own computer.

## Undo with checkpoints

Each message you send is a checkpoint. To put the files back to how they were before a message, hover over the message and select **Revert to here**, then confirm.

## More than one chat

A session can have several chats on the same branch, shown as tabs. Use **New chat** (⌘T) to open another line of work, for example a review of what the first chat did. Each chat has its own model and plan mode setting.

## From the diff to a merged pull request

One button in the session header moves the work on. Its label changes as the pull request moves:

1. **Create PR**: the agent writes the title and description from your changes and your PR template. Talyn then commits, pushes the branch and opens the pull request.
2. **Resolve conflicts**: the agent merges the base branch in and resolves the conflicts.
3. **Fix checks**: the agent gets each failing check with its link and fixes them.
4. **Merge**: Talyn merges the pull request on GitHub.
5. **Archive session**: once the pull request is merged.

**Address review comments** asks the agent to read and handle the unresolved review comments.

To have the agent open the pull request by itself when it finishes, turn on **Open a PR when the agent is done** in **Settings > Agents**.

To link a pull request that already exists, open the **More actions** menu in the header and select **Link pull request…**.

## Threads

A thread is a conversation with no repository of its own. You give it a goal, and it starts a session on each repository that needs a change. Use a thread when one change needs work in several repositories, for example an API, its client and the docs.

To start one, select **New thread** in the sidebar and describe the goal.

The thread keeps track of its sessions. When a session finishes a turn, opens a pull request, has its pull request merged or needs an answer, the thread's agent hears about it and can act. When it needs you, it says so in the thread, with a link to the session.

Every session a thread starts is an ordinary session. You can open it, read its diff and send it messages yourself.

To turn a session into a thread, open **More actions** in the session header and select **Continue as thread**. The new thread starts with a recap of the session, and the session joins it.

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
