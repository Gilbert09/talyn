import type { WorkbenchChatStatus, WorkbenchKind, WorkbenchSandboxState, WorkbenchStatus } from './workbench.js';

/**
 * How many items in each of my workspaces and spaces wait on me. The context
 * rail (the bar on the far left of both apps) shows these on its tiles.
 * `GET /workspaces/attention` answers it.
 *
 * The keys are ids. A workspace or a space with nothing waiting is left out.
 * A session in a space counts for its space and its workspace.
 */
export interface ContextAttentionCounts {
  /** Every session that waits on me in the workspace, in Personal and in its spaces. */
  workspaces: Record<string, number>;
  spaces: Record<string, number>;
  /**
   * The space part of `workspaces`: per workspace, the count of each space.
   * The rail takes away the spaces that have their own tile, so the
   * workspace tile counts the rows of its Personal sidebar. A space session
   * shows in Personal when its space has no tile (Spaces off, or the space
   * is gone), so it stays in the count. An older server leaves it out.
   */
  workspaceSpaces?: Record<string, Record<string, number>>;
  /**
   * The sessions that the counts count, by id, with what each waits on me
   * for. The sidebar marks these rows, so a badge always points at a row.
   * An older server leaves it out.
   */
  sessions?: Record<string, ContextAttentionReason>;
}

/** What a counted session waits on me for. */
export type ContextAttentionReason = 'failed' | 'reply' | 'plan' | 'conflict';

export interface AttentionSessionInput {
  kind: WorkbenchKind | string;
  status: WorkbenchStatus | string;
  sandboxState: WorkbenchSandboxState | string;
  archivedAt: unknown;
  /**
   * The open chats only. A closed tab is not shown, so it cannot need you.
   * `id` and `turnCount` name the alert in {@link sessionAttentionKey}.
   * `planPending` is true when the agent's latest reply holds a plan that
   * waits for "Approve and build" (a ```talyn-plan block after the last
   * message from a person).
   */
  chats: { id?: string; status: WorkbenchChatStatus | string; queued: number; turnCount?: number; planPending?: boolean }[];
  /**
   * The linked pull request. `mergeable` is GitHub's word ('CONFLICTING', 'MERGEABLE', 'UNKNOWN').
   * `id` and `headSha` name the alert in {@link sessionAttentionKey}.
   */
  pr: { id?: string; state: string; mergeable: string | null; headSha?: string | null } | null;
}

/**
 * True when a session waits on me. It is the server's half of the sidebar's
 * `sessionState`: a failure, a question for me, a plan that waits for my
 * approval, or a pull request with conflicts. The sidebar also counts an unread reply, but read state is kept
 * only in the open app, so the server cannot know it.
 *
 * Live work wins over a question, as in the sidebar: a session with a running
 * turn shows as working.
 */
export function sessionNeedsAttention(session: AttentionSessionInput): boolean {
  return sessionAttentionKey(session) !== null;
}

/**
 * A name for what the session waits on me for, or null when it waits on
 * nothing. Opening the session does not clear it: the session counts until
 * the key goes null. A new alert has a new key: a question in a later turn
 * has a new turn count, and conflicts after a push have a new head.
 */
export function sessionAttentionKey(session: AttentionSessionInput): string | null {
  if (session.archivedAt) return null;
  if (session.status === 'archived') return null;
  if (session.status === 'error' || session.sandboxState === 'error') return 'error';
  const failed = session.chats.filter((c) => c.status === 'error');
  if (failed.length > 0) return chatKey('chat_error', failed);
  if (session.status === 'provisioning' || session.sandboxState === 'creating') return null;
  if (session.chats.some((c) => c.status === 'running' || c.queued > 0)) return null;
  const asking = session.chats.filter((c) => c.status === 'awaiting_input');
  if (asking.length > 0) return chatKey('reply', asking);
  const planning = session.chats.filter((c) => c.planPending && c.status === 'idle');
  if (planning.length > 0) return chatKey('plan', planning);
  if (session.kind === 'thread') return null;
  if (session.pr?.state === 'open' && session.pr.mergeable === 'CONFLICTING') {
    return `conflict:${session.pr.id ?? ''}:${session.pr.headSha ?? ''}`;
  }
  return null;
}

/** The reason in a {@link sessionAttentionKey}, or null for no key. */
export function attentionReason(key: string | null): ContextAttentionReason | null {
  if (key === null) return null;
  const head = key.split(':', 1)[0];
  if (head === 'reply') return 'reply';
  if (head === 'plan') return 'plan';
  if (head === 'conflict') return 'conflict';
  return 'failed';
}

/**
 * Why a session is in "Needs you" and what to do about it, in plain words.
 * The hover card shows it, so a person does not have to open the session to
 * find out.
 */
export function attentionReasonText(reason: ContextAttentionReason, prNumber?: number | null): string {
  switch (reason) {
    case 'failed':
      return 'The session or one of its chats failed. Open it to see the error, then retry.';
    case 'reply':
      return 'The agent asked you a question. Open the session to answer it.';
    case 'plan':
      return 'The agent wrote a plan. Open the session to approve it or ask for changes.';
    case 'conflict':
      return `${prNumber ? `#${prNumber}` : 'The pull request'} has merge conflicts with its base branch. Resolve them, or ask the agent to.`;
  }
}

function chatKey(reason: string, chats: AttentionSessionInput['chats']): string {
  return `${reason}:${chats
    .map((c) => `${c.id ?? ''}@${c.turnCount ?? 0}`)
    .sort()
    .join(',')}`;
}

/** Add one item to a count map. */
function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** The counts for a list of sessions that need me, by workspace and by space, and each session's reason. */
export function countContextAttention(
  sessions: { id: string; workspaceId: string; spaceId: string | null; reason: ContextAttentionReason }[],
): Required<ContextAttentionCounts> {
  const out: Required<ContextAttentionCounts> = { workspaces: {}, spaces: {}, workspaceSpaces: {}, sessions: {} };
  for (const s of sessions) {
    bump(out.workspaces, s.workspaceId);
    if (s.spaceId) {
      bump(out.spaces, s.spaceId);
      bump((out.workspaceSpaces[s.workspaceId] ??= {}), s.spaceId);
    }
    out.sessions[s.id] = s.reason;
  }
  return out;
}

/** "99+" above 99, so a tile badge stays small. Null for zero: no badge. */
export function attentionBadgeLabel(count: number | undefined): string | null {
  if (!count || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}
