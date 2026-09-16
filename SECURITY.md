# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, pull requests, or discussions.**

Report them privately through GitHub's
[security advisory form](https://github.com/Gilbert09/talyn/security/advisories/new). This opens a
private channel with the maintainer.

Please include:

- What the issue is, and which component it affects (desktop app, web app, backend, CLI).
- The steps to reproduce it, and what an attacker could achieve.
- The version you found it on.

You can expect an acknowledgement within a few days. We will keep you updated while we work on a
fix, and we will credit you in the advisory unless you prefer otherwise.

## Supported versions

Talyn is in public beta and ships from `main`. Fixes land in the next release; the
[latest release](https://github.com/Gilbert09/talyn/releases/latest) is the only supported version.
The desktop app updates itself, so staying current normally needs no action.

## Scope

In scope: the Talyn desktop app, the web app at `app.talyn.dev`, the backend API, the GitHub App
integration, and this repository.

Out of scope: vulnerabilities in the cloud agent providers you connect (report those to the provider
in question), and issues that need an already-compromised machine or account.

## Credentials

Talyn holds credentials you supply — a GitHub App installation and your agent provider keys. If you
believe a credential has been exposed, revoke it at its source first (GitHub settings, or the
provider's console), then report the issue.
