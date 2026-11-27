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

On the home page, **Recent** under the composer lists your newest sessions and threads. Select one to open it. In the mobile app, the composer stays in the middle of the screen with **Recent** below it until you start to type. When you scroll down **Recent**, the composer moves to the top of the screen as a one-line field, so the list has more room. Scroll back to the top, or tap the field, to show the full composer again. Each row shows the live state, the repository, the lines added and removed, and the pull request. When you tap the message field, the composer moves to the bottom of the screen above the keyboard. Press and hold a row to open its menu.

If you have no sessions yet, the sidebar suggests a few to start. A suggestion on one of your pull requests comes first: fix its failing checks, resolve its merge conflicts, address its review comments, or review a pull request that asks for your review. A suggestion fills in the message and the pull request, and you can change both before you start.

Other options in the composer:

- **Create from…** starts the session on an existing branch or an open pull request, instead of a new branch. In the mobile app, the branch control above the message opens **Start from**, which lists a base branch for a new branch and the repository's open pull requests.
- To start a session from a pull request, you can also use **Open in session** on the pull request. On mobile, it is in the pull request's menu.
- A session on an existing branch can reuse an open PR link from another session in the same workspace. The previous session can be archived. The link appears before the new session pushes changes.
- **Plan** turns on plan mode. The agent reads the code and writes a plan, and changes nothing until you approve it. Press Shift+Tab to switch plan mode.
- The composer shows Markdown formatting while you type: quotes, headings, lists, bold, italic, strikethrough, code, code blocks and links. It also marks file mentions (@) and a slash command at the start of the message. The marks such as `**` and `>` stay in the text, so the agent gets the Markdown that you typed.
- Press Esc to leave the composer. Then you can use keyboard shortcuts such as G then P, which opens your pull requests. The text that you typed stays in the composer.
- **Internet on** / **Internet off** controls whether the sandbox can reach the internet. See [Internet access](/docs/sandboxes#internet-access).
- The attach button adds images, videos and text files. You can also paste or drop them into the chat. Images can be PNG, JPEG, WebP or GIF, up to 10 MB. Videos can be MP4, MOV or WebM, up to 50 MB. On the phone, pick a video from your library.
- On Android, select **Take photo** in the attach menu to open the system camera. The camera app manages its own permission. Cancel in the camera to return to your draft.
- On mobile, the composer focuses the text field after you attach a photo or video.
- A text file must be UTF-8 text, up to 1 MB. Examples are logs, Markdown, CSV, JSON, YAML and source code. The file keeps its name. The agent reads it from the sandbox. The phone shows text files that you attach on the web or desktop, but cannot attach them yet.
- You can attach a video only after the session starts. When you start a new session, attach images and text files only.
- You can send a message while a file uploads. The message waits, and goes when the upload finishes. Press send again to cancel it. If the upload fails, the message is not sent and stays in the composer.
- The agent gets a video as a file in the sandbox. It cannot watch the video. It can take still frames from the video with a tool such as ffmpeg, if the sandbox has one.

Your defaults for new sessions are in **Settings > Sessions**: the agent, the model, the reasoning effort, plan mode, internet access and a branch prefix such as `yourname/`.

The sandbox composer checks the last recorded subscription usage for Claude and Codex.
If every usable subscription for your default agent is at its limit, the composer checks the other agent.
The composer selects that agent if one of its subscriptions has usage left.
You can still select an agent or model for that session.

Open **Settings > Notifications** on your computer or phone to manage your alerts.

- On a computer, turn on a notification when an agent finishes, and a notification when a merge-queue pull request is blocked. These settings apply only to that computer or browser.
- In the mobile app, select a workspace to turn its phone alerts on or off. Choose which alert types to receive. You can set quiet hours and receive alerts only when you are away from your computer. Each phone must allow notifications for Talyn.

Under **Team spaces**, set each phone alert type to **On**, **Off**, or **Use workspace default**. The workspace still controls whether phone alerts are enabled and when they can arrive.

You can also mute a team space, such as Automations.
This personal setting applies to your desktop, browser, and phone.
Your teammates keep their own preferences.
Sessions, threads, and tasks in a muted space send you no alerts.
Linked pull requests are muted when all their sessions and tasks are in spaces you muted.
This includes archived sessions.
A pull request with a session or task in Personal can still send alerts.
Turn off the mute to use your saved settings again.
If muted spaces leave the list, select **Restore alerts** to remove their mutes.
This also works after a space is archived or you leave its team.

Claude adds itself as a commit co-author by default. Turn this off under **Settings > Sessions > Commits**.

## See a session at a glance

Hover over a session in the sidebar to see its details immediately. The card shows:

- The session's state, its full title, the repository and the branch.
- The pull request: its title, its checks and their counts, its review status and its size.
- Uncommitted changes, and committed changes when there is no pull request yet.
- The agent and the model, and whether the sandbox is awake or asleep.
- Running background jobs, a scheduled wake-up, where the session started (for example a Slack channel), and an error if there is one.
- When the session was last active and when it started.

The **Needs you** section at the top of the sidebar lists the sessions that wait on you: a session that failed, asks a question, has a plan to approve, or has a pull request with merge conflicts. A session leaves the list when you open it.

A session in a space also shows who started it. In the mobile app, press and hold a session. The menu shows its state, branch, changes, agent, sandbox and times above the actions.

## The session screen

The chat is in the middle. Each message you send shows when you sent it, for example "5 minutes ago". Each finished agent reply shows when it ended. Hover over a time to see the full date and time. The session header shows **Last message** with the time of the newest message in the session.

The panel on the right has four tabs:

- **Changes**: the diff of the branch against its base branch.
- **All files**: every file on the branch.
- **Pull request**: the pull request's status, checks and reviews, once there is one.
- **Sandbox**: what the sandbox is doing, its CPU and memory use over the last hour, and whether your work is saved.

The terminal dock below has a **Run** tab for your run scripts and a **Terminal** tab with a shell in the sandbox. Press ⌘J on a Mac to show or hide it.

## Switch agents in a session

In the web or desktop composer, use **Agent** to switch between Claude and Codex.
On mobile, open the session menu and select **Switch to Claude** or **Switch to Codex**.
The sandbox must support both connected agents.
A switch stops any running turn. The next agent receives a recap of the conversation.

Talyn selects an equivalent model when you switch:

| Claude model | Codex model |
| --- | --- |
| Opus 5.5 | GPT-6.2 Sol |
| Fable 5.2 | GPT-6 Astra |
| Sonnet 5.5 | GPT-6.1 Terra |
| Sonnet 4.6 | GPT-6 Luna |

These pairs work in both directions. Older Opus and Fable models also switch to Sol and Astra, respectively.
The selected version comes from Talyn's current model list.
If the chat has no model override, the switch uses the session model when both use the same agent.
You can select another model after the switch.

## Subagents

Claude subagents have a Subagent card in web, desktop and mobile. Codex does not have subagent cards yet.
The card shows the type, title and progress. It shows Finished or Failed when the call ends.
Expand the card to read the brief, its nested steps and the result.
Nested steps stay out of the main conversation.

When Claude sends task details, the card shows the current activity, token count, tool count and elapsed time.
Older transcripts use the card's own step count. A chip shows how many subagents still run in the current turn.

Each subagent of the latest turn that started subagents also has a tab above the transcript. The first tab, **Main**, shows the conversation.
A subagent's tab shows its brief, its steps as they happen, and its result.
Click the chip to open the tab of a running subagent. Click the chip again to open the next running subagent.
To open the tab of a subagent from an earlier turn, click **Open** on its card.
Tabs work the same way in web, desktop and mobile.

The extra steps, details, count and tabs require the `session-subagents` feature flag.
If a turn ends with open subagents, Talyn adds a note that those subagents stopped.

## Find in the transcript

Press ⌘F (Ctrl+F on Windows and Linux) to search the session's chat. The find bar shows the number of matches and highlights them.

- Press Enter to go to the next match. Press Shift+Enter to go to the previous match.
- Press Esc to close the find bar.
- In split view, ⌘F searches the pane that has focus.
- The find bar loads the earlier messages, so the search includes the whole transcript.
- The search does not include the contents of collapsed tool calls.
- In the code viewer and in the terminal, ⌘F keeps its usual function.

In the mobile app, tap the search button in the session header. The row of the current match has a tinted background.

## Search all transcripts

Press ⌘K (Ctrl+K on Windows and Linux) and type at least three characters. Below the sessions whose names match, the **Transcript** rows show the sessions and threads whose chats contain the text. Archived sessions are included.

- The search finds the messages that you send and the text that the agent writes. It does not search tool output, such as command output or file contents.
- Each word that you type must be in the same message. A word matches the start of a word in the message: "pyarr" finds "pyarrow", but "arrow" does not.
- Each row shows the text around the match.
- Select a row to open the session. Its find bar opens with your search, so you can step through the matches.

In the mobile app, type in the search field of the menu. The matches show under **In transcripts**.

## Start a session from part of a transcript

Select text in a session's or a thread's chat. A **New session from selection** button shows above the selected text. Click it to open the new-session page:

- The composer holds the selected text as a Markdown quote. Type your task under the quote.
- The repository of the session is selected. A thread has no repository, so the page keeps its usual repository.
- In a space, the space's composer opens.
- Nothing starts until you send the message.
- The quote holds the first 8,000 characters of a longer selection.

In the mobile app, touch and hold a message in the conversation. A menu opens:

- **New session from message** quotes the full message in a new session.
- **Copy message** copies the message text.
- **Select text** shows the message in a text view. Select the part you want, then tap **New session from selection**.

## Share to Talyn from another app

In the mobile app, you can start a session from a link or from text in another app. Open the app's share sheet and pick **Talyn**:

- The new-session page opens. A link shows with the page title when the app sends one. Other text shows as a Markdown quote. Type your task under it.
- The page keeps your usual repository.
- Nothing starts until you send the message.
- When you are signed out, sign in first. The shared item then opens.

Talyn takes text and links. It does not take images or files from the share sheet. To attach an image, use the image button in the composer.

## Talk to the agent while it works

You can send a message while the agent is in the middle of a turn. The message waits in a queue and goes in when the turn ends. Queued messages show above the composer, and you can remove one before it is sent.

To stop the agent, select **Stop the agent**.

Type `@` to mention a file, and `/` for the agent's slash commands. The agent is the real Claude Code or Codex tool, so its commands, skills and plan mode work as they do on your own computer.

## When the agent asks a question

When the agent needs a decision from you, it asks a question and stops. The chat shows the question as a card with the agent's options. Select an option, or write your own answer under **Other**, and send. You can also answer in the composer. The session shows **Waiting for your answer** until you reply, and Talyn sends you a notification.

## Wait for CI

An agent can wait for the checks on its pull request instead of polling them. It sets a wake-up that fires when the checks on the commit finish, when the pull request head moves, or when the pull request merges or closes. The wake-up also has a latest time, which is 3 hours unless the agent sets another. The session shows that it waits for CI, and the agent starts a new turn when the wake-up fires.

## When the model API fails

Sometimes the Claude or Codex API fails on its side, for example with a server error or an overload. Talyn then suspends the sandbox and tries again later. It waits 2, 5, 10, 20 and then 30 minutes between tries, and it tries at most 8 times. The chat shows **The model API is failing** and the time of the next try. Select **Resume now** to try at once, or **Cancel** to stop waiting.

With automatic resume enabled, a waiting session continues by itself when usage returns or you reconnect an account.

If all accounts for the current agent reach their usage limit, Talyn switches to the other available agent.
This also applies when Talyn detects the limit before a turn starts.
The sandbox must support both agents, and the other agent must have an account with available usage.
The next turn uses a conversation recap and a model from the same capability tier.
If neither agent can run, the session waits for usage to return.

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

When a session in a thread asks a question, the thread gets the question too. If the plan or your earlier messages give the answer, the thread answers for you, and the session shows that answer as **From thread**. If the thread does not know the answer, it asks you. You can also answer in the session yourself.

Every session a thread starts is an ordinary session. You can open it, read its diff and send it messages yourself.

To turn a session into a thread, open **More actions** in the session header and select **Continue as thread**. The new thread starts with a recap of the session, and the session joins it.

You can also ask the session's agent to do it, for example "turn this into a thread". The agent starts the thread and gives it its plan. When the agent finds that the work needs changes in more than one repository, it turns the session into a thread by itself. To keep the work in one session, tell the agent so.

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

**Archive all** selects sessions with no open pull request. It skips threads and sessions that are starting, moving, or working.
Sessions with queued messages, running scripts, running background jobs, or pending wake-ups stay open.
Talyn checks each session again on the server before it archives it.
If work starts after the confirmation dialog opens, Talyn keeps the session and shows a notice.
These checks apply to **Archive all**. You can still explicitly archive one session with the **Archive** action.

Talyn also archives a session by itself:

- When its pull request is merged and no chat is running.
- When it has been idle for 7 days.

Open **Settings > Sessions > Auto-archive** to change these rules. You can turn off either rule. You can also choose how long a session stays idle before Talyn archives it.

To bring a session back, open **History** and select **Restore**.

If the archived session is open in the mobile app, tap the three-dot menu in the header. Select **Restore**.

To delete a session for good, open **History** and select delete. This removes the session and its chats. It does not touch the branch on GitHub.

## Local sessions

In the desktop app, a session can also run in a git worktree on your own computer, with your own tools. Choose **Local** instead of **Sandbox** when you start it. A local session has no sandbox, so it does not use your plan's box-hours and does not count toward the boxes running at once. Local sessions are free and unlimited on every plan.

## Limits

Each running sandbox counts against your plan. See [Plans, usage and billing](/docs/billing).

### Add an agent to an older sandbox

A new sandbox includes connected Claude and Codex accounts, even when a temporary usage limit applies.
Accounts that need sign-in are excluded. Each turn still selects its account again.

An older sandbox can run only one agent. When you have connected the other agent, select **Restart sandbox** beside the chat input to add it.
The restart keeps your branch and uncommitted changes. It starts after all running turns end.
Running processes stop. Large ignored files may not transfer.
If the transfer fails, the session keeps its old sandbox.

## Child sessions

Use a subagent for searches, reviews, or independent work on the current branch that finishes within the turn.
Claude supports background Agent calls with `run_in_background: true`.
The chat stays running until the process exits, after those subagents finish.
For long shell commands, use `talyn_run_background`. Bash background calls, `&`, and `nohup` remain unsupported.

Use a child session for another repository, a separate branch and pull request, or work beyond the current turn.
Each child has its own box. It spends box-hours and counts against the concurrent box limit.
The child header links to its parent. The parent shows a **Sessions started** list with each child's status.
These controls appear in web, desktop, and mobile when `session-subagents` is enabled.

A parent gets cards when a child ends a turn, opens a pull request, or merges one.
Set `notify_parent: true` on `talyn_create_session` to wake a normal parent when the child's turn ends.
The default adds cards without a wake. Thread notifications keep their existing behavior.
Use `talyn_list_thread_sessions` to follow children from a normal session.
The `talyn-delegate` skill explains these choices and costs.
