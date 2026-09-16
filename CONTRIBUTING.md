# Contributing to Talyn

Thanks for your interest in Talyn. Bug reports, feature requests, and pull requests are all welcome.

## Reporting bugs and requesting features

Open an [issue](https://github.com/Gilbert09/talyn/issues/new/choose). The bug form asks for the
version, the surface (desktop, web, or source), and a repro — please fill those in, because they are
what makes a report actionable.

**Do not report security vulnerabilities as public issues.** See [`SECURITY.md`](./SECURITY.md).

## Development setup

Talyn is an npm-workspaces monorepo. You need **Node.js ≥ 18** (22 recommended).

```bash
git clone git@github.com:Gilbert09/talyn.git
cd talyn
npm install
npm run dev          # backend + Electron desktop shell
```

[`docs/SETUP.md`](./docs/SETUP.md) covers environment variables and account setup (Supabase auth,
the database, the GitHub App). **Point local development at the local Supabase stack
(`npm run dev:db`), never at production** — the reasons are in `docs/SETUP.md` §0.

## Before you open a pull request

Run these locally. They take seconds and catch most breakage:

```bash
npm run typecheck    # or `tsc --noEmit` in the package you touched
npm run lint
```

Then run the tests that cover your change, rather than the whole suite:

- **Backend** (Vitest): `npx vitest run <path/to/file.test.ts>` in `packages/backend`
- **Desktop** (Jest): `npx jest <pattern>` in `apps/desktop`
- **Web / admin** (Vitest): `npx vitest run <pattern>`

CI runs the full suite across macOS, Windows, and Ubuntu on every pull request. Treat it as the
backstop, not the feedback loop — and watch the run you triggered.

## Pull requests

- Keep commits focused and atomic.
- Use semantic commit messages (`fix:`, `feat:`, `chore:`, `docs:`, `test:`).
- Fill in the pull request template: what changed, why it took that shape, and how you tested it.
  Do not claim testing you have not done.
- Include screenshots for user interface changes.

## Project orientation

[`claude.md`](./claude.md) is the fastest way to understand how the pieces fit together — the core
concepts, the conventions, and the decisions that are load-bearing. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
has the full treatment.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By taking part, you agree to
uphold it.
