import type { Workbench, WorkbenchChat } from '@talyn/shared';

import { safeExternalUrl } from '../../components/Workflow';
import { workbenchKind } from '../../workflow/model';
import { WEB_APP_URL } from '../settings/about';

export type SessionActionKind = 'stop' | 'wake' | 'retry' | 'rename' | 'open_pr' | 'share' | 'parent' | 'archive' | 'restore';

export const isArchived = (item: Pick<Workbench, 'status' | 'archivedAt'>) => item.status === 'archived' || Boolean(item.archivedAt);

/** The chat a Stop press ends: the selected one when it runs, else the first running one. */
export function runningChat(item: Workbench, selectedChat?: string | null): WorkbenchChat | undefined {
  const running = (item.chats ?? []).filter((chat) => chat.status === 'running');
  return running.find((chat) => chat.id === selectedChat) ?? running[0];
}

/** A failed start, which web offers to provision again. */
export const canRetry = (item: Workbench) =>
  item.runtime === 'sandbox' && !isArchived(item) && (item.status === 'error' || item.sandboxState === 'error');

/** A sleeping sandbox. Waking it early saves the first message the wait. */
export const canWake = (item: Workbench) =>
  item.runtime === 'sandbox' && !isArchived(item) && item.status === 'ready' && item.sandboxState === 'suspended';

/** Where the same session opens in Talyn on the web. */
export const webLink = (id: string) => `${WEB_APP_URL}/s/${encodeURIComponent(id)}`;

/**
 * The actions a session or thread offers, in menu order. Mirrors the web
 * header and sidebar menus: archived work only restores, live work renames,
 * stops, retries, wakes and archives.
 */
export function sessionActions(item: Workbench, options: { selectedChat?: string | null; onThreadScreen?: boolean } = {}): SessionActionKind[] {
  const actions: SessionActionKind[] = [];
  const archived = isArchived(item);
  if (!archived && runningChat(item, options.selectedChat)) actions.push('stop');
  if (canRetry(item)) actions.push('retry');
  if (canWake(item)) actions.push('wake');
  if (!archived) actions.push('rename');
  if (item.pr?.url && safeExternalUrl(item.pr.url)) actions.push('open_pr');
  if (workbenchKind(item) === 'session' && item.threadId && !options.onThreadScreen) actions.push('parent');
  actions.push('share');
  actions.push(archived ? 'restore' : 'archive');
  return actions;
}

export const SESSION_ACTION_LABEL: Record<SessionActionKind, string> = {
  stop: 'Stop agent',
  wake: 'Wake sandbox',
  retry: 'Retry start',
  rename: 'Rename',
  open_pr: 'Open pull request on GitHub',
  share: 'Share link',
  parent: 'Open parent thread',
  archive: 'Archive',
  restore: 'Restore',
};

/** Copy for the archive confirmation, adapted from web `ArchiveWorkbenchDialog`. */
export function archiveCopy(item: Workbench) {
  const thread = workbenchKind(item) === 'thread';
  return {
    title: `Archive ${item.title?.trim() || item.name}?`,
    message: thread
      ? 'The thread is archived. Its chats stay, and you can restore it later on the web.'
      : 'The session is archived. The branch, its chats and any PR stay, and you can restore it later.',
  };
}
