# Inbound integrations: issue tracking, error tracking and generic webhooks

Plan of 2026-11-12. Each phase ships on its own, behind its own PostHog flag.

## Decisions (Tom, 2026-11-12)

1. A rule that an issue, an error or a generic webhook matches starts a **session** by default (`start_session`). A rule can choose `start_task` instead.
2. **Write-back is on by default.** A new rule comments on the issue or error when it starts work ("Talyn started: <link>"). A rule can turn it off.
3. **On PR merge, comment and transition.** Talyn comments with the PR link and moves the issue to done (Linear "Done", Jira done transition, GitHub issue closed, Sentry or PostHog issue resolved). A rule can turn the transition off.
4. **GitHub Issues has its own catalog card**, beside Linear and Jira. It uses the existing GitHub App connection: no new auth.
5. The integration's OAuth grant stays **separate** from the vendor's MCP server grant (see below).

## What exists

- `IntegrationKind` (`packages/shared/src/integrations.ts`, page catalog and gates) and `WorkflowIntegration` (`packages/shared/src/workflows.ts`, `WORKFLOW_INTEGRATIONS`, the facts union, `workflowMatches`) are separate unions. A new vendor touches both.
- The engine is adapter-shaped: `services/workflows/source.ts` (`WorkflowSourceAdapter<Input, Target, Facts>`) and `engine.ts` `evaluateWorkflows(source, input)`. A new vendor is a new adapter and a facts member.
- Slack is the inbound pattern: `services/slack/events.ts` verifies the HMAC on the raw body, inserts into `slack_events` (event id is the idempotency), answers 200, processes after the response with a claim (`claimed_at` CAS, 5 attempts), a 60 s sweep and 7-day retention. Mirror Slack, not GitHub's Redis stream.
- `run_prompt` / `run_skill` are PR-only. `start_session` (`sessionAction.ts`) is the shared action. `buildSlackPrompt` (`services/slack/context.ts`) is the untrusted-content fencing to reuse.
- The `posthog` integration kind is PostHog Code credentials, not an error-tracking project. Error tracking gets a new kind.
- Mobile: `apps/mobile/app/integrations/[kind].tsx` and `RulesScreen.tsx` list rules with an enable toggle and "Edit on the web".

## Shared inbound layer (`packages/backend/src/services/inbound/`)

**Connections.** Table `inbound_connections`: `id`, `workspace_id`, `kind` (`linear | jira | sentry | posthog_errors | webhook`), `external_account_id` (Linear org id, Sentry org slug, Jira cloud id; null for generic), `secret_enc` (signing secret or URL token, `tokenCrypto.ts`), `credential_enc` (write-back token), `credential_meta` jsonb (scopes, expiry, `reauth_required_at`, our own actor id), `rule_id` (generic only: one connection per rule), `created_by`, timestamps. Backend-pool only: RLS on, no policy, no grant. UNIQUE `(workspace_id, kind, external_account_id)`.

**Route.** One raw-body receiver, `POST /api/v1/webhooks/in/:connectionId`, mounted in `index.ts` beside `/webhooks/slack` with `express.raw`. Generic adds `/:token` (Zapier and n8n cannot sign): the token hash is compared in constant time, and an optional `X-Talyn-Signature` HMAC is checked when present.

**Verification** (`inbound/adapters/<kind>.ts`, `verify(rawBody, headers, secret) → 'valid' | 'invalid' | 'missing' | 'stale'`):

- Linear: HMAC-SHA256 of the raw body in `Linear-Signature`; reject a `webhookTimestamp` older than 60 s; delivery id `Linear-Delivery`.
- Sentry: HMAC-SHA256 with the integration's client secret in `Sentry-Hook-Signature`; resource in `Sentry-Hook-Resource`; delivery id `Request-ID`.
- Jira Cloud: webhook secret, `X-Hub-Signature: sha256=…`; delivery id `sha256(body)`.
- PostHog errors: a Hog-function destination on `$error_tracking_issue_created` / `issue_reopened` POSTs a body we give. URL token. Polling the error-tracking API is the fallback.
- Generic: token, optional HMAC; delivery id `X-Talyn-Delivery` else `sha256(body)`.

**Deliveries.** Table `inbound_deliveries`: `id`, `connection_id`, `delivery_id`, `event_type`, `payload` jsonb, `received_at`, `claimed_at`, `processed_at`, `attempts`, `outcome`, `error`, `replay_of`. UNIQUE `(connection_id, delivery_id)` is the idempotency. `inbound/process.ts` generalises `processSlackEvent`; `inbound/sweep.ts` retries and prunes at 7 days. Replay inserts a copy with `delivery_id = <orig>:replay:<n>`, so the `workflow_runs (workflow_id, delivery_id)` claim does not swallow it. A list projection never selects `payload`.

**Facts.** New members of the facts union in `shared/workflows.ts`:

```ts
interface IssueEventFacts { integration: 'linear' | 'jira' | 'github_issues'; event: 'issue_created' | 'issue_updated' | 'issue_labeled' | 'issue_assigned' | 'issue_status_changed' | 'issue_commented'; externalId; identifier; title; body; url; labels: string[]; assignee: string | null; team: string | null; project: string | null; status: string; priority: string | null; actor: string | null; unknownFields?: string[] }
interface ErrorEventFacts { integration: 'sentry' | 'posthog_errors'; event: 'error_new' | 'error_regressed' | 'error_threshold' | 'error_assigned'; externalId; title; culprit; url; project; environment; level; release; eventCount; userCount; stackTrace: string | null }
interface WebhookEventFacts { integration: 'webhook'; event: 'webhook_received'; ruleId; payload: unknown; headers: Record<string, string> }
```

`workflowMatches` gains `issueConditionsMatch`, `errorConditionsMatch`, `webhookConditionsMatch`. `workflowSubjectOf` keys `issue:<integration>:<externalId>`, `error:<integration>:<externalId>`, `webhook:<ruleId>`, so the per-subject hourly cap works unchanged. `prepare()` drops self-echo (our own app actor, or a comment id we wrote).

**Conditions.** Each rule carries `connectionId`. Issue: `labelsAny/All/None`, `assignee` (`any | me | logins`), `teams`, `projects`, `statuses`, `titleContains`, `bodyContains`. Error: `projects`, `environments`, `levels`, `minEvents`, `minUsers`, `titleContains`. Webhook: a short list of `jsonPath` + `equals | contains`.

**Actions.** `start_session` (exists; the default for every inbound integration) and a new `start_task` `{ repositoryId, prompt, model?, internetAccess? }` through `createCloudTask({ type: 'code_writing', source: 'workflow' })`. The repository is explicit per rule. Write-back actions: `issue_comment`, `issue_set_status`, `error_comment` (Sentry), `error_set_status`. Write-back runs in the backend with the connection credential; the agent never holds it. A vendor 429 parks the action as `rate_gated` through `retrySweep.ts`.

**Prompt.** `inbound/prompt.ts` `buildInboundPrompt` mirrors `buildSlackPrompt`: the rule's prompt first, then one fenced UNTRUSTED block per source (issue body, comments, stack trace, payload capped at 16 KB), then the source URL. Identifier placeholders (`{{issue.identifier}}`, `{{issue.url}}`, `{{error.url}}`, `{{repo}}`) render inline, single line, length-capped. Text placeholders (`{{issue.body}}`, `{{error.stack}}`, `{{payload.<path>}}`) render only inside the fence. `internetAccess` stays off by default.

**Links and dedupe.** Table `external_issue_links`: `id`, `workspace_id`, `integration`, `connection_id`, `external_id`, `external_key`, `external_url`, `task_id`, `workbench_id`, `pull_request_id`, `run_id`, `our_comment_ids` jsonb, `status` (`active | done | failed`), timestamps. Partial UNIQUE `(workspace_id, integration, external_id) WHERE status = 'active'`. The start actions insert the link before dispatch; a second event on an active link refuses with `issue_already_running`. A `pr:merged` listener (`inbound/onMerge.ts`) finds links by `pull_request_id` (structured, never a search), comments and transitions, then marks the link `done`.

**MCP grant stays separate.** The MCP grant is audience-bound (RFC 8707) to the MCP server, not the vendor API, and the write-back token must never reach `mcpServersForDispatch`. Each integration page offers "Also connect as an MCP server", which starts the normal `services/mcpServers/oauth.ts` flow.

## Per adapter

- **Linear**: OAuth app (scopes `read, write, issues:create, comments:create`, `actor=app`); webhooks created per org through the API at connect time with a Talyn secret. Events: `Issue` create and update, `Comment` create. Write-back: GraphQL `commentCreate`, `issueUpdate(stateId)`.
- **GitHub Issues**: no new auth or route. The App already delivers `issues` and `issue_comment` through `processWebhookDelivery`. `sources/githubIssues.ts` maps them to `IssueEventFacts`. Write-back with the installation token. Own catalog card.
- **Sentry**: integration-platform app (webhook URL, `issue` and alert-rule resources, `event:read issue:write`). Events: issue created, regressed, alert fired. Write-back: comment, status.
- **PostHog errors**: new kind `posthog_errors`, personal API key with `error_tracking:write`. Trigger by alert destination; the page shows the URL and body template.
- **Jira Cloud**: webhook secret plus API token or OAuth 3LO. Write-back: comment, transition. Out of scope: Server and Data Center, Forge.
- **Generic**: one connection per rule, URL shown once with a rotate button, JSON-path conditions, start actions only, no write-back.

## Front ends, flags, docs

- Web: `IntegrationsView.tsx` connection sections and rule editor per vocabulary, plus a Deliveries list with Replay. Desktop: the same, forked. Mobile: connection status screens and the rules list with "Connect on the web" / "Edit on the web", gated by `useFeatures()`.
- Flags: `webhookRules` (`webhook-rules`), `issueRules` (`issue-rules`), `errorRules` (`error-rules`); `fallback: false`, `availability: 'gated'`. The engine asks the workspace owner, routes ask the caller.
- Docs: `apps/marketing/content/docs/integrations-<kind>.md` for each, `DOCS_NAV`, `integrations.md`, and `docs/MCP_SERVER.md` + `mcp.md` because the workflow MCP tools list the integrations.

## Phases

1. Shared layer and generic webhook (`webhookRules`), plus `start_task`. **Done 2026-11-12** (migration `0131`). See the note in `docs/SESSIONS.md`.
2. Linear and GitHub Issues (`issueRules`), with `external_issue_links`, write-back and merge transitions.
3. Sentry and PostHog errors (`errorRules`).
4. Jira.

## Setup Tom does

- Linear OAuth app (redirect `/integrations/linear/callback`), Sentry integration-platform app, later a Jira app. Each client id and secret is an env var.
