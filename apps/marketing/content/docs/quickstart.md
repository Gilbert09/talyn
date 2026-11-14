---
title: Quickstart
description: Sign in with GitHub, install the GitHub App, connect your Claude or ChatGPT subscription, and start your first session.
---

This page takes you from a new account to an agent working on your code. It takes about five minutes.

You need:

- A GitHub account.
- A Claude Pro or Max subscription, or a ChatGPT subscription for Codex.

## 1. Open Talyn

Use the web app at [app.talyn.dev](https://app.talyn.dev), or [install the desktop app](/docs/install) for macOS, Windows or Linux.

## 2. Sign in with GitHub

1. Select **Sign in with GitHub**.
2. Approve the sign-in in the browser window that opens.

Talyn returns you to the app. A short setup guide starts, with four steps.

## 3. Connect GitHub and install the GitHub App

The first step is **Connect GitHub**.

1. Select **Connect**.
2. In the browser, choose the account or organization to install the Talyn GitHub App on.
3. Choose all repositories, or only the repositories you want Talyn to use.
4. Return to Talyn. The row shows **Connected**.

The GitHub App is what gives Talyn live updates and lets an agent push to your branches. Without it, Talyn can only poll public repositories. To add another account or organization later, select **Install on another account**.

## 4. Choose your repositories

The next step asks where your agent will work.

1. Search for a repository.
2. Select at least one.
3. Select **Next**.

A repository marked **App not installed** belongs to an account that does not have the GitHub App yet. Install the App there first.

## 5. Connect your agent

Talyn runs the agent on your own subscription. Pick one:

- **Claude** uses your Claude Pro or Max subscription, or an Anthropic API key.
- **Codex** uses your ChatGPT subscription.

Follow the sign-in steps on the card. [Connect an agent](/docs/connect-agents) has the details for each one. You can connect both, and add the second one later.

You must connect Claude or Codex to start sessions. **Next** stays off until you do, and a line under it says what is missing. PostHog Code is not part of this step. You can add it later in **Settings**. If OpenAI does not offer ChatGPT sign-in in your region, connect Claude instead.

If you do not have a subscription now, select **Skip for now**. Talyn skips the first session and opens the home page. Talyn shows your pull requests, but you cannot start a session until you connect an agent. A banner at the top of the app stays until you connect one. Select **Connect an agent** in the banner to connect one.

## 6. Start your first session

1. Pick a repository.
2. Under **What do you want your agent to do?**, describe a small task. For example: "Add a test for the date parser".
3. Select **Start session**.

The first start can take a little longer while Talyn prepares the sandbox image for the repository. After that, Talyn opens the session. You see the agent's work in the chat and its changes in the **Changes** tab.

When the change looks right, select **Create PR** in the session header. The agent writes the title and description, and Talyn commits, pushes and opens the pull request.

## Next

- [Sessions and threads](/docs/sessions) explains what you can do in a session.
- [Repository setup](/docs/repository-setup) shows how to install dependencies and start your dev server in the sandbox.
- [Pull requests](/docs/pull-requests) covers the PR dashboard and getting PRs merged.
