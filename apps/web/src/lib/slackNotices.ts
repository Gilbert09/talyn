import type { SlackNoticeEvent } from '@talyn/shared';
import { api } from './api';
import { toast } from '../stores/toast';
import { useSlackPendingStore } from '../stores/slackPending';

const NOTICE_TITLE: Record<SlackNoticeEvent['kind'], string> = {
  pick_repository: 'Pick a repository for a Slack request',
  start_failed: 'Could not start a Slack session',
  not_set_up: 'Slack request needs setup',
};

/** Loads the requests that arrived while this client was offline. Errors (flag off) are ignored. */
export async function loadSlackPending(): Promise<void> {
  try {
    useSlackPendingStore.getState().setPending(await api.slack.listPending());
  } catch {
    // The slack flag is off, or the backend is not reachable: nothing to show.
  }
}

/** One `slack:notice`: a toast and the pending item for `pick_repository`. */
export function handleSlackNotice(notice: SlackNoticeEvent): void {
  const store = useSlackPendingStore.getState();
  if (notice.kind === 'pick_repository') {
    if (notice.pending) store.upsert(notice.pending);
    const id = notice.pending?.id ?? null;
    toast.success(NOTICE_TITLE.pick_repository, notice.message, {
      label: 'Pick repository',
      onClick: () => useSlackPendingStore.getState().focus(id),
    });
  } else {
    toast.error(NOTICE_TITLE[notice.kind], notice.message);
  }
}
