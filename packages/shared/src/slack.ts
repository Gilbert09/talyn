/**
 * Slack sessions: the contract between the backend's `/slack` routes and the
 * two front ends, plus the trigger-emoji validator both sides run.
 *
 * Talyn never posts in Slack. A session is started from a reaction, a mention
 * or a DM, and its status is shown as reactions on the triggering message.
 */

/** A Slack workspace (Slack calls it a "team") that has the Talyn app installed. */
export interface SlackInstallationView {
  teamId: string;
  teamName: string | null;
  /** The workspace's web address, e.g. `https://acme.slack.com/`, when Slack told us. */
  teamUrl: string | null;
  /** The bot's Slack user id, for an `<@U…>` mention. */
  botUserId: string;
  /** The bot's handle, so the UI can say "/invite @talyn". Null when unknown. */
  botName: string | null;
  /** Whether the caller installed it. Only the installer may forget the token. */
  installedByMe: boolean;
  /**
   * Slack refused to renew the bot token (revoked, or the app was removed).
   * Someone has to install the app again before anything can run.
   */
  needsReinstall: boolean;
  installedAt: string;
}

/** The caller's link between their Slack identity in one team and their Talyn account. */
export interface SlackUserLinkView {
  id: string;
  teamId: string;
  /** From the installation, null when the team's installation was forgotten. */
  teamName: string | null;
  slackUserId: string;
  /**
   * The Talyn workspace new sessions go to. Null means the account's first
   * workspace (the stored one was deleted).
   */
  workspaceId: string | null;
  /** Shortcode names without colons, e.g. `robot_face`. Empty means no reaction trigger. */
  triggerEmojis: string[];
  /** Whether the team still has an installation. A link without one does nothing. */
  installed: boolean;
  createdAt: string;
}

/** `GET /slack`. */
export interface SlackStatus {
  installations: SlackInstallationView[];
  links: SlackUserLinkView[];
}

/** `POST /slack/install` and `POST /slack/link`: open this URL in a browser. */
export interface SlackAuthorizeResponse {
  authorizeUrl: string;
}

/** Body of `POST /slack/install` and `POST /slack/link`. */
export interface SlackStartInput {
  /** The workspace new sessions go to. Defaults to the caller's first workspace. */
  workspaceId?: string;
}

/** Body of `PATCH /slack/links/:id`. Omitted fields are left alone. */
export interface UpdateSlackLinkInput {
  triggerEmojis?: string[];
  workspaceId?: string;
}

/** `DELETE /slack/installations/:teamId`. */
export interface SlackForgetInstallationResponse {
  teamId: string;
  /** Says that the app is still installed in Slack and how to remove it there. */
  message: string;
}

/** The 403 code every `/slack` route answers when the `slack` flag is off. */
export const SLACK_UNAVAILABLE_CODE = 'slack_unavailable';
/** The 503 code when this deployment has no Slack app configured. */
export const SLACK_NOT_CONFIGURED_CODE = 'slack_not_configured';

/** Slack's limit on an emoji name. */
export const SLACK_EMOJI_NAME_MAX_LENGTH = 100;

// Slack's own rule for emoji names: lowercase letters, digits, `_`, `-`, and
// `+` (for the built-in `+1`).
const EMOJI_NAME = /^[a-z0-9_+-]+$/;

/**
 * One typed emoji name in stored form: trimmed, surrounding colons removed,
 * lowercased. Returns null when the result is not a valid Slack emoji name.
 */
export function normalizeSlackEmojiName(raw: string): string | null {
  const name = raw.trim().replace(/^:+/, '').replace(/:+$/, '').toLowerCase();
  if (!name || name.length > SLACK_EMOJI_NAME_MAX_LENGTH) return null;
  return EMOJI_NAME.test(name) ? name : null;
}

export type SlackEmojiValidation =
  | { ok: true; emojis: string[] }
  | { ok: false; error: string };

/**
 * Validate a whole trigger list: every entry normalized, duplicates removed,
 * order kept. One bad entry refuses the list and names that entry.
 *
 * There is no cap on the count. The list only affects the caller's own link,
 * and the request body limit already bounds one row.
 */
export function validateSlackTriggerEmojis(input: unknown): SlackEmojiValidation {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'triggerEmojis must be a list of emoji names' };
  }
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') {
      return { ok: false, error: 'triggerEmojis must contain only strings' };
    }
    const name = normalizeSlackEmojiName(raw);
    if (!name) {
      return {
        ok: false,
        error:
          `"${raw.slice(0, 120)}" is not a Slack emoji name. Use the shortcode, e.g. robot_face ` +
          `(lowercase letters, digits, _ + -, at most ${SLACK_EMOJI_NAME_MAX_LENGTH} characters).`,
      };
    }
    if (!out.includes(name)) out.push(name);
  }
  return { ok: true, emojis: out };
}
