// PostHog Inbox: the shapes of the PostHog connection status and the dry run
// that the PostHog Inbox rule editor reads. The rule vocabulary itself (facts,
// conditions, matcher) lives in `workflows.ts` with the other integrations.

/** The OAuth scopes PostHog Inbox rules need. */
export const POSTHOG_INBOX_SCOPES = ['inbox:read', 'inbox:write'] as const;

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
  /** When the poller last read the Inbox, or null. */
  lastPolledAt: string | null;
  /** The last poll's error, or null when it worked. */
  lastError: string | null;
  /** The newest push from PostHog that Talyn could read, or null. */
  lastPushAt: string | null;
  /** Whether the workspace has a webhook URL for its PostHog project. */
  pushConfigured: boolean;
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
}

/** PURE: whether a push in the window makes the poller only reconcile. */
export function posthogInboxPushActive(lastPushAt: string | Date | null | undefined, now: number = Date.now()): boolean {
  if (!lastPushAt) return false;
  const at = lastPushAt instanceof Date ? lastPushAt.getTime() : new Date(lastPushAt).getTime();
  if (Number.isNaN(at)) return false;
  return now - at < POSTHOG_INBOX_PUSH_WINDOW_MS;
}
