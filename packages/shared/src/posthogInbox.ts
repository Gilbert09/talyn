// PostHog Inbox: the shapes of the PostHog connection status and the dry run
// that the PostHog Inbox rule editor reads. The rule vocabulary itself (facts,
// conditions, matcher) lives in `workflows.ts` with the other integrations.

/** The OAuth scopes PostHog Inbox rules need. */
export const POSTHOG_INBOX_SCOPES = ['inbox:read', 'inbox:write'] as const;

/**
 * The scopes Talyn needs to set up the push in PostHog itself: create, read,
 * update and delete the webhook destination (PostHog's hog functions API,
 * `hog_function:read` and `hog_function:write`). A grant without them still
 * runs the rules and the claims; only "Set up push in PostHog" needs them.
 */
export const POSTHOG_INBOX_PUSH_SETUP_SCOPES = ['hog_function:read', 'hog_function:write'] as const;

/**
 * The scopes the PostHog Inbox's own OAuth connection asks for: read the
 * reports (`inbox:read`), claim them (`inbox:write`), attach a pull request
 * to the claim (`task:write`) and set up the push destination
 * (`hog_function:read`, `hog_function:write`). `openid` makes it an OIDC
 * grant. Checked against PostHog's OpenAPI schema.
 */
export const POSTHOG_INBOX_OAUTH_SCOPES = [
  'openid',
  'inbox:read',
  'inbox:write',
  'task:write',
  ...POSTHOG_INBOX_PUSH_SETUP_SCOPES,
] as const;

/** The scopes an Inbox grant must hold. The card asks for a reconnect when one is missing. */
export const POSTHOG_INBOX_REQUIRED_SCOPES = ['inbox:read', 'inbox:write', 'task:write'] as const;

/**
 * Which PostHog connection the Inbox rules use.
 *
 * - `posthog_inbox`: the Inbox's own connection (an `integrations` row of
 *   type `posthog_inbox`). It wins when it exists.
 * - `posthog_code`: an older PostHog Code connection whose grant has the Inbox
 *   scopes (or a personal API key). Used only when the Inbox has no connection
 *   of its own, so existing workspaces keep working without a reconnect.
 */
export type PostHogInboxConnectionSource = 'posthog_inbox' | 'posthog_code';

/** The answer code of the Inbox connect routes when PostHog OAuth is not set up on this deployment. */
export const POSTHOG_INBOX_OAUTH_UNAVAILABLE_CODE = 'posthog_inbox_oauth_unavailable';

/** The answer code when the `posthogInboxRules` flag is off for the caller. */
export const POSTHOG_INBOX_RULES_UNAVAILABLE_CODE = 'posthog_inbox_rules_unavailable';

/**
 * Whether Talyn can read the workspace's PostHog Inbox.
 *
 * - `ok`: the connection has the Inbox permissions (an OAuth grant with
 *   `inbox:read`, or a personal API key that PostHog accepted).
 * - `reconnect`: an OAuth grant from before Inbox rules, without `inbox:read`,
 *   or a grant PostHog revoked. Connect PostHog again to fix it.
 * - `unknown`: a personal API key that Talyn has not used on the Inbox yet.
 * - `not_connected`: the workspace has no PostHog connection.
 */
export type PostHogInboxAccess = 'ok' | 'reconnect' | 'unknown' | 'not_connected';

/** `GET /workflows/posthog-inbox/status`. Never holds a credential. */
export interface PostHogInboxStatus {
  access: PostHogInboxAccess;
  /** Why `access` is `reconnect`, for the editor's notice. */
  reason: string | null;
  authMethod: 'oauth' | 'personal_api_key' | null;
  projectId: string | null;
  host: string | null;
  /** Which connection the rules use, or null when none. */
  connection: PostHogInboxConnectionSource | null;
  /**
   * OAuth only: the required scopes ({@link POSTHOG_INBOX_REQUIRED_SCOPES})
   * the stored grant does not hold. Empty for a personal API key or no
   * connection.
   */
  missingScopes: string[];
  /** Whether this deployment can offer "Connect with PostHog" at all. */
  oauthAvailable: boolean;
  /** When the poller last read the Inbox, or null. */
  lastPolledAt: string | null;
  /** The last poll's error, or null when it worked. */
  lastError: string | null;
  /** The newest push from PostHog that Talyn could read, or null. */
  lastPushAt: string | null;
  /** Whether the workspace has a webhook URL for its PostHog project. */
  pushConfigured: boolean;
  /** Whether Talyn created the PostHog destination for that URL ("Set up push in PostHog"). */
  pushManaged: boolean;
  /**
   * OAuth only: the scopes ({@link POSTHOG_INBOX_PUSH_SETUP_SCOPES}) the grant
   * lacks for "Set up push in PostHog". Separate from `missingScopes`: the
   * rules work without them. Empty for a personal API key, whose scopes Talyn
   * cannot read.
   */
  pushSetupMissingScopes: string[];
}

/** One report the dry run found. */
export interface PostHogInboxReportPreview {
  id: string;
  title: string;
  url: string;
  priority: string | null;
  repository: string | null;
  signalCount: number;
  updatedAt: string;
  /** Whether the rule would start a session for it now. */
  matched: boolean;
  /** Why it did not match, in a few words. Null when it matched. */
  reason: string | null;
}

/** `POST /workflows/posthog-inbox/dry-run`: what a rule would act on now. Starts nothing. */
export interface PostHogInboxDryRun {
  /** The reports the rule matches now, newest change first. */
  matches: PostHogInboxReportPreview[];
  /** A few of the reports it read that did not match, with the reason. */
  skipped: PostHogInboxReportPreview[];
  /** How many reports Talyn read from PostHog. */
  scanned: number;
  /** True when PostHog had more reports than the dry run reads. */
  truncated: boolean;
}

// ---- Claims (step 2) --------------------------------------------------------

/**
 * The scopes Talyn needs to claim a report and attach its pull request.
 * PostHog's claim endpoint needs `inbox:write`; adding a pull request to the
 * claim also needs `task:write` (PostHog's OpenAPI, `signals_reports_claim`).
 */
export const POSTHOG_INBOX_CLAIM_SCOPES = ['inbox:write', 'task:write'] as const;

/**
 * Where Talyn's claim on a PostHog report stands.
 *
 * - `claimed`: Talyn holds the report in PostHog. The session works on it.
 * - `pr_attached`: the session's pull request is on the claim. PostHog
 *   resolves the report when the pull request merges.
 * - `merged`: the pull request merged. Nothing more is owed.
 * - `released`: the work ended without a pull request, or the pull request
 *   closed without a merge. Talyn released the claim.
 * - `lost`: PostHog ended Talyn's claim, for example because somebody took
 *   the report over.
 */
export type PostHogClaimState = 'claimed' | 'pr_attached' | 'merged' | 'released' | 'lost';

/** Talyn's claim on one run's report, as the run history shows it. */
export interface PostHogClaimSummary {
  state: PostHogClaimState;
  /** The pull request on the claim, or null. */
  prUrl: string | null;
  /** Why the claim was released or lost, or null. */
  reason: string | null;
  /** True while Talyn still owes PostHog a write (an attach or a release that failed). */
  pending: boolean;
  /** The last failed write to PostHog, or null. */
  error: string | null;
  updatedAt: string | null;
}

/**
 * The prefix a PostHog Inbox session puts on the last line of its final
 * message when it stops without a fix, for example because the diagnosis was
 * wrong. Talyn then releases the claim on the report.
 */
export const TALYN_REPORT_NOT_FIXED_SENTINEL = 'TALYN_REPORT_NOT_FIXED:';

const REPORT_NOT_FIXED_REASON_MAX = 300;

/**
 * Read {@link TALYN_REPORT_NOT_FIXED_SENTINEL} from the last non-empty line of
 * an agent's final message. Null when the message does not end on it: an
 * agent that only discusses the sentinel does not trip it. A sentinel with no
 * reason still counts.
 */
export function parseReportNotFixedSentinel(text: string | null | undefined): { reason: string } | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim().replace(/^`+|`+$/g, '').trim();
    if (line.length === 0) continue;
    if (!line.startsWith(TALYN_REPORT_NOT_FIXED_SENTINEL)) return null;
    const reason = line.slice(TALYN_REPORT_NOT_FIXED_SENTINEL.length).trim();
    if (!reason) return { reason: 'The agent stopped without a fix.' };
    return {
      reason:
        reason.length > REPORT_NOT_FIXED_REASON_MAX
          ? `${reason.slice(0, REPORT_NOT_FIXED_REASON_MAX - 1).trimEnd()}…`
          : reason,
    };
  }
  return null;
}

/** One line for the run history: what Talyn's claim on the report is now. */
export function posthogClaimText(claim: PostHogClaimSummary): string {
  let text: string;
  switch (claim.state) {
    case 'claimed':
      text = 'Claimed the report in PostHog.';
      break;
    case 'pr_attached':
      text = 'Attached the pull request to the claim in PostHog.';
      break;
    case 'merged':
      text = 'The pull request merged. PostHog resolves the report.';
      break;
    case 'released':
      text = claim.reason ? `Released the claim in PostHog: ${claim.reason}.` : 'Released the claim in PostHog.';
      break;
    case 'lost':
      text = claim.reason ? `PostHog ended the claim: ${claim.reason}.` : 'PostHog ended the claim.';
      break;
  }
  if (claim.pending) {
    text += claim.error ? ` PostHog did not take the last update (${claim.error}). Talyn tries again.` : ' Talyn has an update to send to PostHog.';
  }
  return text.replace(/\.\./g, '.');
}

// ---- Push (PostHog webhook destination) -------------------------------------

/** The internal event PostHog emits when an Inbox report becomes ready. */
export const POSTHOG_INBOX_READY_EVENT = '$signals_report_ready';

/**
 * The header that carries the optional shared secret. Add it in PostHog as a
 * secret header of the webhook destination, so PostHog stores it encrypted.
 */
export const POSTHOG_INBOX_SECRET_HEADER = 'x-talyn-secret';

/** A push in this window slows the poller to a reconcile. */
export const POSTHOG_INBOX_PUSH_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The webhook URL of the workspace's PostHog Inbox, for the Connection tab.
 * Never holds a secret: Talyn keeps only a hash of the URL token.
 */
export interface PostHogInboxPushSummary {
  connectionId: string;
  /** The URL up to the token, for display. */
  urlPrefix: string;
  /** The PostHog project the URL is for. */
  projectId: string;
  /** Whether a request must carry `X-Talyn-Secret`. */
  secretRequired: boolean;
  createdAt: string;
  rotatedAt: string | null;
  /** The newest request to the URL, valid or not, or null. */
  lastDeliveryAt: string | null;
  /** The newest push whose report Talyn read from the project, or null. */
  lastPushAt: string | null;
  /** The PostHog destination Talyn created for this URL, or null when the person added it by hand. */
  destination: PostHogInboxDestinationSummary | null;
}

/** The PostHog webhook destination that Talyn created and keeps in step with the URL. */
export interface PostHogInboxDestinationSummary {
  /** PostHog's hog function id. */
  id: string;
  /** The destination in the PostHog app, or null when Talyn does not know the host. */
  url: string | null;
  /** When PostHog last took the URL and the secret, or null. */
  syncedAt: string | null;
  /**
   * Set when Talyn changed the URL but PostHog did not take the change: the
   * destination still sends to the old URL. "Set up push in PostHog" fixes it.
   */
  error: string | null;
}

/** `GET /workflows/posthog-inbox/webhook`: null when the workspace has no URL for its project. */
export type PostHogInboxPushState = PostHogInboxPushSummary | null;

/** The URL and the secret, shown ONCE: when they are made or rotated. */
export interface PostHogInboxPushReveal {
  connectionId: string;
  /** The full URL, token included. */
  url: string;
  /** The value for `X-Talyn-Secret`, or null when the URL needs no secret. */
  secret: string | null;
  /** The header name to add in PostHog. */
  secretHeader: string;
  /**
   * Set when Talyn created the PostHog destination for this URL: whether
   * PostHog took the new URL and secret too. Null when the person added the
   * destination by hand.
   */
  destination?: PostHogInboxDestinationOutcome | null;
}

/** The name of the destination Talyn creates in PostHog, without a GitHub login. */
export const POSTHOG_INBOX_DESTINATION_NAME = 'Talyn – PostHog Inbox push';

/**
 * The destination name with the GitHub login of the person who set it up or
 * last rotated it, so that people who share a PostHog project can tell
 * their destinations apart.
 */
export function posthogInboxDestinationName(githubLogin?: string | null): string {
  const login = githubLogin?.trim();
  return login ? `${POSTHOG_INBOX_DESTINATION_NAME} (@${login})` : POSTHOG_INBOX_DESTINATION_NAME;
}

/** The answer code when the OAuth grant lacks {@link POSTHOG_INBOX_PUSH_SETUP_SCOPES}. Talyn changed nothing. */
export const POSTHOG_INBOX_PUSH_SCOPES_MISSING_CODE = 'posthog_inbox_push_scopes_missing';

/** The answer code when PostHog refused the destination (403: a missing scope or no Inbox access). */
export const POSTHOG_INBOX_PUSH_FORBIDDEN_CODE = 'posthog_inbox_push_forbidden';

/** The answer code when PostHog did not take the destination for another reason. */
export const POSTHOG_INBOX_PUSH_FAILED_CODE = 'posthog_inbox_push_failed';

/** The message for {@link POSTHOG_INBOX_PUSH_SCOPES_MISSING_CODE}. */
export const POSTHOG_INBOX_PUSH_RECONNECT_MESSAGE = 'Reconnect PostHog to let Talyn set up push.';

/**
 * `POST /workflows/posthog-inbox/webhook/setup`: Talyn made or rotated the
 * URL and created or updated the PostHog destination. Never holds the URL
 * token or the secret: PostHog has them, and nobody needs to copy them.
 */
export interface PostHogInboxPushSetupResult {
  connectionId: string;
  destination: PostHogInboxDestinationSummary;
  /** True when Talyn created a new destination, false when it updated its own. */
  created: boolean;
}

/**
 * What happened to Talyn's PostHog destination when the URL changed or went away.
 *
 * - `updated`: PostHog took the new URL and secret.
 * - `deleted`: PostHog deleted the destination.
 * - `not_found`: PostHog no longer had it.
 * - `failed`: PostHog did not take the change. `error` says why. After a
 *   rotate, the destination still sends to the old URL.
 */
export interface PostHogInboxDestinationOutcome {
  state: 'updated' | 'deleted' | 'not_found' | 'failed';
  error: string | null;
  /** The destination in the PostHog app, or null. */
  url: string | null;
}

/** `DELETE /workflows/posthog-inbox/webhook`. */
export interface PostHogInboxPushRemoval {
  removed: number;
  /** Talyn's PostHog destination, or null when Talyn did not create one. */
  destination: PostHogInboxDestinationOutcome | null;
}

/**
 * PURE: the destination's page in the PostHog app
 * (`/project/:projectId/functions/:id`, PostHog's `urls.hogFunction`). Null
 * when a part is missing.
 */
export function posthogDestinationUrl(
  host: string | null | undefined,
  projectId: string | null | undefined,
  destinationId: string | null | undefined
): string | null {
  if (!host || !projectId || !destinationId) return null;
  return `${host.replace(/\/+$/, '')}/project/${encodeURIComponent(projectId)}/functions/${encodeURIComponent(destinationId)}`;
}

/** PURE: whether a push in the window makes the poller only reconcile. */
export function posthogInboxPushActive(lastPushAt: string | Date | null | undefined, now: number = Date.now()): boolean {
  if (!lastPushAt) return false;
  const at = lastPushAt instanceof Date ? lastPushAt.getTime() : new Date(lastPushAt).getTime();
  if (Number.isNaN(at)) return false;
  return now - at < POSTHOG_INBOX_PUSH_WINDOW_MS;
}

// ---- Backlog (older reports) and manual runs --------------------------------

/** The time ranges the backlog offers, in days. The default is the first. */
export const POSTHOG_INBOX_BACKLOG_DAYS = [7, 30, 90] as const;
export type PostHogInboxBacklogDays = (typeof POSTHOG_INBOX_BACKLOG_DAYS)[number];
export const DEFAULT_POSTHOG_INBOX_BACKLOG_DAYS: PostHogInboxBacklogDays = 7;

/** The most reports one "Run selected" request may name. */
export const MAX_POSTHOG_INBOX_RUN_REPORTS = 20;

/** PURE: a backlog range from user input. Anything unknown is the default. */
export function posthogInboxBacklogDays(raw: unknown): PostHogInboxBacklogDays {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return (POSTHOG_INBOX_BACKLOG_DAYS as readonly unknown[]).includes(n)
    ? (n as PostHogInboxBacklogDays)
    : DEFAULT_POSTHOG_INBOX_BACKLOG_DAYS;
}

/**
 * Where one report stands for Talyn, in the backlog.
 *
 * - `not_run`: the rule would act on it. The only state that can be selected.
 * - `running`: Talyn works on it now: a session, and maybe a pull request.
 * - `already_run`: the rule already ran on this version of the report.
 * - `claimed_elsewhere`: another person or agent holds it in PostHog.
 * - `already_addressed`: PostHog says somebody already handles it.
 * - `repository_not_connected`: its repository is not in this workspace.
 * - `held_back`: PostHog's safety judge suppressed it. Talyn never acts on it.
 */
export type PostHogInboxBacklogState =
  | 'not_run'
  | 'running'
  | 'already_run'
  | 'claimed_elsewhere'
  | 'already_addressed'
  | 'repository_not_connected'
  | 'held_back';

export const POSTHOG_INBOX_BACKLOG_STATE_LABELS: Record<PostHogInboxBacklogState, string> = {
  not_run: 'Not run',
  running: 'Running / PR open',
  already_run: 'Already run',
  claimed_elsewhere: 'Claimed elsewhere',
  already_addressed: 'Already addressed',
  repository_not_connected: 'Repository not connected',
  held_back: 'Held back for safety',
};

/** What a backlog state needs to know about one report. */
export interface PostHogInboxBacklogStateInput {
  suppressionSource: string | null;
  alreadyAddressed: boolean | null;
  /** The Talyn repository of the report's repository, or null when it is not connected. */
  workspaceRepositoryId: string | null | undefined;
  /** Whether somebody holds the report in PostHog (an assignee, or a pull request in flight). */
  claimedInPostHog: boolean;
  /** Whether that claim is Talyn's own. */
  claimIsTalyns: boolean;
  /** Whether Talyn has live work on the report (an active link). */
  talynActive: boolean;
  /** Whether this rule already has a run for this version of the report. */
  ranThisVersion: boolean;
}

/**
 * PURE: the backlog state of one report. The order matters: a report Talyn
 * works on reads `running` even after PostHog marks it addressed because of
 * Talyn's own pull request.
 */
export function posthogInboxBacklogState(input: PostHogInboxBacklogStateInput): PostHogInboxBacklogState {
  if ((input.suppressionSource ?? '').trim().toLowerCase() === 'safety_judge') return 'held_back';
  if (input.talynActive) return 'running';
  if (input.claimedInPostHog && !input.claimIsTalyns) return 'claimed_elsewhere';
  if (input.ranThisVersion) return 'already_run';
  if (input.alreadyAddressed === true) return 'already_addressed';
  if (!input.workspaceRepositoryId) return 'repository_not_connected';
  // Talyn's own claim without a live link: a release PostHog has not taken yet.
  if (input.claimedInPostHog) return 'already_run';
  return 'not_run';
}

/** One report in the backlog. */
export interface PostHogInboxBacklogRow {
  id: string;
  title: string;
  /** The report in the PostHog app. */
  url: string;
  priority: string | null;
  actionability: string | null;
  /** `owner/repo`, or null when PostHog did not pick one. */
  repository: string | null;
  sourceProducts: string[];
  signalCount: number;
  createdAt: string | null;
  updatedAt: string;
  state: PostHogInboxBacklogState;
  /** True only for `not_run` rows of a saved, enabled rule. */
  selectable: boolean;
  /** Talyn's work on the report, when it has some. */
  runId: string | null;
  workbenchId: string | null;
  pullRequestId: string | null;
  prUrl: string | null;
}

/** `POST /workflows/posthog-inbox/backlog`: one page of older reports that match a rule. */
export interface PostHogInboxBacklogPage {
  rows: PostHogInboxBacklogRow[];
  /** How many reports Talyn read from PostHog for this page. */
  scanned: number;
  /** The offset of the next page, or null when PostHog has no more. */
  nextOffset: number | null;
  /** How many reports PostHog's own filters keep, before Talyn's matcher. Null when unknown. */
  total: number | null;
  days: PostHogInboxBacklogDays;
  /** The rule the page was read for, or null for an unsaved rule. */
  workflowId: string | null;
  /** Whether "Run selected" works: the rule is saved and enabled. */
  runnable: boolean;
  /** Why it does not, or null. */
  notRunnableReason: string | null;
  /** The rule's daily cap, or null when it has none. */
  dailyCap: number | null;
  /** Runs in the last 24 hours that count toward the cap. */
  runsToday: number;
}

/**
 * What happened to one report in "Run selected".
 *
 * - `started`: a session started.
 * - `parked`: PostHog or a limit refused for now; Talyn retries later.
 * - `failed`: the run failed. The message says why.
 * - `claimed_elsewhere`: PostHog answered 409; somebody else holds it.
 * - `already_run`: this version already ran. Dedupe, so nothing new.
 * - `not_eligible`: the report no longer matches, or its state does not allow a run.
 * - `daily_cap`: the rule's daily cap is reached; Talyn did not try.
 * - `not_found`: PostHog does not have the report.
 * - `unreadable`: Talyn could not read the report from PostHog.
 */
export type PostHogInboxRunOutcome =
  | 'started'
  | 'parked'
  | 'failed'
  | 'claimed_elsewhere'
  | 'already_run'
  | 'not_eligible'
  | 'daily_cap'
  | 'not_found'
  | 'unreadable';

export interface PostHogInboxRunResult {
  reportId: string;
  outcome: PostHogInboxRunOutcome;
  /** One short sentence for the person. */
  message: string;
  runId: string | null;
  workbenchId: string | null;
}

/** `POST /workflows/:id/posthog-inbox/run`. */
export interface PostHogInboxRunResponse {
  results: PostHogInboxRunResult[];
  requested: number;
  started: number;
  dailyCap: number | null;
  /** The whole answer in one sentence, for example "3 of 5 started; the daily cap of 10 is reached." */
  summary: string;
}

/** PURE: the one-sentence summary of a manual run. */
export function posthogInboxRunSummary(results: PostHogInboxRunResult[], dailyCap: number | null): string {
  const requested = results.length;
  const started = results.filter((r) => r.outcome === 'started').length;
  const parked = results.filter((r) => r.outcome === 'parked').length;
  const capped = results.some((r) => r.outcome === 'daily_cap');
  let text = `${started} of ${requested} started`;
  if (capped && dailyCap !== null) text += `; the daily cap of ${dailyCap} is reached`;
  if (parked > 0) text += `; ${parked} wait${parked === 1 ? 's' : ''} for a retry`;
  return `${text}.`;
}

/** How a run was started. `event` is the poller or a push; `manual` is "Run selected". */
export type WorkflowRunTrigger = 'event' | 'manual';

/**
 * The placeholders a PostHog Inbox rule's prompt can use. Talyn fills them in
 * when the session starts (`posthogInboxRulePrompt` in the backend). A short
 * value (the link, the id, the repository) goes inline. A long or free-text
 * value (the title, the summary) is quoted below the prompt as untrusted text,
 * and the prompt points at it.
 */
export const POSTHOG_INBOX_PROMPT_FIELDS = [
  { key: 'report.title', label: 'Title', description: 'The title of the report.' },
  { key: 'report.url', label: 'Link', description: 'The link to the report in PostHog.' },
  { key: 'report.summary', label: 'Summary', description: "PostHog's summary of the problem." },
  { key: 'report.id', label: 'Report ID', description: 'The id of the report in PostHog.' },
  { key: 'repo', label: 'Repository', description: 'The repository the session works on, as owner/name.' },
] as const;

export type PostHogInboxPromptField = (typeof POSTHOG_INBOX_PROMPT_FIELDS)[number]['key'];

/** The placeholder text for a field: `{{report.title}}`. */
export function posthogInboxPromptPlaceholder(key: PostHogInboxPromptField): string {
  return `{{${key}}}`;
}

/** The prompt a new PostHog Inbox rule starts with. The person can change it. */
export const POSTHOG_INBOX_DEFAULT_PROMPT =
  'Fix the problem in the PostHog report "{{report.title}}" ({{report.url}}).\n\n' +
  "Read the report's summary: {{report.summary}}\n\n" +
  'Add a test that fails without the fix.';
