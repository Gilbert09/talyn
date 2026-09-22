# Talyn Architecture

Architectural decisions, core concept deep-dives, and resolved questions. Updated when a decision is revisited. For active work see [`ROADMAP.md`](./ROADMAP.md); for the provider abstraction see [`CLOUD_PROVIDERS.md`](./CLOUD_PROVIDERS.md).

## System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                     Electron App (Desktop)                       │
│  ┌───────────────┐ ┌──────────┐ ┌───────────────┐ ┌───────────┐  │
│  │ GitHub panel  │ │  Tasks   │ │  Merge queue  │ │ Settings  │  │
│  │ (Mine/Review) │ │          │ │               │ │           │  │
│  └───────────────┘ └──────────┘ └───────────────┘ └───────────┘  │
└──────────────────────────────────────────────────────────────────┘
                               │
                 WebSocket + REST (Supabase JWT)
                               │
┌──────────────────────────────────────────────────────────────────┐
│                   Backend (hosted on Railway)                    │
│  PR monitor / cache · merge queue · auto-keep-mergeable watcher  │
│  task queue · CloudTaskProvider registry + poller · skills       │
│  webhook receiver (HMAC) → Redis queue → webhook worker          │
└──────────────────────────────────────────────────────────────────┘
        │                      │                        │
  GitHub App             Cloud providers          Supabase Postgres
  (webhooks in,          (PostHog Code,           + Supabase Auth
  REST/GraphQL out)      Anthropic Managed        (RLS), Redis
                         Agents)
```

Nothing executes on the user's machine. Every task is delegated to a **cloud provider** that runs the agent loop on its own sandbox and opens a PR; the backend creates the remote run, polls it, and ingests the transcript.

## Tech Stack

**Frontend (Electron)**
- React 19 + TypeScript
- Zustand (state), Tailwind + shadcn/ui (UI)
- Electron contextBridge for IPC (typed channels); PKCE OAuth via the system browser with a deep-link return

**Backend**
- TypeScript on Node.js, Express + WebSocket
- Supabase Postgres via Drizzle ORM; migrations applied at boot (advisory-locked)
- Supabase Auth (GitHub OAuth) → JWT middleware → per-request RLS scoping
- Redis consumer group for the webhook queue (fleet-safe)
- GitHub connectivity uses one shared **GitHub App** and webhook-first PR state. Workspace operations use the connected user's token.
- Cloud delegation via the `CloudTaskProvider` registry (`services/cloudProviders/`) — each provider is a self-contained client/credentials/converter/executor/poller module

## Core Concepts (Detail)

### Workspaces
Groups related repositories and integrations. Example: a "PostHog" workspace with `posthog/posthog`, `posthog/posthog.com`, `posthog/charts`. Strictly single-owner; per-workspace provider credentials are AES-GCM-encrypted on the `integrations` row.

### Environments
A secret-free **marker row**, one auto-provisioned per connected cloud provider. Its `type` is how a task resolves its provider — nothing more. (The daemon/SSH-backed execution environments this concept once described were removed in the June 2026 cloud-only refactor.)

### Tasks
Primary unit of work, always delegated to a cloud provider. Types: `code_writing` (freeform prompt on a repo), `pr_response`, `pr_review`; skill runs dispatch as tasks with the `SKILL.md` inlined into the prompt.

Lifecycle: `queued` → `in_progress` → `completed` / `failed` / `cancelled`. The cloud poller drives status and ingests the transcript; review happens on the provider's PR (no local approval gate).

### GitHub / PR core
The heart of the app: webhook-first PR monitoring (with polling reconciliation as the safety net), a per-workspace PR cache, the prioritized GitHub panel (Needs attention / Mine / Review, stacked PRs), the merge queue (auto-fix runs for conflicts/failed checks, bounded check re-runs and branch updates where GitHub allows, and stacked PRs, which take one of two routes: a GitHub NATIVE stack whose landing branch is behind a merge queue that batches stacks is handed over as one submission at its top rung — the provider tests and lands every rung in a single CI round, with the rungs beneath it held hands-off (`external_covered_by`) because a push to any member ejects the whole batch — while everything else drains bottom-up, each child parked in `awaiting_stack` until the PR its base belongs to lands, then retargeted onto the real base), and the auto-keep-mergeable watcher.

Review-ranking research runs offline in `scripts/review-ranking`; Python models are not production dependencies.
The existing scorer remains the serving boundary until a future model passes the release gates.
Web and desktop keep bounded local snapshots for the `reviewPriority` audience, with a manual JSON export.
The shared browser client archives them in IndexedDB for up to 30 days and 50 million serialized characters per workspace.
Atomic transactions preserve snapshot groups across concurrent tabs. A smaller localStorage log remains the failure fallback.
Exports combine both stores and report retention losses. No archive event is uploaded automatically.
Queue membership, viewport exposure, and opens remain separate observations.
Scoring traces retain exact serving inputs and a server profile hash, without raw PR text or affinity identities.
The offline parity command uses the compiled production scorer and comparator, with a version check and runtime digest.
Snapshot headers declare repository scope. Unknown scope and explicit agent checks cannot produce human review labels.
Snapshots retain matched team names from the displayed summary. Unknown membership remains unknown.
These local observations cannot establish historical team membership or exact request rounds.
The lab collects scoped submitted-review journals through read-only GitHub requests, then joins earlier local snapshots.
GraphQL batches all scoped PRs, with a reviewer filter and complete review pagination.
An independent REST path remains available to check coverage and timestamps.
The primary label requires a snapshot before GitHub review creation. Submission time remains a separate sensitivity policy.
Visible pending and late reviews can censor choices. Submitted-review conversion is measured separately from the ranking decision.
Observed content is encoded locally with fixed weights. Later content cannot supply earlier features.
The shared queue model has optional personal adjustments, enabled only by a separate validation window.
Four forward windows separate training, model selection, personal validation, and development evaluation.
The JSON artifact refuses production use. See [`REVIEW_RANKING.md`](./REVIEW_RANKING.md).

Historical comparisons now enumerate repository PRs without selecting them by reviewer outcomes.
The replay applies direct requests, removals, submissions, and PR lifecycle events.
Its rule that every submission ends a request has a live counterexample for comment-only reviews.
Treat those historical metrics as restricted-policy experiments, not proof of complete candidate coverage.
Uncertain candidate state excludes the whole decision. Missing text does not remove a candidate.
Verified title changes reconstruct earlier text for local encoding.
Successive time windows compare models on equal data and retain learning curves and coverage counts.
Complete API pagination still cannot establish what a reviewer saw or recover deleted records.

Production review eligibility preserves active direct requests after prior reviews.
The poll checks direct requests when the requested and reviewed sets overlap; webhook refreshes read the current request data.
Completed team requests still clear. A cached summary cannot make reconciliation discard a confirmed direct request.


## Key Decisions

### 0. Cloud-only pivot — 2026-06
The local-execution model (bundled daemon, local/SSH environments, in-process Claude agents, approval gates, per-task git working trees) was removed wholesale. Every task runs on a cloud provider's sandbox; Talyn is a PR dashboard + delegation layer. This supersedes decisions 2–7 below, which are kept as history.

### 1. TypeScript Backend (not Python) — 2024-01
Single language across the stack, shared types with frontend.

### 2. Local-first Architecture — 2024-01 *(superseded by 0)*
Backend ran alongside the Electron app. The hosted Railway backend replaced this (Phase 18).

### 3. Environment-agnostic Agent Execution — 2024-01 *(superseded by 0)*
SSH/Coder/daemon execution environments — all removed.

### 4. Use Claude CLI (not API directly) — 2024-01 *(superseded by 0)*
No CLI runs anywhere now; providers own their agent loop.

### 5. Tasks Own Agents — 2024-04 *(superseded by 0)*
Agents are now entirely internal to the provider.

### 6. Git-Centric Task Workflow — 2024-04 *(superseded by 0)*
Branch management moved to the provider sandbox; Talyn tracks the resulting PR.

### 7. Approval-Based Automation — 2024-04 *(superseded by 0)*
The provider opens a normal PR; GitHub review IS the approval gate.

### 8. Reference Architecture: PostHog Code — 2024-04
Reference: https://github.com/PostHog/code — informed session persistence, permission modes, and store/service layering; today PostHog Code is a live provider rather than a pattern source.

### 9. Pluggable cloud providers — 2026-06
One `CloudTaskProvider` interface (registry + per-provider `dispatch`/`reconcile`/credentials/`cancel`), so a new vendor lands as a self-contained module with no core changes. **Talyn Fleet (`selfhosted`) is the default** and PostHog Code is the fall-back; Codex Cloud stays deferred until OpenAI ships a server-to-server API. Claude Code (Anthropic Managed Agents) was removed in September 2026 — it billed metered API credits with no subscription option, which is the opposite of what the fleet offers, and the fleet runs Claude on the workspace's own subscription instead.

### 10. GitHub App over OAuth — 2026-06/07
A shared GitHub App supplies installations and webhooks. Workspace reads and writes use the connected user's token.

The September 2026 security review removed installation-token routing from workspace operations. Installation discovery does not prove a user's repository access.
Webhook delivery requires a fresh repository-access check for each workspace. Cached responses are not shared across workspaces.
This costs additional GitHub calls and uses user rate budgets. Reintroducing installation credentials requires an explicit repository authorization design.
GitHub can still treat user-to-server tokens as integration credentials for merge rules.

See [the security review](./SECURITY_AUDIT.md) for validation, rollout requirements, and remaining work.

### 11. Backend Database Role

The backend pool remains privileged for background work. Request scopes switch to the non-login `talyn_backend` role.
Existing `auth.uid()` policies then restrict queries to the caller's rows.
Supabase client roles have no direct privileges on application tables, columns, or sequences.
This prevents direct Data API requests from bypassing REST validation of server-managed fields.
Supabase authentication remains separate and unchanged. Future application grants must target `talyn_backend`.
Migration 0055 requires draining old replicas before revoking their former role's permissions.

## References

- **PostHog Code** — https://github.com/PostHog/code
- **Electron React Boilerplate** — https://github.com/electron-react-boilerplate/electron-react-boilerplate
