---
title: "Conductor alternatives for parallel coding agents"
description: "Conductor Cloud shuts down on November 20, 2026. Six ways to keep running coding agents in parallel: Talyn, Claude Code on the web, Codex, Cursor cloud agents, T3 Code and Devin, with when each one fits."
competitor: "Conductor"
navLabel: "Conductor alternatives"
category: "Cloud coding agents"
verdict: "You want to keep your local Conductor workspaces on your Mac until the app winds down in early 2027, and you do not need to move yet."
updated: "2026-11-10"
sources:
  - label: "Conductor is joining Meta (announcement and timeline)"
    url: "https://www.conductor.build/announcement"
  - label: "Conductor"
    url: "https://www.conductor.build/"
  - label: "Claude Code on the web: cloud sessions"
    url: "https://code.claude.com/docs/en/claude-code-on-the-web"
  - label: "Codex cloud documentation"
    url: "https://learn.chatgpt.com/docs/cloud"
  - label: "Cursor docs: cloud agents"
    url: "https://cursor.com/docs/cloud-agent"
  - label: "T3 Code"
    url: "https://t3.codes/"
  - label: "pingdotgg/t3code on GitHub"
    url: "https://github.com/pingdotgg/t3code"
  - label: "Devin pricing"
    url: "https://devin.ai/pricing"
related: ["conductor", "t3-code", "cursor-background-agents"]
relatedFeatures: ["sessions", "agents"]
faq:
  - q: "What is the best alternative to Conductor Cloud?"
    a: "It depends on where you want agents to run. For parallel sessions in cloud sandboxes on your own Claude or ChatGPT plan, try Talyn or Claude Code on the web. For agents on your own machine, try T3 Code. For one vendor's cloud, try Codex or Cursor."
  - q: "When does Conductor Cloud shut down?"
    a: "Conductor Cloud goes read-only on November 13, 2026 and shuts down on November 20, 2026. Local Conductor keeps getting new models and critical fixes until it winds down in early 2027. Export your cloud data before November 20."
  - q: "Which alternative runs on my existing Claude or ChatGPT subscription?"
    a: "Talyn runs Claude Code on a Claude plan and Codex on a ChatGPT plan. Claude Code on the web counts toward your Claude plan's usage limits. T3 Code uses the agent CLIs you have installed and logged in. Cursor and Devin bill their own plans."
  - q: "Can I keep my conductor.json?"
    a: "In Talyn, yes. Talyn reads conductor.json and .conductor/settings.toml, so setup, run and archive scripts work unchanged. We did not check whether the other tools on this page read Conductor's config files."
---

If you want to keep the Conductor way of working, with one agent per task in
its own workspace, **Talyn** and **Claude Code on the web** are the closest
cloud options. If you want agents on your own machine, **T3 Code** is the
closest local one.

Conductor announced on November 4, 2026 that it is joining Meta. Conductor
Cloud goes read-only on November 13 and shuts down on November 20. Local
Conductor gets new models and critical fixes until early 2027, then winds down.
We wrote this page from each tool's own site on November 10, 2026. The first
option is ours, so weigh that.

## What to look for

Four questions separate these tools.

- **Where does the agent run?** On your laptop, or in a cloud sandbox that keeps
  working when the laptop closes.
- **Who bills the model?** Your own Claude or ChatGPT plan, or the tool's plan.
- **Which agents does it run?** One vendor's, or several.
- **What happens after the pull request?** Some tools stop at the pull request.

## Talyn

Talyn runs Claude Code and Codex in parallel cloud sandboxes. Each task is a
session with its own branch, agent, diff, terminal and run scripts. Talyn then
takes the pull request through failing checks, conflicts and a merge queue.

- **Runs:** in a Firecracker microVM on our hardware. A sandbox sleeps after 10
  idle minutes and costs nothing while it sleeps. In the desktop app, a session
  can also run in a git worktree on your computer.
- **Bills:** Free is 10 box-hours a month. Pro is $40 a month for 200
  box-hours. The model runs on your own Claude or ChatGPT plan.
- **Platforms:** macOS, Windows, Linux and a browser app. GitHub only.
- **Carries over from Conductor:** it reads `conductor.json` and
  `.conductor/settings.toml` as they are.
- **Does not do:** Cursor or OpenCode as the agent, GitLab or Bitbucket, or a
  public iOS app yet. Windows builds are unsigned.

**Pick it if** you want many sessions in the cloud on your own plan, with the
pull request carried to merged. See [the Conductor move guide](/compare/conductor).

## Claude Code on the web

Anthropic's own cloud sessions for Claude Code. You start them from the
browser at claude.ai/code, the Code tab of the Claude app, the desktop app or
`claude --cloud` in a terminal. A session keeps running after you close your
laptop.

- **Runs:** on infrastructure Anthropic manages, or on your organization's
  self-hosted environment.
- **Bills:** it counts toward your plan's usage limits. Anthropic says there is
  no separate charge for the cloud VM. It needs a Pro, Max, Ultra or Team plan,
  or Enterprise premium seats.
- **Agent:** Claude Code only.
- **Git hosts:** repository cloning and pull request creation need GitHub. A
  GitLab or Bitbucket repository can go up as a local bundle, but the session
  cannot push back to it.
- **Also has:** auto-fix for pull requests, which watches CI failures and
  review comments, and scheduled cloud tasks. Its docs say auto-fix cannot react
  to a merge conflict on its own.

**Pick it if** you only use Claude and want the vendor's own product. Talyn adds
Codex, a merge queue and sandbox sizes. We did not compare the two on price or
speed.

## Codex cloud

OpenAI's cloud environments for Codex. Tasks run on OpenAI's side and continue
while you do something else. Its docs page says you start them from the web,
mobile, the desktop app and the Codex CLI.

- **Runs:** in OpenAI's cloud.
- **Bills:** the docs page we read does not say which plans include it.
- **Agent:** Codex only.
- **Network:** you choose all public internet, package manager domains only, or
  extra allowed domains.

**Pick it if** you live in ChatGPT and want OpenAI's own surfaces. See
[Talyn vs Codex cloud](/compare/codex-cloud).

## Cursor cloud agents

Cursor's cloud agents run tasks in isolated VMs and push a branch for handoff.
Cursor renamed them from background agents.

- **Runs:** in Cursor's cloud, or on self-hosted machines you manage.
- **Starts from:** Cursor Desktop, the web, the iOS app, Slack, `@cursor`
  comments on GitHub and Bitbucket, Linear and an API.
- **Bills:** usage counts against your Cursor plan at the selected model's rate,
  with a spend limit. It needs Premium or higher, Teams or Enterprise.
- **Git hosts:** GitHub, GitLab, Bitbucket Cloud and Azure DevOps.

**Pick it if** you already work in Cursor and want to dispatch from where you
are. See [Talyn vs Cursor cloud agents](/compare/cursor-background-agents).

## T3 Code

A free, MIT-licensed control surface for coding agents. It drives the agent CLIs
you have installed, on hardware you own. Its homepage lists Claude Code, Codex,
Cursor, Grok, OpenCode and Antigravity.

- **Runs:** on your machine. Its homepage describes no hosted service.
- **Bills:** nothing. You bring your own credentials, and it says it resells no
  keys.
- **Platforms:** desktop and browser clients, with iOS and Android apps linked
  on its homepage.
- **Does not do:** run in the cloud for you. The machine must stay on.

**Pick it if** you want local agents, the widest choice of agents, and no
vendor in the middle. It is the closest local match to Conductor's local app.
See [Talyn vs T3 Code](/compare/t3-code).

## Devin

An autonomous coding agent. You give it a task and it works in its own
environment and produces a pull request. Its pricing page lists Devin Cloud
and Devin Desktop.

- **Bills:** Free has a light quota. Pro is $20 a month, Max is $200 a month,
  and Teams is $80 a month plus $40 per developer seat. Paid plans have usage
  allowances that refresh daily and weekly. Extra usage is at API pricing.
- **Style:** you hand over a whole task and it comes back with a pull request.

**Pick it if** you want to hand over tickets and would rather buy its usage than
bring your own plan. See
[Talyn vs Devin](/compare/devin).

## Conductor itself

If your work lives in local workspaces on a Mac, you can stay on local Conductor
until it winds down in early 2027. Pro users keep Pro features for free. Its
home page says it runs the first-party Claude Code, Codex, Cursor and OpenCode
agents. If you need Cursor or OpenCode as your agent, check each option above
for it.

## Quick comparison

| Tool | Where it runs | Billing | Agents |
| --- | --- | --- | --- |
| Talyn | Cloud sandboxes, or local worktree | Box-hours, plus your Claude or ChatGPT plan | Claude Code, Codex |
| Claude Code on the web | Anthropic cloud, or self-hosted | Your Claude plan's usage limits | Claude Code |
| Codex cloud | OpenAI cloud | Not stated on the docs page we read | Codex |
| Cursor cloud agents | Cursor cloud, or self-hosted machines | Your Cursor plan, at model rates | The model you select |
| T3 Code | Your machine | Free | Six, including Claude Code and Codex |
| Devin | Devin Cloud | Allowance, then API pricing | Devin |
