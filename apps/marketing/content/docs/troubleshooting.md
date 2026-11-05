---
title: Troubleshooting and FAQ
navLabel: Troubleshooting
description: What to do when an agent needs reconnecting, a subscription runs out, a sandbox will not wake, or GitHub is having an outage.
---

## Reconnect needed

**Reconnect needed** means Anthropic or OpenAI no longer accepts the sign-in that Talyn saved, so runs on that agent cannot start. This happens when the sign-in is revoked or expires. For Claude, it also happens when the account no longer has a Claude subscription.

You see it next to **Claude subscription** or **Codex (ChatGPT) subscription** in **Settings > Agents** (desktop) or **Settings > Integrations** (web). The usage gauge in the sidebar also says the agent needs reconnecting.

To fix it for Claude:

1. Select **Reconnect**.
2. Select **Sign in with Claude** and approve the request in your browser.
3. Paste the code from Anthropic into **Code from Anthropic**.
4. Select **Finish sign-in**.

To fix it for Codex, sign in to ChatGPT again: select **Sign in with ChatGPT** in the desktop app. In the web app, run `codex login` on your computer and paste the contents of `~/.codex/auth.json`.

## Usage limits and failover

Your Claude or ChatGPT subscription has its own usage limits. When a run hits one, or the vendor rate-limits your account, Talyn does not just fail the run. It moves the run to another agent you have connected:

1. First, another account on the same agent, if you connected more than one.
2. Then your other agent. For example, a Claude run moves to Codex.

The run's details show a note that says why it moved and where to. Your default agent does not change. Talyn also remembers that the subscription ran out, so the next run goes straight to the other agent instead of starting a sandbox to find out again.

Each account row in the agent settings shows its usage, and **Limit reached, resets** with a time when the vendor gives one.

If there is no other agent to move to, the run fails with a message that says so. Add usage to your subscription, or connect another agent.

## A sandbox will not start or wake

Open the **Sandbox** tab in the session. It shows what the sandbox is doing and the last problem.

- **Asleep**: send a message, or select **Wake**. It wakes in a few seconds.
- **In storage**: the sandbox slept for a long time. Waking it takes a few minutes.
- **Waiting for a free sandbox**: you have as many boxes running as your plan allows. It starts when another one stops. You can archive sessions you no longer need.
- **Out of box-hours**: you have used your plan's box-hours. See [When you run out](/docs/billing#when-you-run-out).
- **Lost**: the sandbox is gone. Talyn starts a new one at your next message and restores your saved work.
- **Failed**, or stuck while it starts: select **Show setup output** to see why. A failing setup script is a common cause. Fix it in `.talyn/settings.toml`, then select **Retry**.

**Retry** deletes the sandbox and starts a new one from the branch on GitHub. Changes that are not pushed are lost, so push first if you can.

## A run says "Needs you"

The agent stopped because only a person can continue, for example to approve a visual check, add a credential, or make a product decision. The agent's reason is on the run. Deal with it, then select **Run again**.

A pull request whose only problem is a check that needs a person shows **Needs human**. No agent runs on it until a person clears the check.

## GitHub is having an outage

When GitHub has an outage, Talyn shows a banner at the top of the app with GitHub's own description of the incident, and a **GitHub status** button. Pull request updates, merges and agent runs that need GitHub fail or wait until it is back. Talyn retries by itself, so you do not need to do anything.

The banner can also say that GitHub is answering Talyn with errors before GitHub has reported an incident.

## Pull requests are not updating live

If a banner says the Talyn GitHub App is not installed on an account, Talyn polls that account's public repositories every few minutes instead of getting live updates. Select **Install app** and install it on that account.

If your organization uses SAML single sign-on, select **Authorize SSO** when Talyn asks.

## The Windows installer shows a warning

The Windows installer is not code-signed yet. In the SmartScreen window, select **More info**, then **Run anyway**. See [Install Talyn](/docs/install#windows).

## Questions

**Does Talyn charge for the model?** No. Runs use your own Claude or ChatGPT subscription. You pay Talyn for box-hours. See [Plans, usage and billing](/docs/billing).

**Does Talyn work with GitLab or Bitbucket?** No. Talyn works with GitHub.

**Can Talyn merge something I did not ask it to?** Only pull requests you put in the merge queue. Keeping a pull request green fixes it, but does not merge it. Every merge goes through GitHub's merge API, so your branch protection applies.

**Does Talyn push to my branches?** Only when you ask: when an agent fixes a pull request, when you open a pull request from a session, or when you turn on keep green for a pull request. Talyn saves a session's unpushed work to its own storage, not to GitHub.

**Something else?** Open an issue on [GitHub](https://github.com/Gilbert09/talyn/issues).
