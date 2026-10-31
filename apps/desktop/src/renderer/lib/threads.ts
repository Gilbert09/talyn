import type { ThreadSessionAction, ThreadSessionEvent, Workbench, WorkbenchChat } from '@talyn/shared';

/**
 * Threads: a workbench with `kind: 'thread'` and no repository. It starts
 * sessions on repositories, and each of those sessions carries `threadId`.
 *
 * Pure helpers only (no React, no stores), so the web app can copy this file.
 */

type Kinded = Pick<Workbench, 'kind'>;
type Archivable = Pick<Workbench, 'status' | 'archivedAt'>;

/** True for a thread. An older server sends no `kind`: that is a session. */
export function isThread(wb: Kinded): boolean {
  return wb.kind === 'thread';
}

function archived(wb: Archivable): boolean {
  return wb.status === 'archived' || Boolean(wb.archivedAt);
}

/** Live threads, oldest first, so a row does not move when a thread gets busy. */
export function liveThreads<T extends Workbench>(all: T[]): T[] {
  return all.filter((w) => isThread(w) && !archived(w)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The sessions of one thread, oldest first. Archived ones only with `includeArchived`. */
export function threadChildren<T extends Workbench>(all: T[], threadId: string, opts: { includeArchived?: boolean } = {}): T[] {
  return all
    .filter((w) => !isThread(w) && w.threadId === threadId && (opts.includeArchived || !archived(w)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The repositories a thread's sessions work on, alphabetical and without repeats. */
export function threadRepositories(children: Pick<Workbench, 'repoFullName'>[]): string[] {
  return [...new Set(children.map((c) => c.repoFullName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** How many of these sessions have a chat that runs now. */
export function runningSessionCount(
  children: Pick<Workbench, 'id'>[],
  chatsByWorkbench: Record<string, Pick<WorkbenchChat, 'status'>[] | undefined>
): number {
  return children.filter((c) => (chatsByWorkbench[c.id] ?? []).some((chat) => chat.status === 'running')).length;
}

/** The short summary on a thread's sidebar row: "2 running", or "idle". */
export function threadSummary(running: number): string {
  return running > 0 ? `${running} running` : 'idle';
}

/** Where a workbench works, for lists: its repository, or "Thread". */
export function workbenchPlaceLabel(wb: Pick<Workbench, 'kind' | 'repoFullName'>): string {
  return isThread(wb) ? 'Thread' : wb.repoFullName;
}

/** The title of a `talyn_thread` transcript card. */
export function threadCardTitle(event: Pick<ThreadSessionEvent, 'action' | 'status'>): string {
  const titles: Record<ThreadSessionAction, string> = {
    session_started: 'Session started',
    session_finished: event.status === 'error' ? 'Session stopped with an error' : 'Session finished its turn',
    pr_opened: 'Pull request opened',
    needs_input: 'Session needs an answer',
  };
  return titles[event.action] ?? 'Session update';
}

/** One `@` mention a thread's composer offers. `value` is the text after the `@`. */
export interface ThreadMention {
  value: string;
  label: string;
  kind: 'repository' | 'session';
}

/** The text a session mention inserts after the `@`. */
export function sessionMentionValue(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * What a thread's `@` offers: its live sessions first (the work in hand), then
 * the workspace's repositories. A case-insensitive match on the label and the
 * value; prefix matches first. At most 20.
 */
export function threadMentions(
  query: string,
  repositories: Array<{ fullName: string }>,
  sessions: Array<Pick<Workbench, 'id' | 'name' | 'repoFullName'> & { title?: string | null }>
): ThreadMention[] {
  const all: ThreadMention[] = [
    ...sessions.map((s) => ({
      value: sessionMentionValue(s.id),
      label: `${s.title?.trim() || s.name} · ${s.repoFullName}`,
      kind: 'session' as const,
    })),
    ...[...new Set(repositories.map((r) => r.fullName))]
      .sort((a, b) => a.localeCompare(b))
      .map((fullName) => ({ value: fullName, label: fullName, kind: 'repository' as const })),
  ];
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, 20);
  const starts = (m: ThreadMention) => m.label.toLowerCase().startsWith(q) || m.value.toLowerCase().startsWith(q);
  return all
    .filter((m) => m.label.toLowerCase().includes(q) || m.value.toLowerCase().includes(q))
    .sort((a, b) => Number(starts(b)) - Number(starts(a)))
    .slice(0, 20);
}

/** A short CI note for a session's open pull request, or null when there is nothing to say. */
export function prCiLabel(ciStatus: string | undefined): string | null {
  switch (ciStatus) {
    case 'passing':
      return 'CI passing';
    case 'failing_required':
    case 'failing_optional':
      return 'CI failing';
    case 'running':
    case 'pending':
      return 'CI running';
    default:
      return null;
  }
}

/** How many memory entries the work panel shows before "Open all". */
export const WORK_PANEL_MEMORY_LIMIT = 5;
