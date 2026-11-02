import type { MergeQueuePublic } from '@talyn/client';
import { api } from './api';
import { toast } from '../stores/toast';

export function canResubmitMergeQueue(entry: MergeQueuePublic | null | undefined): boolean {
  return Boolean(
    entry &&
      (entry.status === 'blocked' || entry.status === 'blocked_manual') &&
      (entry.external ||
        entry.blockedCode === 'external_gate' ||
        entry.blockedCode === 'external_queue_rejected')
  );
}

export async function resubmitMergeQueue(id: string): Promise<void> {
  try {
    await api.pullRequests.resubmitMergeQueue(id);
    toast.success('Re-submitted to Trunk');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Please try again.';
    toast.error(
      (error as { status?: number })?.status === 409 ? message : 'Could not re-submit to Trunk',
      (error as { status?: number })?.status === 409 ? undefined : message
    );
  }
}
