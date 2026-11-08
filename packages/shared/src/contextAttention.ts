import type { WorkbenchChatStatus, WorkbenchKind, WorkbenchSandboxState, WorkbenchStatus } from './workbench.js';

/**
 * How many items in each of my workspaces and spaces wait on me. The context
 * rail (the bar on the far left of both apps) shows these on its tiles.
 * `GET /workspaces/attention` answers it.
 *
 * The keys are ids. A workspace or a space with nothing waiting is left out.
 * A session in a space counts for its workspace and for its space, because
 * both sidebars show it.
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
  /** The open chats only. A closed tab is not shown, so it cannot need you. */
  chats: { status: WorkbenchChatStatus | string; queued: number }[];
  /** The linked pull request. `mergeable` is GitHub's word ('CONFLICTING', 'MERGEABLE', 'UNKNOWN'). */
  pr: { state: string; mergeable: string | null } | null;
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
  if (session.archivedAt) return false;
  if (session.status === 'archived') return false;
  if (session.status === 'error' || session.sandboxState === 'error') return true;
  if (session.chats.some((c) => c.status === 'error')) return true;
  if (session.status === 'provisioning' || session.sandboxState === 'creating') return false;
  if (session.chats.some((c) => c.status === 'running' || c.queued > 0)) return false;
  if (session.chats.some((c) => c.status === 'awaiting_input')) return true;
  if (session.kind === 'thread') return false;
  return session.pr?.state === 'open' && session.pr.mergeable === 'CONFLICTING';
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
