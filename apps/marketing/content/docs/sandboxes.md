---
title: Sandboxes
description: Each session runs in its own cloud sandbox. Box sizes, sleep and wake, saved work, internet access, and what to do when a sandbox has a problem.
---

Each session gets its own sandbox: a small cloud machine with your repository checked out on the session's branch. The agent runs its commands there, your setup and run scripts run there, and the **Terminal** tab opens a shell there.

Sandboxes are separate from each other. Two sessions on the same repository cannot see each other's files.

## Box sizes

| Size | vCPU | Memory | Good for | Box-hours per hour |
| --- | --- | --- | --- | --- |
| Small | 2 | 4 GB | Docs, scripts and unattended runs | 0.5 |
| Standard | 4 | 4 GB | Most repos | 1 |
| Medium | 4 | 8 GB | Big builds, one database | 1.25 |
| Large | 6 | 12 GB | Full test stacks | 2 |
| X-Large | 8 | 16 GB | The heaviest stacks | 2.5 |

The free plan can use Small and Standard. Pro can use every size. See [Plans, usage and billing](/docs/billing).

### Set the size for a repository

1. Open **Settings > Repositories** in the desktop app, or **Settings > Workspace** in the web app.
2. Find the repository.
3. Set **Sandbox size**.

**Auto** lets Talyn pick a size for the repository and shows the reason. New sessions on the repository use this size.

Work that runs without you, such as loops, workflows and fix runs, uses a Small box.

### Move a session to another size

If a session needs more memory, you or the agent can move it to another size. The move starts when the current turn ends. Talyn moves your work to the new box and the session carries on there.

## Sleep and wake

A sandbox that is idle for 10 minutes goes to sleep. A sleeping sandbox uses no box-hours.

Your next message wakes it, usually in a few seconds. You can also select **Wake** in the **Sandbox** tab. While it sleeps, you can still read the session's changes and files from the copy Talyn keeps.

A sandbox that sleeps for a long time moves to storage. Waking it from storage takes a few minutes.

## Your work is saved

After every turn, Talyn saves the work you have not pushed: uncommitted changes and commits that are not on GitHub. It saves to Talyn's own storage and pushes nothing to GitHub.

If a sandbox is lost, Talyn starts a new one at your next message and restores the saved work. If the branch on GitHub has moved on since the save, Talyn keeps the saved work in storage and does not apply it on top.

## Internet access

The **Internet on** / **Internet off** switch decides what a session's sandbox can reach.

- **On**: the sandbox can reach any website, for example to install tools or read docs. New sessions start with internet on, unless you change the default in **Settings > Sessions**.
- **Off**: the sandbox can reach only its repository, the package registries and the agent's API.

Turn it off for work on code you do not trust, or when you do not want the agent to send anything outside.

Runs that Talyn starts for you on a pull request, such as fix runs and code reviews, reach only the repository and the agent's API. Loops have their own switch. See [Loops](/docs/loops#internet-access).

## Run your app

Start your dev server with a run script. See [Repository setup](/docs/repository-setup).

In the desktop app, Talyn forwards the sandbox's port to the same port on your computer, so you open the app on `localhost` like any other dev server.

## Sandbox status

The status chip in the session header shows what the sandbox is doing: **Starting**, **Running**, **Idle**, **Asleep**, **In storage**, **Waking**, **Moving**, **Lost** or **Failed**. The **Sandbox** tab shows more detail, the setup output, and the last problem.

If a sandbox is stuck while it starts, or has failed, select **Retry** in the **Sandbox** tab. Retry deletes the sandbox and starts a new one from the branch on GitHub. Changes that are not pushed are lost, so push first if you can. See [Troubleshooting](/docs/troubleshooting#a-sandbox-will-not-start-or-wake).
