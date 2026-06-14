# Cloud Task Providers — Pluggable Delegation (PostHog Code, Codex Cloud, Claude Routines)

> Status: **Phases 1–2 shipped** (June 2026, the cloud-only refactor). Goal: turn the
> one-off PostHog Code integration into a pluggable "cloud task provider" abstraction,
> then add **OpenAI Codex Cloud** and **Claude Code Routines** as two more delegators
> behind the same machinery.
>
> **What's done:** the `CloudTaskProvider` interface + registry
> (`services/cloudProviders/{types,registry,poller,environment}.ts`), PostHog Code
> wrapped as the first provider (`cloudProviders/posthog/provider.ts`, delegating to the
> existing `posthogCode/*` executor/streamer/poller), the cloud-only task queue + generic
> poller, the neutral `CloudTaskMetadata` + `readCloudTaskMeta` helpers, and the generic
> `/api/v1/cloud-providers` route. The whole local-execution layer (daemon, envs, agents,
> permissions, backlog) was removed in the same pass.
>
> **Deviations from the plan below:** (1) `dispatch(task, env)` keeps its `env` param —
> it's now the secret-free cloud-marker env (we chose to keep a thin env marker rather
> than move `provider` onto the task). (2) The deep streamer/poller generalisation into
> `TranscriptSource`/`TranscriptConverter` was **deferred** — with one provider, the
> PostHog poller/streamer are wrapped as-is; generalise them when Codex/Claude land.
> (3) The Settings/composer UI stays PostHog-specific until a 2nd provider exists.
> Phase 4 (Claude Code, Managed Agents) **shipped** (June 2026) — `services/claudeCode/*`
> + `cloudProviders/claude/provider.ts`, registered in `index.ts`, with a generic
> `CloudProviderCard` Settings form. Phase 3 (Codex Cloud) is **deferred** — no
> server-to-server API (see the Phase 0 findings). Remaining: per-task provider
> picker in the composer; `TranscriptSource`/`TranscriptConverter` generalisation.

## Background

A `posthog_code` environment is a **delegation marker**: a task assigned to it
bypasses Owl's agent loop entirely. An **executor** kicks off a remote run, a
**poller** reconciles remote status → Owl task status, and a **streamer +
converter** ingest the remote transcript into `task.transcript`. Status/PR/
transcript flow back through Owl's normal task model.

Everything provider-specific lives under
`packages/backend/src/services/posthogCode/` — `client.ts`, `credentials.ts`,
`executor.ts`, `poller.ts`, `streamer.ts`, `acpConverter.ts`. The **frontend and
task model are already provider-agnostic** (the transcript renderer keys off
`task.transcript`; the PR pill keys off `task.metadata.pullRequest`), so this work
is almost entirely backend plumbing.

Today the design is **parallel-cloneable but not pluggable**: dispatch is a hard
`if (env.type === 'posthog_code')` branch in `taskQueue.ts`, metadata is
`posthog*`-prefixed, and the converter reads PostHog-specific `_meta`. Going from
one provider to three justifies a small refactor first.

## Guiding principles

1. **Behaviour-preserving refactor first.** Phase 1 moves PostHog Code under a
   provider interface with zero behaviour change and all existing tests green.
2. **One neutral target format.** Providers differ only in (a) their API client,
   (b) their wire→`AgentEvent` converter, and (c) credential shape. `AgentEvent`
   stays the universal transcript format.
3. **Shared lifecycle, provider-specific edges.** PR detection/linking, task
   finalization, idle detection, and the streamer loop are generic. Each provider
   only supplies `dispatch`, `reconcile` (status mapping), and a converter.
4. **De-risk the unknowns early.** Each provider's "can we even create a cloud
   task + fetch its transcript over an API" is a spike (Phase 0) before we commit.

---

## Phase 0 — API verification spikes (de-risk, ~0.5–1 day each)

Feasibility hinges on each vendor exposing a programmatic *create-cloud-task* and
*fetch-transcript* path. Confirm before building.

### 0a. Codex Cloud
- **Open question:** the public `@openai/codex-sdk` (`codex.startThread().run()`)
  appears to drive a **local** Codex process, not the hosted cloud sandbox. The
  *cloud* tasks (per-task sandbox, preloaded repo, proposes a PR) are surfaced via
  Codex Web and `@codex` GitHub mentions. Verify whether there is a **REST/cloud
  task API** to: create a cloud task against a repo + prompt, poll status, fetch
  the transcript, and read the resulting PR.
- **Fallbacks if no direct cloud API:** (i) drive it via GitHub (`@codex` mention
  on an issue/PR) and reconcile through our existing GitHub monitor; (ii) run the
  Codex SDK under Owl's **local daemon** instead (different model — see "Two
  models" below). Decide which is acceptable.
- **Deliverable:** a throwaway script that creates a task and tails its output, or
  a written "not viable as cloud delegation yet → use GitHub/daemon path".

### 0b. Claude Code Routines
- Routines are a research preview (beta header `experimental-cc-routine-2026-04-01`).
  `POST …/routines/:id/fire` with input text returns a **session id + URL**, runs on
  Anthropic's cloud, exposes results via **webhook**.
- **Open questions:** (1) Can we create/run an *ad-hoc* prompt+repo per call, or
  must a routine be **pre-created** (prompt+repos+connectors saved up front)? If the
  latter, Owl's "arbitrary task" model maps awkwardly — we'd either create a routine
  per task (if the API allows) or require the user to bind an env to an existing
  routine. (2) How is the **transcript** retrieved — webhook payload, polling the
  session URL/API, or an SSE/stream endpoint? (3) Does a routine run open a **PR**,
  and is its URL in the result?
- **Deliverable:** a script that fires a routine and retrieves the transcript +
  result, plus a decision on the task→routine mapping.

**Gate:** only start Phase 3/4 for a provider once its spike passes. Phase 1–2
(the refactor) are worth doing regardless.

### Phase 0 findings — desk research (June 13 2026)

Ahead of running the spikes, web research against the vendors' official docs
settled the two open questions and changed the Codex plan:

**Codex Cloud → no server-to-server API; DEFERRED.** OpenAI ships *no* public
REST/SDK endpoint to create a Codex Cloud task from a backend. The only
hosted-sandbox surfaces are the **`codex cloud` CLI** (`exec`/`status`/`diff`/
`cancel`, needs a self-hosted runner + pre-created opaque env IDs, unstable JSON
output — see openai/codex#24777) and **`@codex` GitHub mentions**. The
`@openai/codex` SDK and `codex exec` drive a *local* agent, not the cloud.
Decision: **defer the Codex provider** rather than re-introduce a runner or build
on the brittle CLI; revisit if OpenAI ships a scriptable cloud API. (The
GitHub-mention fallback remains a future option behind the same provider seam.)

**Claude Code (web) → Managed Agents API; PROCEEDING.** Anthropic exposes two
hosted surfaces: (a) the **Routines API** (`POST /v1/claude_code/routines/:id/fire`,
experimental beta, OAuth `sk-ant-oat01-…`) — fire-and-forget, returns only a
session id/URL, routines must be *pre-created*, no transcript/poll/cancel; and
(b) the **Managed Agents API** (`POST /v1/agents` + `/v1/sessions`, SSE transcript
via `GET /v1/sessions/:id/stream`, `interrupt`/`archive` to cancel, `x-api-key`,
beta header `managed-agents-2026-04-01`) — dynamic per-task session with a mounted
GitHub repo + prompt + model. **We target Managed Agents** for full PostHog-Code
parity; PR URL is parsed from the transcript (the agent prints it). Exact
payload/event shapes are unconfirmed — `scripts/spikes/spike-claude.ts` validates
them against a real account before the module is built.

#### Claude Managed Agents — confirmed contract (spike run June 14 2026)

`scripts/spikes/spike-claude.ts` (throwaway, git-ignored) exercised the full
lifecycle against a real account. Confirmed:

- **Headers (all calls):** `x-api-key`, `anthropic-version: 2023-06-01`,
  `anthropic-beta: managed-agents-2026-04-01`, `content-type: application/json`.
- **`POST /v1/agents`** → 200. Body: `{ name, model, system, tools, mcp_servers }`.
  Tool `type`s are **`agent_toolset_20260401`** (prebuilt bash/read/write/edit/…,
  defaults `permission_policy.always_allow`) and **`mcp_toolset`**
  (`{ type:'mcp_toolset', mcp_server_name:'github' }`, defaults `always_ask`).
  GitHub MCP wired via `mcp_servers:[{ type:'url', name:'github', url:'https://api.githubcopilot.com/mcp/' }]`.
  Returns `agent_…` id.
- **`POST /v1/environments`** → 200 (`env_…`). The sandbox the session runs in
  (`config.type:'cloud'`, `networking:'unrestricted'`, has an `environment` map
  for env vars + `init_script`). Reusable per workspace.
- **`POST /v1/sessions`** → 200 (`sesn_…`, `status:'idle'`). Body:
  `{ agent:'agent_…', environment_id:'env_…', resources:[{ type:'github_repository', url, authorization_token, checkout? }] }`.
  The repo mounts at `/workspace/<repo>`. **`checkout` is an OBJECT** (string →
  400 "value must be an object"); exact inner shape still TBD (omitting it
  defaults to the repo's default branch). The field is **`agent`**, not `agent_id`.
- **Prompt** is NOT in the session create — send `POST /v1/sessions/{id}/events`
  with `{ events:[{ type:'user.message', content:[{ type:'text', text }] }] }`.
- **Transcript = POLL `GET /v1/sessions/{id}/events?limit=100`** → `{ data:[event…] }`,
  oldest-first, dedup by event `id`. (`/events/stream` only replays the backlog
  then closes — not a long-lived tail, so the existing poll loop drives it.)
  Pagination for >100 events (an `after` cursor) still to confirm.
- **Event taxonomy** (semantic `event.type` → converter mapping to `AgentEvent`):
  `user.message` / `agent.message` `{content:[{type:'text',text}]}`;
  `agent.thinking`; `agent.tool_use` `{name, input, id, evaluated_permission}`;
  `agent.tool_result` `{content:[{type:'text',text}], is_error, id}`;
  `span.model_request_start|end` (`model_usage` token counts → cost; otherwise
  ignorable); `session.status_running|idle`, `session.thread_status_running|idle`;
  `session.error` `{error:{message,type,…}}` (non-fatal unless terminal).
- **Terminal** = `session.status_idle` with `stop_reason.type:'end_turn'`
  (sessions have no "completed" state — they sit `idle` after finishing). Session
  GET `status` is `running` → `idle`.
- **Cancel** = `POST …/events {events:[{type:'user.interrupt'}]}` and/or
  `DELETE /v1/sessions/{id}` (→ `session_deleted`). Both 200.
- **Cost** available from `span.model_request_end.model_usage` token counts.

**PR-open path — CONFIRMED (write spike, real PR opened on `owl`).** Plan B
(agent uses `git`/`gh` via bash) is **dead**: `gh` isn't installed in the sandbox,
the repo is served through a localhost git proxy, and the `authorization_token`
is *not* exposed to the agent's shell — the agent burned 19 tool calls hunting for
a credential and got 403s. The working path is the **GitHub MCP + a vault**:
- `POST /v1/vaults` `{ display_name, metadata }` → `{ id:'vlt_…', type:'vault' }`.
- `POST /v1/vaults/{id}/credentials` `{ display_name, auth:{ type:'static_bearer', mcp_server_url:'https://api.githubcopilot.com/mcp/', token:'<gh PAT>' } }` → `{ id:'vcrd_…', vault_id }`. (Token is write-only; the stored `mcp_server_url` is returned slash-normalized and still matches.)
- Agent: set the github `mcp_toolset` to **`default_config.permission_policy.always_allow`** (default is `always_ask`, which would stall an unattended run).
- Session: pass **`vault_ids:[vaultId]`** — the credential is matched to the MCP by URL automatically.
- The agent then opens the PR with the github MCP tools (`get_me`, `list_branches`,
  `create_branch`, `create_or_update_file`, `create_pull_request`). The **PR URL
  appears in the `agent.mcp_tool_result`** of `create_pull_request` (regex
  `https://github\.com/[^/]+/[^/]+/pull/\d+` over the event JSON catches it).
- PAT scopes: `repo` (classic) or fine-grained `contents:rw` + `pull_requests:rw`.

Remaining minor TBD: the **`checkout` object shape** (for mounting a PR's *head*
branch on `pr_response`/`pr_review`); `code_writing` works without it. For
PR-response tasks the agent can also operate on the existing branch via the MCP.

**Verdict: Managed Agents gives full parity, including autonomous PRs.** Provider
design — dispatch = ensure agent (toolset + github MCP `always_allow`) + ensure
environment + ensure vault (per workspace, reusable) → create session
(`agent` + `environment_id` + `vault_ids` + `github_repository` resource) → post
the prompt event; reconcile = poll `GET /sessions/{id}/events`, map → `AgentEvent[]`,
terminal on `session.status_idle/end_turn`, detect the PR URL from the
`create_pull_request` `agent.mcp_tool_result`; cancel = `user.interrupt` + `DELETE`.

---

## Phase 1 — Provider abstraction (behaviour-preserving, ~1–2 days)

Introduce the interface + registry and move PostHog Code under it with **no
behaviour change**. New home: `packages/backend/src/services/cloudProviders/`.

### 1a. Define the contract — `cloudProviders/types.ts`
```ts
export interface ReconcileOutcome {
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  prUrl?: string | null;
  branch?: string | null;
  error?: string | null;
  logUrl?: string | null;
  /** Provider-specific bits to merge into metadata.cloudTask.extra. */
  extra?: Record<string, unknown>;
}

/** Normalises a provider's wire frames into Owl AgentEvents. */
export interface TranscriptConverter {
  push(rawFrame: unknown): AgentEventInput[];
  end(): AgentEventInput[];
}

/** Live tail + durable backfill for a provider's transcript. */
export interface TranscriptSource {
  /** Async iterator of raw frames for a live run (SSE, websocket, poll loop). */
  live?(signal: AbortSignal, cursor?: string): AsyncIterable<{ frame: unknown; cursor?: string }>;
  /** One-shot durable fetch for terminal/finished runs. */
  backfill?(): Promise<unknown[]>;
}

export interface CloudTaskProvider {
  type: EnvironmentType;            // 'posthog_code' | 'codex_cloud' | 'claude_code'
  displayName: string;
  defaultRenderer: EnvironmentRenderer; // 'structured'

  /** Validate + persist credentials (Settings → Integrations). */
  validateCredentials(workspaceId: string, input: unknown): Promise<{ ok: boolean; error?: string }>;
  hasCredentials(workspaceId: string): Promise<boolean>;

  /** Kick off a remote task; stamp metadata.cloudTask; flip task in_progress. */
  dispatch(task: Task, env: Environment): Promise<{ ok: boolean; error?: string }>;

  /** Read remote status for one in-progress task. */
  reconcile(task: Task): Promise<ReconcileOutcome>;

  /** Transcript ingestion. */
  createConverter(): TranscriptConverter;
  openTranscript(task: Task): Promise<TranscriptSource | null>;
}
```

### 1b. Registry — `cloudProviders/registry.ts`
```ts
const providers = new Map<EnvironmentType, CloudTaskProvider>();
export function registerCloudProvider(p: CloudTaskProvider) { providers.set(p.type, p); }
export function getCloudProvider(type: EnvironmentType) { return providers.get(type) ?? null; }
export function isCloudEnv(type: EnvironmentType) { return providers.has(type); }
export function listCloudProviders() { return [...providers.values()]; }
```
Register providers at boot in `index.ts` (alongside the existing poller `init()`).

### 1c. Move PostHog Code under the interface
- Relocate `services/posthogCode/` → `services/cloudProviders/posthog/` (keep files).
- Add `posthog/provider.ts` implementing `CloudTaskProvider` by delegating to the
  existing `dispatchTaskToPostHogCode`, the existing poller's `reconcile` logic
  (refactored to return `ReconcileOutcome`), and the existing ACP converter +
  SSE/session-logs streamer wrapped as a `TranscriptSource`.

### 1d. Generic dispatch — `taskQueue.ts` (~L273–305)
Replace the special-case branch:
```ts
const provider = targetEnv && getCloudProvider(targetEnv.type);
if (provider) {
  const r = await provider.dispatch(task, targetEnv);
  if (!r.ok) { /* existing error handling */ }
  continue;
}
```
And in `recoverStuckTasks` (~L143–150), replace `meta.posthogRunId` with
`meta.cloudTask?.remoteRunId` (see Phase 2 metadata).

### 1e. Generic streamer + poller
- **Streamer** (`cloudProviders/streamer.ts`): generalise the current
  `posthogCode/streamer.ts` to take a `TranscriptSource` + `TranscriptConverter`
  instead of hard-coded SSE/session-logs. Keep the seq assignment, 25-event
  persist, truncation, reconnect-to-tail, `flushNow`, and `seedTranscript` logic.
- **Poller** (`cloudProviders/poller.ts`): generalise to: for each in-progress task
  with `metadata.cloudTask`, look up the provider, call `reconcile()`, then run the
  **shared** finalize/PR-link/idle logic (lift `linkPr`, `findPullRequestUrl`,
  `maybeFinalizeIdle`, `finalize` out of `posthogCode/poller.ts` into shared
  helpers — they're already provider-neutral except PR-URL parsing, which is GitHub
  for all three).

### 1f. `environment.ts` `testConnection` (~L195–203)
Replace `config.type === 'posthog_code'` with `isCloudEnv(config.type)` →
`{ success: true }`.

**Acceptance:** existing `prMonitorPoll`, `posthogCodePoller`,
`posthogCodeStreamer`, `posthogCodeAcpConverter`, task-queue tests all pass
unchanged. No DB or wire change yet. PostHog Code behaves identically.

---

## Phase 2 — Generalise metadata, credentials, routes, env types (~1–2 days)

### 2a. Neutral task metadata — `packages/shared/src/index.ts`
Add alongside (not replacing) `PostHogCodeTaskMetadata`:
```ts
export interface CloudTaskMetadata {
  provider: EnvironmentType;        // which provider owns this task
  remoteTaskId: string;
  remoteRunId?: string;
  status?: string;
  logUrl?: string;
  prUrl?: string;
  extra?: Record<string, unknown>;  // provider-specific bag
}
// task.metadata.cloudTask?: CloudTaskMetadata
```
- **Back-compat:** a read helper `readCloudTaskMeta(task)` that prefers
  `metadata.cloudTask` and falls back to mapping legacy `posthog*` fields. All
  call sites (poller, streamer, routes, frontend) read through the helper.
- **Migration:** a one-shot backfill (drizzle migration `00NN` + a small script,
  or lazy on first poll) writing `cloudTask` from legacy `posthog*` for
  in-flight tasks. Completed tasks can stay legacy (read helper covers them).

### 2b. Generic credentials/integrations
- `integrations` table is already generic (`(workspaceId, type)` + encrypted
  `config`). Add a `cloudProviders/credentials.ts` base: `getIntegration(ws, type)`,
  `storeIntegration(ws, type, config)` with the existing `tokenCrypto` envelope.
- Each provider defines its own credential shape and `validateCredentials`
  (PostHog: apiKey+projectId+host; Codex: apiKey/org + repo connection; Claude:
  OAuth/api key + beta header + routine binding).

### 2c. Generic provider routes — `routes/cloudProviders.ts`
- `GET  /api/cloud-providers` → list registered providers + connected status.
- `GET/PUT/DELETE/POST(test) /api/cloud-providers/:type/config` → delegate to the
  provider's credential methods; auto-provision the env on connect via a generic
  `ensureCloudEnvironment(workspaceId, type, defaults)` (lift from
  `routes/posthog.ts:ensurePostHogCodeEnvironment`).
- Keep `/api/posthog/*` as thin aliases for one release, then migrate the
  frontend and delete.

### 2d. Env type union + config — `packages/shared/src/index.ts`
- `EnvironmentType = 'local' | 'remote' | 'posthog_code' | 'codex_cloud' | 'claude_code'`.
- Add `CodexCloudEnvironmentConfig` / `ClaudeRoutineEnvironmentConfig` to the
  `EnvironmentConfig` union (model/adapter/routine-id defaults as needed).

### 2e. Frontend generic surfaces
- **Settings → Integrations**: render one panel per `GET /api/cloud-providers`
  entry instead of a hard-coded PostHog panel.
- **Env picker / Add-Environment modal**: list cloud providers generically; each
  connected provider exposes its auto-provisioned env.
- **TaskComposer**: drive model/adapter controls off provider capability metadata
  (PostHog: model + reasoning effort; Codex: model; Claude: routine select) rather
  than the `isCloudTask` special-case.
- **QueuePanel cloud banner**: read provider `displayName` + `logUrl` from
  `metadata.cloudTask` instead of `posthog*`.

**Acceptance:** PostHog Code works end-to-end through the generic
metadata/credentials/routes/UI. Legacy tasks still render. Tests updated to the
neutral shapes.

---

## Phase 3 — Codex Cloud provider — DEFERRED

> Phase 0 found **no server-to-server Codex Cloud API** (only the `codex cloud`
> CLI under a self-hosted runner, or `@codex` GitHub mentions). Deferred until
> OpenAI ships a scriptable cloud API, or we accept the GitHub-mention path
> behind this same provider seam. The sketch below is retained for that day.

`services/cloudProviders/codex/`:
- **`client.ts`** — REST wrapper: create cloud task (repo + prompt + model), get
  status, fetch transcript (stream or poll), read PR. Auth via Codex API key/org.
- **`credentials.ts`** — `type: 'codex'` integration; `validateCredentials` pings.
- **`converter.ts`** — Codex event stream → `AgentEvent[]`. Codex emits a
  different shape than ACP (turn/message/tool-call events); map text →
  assistant/text, reasoning → thinking, tool calls → tool_use, results →
  tool_result, stderr/console → system. Emit live `stream_event` deltas like the
  ACP converter does.
- **`transcriptSource.ts`** — `live()` (SSE or poll loop) + `backfill()`.
- **`provider.ts`** — implements `CloudTaskProvider`; `dispatch` creates the task
  + stamps `cloudTask`; `reconcile` maps Codex status → `ReconcileOutcome` +
  PR URL.
- Register in `index.ts`; add `codex_cloud` env config; UI capability metadata
  (model select).
- **Tests:** converter unit tests (fixture Codex frames → AgentEvents), a poller
  reconcile test (mocked client: in_progress → completed + PR), a dispatch test.

---

## Phase 4 — Claude Code provider — SHIPPED (June 2026)

> Implemented via Anthropic's **Managed Agents API** (not Routines — that path is
> subscription-billed but fire-and-forget / low-parity; see the Phase 0 findings
> and the billing analysis). Provider type `claude_code`, displayName
> "Claude Code". Contract confirmed by the spike (see above).

`services/claudeCode/` + `services/cloudProviders/claude/provider.ts`:
- **`client.ts`** — Managed Agents wrapper: create agent / environment / vault
  (+ GitHub credential) / session, post the prompt event, poll the event list,
  get session, interrupt + delete. `debugBus` service tag `claude_managed_agents`.
- **`credentials.ts`** — `type: 'claude_code'` integration; encrypted Anthropic
  key + GitHub PAT; caches the reusable agent/environment/vault ids per workspace
  (cleared on credential rotation).
- **`converter.ts`** — `managedAgentEventToAgentEvents` (poll-based, complete
  events → `AgentEvent[]`; no chunk coalescing) + `findPullRequestUrl` /
  `isTerminalEvent`.
- **`executor.ts`** — `dispatch`: ensure resources → create session w/ repo
  resource + vault → post the prompt (starts the run) → stamp `cloudTask` →
  `in_progress`.
- **`poller.ts`** — `reconcile`: poll events → transcript (persist + emit only
  what's new), detect+link the PR from `create_pull_request`, finalize on
  `session.status_idle`/`end_turn`; `stopStreaming` clears the in-memory cursor.
- **`provider.ts`** — `CloudTaskProvider`; `cancel` = interrupt + delete session.
- Registered in `index.ts`; DebugPanel `SERVICE_INFO`; generic `CloudProviderCard`
  Settings form (Anthropic key + GitHub PAT).
- **Tests:** `claudeCodeConverter.test.ts` (event mapping, PR detection, terminal),
  `claudeCodeProvider.test.ts` (conformance + registry).
- **Known follow-ups:** per-task provider picker (PR-fix tasks currently prefer
  PostHog, else Claude); `checkout` object shape for `pr_response`/`pr_review`
  head-branch mounting; executor/poller DB-mocked reconcile tests; reusing the
  workspace GitHub connection instead of a separate PAT (OAuth-token↔MCP compat
  unverified).

---

## Phase 5 — UX polish, docs, rollout (~1 day)

- Per-provider "Add Environment" cards with connect flows; status pills in Settings.
- Feature-flag each new provider (env var / settings) so they ship dark and enable
  per workspace.
- Docs: update `docs/ARCHITECTURE.md` (provider abstraction), `docs/ROADMAP.md`
  (phase items), `docs/SESSIONS.md` (session note), and a user-facing
  `docs/CLOUD_PROVIDERS_USAGE.md`.

---

## Two integration models (scope clarification)

This plan covers **cloud delegation** (vendor hosts the sandbox + agent loop; Owl
kicks off + reconciles). The alternative is **local execution via Owl's daemon**
(Owl runs the `claude`/`codex` CLI itself). Owl already runs Claude locally; adding
the **Codex CLI** there is a *runtime adapter on the agent service*, not a cloud
provider, and is out of scope here. If 0a shows Codex has no cloud task API, the
local-daemon path is the pragmatic fallback for Codex.

## Risks & open questions

- **Codex cloud API existence** (0a) — biggest unknown; may force GitHub-mention or
  local-daemon fallback.
- **Routine ad-hoc vs pre-created** (0b) — shapes the UX and whether "any task" is
  possible.
- **Transcript retrieval variance** — SSE (PostHog) vs webhook (Claude) vs poll
  (Codex?) — handled by the `TranscriptSource` abstraction but each needs care
  (ordering, dedup, backfill).
- **PR creation** — PostHog/Codex open PRs themselves; if Claude routines don't,
  reuse Owl's `taskPullRequest` to open from the produced branch.
- **Webhook reachability** — fine on Railway; document a tunnel for local dev.
- **Metadata migration** — keep the read-through helper until all legacy tasks age
  out; never hard-cut `posthog*`.

## Effort summary

| Phase | Scope | Est. |
|---|---|---|
| 0 | API spikes (Codex, Claude) | ~1–2 days |
| 1 | Provider interface + registry; move PostHog under it (no behaviour change) | ~1–2 days |
| 2 | Neutral metadata/credentials/routes/env-types + frontend plumbing | ~1–2 days |
| 3 | Codex Cloud provider | ~2–3 days |
| 4 | Claude Routines provider | ~2–3 days |
| 5 | UX polish, flags, docs | ~1 day |

After Phases 1–2, each new provider is a self-contained ~5–6 file module
(`client` + `credentials` + `converter` + `transcriptSource` + `provider`
+ tests) with **no changes to the core**.
