---
title: Security and data
description: How Talyn handles your agent sign-ins, MCP keys and GitHub access, what a sandbox can reach, and what Talyn stores.
---

This page explains what Talyn does with your credentials and your code. For the legal terms, read the [privacy policy](/privacy) and the [terms](/terms).

## Credentials stay out of the sandbox

The sandbox that runs the agent never holds your agent sign-in or your MCP server keys.

- **Agent sign-ins**: when the agent calls the Claude or OpenAI API, the request goes through Talyn's proxy outside the sandbox, and the proxy adds your credential to it.
- **MCP server keys**: the agent calls an MCP server at an address with no key in it. The proxy adds the key to each request.

So an agent that reads a hostile file, and is tricked into trying to send your keys somewhere, has no keys to find.

Each session runs in its own sandbox, and Talyn deletes the sandbox when you archive the session.

## Signing in to Claude and ChatGPT

Talyn opens Anthropic's or OpenAI's own sign-in page in your browser. Talyn never sees your password. It stores the token that the sign-in gives it, and uses it only for your runs.

You can disconnect an agent at any time in **Settings > Agents** (desktop) or **Settings > Integrations** (web).

## What a sandbox can reach

- **Sessions** have internet access on by default, so the agent can install tools and read docs. Turn it off for a session, or as your default in **Settings > Sessions**. With it off, the sandbox reaches only its repository, the package registries and the agent's API.
- **Fix runs, code reviews and skill runs** on pull requests reach only the repository and the agent's API.
- **Loops** reach only the repository and the agent's API, unless you choose **Allow the internet** for that loop.

A sandbox cannot reach your computer or a private network.

## GitHub access

Talyn is a GitHub App. It can see only the repositories you install it on, and you can change them in GitHub at any time. It needs write access to code, so that an agent can push a fix to your branch.

Talyn merges through GitHub's normal merge API, so your branch protection rules and required reviews apply. It does not need organization admin rights.

## What Talyn stores

- Your GitHub identity, and metadata about your pull requests, repositories, branches and checks.
- Your agent sign-ins, MCP server keys and other integration tokens, encrypted with AES-256-GCM.
- The transcripts of your sessions and agent runs, so you can read them in the app.
- Work in a session that you have not pushed yet. Talyn saves it after each turn so that a lost sandbox can be restored. See [Your work is saved](/docs/sandboxes#your-work-is-saved).

Talyn never shows a stored key back to you in full.

## Untrusted input

Pull request text, review comments, Slack messages and repository files can all be written by someone else. Talyn tells the agent which text is untrusted, and the limits above do not depend on the agent obeying it.

## API and MCP tokens

[API tokens](/docs/api) and [Talyn MCP server](/docs/mcp) tokens act as your account. Talyn stores only a hash of each API token. Give an API token only the access it needs, set an expiry, and revoke it when you stop using it.

## Report a problem

Do not report a security problem in a public issue. Use GitHub's [private security advisory form](https://github.com/Gilbert09/talyn/security/advisories/new) for the Talyn repository. If you think a credential was exposed, revoke it at its source first, then report it.
