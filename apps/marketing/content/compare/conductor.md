---
title: "Conductor alternative: move off Conductor Cloud to Talyn"
description: "Conductor Cloud shuts down on November 20, 2026. Talyn runs parallel Claude Code and Codex sessions in cloud sandboxes and reads your conductor.json unchanged."
competitor: "Conductor"
category: "Cloud coding agents"
navLabel: "vs Conductor"
verdict: "You want to keep your local Conductor workspaces on your Mac until early 2027, or you need Cursor or OpenCode as your agent."
updated: "2026-11-10"
faq:
  - q: "What happens to Conductor Cloud on November 20?"
    a: "Conductor Cloud shuts down on November 20, 2026, and Conductor starts to delete cloud user data. On November 13 it goes read-only: you can read old chats and export data, but you cannot send new messages. Export your data before November 20."
  - q: "Will my conductor.json work in Talyn?"
    a: "Yes. Talyn reads conductor.json and .conductor/settings.toml, so a repository set up for Conductor works with no changes. The setup, run and archive scripts run as before, and each CONDUCTOR_* variable your scripts use is set with the same value as its TALYN_* name."
  - q: "How do I move a Conductor Cloud workspace to Talyn?"
    a: "Push the workspace's branch to GitHub before November 13. Open Talyn, sign in with GitHub, and connect Claude, ChatGPT or both. Start a session and choose Create from to open it on that branch or its pull request. Talyn does not import Conductor chats."
  - q: "Does Talyn work on Windows and Linux?"
    a: "Yes. Talyn has desktop apps for macOS, Windows and Linux, and a browser app at app.talyn.dev, all on the same account and sessions. Windows builds are unsigned, so SmartScreen warns on the first install. The browser app needs no install."
  - q: "What does Talyn cost?"
    a: "Talyn is free with 10 box-hours a month. Pro is $40 a month for 200 box-hours, every sandbox size and up to 100 sandboxes at once. Agents run on your own Claude or ChatGPT plan, so you pay Talyn for the machines, not the model."
sources:
  - label: "Conductor is joining Meta (announcement and timeline)"
    url: "https://www.conductor.build/announcement"
  - label: "Conductor changelog 0.93.0"
    url: "https://www.conductor.build/changelog/0.93.0-conductor-is-joining-meta"
  - label: "Conductor"
    url: "https://www.conductor.build/"
related: ["t3-code", "cursor-background-agents", "codex-cloud"]
relatedFeatures: ["sessions", "threads", "agents"]
---

Conductor and Talyn are built around the same idea. You give each task its own
agent, on its own branch, in its own workspace, and you run several of them at
once. Conductor called the unit a workspace. Talyn calls it a session.

On November 4, 2026, Conductor announced that it is joining Meta. If you use
Conductor Cloud, you need somewhere to move your work this month. This page
says what changes on which date, what carries over to Talyn unchanged, and what
Talyn does not do.

Ready to move? [Open the browser app](https://app.talyn.dev) or
[download Talyn](/download), sign in with GitHub, and pick up your first branch
in a few minutes.

## The Conductor timeline

From Conductor's own announcement:

- **November 4**: no new sign-ups and no new downloads. Existing Pro users keep
  Pro features for free.
- **November 13**: Conductor Cloud goes read-only. You can read old chats and
  export data, but you cannot send new messages. Active subscribers get a
  refund.
- **November 20**: Conductor Cloud shuts down and Conductor starts to delete
  cloud user data.
- **Early 2027**: local Conductor gets new models and critical fixes until
  then, and then it winds down.

## What carries over unchanged

**Your setup scripts.** Talyn reads `conductor.json` and
`.conductor/settings.toml`, so a repository set up for Conductor works with no
changes. The setup, run and archive scripts run as they did, and every
`CONDUCTOR_*` variable your scripts use is set, with the same value as its
`TALYN_*` name. See [repository setup](/docs/repository-setup).

**Your subscriptions.** Talyn runs first-party Claude Code on your Claude Pro
or Max plan and Codex on your ChatGPT Plus or Pro plan. You sign in with the
account. There is no API key and no token markup.

**The way you work.** Each session has its own branch, sandbox, diff, terminal
and run scripts. Sessions never touch each other's files. In the desktop app, a
session can also run in a git worktree on your own computer, and a local
session uses none of your box-hours.

**Cloud sandboxes.** Each cloud session runs in its own Firecracker microVM.
Talyn builds an image of your repository with the setup already done, so a new
session does not start from a clean machine. A sandbox goes to sleep after 10
minutes without work, and a sleeping sandbox costs nothing.

## How to move

1. **Before November 13, save your work in Conductor Cloud.** Push the branch
   of each workspace you want to keep to GitHub. Conductor also lets you
   right-click a cloud workspace and choose **Transfer to local**, and export
   everything from **Settings → Account → Export data**.
2. **Open Talyn.** [Download it](/download) for macOS, Windows or Linux, or use
   [the browser app](https://app.talyn.dev). Sign in with GitHub and install the
   Talyn GitHub App on the repositories you work in.
3. **Connect Claude, ChatGPT or both.** Talyn uses the subscription you sign in
   with. See [connect your agents](/docs/connect-agents).
4. **Pick up each branch.** Start a session and choose **Create from…** to open
   it on an existing branch or an open pull request.

Talyn does not import Conductor chats. The work is on the branch, and the
session starts a new conversation on top of it.

## What Talyn adds

- **Windows, Linux and the browser.** The same account and the same sessions on
  macOS, Windows, Linux and at app.talyn.dev.
- **Threads.** One conversation with a goal that starts a session on every
  repository that needs a change, and keeps track of each one.
- **Past the pull request.** One button opens the pull request. The same button
  then fixes failing checks, resolves conflicts and merges. A merge queue lands
  ready pull requests in order and sends an agent when one breaks.
- **Code review in the app.** Several reviewers read a change, then a check
  drops what it cannot back up. Nothing reaches GitHub unless you post it.
- **Work that starts without you.** Scheduled automations run a prompt on a schedule. GitHub automations
  run on pull request events. Both run in the cloud with the app closed.
- **Slack, MCP servers and a public API.** Start a session from a Slack
  message, give the agent your Linear or Sentry tools without putting the keys
  in the sandbox, or drive sessions from your own scripts.

## What Talyn does not do

- **No Cursor or OpenCode.** Talyn runs Claude Code and Codex.
- **No public iOS app yet.** The mobile app is coming. Today you can use the
  browser app on your phone.
- **Team sharing is not generally available.** Each person has their own
  workspaces.
- **GitHub only.** No GitLab and no Bitbucket.
- **Windows builds are unsigned.** SmartScreen warns on the first install.

## Price

Talyn is free with 10 box-hours a month. Pro is $40 a month for 200 box-hours,
every sandbox size and up to 100 sandboxes at once. A box-hour is one standard
sandbox awake for one hour, billed per second. The model runs on your own
Claude or ChatGPT plan, so you pay Talyn for the machines, not the model. See
[pricing](/pricing).

## Which one

**Stay on local Conductor if** your work already lives in local workspaces on
your Mac and you are happy to move when it winds down in early 2027.

**Use Talyn if** you used Conductor Cloud, you want your agents to keep working
with the laptop closed, or you need Windows, Linux or the browser.
