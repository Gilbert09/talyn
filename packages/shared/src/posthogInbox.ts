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
