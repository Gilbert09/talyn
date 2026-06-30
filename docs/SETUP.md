# FastOwl Setup Checklist

Actions you (Tom) need to take outside this repo. Everything that *can* be automated by Claude Code is being automated — this doc covers the things that require your credentials, accounts, or browser approval.

Legend:
- ⚡ **Now** — needed for current dev loop
- 🔜 **Soon** — needed for Phase 18 (hosted backend)
- 🧰 **Nice-to-have** — dev ergonomics, do when convenient

---

## ⚡ Required now

### 0. Local dev stack — Supabase local + dev-only GitHub OAuth apps

> **Why this exists (June 2026):** local dev used to point at the **prod** Supabase
> DB and the **prod** GitHub OAuth app. That cross-talk silently revoked prod's
> GitHub token: every reconnect (dev or prod) minted a new token against the same
> OAuth app until GitHub's 10-tokens-per-user/app/scope cap revoked the oldest,
> and any backend still holding the revoked token in memory would 401 and delete
> the shared `integrations` row. Dev and prod must never share a DB, an OAuth
> app, or a `FASTOWL_TOKEN_KEY`.

Local dev runs the full stack on your machine via the Supabase CLI (Docker required):

```bash
npm run dev:db        # supabase start (db + auth + api; heavyweight services excluded)
npm run dev           # backend (migrations auto-apply on boot) + desktop
npm run dev:db:stop   # when you're done
```

Local endpoints (stable across restarts):
- API / auth: `http://127.0.0.1:54321`
- Postgres: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- Studio: `http://127.0.0.1:54323`
- Keys: `npx supabase status` prints the local anon + service_role keys

Two **dev-only** classic GitHub OAuth apps back this (create once in the browser —
GitHub has no API for it):

1. **`FastOwl Login (Local Dev)`** — desktop login via local Supabase auth.
   - Homepage: `http://127.0.0.1:54321`
   - Callback: `http://127.0.0.1:54321/auth/v1/callback`
   - Client id + secret go in `supabase/.env` (gitignored) as
     `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` / `…_SECRET`; the provider is wired
     up in `supabase/config.toml`. The dev desktop deep link
     `fastowl-dev://auth-callback` is already in `additional_redirect_urls`
     (dev builds use the `fastowl-dev://` scheme so the OAuth callback reopens
     your dev build instead of an installed production FastOwl.app).
2. **`FastOwl (Local Dev)`** — the workspace GitHub integration (PR monitoring etc.).
   - Homepage: `http://localhost:4747`
   - Callback: `http://localhost:4747/api/v1/github/callback`
   - Client id + secret go in `packages/backend/.env` as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

`packages/backend/.env` and `apps/desktop/.env` must point at the local stack —
never at Railway/prod values (those live only in Railway service variables).

### 1. Anthropic API key

Used by `packages/backend/src/services/ai.ts` for auto-generating task titles/descriptions from prompts.

1. Go to https://console.anthropic.com/settings/keys
2. Create a key
3. Export it when running the backend:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```
   Or add it to a `.env` file at the repo root (add to `.gitignore` first — don't commit).

Without this, task metadata falls back to first-60-chars heuristic, which is functional but noticeably worse.

### 2. `claude` CLI on every environment

FastOwl spawns `claude` (interactive mode) via node-pty on the chosen environment. The binary must be in the PATH of whichever shell gets spawned.

- **Local**: `npm install -g @anthropic-ai/claude-cli` (or whatever the current install command is), log in via `claude login`
- **VMs**: same, on the remote user's shell

Verify by running `claude --version` as the shell user FastOwl will use.

**One-time MCP trust approval** (only if you run autonomous tasks in **strict** mode on this environment — i.e., the env's "Allow unattended Claude runs to bypass permission prompts" toggle is OFF):

FastOwl's repo root ships a `.mcp.json` registering the Supabase MCP server. On first encounter, Claude Code prompts you to trust it. Autonomous runs can't answer that prompt, so do it once interactively:

```bash
cd ~/path/to/fastowl    # or wherever the clone lives on this env
claude                  # opens the TUI
# → prompted: "New MCP server found in .mcp.json: supabase — use this?"
# → pick "Use this and all future MCP servers in this project"
# → Ctrl-D to exit
```

The approval lands in your user-level Claude config and sticks. You don't need to do this on daemon envs that have "bypass permissions" enabled — they skip all prompts by design.

### 3. GitHub OAuth app (already scaffolded in backend)

Used by the GitHub integration (connect GitHub → PR monitoring, PR actions, repo listing).

> **Use a classic OAuth App, NOT a GitHub App.** The connect flow in
> `services/github.ts` is the classic OAuth web flow (`scope=repo
> read:user read:org`, exchange code → long-lived user token). A GitHub
> App grants access *by installation*, so it can't read a repo you
> personally have access to (e.g. `posthog/posthog`) without being
> installed on that org — the wrong model here. A classic OAuth App's
> token acts as you, so it reads any public repo and any private repo
> your account can reach (private *org* repos may still need the org to
> approve the app under its third-party-access policy). You can tell the
> two apart by the client ID: classic OAuth = bare hex / `Ov23…`; a
> GitHub App is `Iv1.…` / `Iv23…` — if you see that prefix, you made the
> wrong app type.

1. https://github.com/settings/developers → **OAuth Apps** tab → **New OAuth App** (do *not* use the "GitHub Apps" tab)
2. Application name: `FastOwl (Dev)` (make a separate prod one later)
3. Homepage URL: `http://localhost:4747`
4. Authorization callback URL: `http://localhost:4747/api/v1/github/callback` (must match `GITHUB_REDIRECT_URI` exactly)
5. Create, then **Generate a new client secret**
6. Export before running the backend:
   ```bash
   export GITHUB_CLIENT_ID=Ov23xxxxx        # classic OAuth App id (NOT Iv1./Iv23 — that's a GitHub App)
   export GITHUB_CLIENT_SECRET=xxxxx
   export GITHUB_REDIRECT_URI=http://localhost:4747/api/v1/github/callback
   ```

No scopes are configured on the app itself — the backend requests
`repo read:user read:org` at authorize time.

Without these, the "Connect GitHub" button in Settings will fail loudly.

### 3b. GitHub App (webhooks + realtime, hybrid auth)

The App is what lets us replace polling with **webhooks** and scale across
replicas. It uses **hybrid auth**: an installation token does all repo/PR/checks
reads + receives webhooks, while a user-to-server token (requested during
install) resolves the viewer's login + authored/review-requested buckets. The
classic OAuth App above still works; the App lights up per workspace as each one
re-connects via the install flow.

> **Make TWO Apps — "Talyn App Dev" (slug `talyn-app-dev`) and "Talyn App"
> (slug `talyn-app`).** A GitHub App has
> exactly **one** webhook URL, so it can't serve localhost and Railway at once.
> Dev's creds go in `packages/backend/.env`; prod's go in Railway variables. The
> backend just reads whatever `GITHUB_APP_*` / `GITHUB_WEBHOOK_SECRET` env it
> finds — no code difference. Use a separate private key + secret per App.

1. https://github.com/settings/apps → **New GitHub App**.
2. **Webhook URL**: `https://<your-backend>/api/v1/webhooks/github`.
   - Prod: `https://fastowl-backend-production.up.railway.app/api/v1/webhooks/github`.
   - Local: tunnel it — `npx smee-client --url https://smee.io/<channel> --target http://localhost:4747/api/v1/webhooks/github`, and use the `smee.io/<channel>` URL here.
   **Webhook secret**: generate one → `GITHUB_WEBHOOK_SECRET`.
3. **Permissions** (read-only unless noted): Pull requests **R/W** (merge/auto-merge
   write paths), Checks **R**, Commit statuses **R**, Contents **R**, Metadata **R**,
   Members **R** (team-based review-request resolution).
4. **Subscribe to events**: `pull_request`, `pull_request_review`,
   `pull_request_review_comment`, `issue_comment`, `check_run`, `check_suite`,
   `status`, `push`, `installation`, `installation_repositories`.
   (`push` is what lets us catch a PR becoming conflicting because its **base
   branch** advanced — GitHub sends no per-PR event for that; on a push we
   refresh every open PR based on the pushed branch.)
5. Enable **"Request user authorization (OAuth) during installation"**, and set the
   **Callback URL** to `http://localhost:4747/api/v1/github/app/callback` (prod: the
   Railway host equivalent — an App can list multiple callback URLs).
6. **Leave "Expire user authorization tokens" OFF.** With it on, the user token
   dies after 8h and we have no refresh-token rotation yet — the workspace would
   silently break (and a 401 on the user token can tear down the integration).
   The installation token is separate and always short-lived; we mint/refresh it
   ourselves regardless. (Turning expiry on is a follow-up, paired with rotation.)
7. Generate a **private key** (.pem), base64 it, and set the env vars (see the
   `.env` block below): `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`,
   `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`.
8. Set `REDIS_URL` (webhooks are enqueued onto a Redis Stream; without it the
   receiver acks-and-drops and the reconcile sweep keeps PRs fresh).
   - Optional: `WEBHOOK_STREAM_MAXLEN` caps the ingest stream length (default
     `50000`, approximate trim). A backlog only forms if the worker can't keep
     up; raise it for more runway before the oldest deliveries are dropped, but
     size it to your Redis memory — each entry holds a full webhook payload
     (~10-30KB), so 50k ≈ up to ~1GB worst case.

**Connecting (two steps):**
1. **Install** the App on each account/org whose repos you want to track —
   GitHub → the App's page → *Install* (or *Configure* to add repos). One-time
   per account; a user can install it on their personal account **and** several
   orgs.
2. In the desktop, Settings → Integrations → GitHub → **Connect GitHub**. This
   runs the OAuth **user-authorization** flow (`/login/oauth/authorize`), which
   always redirects back to `/github/app/callback` with a signed `state` —
   whether or not the App is already installed. (We deliberately do NOT use
   `/installations/new`, which dead-ends on the "configure" page for an existing
   install.) The callback exchanges the code for the user token, discovers **all**
   the user's installations via `GET /user/installations`, records them, and
   bulk-refreshes.

Data-plane reads resolve the installation **per repo owner**, so one workspace
can span repos across multiple installed accounts/orgs. A repo only delivers
webhooks once the App is installed on its owner with that repo selected. The
reconcile sweep (~5 min) + manual refresh are the safety net for missed deliveries.

---

## 🔜 Needed for Phase 18 (hosted backend)

Do these when we're ready to stand up the hosted infrastructure — not urgent yet, but creating the accounts early is free and removes friction when we get there.

### 4. Supabase project

For Postgres + auth when Phase 18.1/18.2 lands.

1. Create account at https://supabase.com
2. New project (free tier is fine for dev) — pick closest region
3. From the project dashboard, grab:
   - `SUPABASE_URL` (Project settings → API → Project URL)
   - `SUPABASE_ANON_KEY` (same page → anon public)
   - `SUPABASE_SERVICE_ROLE_KEY` (same page → service_role) — **never expose to the desktop app**, backend only
   - `DATABASE_URL` (Project settings → Database → Connection string → URI, with pooling for runtime)
4. Enable GitHub OAuth in Supabase Auth (Authentication → Providers → GitHub). You'll need to create a **separate** GitHub OAuth app for Supabase auth (the one from #3 is for workspace-level GitHub integration):
   - https://github.com/settings/developers → **New OAuth App**
   - Homepage URL: your Supabase project URL
   - Authorization callback URL: `https://<project-ref>.supabase.co/auth/v1/callback`
   - Paste the client ID/secret into Supabase Authentication → Providers → GitHub
5. Add `fastowl://auth-callback` to **Redirect URLs** in Supabase (Authentication → URL Configuration → Redirect URLs). Without this, the desktop deep-link flow fails silently with an "invalid redirect URL" error.

### Single-user allow-list (optional, recommended while FastOwl is pre-invites)

FastOwl doesn't ship an invite flow yet — anyone with a GitHub account can sign in to an instance. To lock a self-hosted instance to just you, set on the backend:

```
FASTOWL_ALLOWED_EMAILS=you@example.com
```

Multiple emails are comma-separated. Unauthorised callers get a 403 on first request. Once invite flows land (TODO in ROADMAP Phase 19) this can go away.

### 5. Railway account (deployed)

Hosted backend lives at **https://fastowl-backend-production.up.railway.app**
(project `FastOwl`, service `fastowl-backend`, env `production`).
Auto-deploy on push to main via `.github/workflows/deploy-backend.yml` —
needs a `RAILWAY_TOKEN` GitHub secret:

1. Railway dashboard → **Project Settings → Tokens** → create a project
   token (account-scoped works too) → copy.
2. GitHub repo → **Settings → Secrets and variables → Actions** → **New
   repository secret** → name `RAILWAY_TOKEN`, paste value.

**Supabase connection**: Railway can't route IPv6, so the backend uses
the **transaction pooler** (`aws-1-eu-west-2.pooler.supabase.com:6543`)
not the direct connection. If you rotate the DB password, update
`DATABASE_URL` on Railway too (`railway variables --set 'DATABASE_URL=...'`).

**GitHub OAuth callback**: the workspace-integration GitHub OAuth app
(the one from section #3 above, used for PR monitoring) has its
authorization callback URL pointing at localhost. Once you actually
start using GitHub integration against the hosted backend, update the
OAuth app's callback to
`https://fastowl-backend-production.up.railway.app/api/v1/github/callback`.
The Supabase-auth GitHub OAuth app (for user sign-in) is separate and
already points at Supabase's domain, not ours.

### 6. PostHog project

Single source of truth for analytics + error tracking + logs (Phase 18.8).

1. Create project at https://posthog.com (or self-host)
2. From Project settings grab:
   - `POSTHOG_PROJECT_API_KEY` (write key, used in server + desktop)
   - `POSTHOG_PERSONAL_API_KEY` (read key, used by CI / MCP server / dashboards)
   - `POSTHOG_HOST` (`https://us.i.posthog.com` or `https://eu.i.posthog.com` or self-hosted URL)
3. In the project, enable **Error tracking** and **Session replay** features
4. Create a feature flag called `fastowl_debug` (off by default) that we can flip for verbose logging per user

**Where the write key goes (both use the same project key):**

- **Desktop** — `FASTOWL_POSTHOG_KEY` / `FASTOWL_POSTHOG_HOST`, baked in at webpack build time (CI secret). The renderer also bakes `FASTOWL_APP_VERSION` from `release/app/package.json` automatically so every event carries `app_version`.
- **Backend** (Railway env) — `FASTOWL_POSTHOG_KEY` / `FASTOWL_POSTHOG_HOST` enable server-side task-lifecycle events (`task_dispatched` / `task_completed` / `task_failed`), attributed to the workspace owner. Unset ⇒ server analytics is a no-op (see `packages/backend/src/services/analytics.ts`).

---

## 🧰 Nice-to-have: MCP servers for Claude Code

Wiring these up lets Claude Code answer questions about GitHub state, DB schema, PostHog events without manual copy-pasting. Add them to `~/.claude/mcp_servers.json` or via `claude mcp add`.

### GitHub MCP

```bash
claude mcp add github -- npx -y @modelcontextprotocol/server-github
```

Needs a `GITHUB_PERSONAL_ACCESS_TOKEN` env var. Create one at https://github.com/settings/tokens with `repo` + `read:org` scopes.

### Supabase MCP (once #4 is set up)

Follow https://github.com/supabase-community/supabase-mcp for the install command. Needs `SUPABASE_ACCESS_TOKEN` (Supabase account level) and the project ref.

### PostHog MCP (once #6 is set up)

Not yet officially released but community versions exist — search `posthog mcp` on GitHub. Will use `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_HOST`.

### Railway MCP (once #5 is set up)

Official Railway MCP server — see https://docs.railway.com for the current
install command. Uses a Railway account token (same one you minted in #5).
Lets Claude Code create projects, deploy services, read logs, and manage
variables without leaving the editor.

### FastOwl MCP (local)

Exposes FastOwl's own task + backlog operations as Claude tools. Useful for letting a Claude Code session (or a child agent running inside a FastOwl task) create tasks, sync backlog sources, and kick the Continuous Build scheduler without dropping to a shell.

```bash
# build first
npm run build -w @fastowl/shared -w @fastowl/mcp-server

# register
claude mcp add fastowl -- node "$(pwd)/packages/mcp-server/dist/index.js"
```

Or add to `~/.claude/mcp_servers.json` manually:

```jsonc
{
  "mcpServers": {
    "fastowl": {
      "command": "node",
      "args": ["/absolute/path/to/fastowl/packages/mcp-server/dist/index.js"],
      "env": { "FASTOWL_API_URL": "http://localhost:4747" }
    }
  }
}
```

No external account needed — it talks to your local FastOwl backend. For agents FastOwl spawns, parent-injected env vars (`FASTOWL_WORKSPACE_ID`, `FASTOWL_TASK_ID`) mean the tools work argument-free.

After adding any MCP server, restart Claude Code. Verify with `/mcp` in the prompt.

---

## GitHub secrets (for CI)

Once the accounts above exist, add these to **Repo Settings → Secrets and variables → Actions** so CI can use them:

| Secret                          | Purpose                                   |
| ------------------------------- | ----------------------------------------- |
| `ANTHROPIC_API_KEY`             | Future: CI-run tests that hit the API    |
| `GITHUB_TOKEN`                  | Already provided by Actions               |
| `RAILWAY_TOKEN`                 | Deploy the backend on merges to main      |
| `DATABASE_URL`                  | drizzle-kit migrate step                  |
| `SUPABASE_SERVICE_ROLE_KEY`     | Server-side admin operations in migrations|
| `POSTHOG_PROJECT_API_KEY`       | Ship error events + build metrics         |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_ID_PASS` | macOS notarization (already in `publish.yml`) |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Code signing (same)                       |

---

## Local `.env` convention

Backend reads env vars on startup. To avoid exporting them every terminal, create `packages/backend/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...

# Workspace-level GitHub integration (for PR monitoring)
GITHUB_CLIENT_ID=Iv1.xxx
GITHUB_CLIENT_SECRET=xxx
GITHUB_REDIRECT_URI=http://localhost:4747/api/v1/github/callback

# Database + auth (Phase 18)
DATABASE_URL=postgres://...supabase.co:6543/postgres?pgbouncer=true
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...    # service role, bypasses RLS
# FASTOWL_ALLOWED_EMAILS=you@example.com   # optional single-user lock

# Redis — cross-replica WebSocket fan-out + the GitHub webhook ingest queue.
# Optional: leave unset to run single-process; the app degrades to local-only
# delivery and webhooks are not enqueued (the reconcile sweep keeps PRs fresh).
# Start the container with `npm run dev:redis` (see docker-compose.yml).
# REDIS_URL=redis://localhost:6379

# GitHub App (webhooks + installation auth). Optional until you create the App;
# when unset, the app stays on the OAuth connect flow. See the GitHub App
# section below. GITHUB_APP_PRIVATE_KEY is the .pem, base64-encoded.
# GITHUB_APP_ID=123456
# GITHUB_APP_SLUG=talyn-app
# GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxx
# GITHUB_APP_CLIENT_SECRET=xxxxxxxx
# GITHUB_APP_PRIVATE_KEY=<base64 of the downloaded .pem>
# GITHUB_WEBHOOK_SECRET=<the secret you set on the App's webhook>

POSTHOG_PROJECT_API_KEY=phc_xxx     # optional, for when 18.8 lands
POSTHOG_HOST=https://us.i.posthog.com
```

Desktop app env (set in the shell before `npm run build` or `npm start`):

```
FASTOWL_SUPABASE_URL=https://<ref>.supabase.co
FASTOWL_SUPABASE_ANON_KEY=eyJ...    # anon key, safe to bundle
FASTOWL_API_URL=http://localhost:4747   # default if unset
```

CLI uses `~/.fastowl/token` (populated via `fastowl token set` — copy the current token from desktop → Settings → Account → Copy CLI token). MCP server expects `FASTOWL_AUTH_TOKEN` in its spawn env.

And ensure `.gitignore` has `packages/backend/.env`. (If the backend doesn't yet load `.env` automatically, we'll add a `dotenv` import in Phase 18 cleanup — not critical yet.)

---

## What Claude Code cannot do for you

Everything in this doc that requires an account, a browser approval, or a credential you own. Specifically:
- Create Anthropic / GitHub / Supabase / Railway / PostHog accounts
- Approve OAuth apps
- Generate API keys
- Add GitHub repo secrets
- Install `claude` CLI binaries on remote VMs (we *can* automate this via the Phase 18.3 remote install flow once that ships, but not yet)

Everything else — schema, migrations, deploy configs, Dockerfiles, CI YAML — Claude Code can scaffold. Just share the credentials above when each phase starts.
