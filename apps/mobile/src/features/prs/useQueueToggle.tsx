import type { PRRow } from '@talyn/client/native';
import { useRef, useState } from 'react';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { useToast } from '../../components/UI';
import { trackEvent } from '../../lib/analytics';
import { showActionError } from '../../lib/errors';
import { prActions } from './actions';

export function useQueueToggle() {
  const { workflow } = useMobileRuntime();
  const toast = useToast();
  const inFlight = useRef(new Set<string>());
  const [busyId, setBusyId] = useState<string | null>(null);
  const canQueue = (row: PRRow) => prActions(row, { posthogConnected: false }).queue;
  const toggle = async (row: PRRow, enabled: boolean) => {
    if (!canQueue(row) || inFlight.current.has(row.id)) return;
    inFlight.current.add(row.id);
    setBusyId(row.id);
    try {
      await workflow.setMergeQueue(row.id, enabled);
      toast.show(`${enabled ? 'Added' : 'Removed'} #${row.number} ${enabled ? 'to' : 'from'} the merge queue.`);
      trackEvent('merge_queue_toggled', { enabled, pr_number: row.number, source: 'pr_list' });
    } catch (error) {
      showActionError(`Could not ${enabled ? 'queue' : 'dequeue'} #${row.number}`, error);
    } finally {
      inFlight.current.delete(row.id);
      setBusyId((current) => current === row.id ? null : current);
    }
  };
  return { canQueue, toggle, busyId, toast: toast.element };
}
