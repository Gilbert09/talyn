import type { WorkbenchChatStatus, WorkbenchKind, WorkbenchSandboxState, WorkbenchStatus } from './workbench.js';

/**
 * How many items in each of my workspaces and spaces wait on me. The context
 * rail (the bar on the far left of both apps) shows these on its tiles.
 * `GET /workspaces/attention` answers it.
 *
 * The keys are ids. A workspace or a space with nothing waiting is left out.
 * A session in a space counts for its space and its workspace. The workspace
 * tile is the desktop launcher, so its count covers Personal and every space.
 */
export interface ContextAttentionCounts {
  workspaces: Record<string, number>;
  spaces: Record<string, number>;
}

export interface AttentionSessionInput {
  kind: WorkbenchKind | string;
  status: WorkbenchStatus | string;
  sandboxState: WorkbenchSandboxState | string;
  archivedAt: unknown;
  /**
   * The open chats only. A closed tab is not shown, so it cannot need you.
   * `id` and `turnCount` name the alert in {@link sessionAttentionKey}.
   */
  chats: { id?: string; status: WorkbenchChatStatus | string; queued: number; turnCount?: number }[];
  /**
   * The linked pull request. `mergeable` is GitHub's word ('CONFLICTING', 'MERGEABLE', 'UNKNOWN').
   * `id` and `headSha` name the alert in {@link sessionAttentionKey}.
   */
  pr: { id?: string; state: string; mergeable: string | null; headSha?: string | null } | null;
}

/**
 * True when a session waits on me. It is the server's half of the sidebar's
 * `sessionState`: a failure, a question for me, or a pull request with
 * conflicts. The sidebar also counts an unread reply, but read state is kept
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
 * nothing. When I open the session, the server keeps this key
 * (`workbenches.attention_ack`), and the rail stops counting the session while
 * the key stays the same. A new alert has a new key, so it counts again: a
 * question in a later turn has a new turn count, and conflicts after a push
 * have a new head.
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
  if (session.kind === 'thread') return null;
  if (session.pr?.state === 'open' && session.pr.mergeable === 'CONFLICTING') {
    return `conflict:${session.pr.id ?? ''}:${session.pr.headSha ?? ''}`;
  }
  return null;
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

/** The counts for a list of sessions that need me, by workspace and by space. */
export function countContextAttention(
  sessions: { workspaceId: string; spaceId: string | null }[],
): ContextAttentionCounts {
  const out: ContextAttentionCounts = { workspaces: {}, spaces: {} };
  for (const s of sessions) {
    bump(out.workspaces, s.workspaceId);
    if (s.spaceId) bump(out.spaces, s.spaceId);
  }
  return out;
}

/** "99+" above 99, so a tile badge stays small. Null for zero: no badge. */
export function attentionBadgeLabel(count: number | undefined): string | null {
  if (!count || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}
